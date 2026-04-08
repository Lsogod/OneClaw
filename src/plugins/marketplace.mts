import { mkdir } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import type { OneClawConfig } from "../types.mts"
import { readJsonIfExists, writeJson } from "../utils.mts"
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

function marketplacePath(config: OneClawConfig, cwd: string, scope: PluginMarketplaceScope): string {
  return scope === "project"
    ? join(cwd, ".oneclaw", "plugins", "marketplace.json")
    : join(config.homeDir, "plugins", "marketplace.json")
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
  options: { trust?: boolean } = {},
): Promise<Record<string, unknown>> {
  const entry = await findPluginMarketplaceEntry(config, cwd, name)
  if (!entry) {
    return {
      installed: false,
      reason: `Plugin marketplace entry not found: ${name}`,
    }
  }
  if (/^(https?:|git\+|ssh:)/i.test(entry.source)) {
    return {
      installed: false,
      reason: "Remote marketplace sources are recorded but not installed automatically. Clone or vendor the plugin locally, then install from a local path.",
      entry,
    }
  }
  const audit = await auditPlugin(config, entry.source)
  const trust = options.trust ? await trustPlugin(config, entry.source) : undefined
  const installed = await installPluginFromPath(config, entry.source)
  return {
    installed: true,
    entry,
    audit,
    trust,
    result: installed,
  }
}
