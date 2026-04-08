import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import type { ContentBlock, Logger, Message, OneClawConfig } from "./types.mts"

function writeStderr(message: string): void {
  process.stderr.write(message.endsWith("\n") ? message : `${message}\n`)
}

export function createConsoleLogger(verbose = false): Logger {
  return {
    info(message) {
      writeStderr(message)
    },
    warn(message) {
      writeStderr(message)
    },
    error(message) {
      writeStderr(message)
    },
    debug(message) {
      if (verbose) {
        writeStderr(message)
      }
    },
  }
}

export function expandHome(input: string): string {
  if (!input.startsWith("~")) {
    return input
  }
  return resolve(input.replace(/^~(?=$|\/)/, homedir()))
}

export function randomId(prefix = "oc"): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`
}

export async function ensureDir(pathname: string): Promise<void> {
  await mkdir(pathname, { recursive: true })
}

export async function readTextIfExists(pathname: string): Promise<string | null> {
  if (!existsSync(pathname)) {
    return null
  }
  return readFile(pathname, "utf8")
}

export async function readJsonIfExists<T>(pathname: string): Promise<T | null> {
  const raw = await readTextIfExists(pathname)
  if (!raw) {
    return null
  }
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    process.stderr.write(`[oneclaw] warning: failed to parse ${pathname}: ${error instanceof Error ? error.message : String(error)}\n`)
    return null
  }
}

export async function writeJson(pathname: string, value: unknown): Promise<void> {
  await ensureDir(dirname(pathname))
  await writeFile(pathname, JSON.stringify(value, null, 2))
}

export async function writeText(pathname: string, value: string): Promise<void> {
  await ensureDir(dirname(pathname))
  await writeFile(pathname, value)
}

export async function appendText(pathname: string, value: string): Promise<void> {
  const previous = (await readTextIfExists(pathname)) ?? ""
  await writeText(pathname, previous + value)
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function toPlainText(blocks: ContentBlock[]): string {
  return blocks
    .map(block => {
      if (block.type === "text") return block.text
      if (block.type === "tool_call") {
        return `[tool_call:${block.name}] ${JSON.stringify(block.input)}`
      }
      return `[tool_result:${block.name}] ${block.result}`
    })
    .join("\n")
}

export function flattenMessageText(messages: Message[]): string {
  return messages
    .map(message => `${message.role}: ${toPlainText(message.content)}`)
    .join("\n")
}

export function limitText(input: string, maxChars = 4000): string {
  if (input.length <= maxChars) {
    return input
  }
  const suffix = `\n...[truncated ${input.length - maxChars} chars]`
  if (suffix.length >= maxChars) {
    return input.slice(0, maxChars)
  }
  return `${input.slice(0, maxChars - suffix.length)}${suffix}`
}

export function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export async function walkFiles(
  root: string,
  depth = 3,
  prefix = "",
): Promise<string[]> {
  if (depth < 0 || !existsSync(root)) {
    return []
  }

  const entries = await readdir(root, { withFileTypes: true })
  const results: string[] = []
  const ignoredDirectories = new Set([".git", "node_modules", "dist", "release"])

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) {
      continue
    }
    const fullPath = join(root, entry.name)
    const displayPath = prefix ? `${prefix}/${entry.name}` : entry.name
    results.push(displayPath)
    if (entry.isDirectory() && depth > 0) {
      const nested = await walkFiles(fullPath, depth - 1, displayPath)
      results.push(...nested)
    }
  }

  return results.sort()
}

export async function collectFilesByExtension(
  roots: string[],
  extensions: string[],
  depth = 3,
): Promise<string[]> {
  const matches = new Set<string>()
  for (const root of roots) {
    if (!existsSync(root)) {
      continue
    }
    const queue: Array<{ path: string; level: number }> = [{ path: root, level: 0 }]
    while (queue.length > 0) {
      const current = queue.shift()!
      const entries = await readdir(current.path, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(current.path, entry.name)
        if (entry.isDirectory()) {
          if (current.level < depth) {
            queue.push({ path: fullPath, level: current.level + 1 })
          }
          continue
        }
        if (extensions.some(extension => entry.name.endsWith(extension))) {
          matches.add(fullPath)
        }
      }
    }
  }
  return [...matches].sort()
}

export async function fileExists(pathname: string): Promise<boolean> {
  try {
    await stat(pathname)
    return true
  } catch {
    return false
  }
}

export function isInsideRoots(targetPath: string, roots: string[]): boolean {
  if (roots.length === 0) {
    return true
  }

  const resolvedTarget = resolve(targetPath)
  return roots.some(root => {
    const resolvedRoot = resolve(root)
    const rel = relative(resolvedRoot, resolvedTarget)
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
  })
}

export function deepMergeConfig<T extends Record<string, unknown>>(
  base: T,
  override: Partial<T>,
): T {
  const result = { ...base } as Record<string, unknown>
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) {
      continue
    }

    if (
      isRecord(value) &&
      isRecord(result[key])
    ) {
      result[key] = deepMergeConfig(
        result[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      )
      continue
    }

    result[key] = value
  }
  return result as T
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "item"
}

export function matchesPattern(pattern: string, input: string): boolean {
  const escaped = pattern
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`, "i").test(input)
}

export function resolveConfigPath(config: OneClawConfig, sessionId: string): string {
  return join(config.sessionDir, sessionId, "session.json")
}

export function summarizeCompaction(messages: Message[]): string {
  return messages
    .map(message => {
      const preview = limitText(toPlainText(message.content), 300)
      return `- ${message.role}: ${preview}`
    })
    .join("\n")
}

export function formatSessionSummary(messages: Message[], maxChars = 1200): string {
  const parts = messages
    .slice(-6)
    .map(message => `${message.role}: ${limitText(toPlainText(message.content), 200)}`)
  return limitText(parts.join("\n"), maxChars)
}

export function promptFromArgs(argv: string[]): string | null {
  const promptIndex = argv.findIndex(arg => arg === "-p" || arg === "--prompt")
  if (promptIndex >= 0 && argv[promptIndex + 1]) {
    return argv[promptIndex + 1]
  }

  const valueFlags = new Set(["-p", "--prompt", "--skill", "--subtask"])
  const positional: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (valueFlags.has(value)) {
      index += 1
      continue
    }
    if (!value.startsWith("--")) {
      positional.push(value)
    }
  }
  if (positional.length > 0) {
    return positional.join(" ")
  }

  return null
}

export function parseFlagValues(argv: string[], flag: string): string[] {
  const values: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag && argv[index + 1]) {
      values.push(argv[index + 1])
    }
  }
  return values
}

export function displayPath(cwd: string, targetPath: string): string {
  return relative(cwd, targetPath) || basename(targetPath)
}
