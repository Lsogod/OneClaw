import { resolve } from "node:path"
import type {
  Logger,
  OneClawConfig,
  SessionRecord,
  SessionRunResult,
} from "../types.mts"
import { HookExecutor } from "../hooks/executor.mts"
import type { QueryEvent } from "./query-engine.mts"
import { QueryEngine } from "./query-engine.mts"
import { AppStateStore } from "../state/store.mts"
import {
  isInsideRoots,
  randomId,
} from "../utils.mts"
import type { SessionBackend } from "../session/backend.mts"
import { TaskManager } from "../tasks/task-manager.mts"

type RunOptions = {
  skillNames?: string[]
  onEvent?: (event: QueryEvent) => void
}

export class SessionEngine {
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly runLocks = new Map<string, Promise<void>>()

  constructor(
    private readonly config: OneClawConfig,
    private readonly queryEngine: QueryEngine,
    private readonly tasks: TaskManager,
    private readonly logger: Logger,
    private readonly backend: SessionBackend,
    private readonly hookExecutor: HookExecutor,
    private readonly state: AppStateStore,
  ) {}

  listSessions(): SessionRecord[] {
    return [...this.sessions.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )
  }

  async listSnapshots(): Promise<SessionRecord[]> {
    const diskSessions = await this.backend.listSessions()
    const merged = new Map<string, SessionRecord>()
    for (const session of diskSessions) {
      merged.set(session.id, session)
    }
    for (const session of this.sessions.values()) {
      merged.set(session.id, session)
    }
    return [...merged.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )
  }

  private normalizeAndValidateCwd(cwd: string): string {
    const normalized = resolve(cwd)
    if (!isInsideRoots(normalized, this.config.permissions.writableRoots)) {
      throw new Error(`Session cwd is outside writable roots: ${normalized}`)
    }
    return normalized
  }

  private async acquireSessionLock(
    sessionId: string,
  ): Promise<() => void> {
    const previous = this.runLocks.get(sessionId) ?? Promise.resolve()
    let releaseLock!: () => void
    const current = new Promise<void>(resolveCurrent => {
      releaseLock = resolveCurrent
    })
    this.runLocks.set(sessionId, current)
    await previous
    let released = false
    return () => {
      if (released) {
        return
      }
      released = true
      releaseLock()
      if (this.runLocks.get(sessionId) === current) {
        this.runLocks.delete(sessionId)
      }
    }
  }

  private async withSessionLock<T>(
    sessionId: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const release = await this.acquireSessionLock(sessionId)
    try {
      return await action()
    } finally {
      release()
    }
  }

  async createSession(
    cwd = process.cwd(),
    metadata?: Record<string, unknown>,
  ): Promise<SessionRecord> {
    const normalizedCwd = this.normalizeAndValidateCwd(cwd)
    const session: SessionRecord = {
      id: randomId("session"),
      cwd: normalizedCwd,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      metadata,
    }
    this.sessions.set(session.id, session)
    await this.persistSession(session)
    await this.hookExecutor.execute("session_start", {
      event: "session_start",
      sessionId: session.id,
      metadata,
    }, session.cwd)
    this.state.patch({
      activeSessions: this.sessions.size,
      taskCount: this.tasks.list().length,
    })
    return session
  }

  async loadSession(sessionId: string): Promise<SessionRecord | null> {
    const existing = this.sessions.get(sessionId)
    if (existing) {
      return existing
    }

    const loaded = await this.backend.loadSession(sessionId)
    if (!loaded) {
      return null
    }
    this.sessions.set(loaded.id, loaded)
    return loaded
  }

  async getOrCreateSession(sessionId?: string, cwd = process.cwd()): Promise<SessionRecord> {
    if (!sessionId) {
      return this.createSession(cwd)
    }
    const loaded = await this.loadSession(sessionId)
    if (loaded) {
      return loaded
    }
    return this.createSession(cwd)
  }

  async runPrompt(
    sessionId: string,
    prompt: string,
    options: RunOptions = {},
  ): Promise<SessionRunResult> {
    const execution = await this.runPromptWithEvents(sessionId, prompt, options)
    return execution.result
  }

  async runPromptWithEvents(
    sessionId: string,
    prompt: string,
    options: RunOptions = {},
  ): Promise<{ result: SessionRunResult; events: QueryEvent[] }> {
    return this.withSessionLock(sessionId, async () => {
      const session = await this.loadSession(sessionId)
      if (!session) {
        throw new Error(`Unknown session: ${sessionId}`)
      }

      session.cwd = this.normalizeAndValidateCwd(session.cwd)
      const execution = await this.queryEngine.run(session, prompt, options)
      session.updatedAt = new Date().toISOString()
      await this.persistSession(session)
      this.state.patch({
        activeSessions: this.sessions.size,
        taskCount: this.tasks.list().length,
      })
      this.logger.debug?.(`[session] ${session.id} updated`)
      return execution
    })
  }

  async streamPromptWithEvents(
    sessionId: string,
    prompt: string,
    options: RunOptions = {},
  ): Promise<{
    events: AsyncIterable<QueryEvent>
    result: Promise<SessionRunResult>
  }> {
    const release = await this.acquireSessionLock(sessionId)
    try {
      const session = await this.loadSession(sessionId)
      if (!session) {
        release()
        throw new Error(`Unknown session: ${sessionId}`)
      }

      session.cwd = this.normalizeAndValidateCwd(session.cwd)
      const execution = this.queryEngine.stream(session, prompt, options)
      const result = execution.result.then(async result => {
        session.updatedAt = new Date().toISOString()
        await this.persistSession(session)
        this.state.patch({
          activeSessions: this.sessions.size,
          taskCount: this.tasks.list().length,
        })
        this.logger.debug?.(`[session] ${session.id} updated`)
        return result
      }).finally(() => {
        release()
      })

      return {
        events: execution.events,
        result,
      }
    } catch (error) {
      release()
      throw error
    }
  }

  async persistSession(session: SessionRecord): Promise<void> {
    await this.backend.saveSession(session)
  }

  async exportSessionMarkdown(sessionId: string): Promise<string> {
    const session = await this.loadSession(sessionId)
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`)
    }
    return this.backend.exportMarkdown(session)
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      await this.hookExecutor.execute("session_end", {
        event: "session_end",
        sessionId: session.id,
      }, session.cwd)
    }
  }
}
