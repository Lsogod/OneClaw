import { spawnSync } from "node:child_process"
import { mkdir, rm } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { OneClawConfig } from "../types.mts"
import { readJsonIfExists, slugify, writeJson } from "../utils.mts"
import { auditPlugin, installPluginFromPath, trustPlugin } from "./installer.mts"

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
  options: { trust?: boolean; dryRun?: boolean } = {},
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
      trusted: Boolean(options.trust),
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
