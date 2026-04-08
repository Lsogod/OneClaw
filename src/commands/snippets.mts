import { basename, join } from "node:path"
import { readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import type { OneClawConfig } from "../types.mts"
import { collectFilesByExtension, ensureDir, limitText, readTextIfExists, slugify, writeText } from "../utils.mts"

export type CommandSnippetSource = "project" | "user" | "plugin"

export type CommandSnippet = {
  name: string
  description: string
  source: CommandSnippetSource
  path: string
  body: string
}

function parseFrontmatter(raw: string): {
  meta: Record<string, string>
  body: string
} {
  if (!raw.startsWith("---\n")) {
    return { meta: {}, body: raw }
  }
  const endIndex = raw.indexOf("\n---\n", 4)
  if (endIndex < 0) {
    return { meta: {}, body: raw }
  }
  const metaBlock = raw.slice(4, endIndex)
  const body = raw.slice(endIndex + 5)
  const meta: Record<string, string> = {}
  for (const line of metaBlock.split("\n")) {
    const separator = line.indexOf(":")
    if (separator < 0) continue
    meta[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }
  return { meta, body }
}

async function pluginCommandRoots(pluginDirs: string[]): Promise<string[]> {
  const roots = new Set<string>()
  for (const pluginDir of pluginDirs) {
    if (!existsSync(pluginDir)) {
      continue
    }
    const directCommands = join(pluginDir, "commands")
    if (existsSync(directCommands)) {
      roots.add(directCommands)
    }
    const entries = await readdir(pluginDir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) {
        continue
      }
      const commandsDir = join(pluginDir, entry.name, "commands")
      if (existsSync(commandsDir)) {
        roots.add(commandsDir)
      }
    }
  }
  return [...roots].sort()
}

export async function commandSnippetRoots(config: OneClawConfig, cwd: string): Promise<Array<{ source: CommandSnippetSource; root: string }>> {
  return [
    { source: "project", root: join(cwd, ".oneclaw", "commands") },
    { source: "user", root: join(config.homeDir, "commands") },
    ...(await pluginCommandRoots(config.pluginDirs)).map(root => ({ source: "plugin" as const, root })),
  ]
}

export async function listCommandSnippets(config: OneClawConfig, cwd: string): Promise<CommandSnippet[]> {
  const snippets: CommandSnippet[] = []
  for (const { source, root } of await commandSnippetRoots(config, cwd)) {
    const files = await collectFilesByExtension([root], [".md"], 2)
    for (const file of files) {
      const raw = await readTextIfExists(file)
      if (!raw) {
        continue
      }
      const parsed = parseFrontmatter(raw)
      const fallbackName = basename(file).replace(/\.md$/i, "")
      snippets.push({
        name: parsed.meta.name || fallbackName,
        description: parsed.meta.description || "",
        source,
        path: file,
        body: parsed.body.trim(),
      })
    }
  }
  return snippets.sort((left, right) =>
    left.name.localeCompare(right.name) || left.source.localeCompare(right.source) || left.path.localeCompare(right.path),
  )
}

export async function findCommandSnippet(config: OneClawConfig, cwd: string, name: string): Promise<CommandSnippet | null> {
  const normalized = name.toLowerCase()
  const priority: Record<CommandSnippetSource, number> = { project: 0, user: 1, plugin: 2 }
  const matches = (await listCommandSnippets(config, cwd))
    .filter(snippet => snippet.name.toLowerCase() === normalized)
    .sort((left, right) => priority[left.source] - priority[right.source])
  return matches[0] ?? null
}

export function renderCommandSnippet(snippet: CommandSnippet, args: string): string {
  const trimmedArgs = args.trim()
  let rendered = snippet.body
    .replace(/\{\{\s*args\s*\}\}/g, trimmedArgs)
    .replace(/\{\{\s*command\s*\}\}/g, snippet.name)
  if (trimmedArgs && rendered === snippet.body) {
    rendered = `${rendered}\n\nUser arguments:\n${trimmedArgs}`
  }
  return limitText(rendered, 12000)
}

export async function initCommandSnippet(cwd: string, name = "review"): Promise<{ path: string; created: boolean }> {
  const safeName = slugify(name || "review")
  const path = join(cwd, ".oneclaw", "commands", `${safeName}.md`)
  if (existsSync(path)) {
    return { path, created: false }
  }
  await ensureDir(join(cwd, ".oneclaw", "commands"))
  await writeText(path, [
    "---",
    `name: ${safeName}`,
    "description: Run a focused project command snippet.",
    "---",
    "",
    `Execute the ${safeName} command for this workspace.`,
    "",
    "Arguments:",
    "{{args}}",
    "",
  ].join("\n"))
  return { path, created: true }
}
