import { spawnSync } from "node:child_process"
import { createHmac } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { OneClawConfig } from "../types.mts"
import { readJsonIfExists, slugify, writeJson } from "../utils.mts"
import { auditPlugin, getUserPluginDir, installPluginFromPath, trustPlugin } from "./installer.mts"

export type PluginMarketplaceScope = "project" | "user"

export type PluginMarketplaceEntry = {
  name: string
  source: string
  description?: string
  version?: string
  tags?: string[]
  permissions?: string[]
  addedAt: string
  scope?: PluginMarketplaceScope
  path?: string
}

type PluginMarketplaceFile = {
  plugins?: PluginMarketplaceEntry[]
}

type PluginMarketplaceLockRecord = {
  name: string
  source: string
  resolvedSource: string
  version?: string
  manifestSha256: string
  installedAt: string
  trusted: boolean
  trustRequired?: boolean
  expectedSha256?: string
  versionConstraint?: string
  signature?: string
  signatureEnv?: string
}

type PluginMarketplaceLockFile = {
  version: 1
  plugins?: Record<string, PluginMarketplaceLockRecord>
}

function marketplacePath(config: OneClawConfig, cwd: string, scope: PluginMarketplaceScope): string {
  return scope === "project"
    ? join(cwd, ".oneclaw", "plugins", "marketplace.json")
    : join(config.homeDir, "plugins", "marketplace.json")
}

function marketplaceLockPath(config: OneClawConfig): string {
  return join(config.homeDir, "plugins", "marketplace-lock.json")
}

function marketplaceSourceDir(config: OneClawConfig, name: string): string {
  return join(config.homeDir, "plugins", "sources", slugify(name))
}

function isRemoteSource(source: string): boolean {
  return /^(https?:|git\+|ssh:|git@)/i.test(source)
}

function cloneSource(source: string): string {
  return source.replace(/^git\+/i, "")
}

function parseVersion(version?: string): [number, number, number] | null {
  const match = version?.match(/(\d+)\.(\d+)\.(\d+)/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

function compareVersions(left: [number, number, number], right: [number, number, number]): number {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index]
    }
  }
  return 0
}

function versionSatisfies(version: string | undefined, constraint: string | undefined): boolean {
  const normalized = constraint?.trim()
  if (!normalized || normalized === "*") {
    return true
  }
  const parsed = parseVersion(version)
  if (!parsed) {
    return false
  }
  if (normalized.startsWith("^")) {
    const base = parseVersion(normalized.slice(1))
    return base ? parsed[0] === base[0] && compareVersions(parsed, base) >= 0 : false
  }
  if (normalized.startsWith("~")) {
    const base = parseVersion(normalized.slice(1))
    return base ? parsed[0] === base[0] && parsed[1] === base[1] && compareVersions(parsed, base) >= 0 : false
  }
  const operator = normalized.match(/^(>=|<=|>|<|=)?\s*(.+)$/)
  const target = parseVersion(operator?.[2])
  const comparison = target ? compareVersions(parsed, target) : 0
  const op = operator?.[1] ?? "="
  return op === ">=" ? comparison >= 0
    : op === "<=" ? comparison <= 0
      : op === ">" ? comparison > 0
        : op === "<" ? comparison < 0
          : comparison === 0
}

function verifyMarketplaceSignature(
  manifestSha256: string,
  signature?: string,
  signatureEnv?: string,
): { ok: boolean; kind?: string; error?: string } {
  const raw = signature?.trim()
  if (!raw) {
    return { ok: true }
  }
  if (raw.startsWith("hmac-sha256:")) {
    if (!signatureEnv) {
      return { ok: false, kind: "hmac-sha256", error: "signatureEnv is required for hmac-sha256 signatures" }
    }
    const secret = process.env[signatureEnv]
    if (!secret) {
      return { ok: false, kind: "hmac-sha256", error: `Missing signature env: ${signatureEnv}` }
    }
    const expected = raw.replace(/^hmac-sha256:/, "")
    const actual = createHmac("sha256", secret).update(manifestSha256).digest("hex")
    return { ok: expected === actual, kind: "hmac-sha256", error: expected === actual ? undefined : "signature mismatch" }
  }
  const expected = raw.replace(/^sha256:/, "")
  return { ok: expected === manifestSha256, kind: "sha256", error: expected === manifestSha256 ? undefined : "signature mismatch" }
}

function normalizeEntry(entry: PluginMarketplaceEntry, scope: PluginMarketplaceScope, path: string): PluginMarketplaceEntry {
  return {
    name: entry.name,
    source: entry.source,
    description: entry.description,
    version: entry.version,
    tags: [...new Set(entry.tags ?? [])].sort(),
    permissions: [...new Set(entry.permissions ?? [])].sort(),
    addedAt: entry.addedAt,
    scope,
    path,
  }
}

async function readMarketplaceFile(path: string, scope: PluginMarketplaceScope): Promise<PluginMarketplaceEntry[]> {
  const document = await readJsonIfExists<PluginMarketplaceFile>(path)
  return (document?.plugins ?? [])
    .filter(entry => typeof entry?.name === "string" && typeof entry?.source === "string")
    .map(entry => normalizeEntry(entry, scope, path))
    .sort((left, right) => left.name.localeCompare(right.name))
}

async function writeMarketplaceFile(path: string, entries: PluginMarketplaceEntry[]): Promise<void> {
  await writeJson(path, {
    plugins: entries
      .map(entry => ({
        name: entry.name,
        source: entry.source,
        description: entry.description,
        version: entry.version,
        tags: [...new Set(entry.tags ?? [])].sort(),
        permissions: [...new Set(entry.permissions ?? [])].sort(),
        addedAt: entry.addedAt,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  })
}

export async function initPluginMarketplace(
  config: OneClawConfig,
  cwd: string,
  scope: PluginMarketplaceScope = "project",
): Promise<{ path: string; created: boolean; scope: PluginMarketplaceScope }> {
  const path = marketplacePath(config, cwd, scope)
  const existing = await readJsonIfExists<PluginMarketplaceFile>(path)
  if (existing) {
    return { path, created: false, scope }
  }
  await mkdir(dirname(path), { recursive: true })
  await writeMarketplaceFile(path, [])
  return { path, created: true, scope }
}

export async function listPluginMarketplace(
  config: OneClawConfig,
  cwd: string,
  query = "",
): Promise<{
  count: number
  paths: Record<PluginMarketplaceScope, string>
  plugins: PluginMarketplaceEntry[]
}> {
  const paths = {
    project: marketplacePath(config, cwd, "project"),
    user: marketplacePath(config, cwd, "user"),
  }
  const all = [
    ...await readMarketplaceFile(paths.project, "project"),
    ...await readMarketplaceFile(paths.user, "user"),
  ]
  const normalizedQuery = query.trim().toLowerCase()
  const plugins = normalizedQuery
    ? all.filter(entry => [
        entry.name,
        entry.source,
        entry.description ?? "",
        ...(entry.tags ?? []),
      ].join("\n").toLowerCase().includes(normalizedQuery))
    : all
  return {
    count: plugins.length,
    paths,
    plugins: plugins.sort((left, right) =>
      `${left.scope}:${left.name}`.localeCompare(`${right.scope}:${right.name}`),
    ),
  }
}

export async function addPluginMarketplaceEntry(
  config: OneClawConfig,
  cwd: string,
  scope: PluginMarketplaceScope,
  entry: {
    name: string
    source: string
    description?: string
    version?: string
    tags?: string[]
  },
): Promise<{ path: string; entry: PluginMarketplaceEntry; replaced: boolean }> {
  const path = marketplacePath(config, cwd, scope)
  const entries = await readMarketplaceFile(path, scope)
  const previous = entries.find(item => item.name === entry.name)
  const next: PluginMarketplaceEntry = normalizeEntry({
    name: entry.name,
    source: entry.source,
    description: entry.description,
    version: entry.version,
    tags: entry.tags,
    permissions: [],
    addedAt: previous?.addedAt ?? new Date().toISOString(),
  }, scope, path)
  await writeMarketplaceFile(path, [
    ...entries.filter(item => item.name !== entry.name),
    next,
  ])
  return { path, entry: next, replaced: Boolean(previous) }
}

export async function removePluginMarketplaceEntry(
  config: OneClawConfig,
  cwd: string,
  scope: PluginMarketplaceScope,
  name: string,
): Promise<{ path: string; removed: boolean; name: string }> {
  const path = marketplacePath(config, cwd, scope)
  const entries = await readMarketplaceFile(path, scope)
  const remaining = entries.filter(entry => entry.name !== name)
  await writeMarketplaceFile(path, remaining)
  return {
    path,
    removed: remaining.length !== entries.length,
    name,
  }
}

export async function findPluginMarketplaceEntry(
  config: OneClawConfig,
  cwd: string,
  name: string,
): Promise<PluginMarketplaceEntry | null> {
  const marketplace = await listPluginMarketplace(config, cwd)
  return marketplace.plugins.find(entry => entry.name === name) ?? null
}

export async function installPluginFromMarketplace(
  config: OneClawConfig,
  cwd: string,
  name: string,
  options: {
    trust?: boolean
    dryRun?: boolean
    requireTrust?: boolean
    expectedSha256?: string
    versionConstraint?: string
    signature?: string
    signatureEnv?: string
  } = {},
): Promise<Record<string, unknown>> {
  const entry = await findPluginMarketplaceEntry(config, cwd, name)
  if (!entry) {
    return {
      installed: false,
      reason: `Plugin marketplace entry not found: ${name}`,
    }
  }
  const remote = isRemoteSource(entry.source)
  const resolvedSource = remote ? marketplaceSourceDir(config, entry.name) : entry.source
  if (options.dryRun) {
    return {
      installed: false,
      dryRun: true,
      entry,
      remote,
      resolvedSource,
      steps: [
        ...(remote ? [`clone ${entry.source} -> ${resolvedSource}`] : []),
        `audit ${resolvedSource}`,
        ...(options.expectedSha256 ? [`verify manifest sha256 ${options.expectedSha256}`] : []),
        ...(options.versionConstraint ? [`verify version ${options.versionConstraint}`] : []),
        ...(options.signature ? [`verify signature ${options.signatureEnv ? `${options.signatureEnv}:` : ""}${options.signature}`] : []),
        ...(options.requireTrust ? ["require existing trust"] : []),
        `install ${entry.name}`,
        ...(options.trust ? [`trust ${entry.name}`] : []),
      ],
    }
  }
  if (remote) {
    await rm(resolvedSource, { recursive: true, force: true })
    await mkdir(dirname(resolvedSource), { recursive: true })
    const clone = spawnSync("git", [
      "clone",
      "--depth",
      "1",
      ...(entry.version ? ["--branch", entry.version] : []),
      cloneSource(entry.source),
      resolvedSource,
    ], {
      encoding: "utf8",
    })
    if (clone.status !== 0) {
      return {
        installed: false,
        entry,
        remote,
        resolvedSource,
        error: (clone.stderr || clone.stdout || "git clone failed").trim(),
      }
    }
  }
  const audit = await auditPlugin(config, resolvedSource)
  if (options.expectedSha256 && audit.manifestSha256 !== options.expectedSha256) {
    return {
      installed: false,
      entry,
      remote,
      resolvedSource,
      audit,
      error: `Manifest sha256 mismatch: expected ${options.expectedSha256}, got ${audit.manifestSha256}`,
    }
  }
  const constraint = options.versionConstraint
  if (constraint && !versionSatisfies(audit.version, constraint)) {
    return {
      installed: false,
      entry,
      remote,
      resolvedSource,
      audit,
      error: `Plugin version ${audit.version ?? "(missing)"} does not satisfy ${constraint}`,
    }
  }
  const signature = verifyMarketplaceSignature(audit.manifestSha256, options.signature, options.signatureEnv)
  if (!signature.ok) {
    return {
      installed: false,
      entry,
      remote,
      resolvedSource,
      audit,
      signature,
      error: `Plugin signature verification failed: ${signature.error}`,
    }
  }
  if (options.requireTrust && !audit.trust.trusted && !options.trust) {
    return {
      installed: false,
      entry,
      remote,
      resolvedSource,
      audit,
      error: "Plugin is not trusted. Use /plugin trust add <path> first, or pass --trust explicitly.",
    }
  }
  const trust = options.trust ? await trustPlugin(config, resolvedSource) : undefined
  const installed = await installPluginFromPath(config, resolvedSource)
  const lockPath = marketplaceLockPath(config)
  const lock = await readJsonIfExists<PluginMarketplaceLockFile>(lockPath) ?? {
    version: 1,
    plugins: {},
  }
  lock.plugins = {
    ...(lock.plugins ?? {}),
    [entry.name]: {
      name: entry.name,
      source: entry.source,
      resolvedSource,
      version: entry.version ?? audit.version,
      manifestSha256: audit.manifestSha256,
      installedAt: new Date().toISOString(),
      trusted: Boolean(options.trust) || audit.trust.trusted,
      trustRequired: Boolean(options.requireTrust),
      expectedSha256: options.expectedSha256,
      versionConstraint: constraint,
      signature: options.signature ? "present" : undefined,
      signatureEnv: options.signatureEnv,
    },
  }
  await writeJson(lockPath, lock)
  return {
    installed: true,
    entry,
    remote,
    resolvedSource,
    audit,
    trust,
    lockPath,
    lock: lock.plugins[entry.name],
    result: installed,
  }
}

export async function diffPluginFromMarketplace(
  config: OneClawConfig,
  cwd: string,
  name: string,
): Promise<Record<string, unknown>> {
  const entry = await findPluginMarketplaceEntry(config, cwd, name)
  if (!entry) {
    return {
      found: false,
      reason: `Plugin marketplace entry not found: ${name}`,
    }
  }
  const remote = isRemoteSource(entry.source)
  const resolvedSource = remote ? marketplaceSourceDir(config, entry.name) : resolve(entry.source)
  const installedRoot = join(getUserPluginDir(config), entry.name)
  const sourceAvailable = existsSync(resolvedSource)
  const installed = existsSync(installedRoot)
  const audit = sourceAvailable
    ? await auditPlugin(config, resolvedSource).catch(error => ({
        error: error instanceof Error ? error.message : String(error),
      }))
    : null
  const diff = sourceAvailable && installed
    ? spawnSync("git", ["diff", "--no-index", "--stat", resolvedSource, installedRoot], {
        encoding: "utf8",
      })
    : null
  return {
    found: true,
    entry,
    remote,
    resolvedSource,
    sourceAvailable,
    installed,
    installedRoot,
    cloneRequired: remote && !sourceAvailable,
    audit,
    diffStat: diff
      ? (diff.stdout || diff.stderr || "").trim() || "(no differences)"
      : sourceAvailable
        ? installed
          ? "(no diff output)"
          : "Plugin is not installed yet."
        : "Remote plugin source has not been cloned yet. Run install --dry-run or install to prepare it.",
  }
}
