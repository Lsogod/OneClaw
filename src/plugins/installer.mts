import { createHash } from "node:crypto"
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { basename, join, resolve } from "node:path"
import type { OneClawConfig } from "../types.mts"
import { readJsonIfExists, writeJson } from "../utils.mts"

const PLUGIN_MANIFEST_CANDIDATES = [
  "plugin.json",
  ".oneclaw-plugin/plugin.json",
  ".claude-plugin/plugin.json",
]

type PluginInstallRecord = {
  name: string
  source: string
  destination: string
  version?: string
  manifestSha256?: string
  permissions?: string[]
  installedAt: string
}

type PluginState = {
  installed?: Record<string, PluginInstallRecord>
  disabledPlugins?: string[]
}

function userPluginDir(config: OneClawConfig): string {
  return config.pluginDirs[config.pluginDirs.length - 1] ?? join(config.homeDir, "plugins")
}

function statePath(config: OneClawConfig): string {
  return join(userPluginDir(config), ".oneclaw-plugin-state.json")
}

async function readPluginState(config: OneClawConfig): Promise<PluginState> {
  return await readJsonIfExists<PluginState>(statePath(config)) ?? {
    installed: {},
    disabledPlugins: [],
  }
}

async function writePluginState(config: OneClawConfig, state: PluginState): Promise<void> {
  await mkdir(userPluginDir(config), { recursive: true })
  await writeJson(statePath(config), {
    installed: state.installed ?? {},
    disabledPlugins: [...new Set(state.disabledPlugins ?? [])].sort(),
  })
}

async function readManifest(source: string): Promise<{ path: string; manifest: Record<string, unknown> }> {
  for (const candidate of PLUGIN_MANIFEST_CANDIDATES) {
    const manifestPath = join(source, candidate)
    const manifest = await readJsonIfExists<Record<string, unknown>>(manifestPath)
    if (manifest) {
      return { path: manifestPath, manifest }
    }
  }
  throw new Error(`Plugin manifest not found in ${source}. Expected one of: ${PLUGIN_MANIFEST_CANDIDATES.join(", ")}`)
}

async function sha256File(pathname: string): Promise<string> {
  return createHash("sha256").update(await readFile(pathname)).digest("hex")
}

function normalizePermissions(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  return [...new Set(value.filter(item => typeof item === "string").map(item => item.trim()).filter(Boolean))].sort()
}

async function collectPluginInventory(root: string): Promise<{
  totalFiles: number
  jsModules: string[]
  hookFiles: string[]
  skillFiles: string[]
  manifestFiles: string[]
}> {
  const jsModules: string[] = []
  const hookFiles: string[] = []
  const skillFiles: string[] = []
  const manifestFiles: string[] = []
  let totalFiles = 0
  const queue: Array<{ path: string; relative: string }> = [{ path: root, relative: "" }]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const entry of await readdir(current.path, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") {
        continue
      }
      const fullPath = join(current.path, entry.name)
      const relativePath = current.relative ? `${current.relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        queue.push({ path: fullPath, relative: relativePath })
        continue
      }
      totalFiles += 1
      if (/\.(mjs|js|mts|ts)$/.test(entry.name)) {
        jsModules.push(relativePath)
      }
      if (/hooks?\.(json|ya?ml|mjs|js|mts|ts)$/i.test(entry.name) || relativePath.includes("/hooks/")) {
        hookFiles.push(relativePath)
      }
      if (entry.name.endsWith(".md") && /(^|\/)(skills?|commands?)\//.test(relativePath)) {
        skillFiles.push(relativePath)
      }
      if (PLUGIN_MANIFEST_CANDIDATES.includes(relativePath)) {
        manifestFiles.push(relativePath)
      }
    }
  }
  return {
    totalFiles,
    jsModules: jsModules.sort(),
    hookFiles: hookFiles.sort(),
    skillFiles: skillFiles.sort(),
    manifestFiles: manifestFiles.sort(),
  }
}

function inferPermissionWarnings(manifest: Record<string, unknown>, permissions: string[], inventory: Awaited<ReturnType<typeof collectPluginInventory>>): string[] {
  const warnings: string[] = []
  const hasPermission = (permission: string) => permissions.includes(permission)
  if (permissions.length === 0) {
    warnings.push("manifest.permissions is missing; review this plugin before enabling it.")
  }
  if ((typeof manifest.main === "string" || inventory.jsModules.length > 0) && !hasPermission("code")) {
    warnings.push("Plugin contains executable JS/TS modules but does not declare permission 'code'.")
  }
  if ((typeof manifest.hooksFile === "string" || inventory.hookFiles.length > 0) && !hasPermission("hooks")) {
    warnings.push("Plugin contains hooks but does not declare permission 'hooks'.")
  }
  if ((Array.isArray(manifest.tools) || typeof manifest.toolsFile === "string") && !hasPermission("tools")) {
    warnings.push("Plugin exposes tools but does not declare permission 'tools'.")
  }
  if ((Array.isArray(manifest.systemPromptPatches) || typeof manifest.skillsDir === "string" || inventory.skillFiles.length > 0) && !hasPermission("prompt")) {
    warnings.push("Plugin can modify prompt/skills context but does not declare permission 'prompt'.")
  }
  return warnings
}

export async function validatePluginDirectory(
  sourcePath: string,
): Promise<{ name: string; version?: string; manifestPath: string; manifestSha256: string; permissions: string[]; warnings: string[] }> {
  const source = resolve(sourcePath)
  const sourceStats = await stat(source).catch(() => null)
  if (!sourceStats?.isDirectory()) {
    throw new Error(`Plugin source directory not found: ${sourcePath}`)
  }
  const { path: manifestPath, manifest } = await readManifest(source)
  const warnings: string[] = []
  const name = typeof manifest.name === "string" && manifest.name.trim()
    ? manifest.name.trim()
    : basename(source)
  if (!/^[a-zA-Z0-9._-]+$/.test(name)) {
    warnings.push(`Plugin name '${name}' contains unusual characters.`)
  }
  const version = typeof manifest.version === "string" ? manifest.version : undefined
  const declaredPermissions = manifest.permissions
  if (declaredPermissions !== undefined && !Array.isArray(declaredPermissions)) {
    warnings.push("manifest.permissions should be an array when present.")
  }
  const permissions = normalizePermissions(declaredPermissions)
  return {
    name,
    version,
    manifestPath,
    manifestSha256: await sha256File(manifestPath),
    permissions,
    warnings,
  }
}

export async function auditPlugin(
  config: OneClawConfig,
  target: string,
): Promise<{
  source: string
  installedName?: string
  name: string
  version?: string
  manifestPath: string
  manifestSha256: string
  permissions: string[]
  inventory: Awaited<ReturnType<typeof collectPluginInventory>>
  warnings: string[]
  state: {
    installed: boolean
    disabled: boolean
    recordedSource?: string
    destination?: string
  }
}> {
  const state = await readPluginState(config)
  const installedRecord = state.installed?.[target]
  const source = existsSync(target) ? resolve(target) : installedRecord?.destination ?? join(userPluginDir(config), target)
  const sourceStats = await stat(source).catch(() => null)
  if (!sourceStats?.isDirectory()) {
    throw new Error(`Plugin not found: ${target}`)
  }
  const { path: manifestPath, manifest } = await readManifest(source)
  const validation = await validatePluginDirectory(source)
  const inventory = await collectPluginInventory(source)
  const warnings = [
    ...validation.warnings,
    ...inferPermissionWarnings(manifest, validation.permissions, inventory),
  ]
  const installedName = installedRecord ? target : Object.entries(state.installed ?? {})
    .find(([, record]) => resolve(record.destination) === source)?.[0]
  const disabledPlugins = new Set(state.disabledPlugins ?? [])
  return {
    source,
    installedName,
    name: validation.name,
    version: validation.version,
    manifestPath,
    manifestSha256: validation.manifestSha256,
    permissions: validation.permissions,
    inventory,
    warnings,
    state: {
      installed: Boolean(installedName),
      disabled: disabledPlugins.has(validation.name) || existsSync(join(source, ".oneclaw-disabled")),
      recordedSource: installedRecord?.source,
      destination: installedRecord?.destination,
    },
  }
}

export async function installPluginFromPath(
  config: OneClawConfig,
  sourcePath: string,
): Promise<{ source: string; destination: string; name: string; version?: string; warnings: string[] }> {
  const source = resolve(sourcePath)
  const sourceStats = await stat(source).catch(() => null)
  if (!sourceStats?.isDirectory()) {
    throw new Error(`Plugin source directory not found: ${sourcePath}`)
  }
  const validation = await validatePluginDirectory(source)
  const destinationRoot = userPluginDir(config)
  await mkdir(destinationRoot, { recursive: true })
  const destination = join(destinationRoot, validation.name)
  await rm(destination, { recursive: true, force: true })
  await cp(source, destination, { recursive: true })
  const state = await readPluginState(config)
  state.installed = {
    ...(state.installed ?? {}),
    [validation.name]: {
      name: validation.name,
      source,
      destination,
      version: validation.version,
      manifestSha256: validation.manifestSha256,
      permissions: validation.permissions,
      installedAt: new Date().toISOString(),
    },
  }
  state.disabledPlugins = (state.disabledPlugins ?? []).filter(name => name !== validation.name)
  await writePluginState(config, state)
  return {
    source,
    destination,
    name: validation.name,
    version: validation.version,
    warnings: validation.warnings,
  }
}

export async function uninstallPlugin(
  config: OneClawConfig,
  name: string,
): Promise<{ removed: boolean; destination: string }> {
  const destination = join(userPluginDir(config), name)
  const existing = await stat(destination).catch(() => null)
  if (!existing?.isDirectory()) {
    return {
      removed: false,
      destination,
    }
  }
  await rm(destination, { recursive: true, force: true })
  const state = await readPluginState(config)
  if (state.installed) {
    delete state.installed[name]
  }
  state.disabledPlugins = (state.disabledPlugins ?? []).filter(entry => entry !== name)
  await writePluginState(config, state)
  return {
    removed: true,
    destination,
  }
}

export function getUserPluginDir(config: OneClawConfig): string {
  return userPluginDir(config)
}

export async function updatePlugin(
  config: OneClawConfig,
  name: string,
): Promise<{ updated: boolean; reason?: string; source?: string; destination?: string }> {
  const state = await readPluginState(config)
  const record = state.installed?.[name]
  if (!record?.source) {
    return {
      updated: false,
      reason: `Plugin '${name}' has no recorded install source.`,
    }
  }
  const result = await installPluginFromPath(config, record.source)
  return {
    updated: true,
    source: result.source,
    destination: result.destination,
  }
}

export async function setPluginEnabled(
  config: OneClawConfig,
  name: string,
  enabled: boolean,
): Promise<{ name: string; enabled: boolean }> {
  const destination = join(userPluginDir(config), name)
  if (!existsSync(destination)) {
    throw new Error(`Plugin '${name}' is not installed in ${userPluginDir(config)}`)
  }
  const state = await readPluginState(config)
  const disabled = new Set(state.disabledPlugins ?? [])
  if (enabled) {
    disabled.delete(name)
    await rm(join(destination, ".oneclaw-disabled"), { force: true })
  } else {
    disabled.add(name)
    await writeFile(join(destination, ".oneclaw-disabled"), `disabledAt=${new Date().toISOString()}\n`)
  }
  state.disabledPlugins = [...disabled].sort()
  await writePluginState(config, state)
  return { name, enabled }
}

export async function pluginLifecycleState(config: OneClawConfig): Promise<PluginState & { userPluginDir: string }> {
  return {
    ...(await readPluginState(config)),
    userPluginDir: userPluginDir(config),
  }
}
