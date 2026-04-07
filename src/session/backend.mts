import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import type { OneClawConfig, SessionRecord } from "../types.mts"
import { fileExists, readJsonIfExists, resolveConfigPath, writeJson, writeText } from "../utils.mts"

export interface SessionBackend {
  getSessionDir(sessionId: string): string
  saveSession(session: SessionRecord): Promise<void>
  loadSession(sessionId: string): Promise<SessionRecord | null>
  listSessions(): Promise<SessionRecord[]>
  loadLatestSession(): Promise<SessionRecord | null>
  deleteSession(sessionId: string): Promise<boolean>
  exportJson(session: SessionRecord): Promise<string>
  exportMarkdown(session: SessionRecord): Promise<string>
}

export class FileSessionBackend implements SessionBackend {
  constructor(private readonly config: OneClawConfig) {}

  getSessionDir(sessionId: string): string {
    return join(this.config.sessionDir, sessionId)
  }

  async saveSession(session: SessionRecord): Promise<void> {
    await writeJson(resolveConfigPath(this.config, session.id), session)
  }

  async loadSession(sessionId: string): Promise<SessionRecord | null> {
    return readJsonIfExists<SessionRecord>(resolveConfigPath(this.config, sessionId))
  }

  async listSessions(): Promise<SessionRecord[]> {
    if (!(await fileExists(this.config.sessionDir))) {
      return []
    }

    const entries = await readdir(this.config.sessionDir, { withFileTypes: true })
    const sessions: SessionRecord[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue
      }
      const session = await this.loadSession(entry.name)
      if (session) {
        sessions.push(session)
      }
    }
    return sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }

  async loadLatestSession(): Promise<SessionRecord | null> {
    return (await this.listSessions())[0] ?? null
  }

  async deleteSession(sessionId: string): Promise<boolean> {
    const target = this.getSessionDir(sessionId)
    const exists = await fileExists(target)
    if (!exists) {
      return false
    }
    await rm(target, { recursive: true, force: true })
    return true
  }

  async exportJson(session: SessionRecord): Promise<string> {
    const targetPath = join(this.getSessionDir(session.id), "transcript.json")
    await writeJson(targetPath, session)
    return targetPath
  }

  async exportMarkdown(session: SessionRecord): Promise<string> {
    const lines = [
      `# Session ${session.id}`,
      "",
      `- cwd: ${session.cwd}`,
      `- created_at: ${session.createdAt}`,
      `- updated_at: ${session.updatedAt}`,
      "",
    ]

    for (const message of session.messages) {
      lines.push(`## ${message.role}`)
      lines.push("")
      for (const block of message.content) {
        if (block.type === "text") {
          lines.push(block.text)
          continue
        }
        if (block.type === "tool_call") {
          lines.push(`- tool_call: ${block.name} ${JSON.stringify(block.input)}`)
          continue
        }
        lines.push(`- tool_result: ${block.name} ${block.result}`)
      }
      lines.push("")
    }

    const targetPath = join(this.getSessionDir(session.id), "transcript.md")
    await writeText(targetPath, `${lines.join("\n").trimEnd()}\n`)
    return targetPath
  }
}

export function createSessionBackend(config: OneClawConfig): SessionBackend {
  return new FileSessionBackend(config)
}
