import { readdir, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import type { MemoryScope, OneClawConfig } from "../types.mts"
import { appendText, ensureDir, limitText, readTextIfExists, slugify, writeText } from "../utils.mts"
import { FileMemoryStore } from "./store.mts"

type MemoryEntry = {
  scope: Exclude<MemoryScope, "session">
  name: string
  title: string
  path: string
  content: string
}

export class MemoryManager {
  constructor(private readonly config: OneClawConfig) {}

  getSessionStore(sessionId: string): FileMemoryStore {
    return new FileMemoryStore(this.config, sessionId)
  }

  getProjectMemoryPath(cwd: string): string {
    return join(cwd, this.config.memory.projectDirName, this.config.memory.projectFileName)
  }

  getGlobalMemoryPath(): string {
    return this.config.memory.globalFile
  }

  private getProjectMemoryDir(cwd: string): string {
    return join(cwd, this.config.memory.projectDirName, "memory")
  }

  private getProjectMemoryIndexPath(cwd: string): string {
    return join(cwd, this.config.memory.projectDirName, "MEMORY.md")
  }

  private getGlobalMemoryDir(): string {
    return join(this.config.homeDir, "memory", "entries")
  }

  private getGlobalMemoryIndexPath(): string {
    return join(this.config.homeDir, "memory", "MEMORY.md")
  }

  private entryDir(scope: Exclude<MemoryScope, "session">, cwd: string): string {
    return scope === "project"
      ? this.getProjectMemoryDir(cwd)
      : this.getGlobalMemoryDir()
  }

  private indexPath(scope: Exclude<MemoryScope, "session">, cwd: string): string {
    return scope === "project"
      ? this.getProjectMemoryIndexPath(cwd)
      : this.getGlobalMemoryIndexPath()
  }

  private async readProjectMemory(cwd: string): Promise<string> {
    return (await readTextIfExists(this.getProjectMemoryPath(cwd))) ?? ""
  }

  private async readGlobalMemory(): Promise<string> {
    return (await readTextIfExists(this.getGlobalMemoryPath())) ?? ""
  }

  async readScope(scope: MemoryScope, options: {
    cwd: string
    sessionId: string
  }): Promise<string> {
    if (!this.config.memory.enabled) {
      return ""
    }
    if (scope === "session") {
      return this.getSessionStore(options.sessionId).read()
    }
    if (scope === "project") {
      return this.readProjectMemory(options.cwd)
    }
    return this.readGlobalMemory()
  }

  async append(scope: MemoryScope, note: string, options: {
    cwd: string
    sessionId: string
  }): Promise<void> {
    if (!this.config.memory.enabled) {
      return
    }

    const line = note.endsWith("\n") ? note : `${note}\n`
    if (scope === "session") {
      await this.getSessionStore(options.sessionId).append(line)
      return
    }

    const targetPath = scope === "project"
      ? this.getProjectMemoryPath(options.cwd)
      : this.getGlobalMemoryPath()
    await ensureDir(dirname(targetPath))
    await appendText(targetPath, line)
  }

  async replace(scope: MemoryScope, note: string, options: {
    cwd: string
    sessionId: string
  }): Promise<void> {
    if (!this.config.memory.enabled) {
      return
    }

    if (scope === "session") {
      await this.getSessionStore(options.sessionId).replace(note)
      return
    }

    const targetPath = scope === "project"
      ? this.getProjectMemoryPath(options.cwd)
      : this.getGlobalMemoryPath()
    await ensureDir(dirname(targetPath))
    await writeText(targetPath, note)
  }

  async listEntries(scope: Exclude<MemoryScope, "session">, cwd: string): Promise<MemoryEntry[]> {
    const dir = this.entryDir(scope, cwd)
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    const results: MemoryEntry[] = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue
      }
      const path = join(dir, entry.name)
      const content = (await readTextIfExists(path)) ?? ""
      const lines = content.split(/\r?\n/)
      const firstLine = lines[0]?.replace(/^#\s*/, "").trim()
      results.push({
        scope,
        name: entry.name.replace(/\.md$/i, ""),
        title: firstLine || entry.name.replace(/\.md$/i, ""),
        path,
        content,
      })
    }
    return results.sort((left, right) => left.title.localeCompare(right.title))
  }

  async addEntry(
    scope: Exclude<MemoryScope, "session">,
    title: string,
    content: string,
    cwd: string,
  ): Promise<MemoryEntry> {
    const dir = this.entryDir(scope, cwd)
    const indexPath = this.indexPath(scope, cwd)
    const slug = slugify(title.replace(/\.md$/i, ""))
    const path = join(dir, `${slug}.md`)
    const body = content.trim()
    const rendered = `# ${title.trim()}\n\n${body}\n`
    await ensureDir(dir)
    await writeText(path, rendered)
    const indexHeader = scope === "project" ? "# Project Memory\n" : "# Global Memory\n"
    const existingIndex = (await readTextIfExists(indexPath)) ?? indexHeader
    const nextLine = `- [${title.trim()}](memory/${slug}.md)`
    const nextIndex = existingIndex.includes(nextLine)
      ? existingIndex
      : `${existingIndex.trimEnd()}\n${nextLine}\n`
    await writeText(indexPath, nextIndex)
    return {
      scope,
      name: slug,
      title: title.trim(),
      path,
      content: rendered,
    }
  }

  async removeEntry(
    scope: Exclude<MemoryScope, "session">,
    name: string,
    cwd: string,
  ): Promise<boolean> {
    const entries = await this.listEntries(scope, cwd)
    const match = entries.find(entry =>
      entry.name === name || basename(entry.path) === name || entry.title === name,
    )
    if (!match) {
      return false
    }
    await rm(match.path, { force: true })
    const indexPath = this.indexPath(scope, cwd)
    const indexRaw = await readTextIfExists(indexPath)
    if (indexRaw) {
      const filtered = indexRaw
        .split(/\r?\n/)
        .filter(line => !line.includes(`${match.name}.md`) && !line.includes(`[${match.title}]`))
        .join("\n")
      await writeText(indexPath, `${filtered.trimEnd()}\n`)
    }
    return true
  }

  async searchEntries(
    query: string,
    options: {
      cwd: string
      sessionId: string
    },
  ): Promise<Array<{
    scope: MemoryScope
    title: string
    path: string
    preview: string
  }>> {
    const lowered = query.toLowerCase()
    const results: Array<{
      scope: MemoryScope
      title: string
      path: string
      preview: string
    }> = []
    const sessionText = await this.getSessionStore(options.sessionId).read()
    if (sessionText.toLowerCase().includes(lowered)) {
      results.push({
        scope: "session",
        title: "Session Memory",
        path: join(this.config.sessionDir, options.sessionId, "memory.md"),
        preview: limitText(sessionText, 240),
      })
    }
    for (const scope of ["project", "global"] as const) {
      const entries = await this.listEntries(scope, options.cwd)
      for (const entry of entries) {
        if (
          entry.title.toLowerCase().includes(lowered)
          || entry.content.toLowerCase().includes(lowered)
        ) {
          results.push({
            scope,
            title: entry.title,
            path: entry.path,
            preview: limitText(entry.content, 240),
          })
        }
      }
    }
    return results
  }

  async buildPromptSections(options: {
    cwd: string
    sessionId: string
    maxChars?: number
  }): Promise<string[]> {
    if (!this.config.memory.enabled) {
      return []
    }

    const candidates: Array<{ title: string; text: string }> = []
    if (this.config.memory.includeGlobal) {
      const text = await this.readGlobalMemory()
      if (text.trim()) {
        candidates.push({ title: "Global Memory", text: text.trim() })
      }
    }
    if (this.config.memory.includeProject) {
      const text = await this.readProjectMemory(options.cwd)
      if (text.trim()) {
        candidates.push({ title: "Project Memory", text: text.trim() })
      }
    }
    if (this.config.memory.includeSession) {
      const text = await this.getSessionStore(options.sessionId).read()
      if (text.trim()) {
        candidates.push({ title: "Session Memory", text: text.trim() })
      }
    }

    const sections: string[] = []
    let remaining = options.maxChars ?? Number.POSITIVE_INFINITY
    for (let index = 0; index < candidates.length; index += 1) {
      if (remaining <= 48) {
        break
      }
      const sectionsLeft = candidates.length - index
      const fairShare = Number.isFinite(remaining)
        ? Math.max(64, Math.floor(remaining / sectionsLeft) - 32)
        : 4000
      const body = limitText(candidates[index].text, Math.min(4000, fairShare))
      const rendered = `## ${candidates[index].title}\n${body}`
      sections.push(rendered)
      if (Number.isFinite(remaining)) {
        remaining -= rendered.length + 2
      }
    }

    return sections
  }
}
