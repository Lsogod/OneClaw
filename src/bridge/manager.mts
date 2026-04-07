import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export type BridgeSessionRecord = {
  sessionId: string
  cwd: string
  startedAt: string
  updatedAt: string
  taskId?: string
  team?: string
  turnCount: number
  lastPrompt?: string
  lastOutput?: string
  activeRequestId?: string
  history: Array<{
    at: string
    prompt: string
    output: string
    ok: boolean
  }>
  status: "idle" | "running" | "completed" | "failed" | "cancelled" | "interrupted"
}

type BridgeSubscriber = (sessions: BridgeSessionRecord[]) => void

export class BridgeSessionManager {
  private readonly sessions = new Map<string, BridgeSessionRecord>()
  private readonly requestToSession = new Map<string, string>()
  private readonly subscribers = new Set<BridgeSubscriber>()
  private readonly storagePath?: string

  constructor(storagePath?: string) {
    this.storagePath = storagePath
    this.hydrate()
  }

  private emit(): void {
    this.persist()
    const snapshot = this.list()
    for (const subscriber of this.subscribers) {
      subscriber(snapshot)
    }
  }

  recordSession(sessionId: string, cwd: string, metadata: {
    taskId?: string
    team?: string
  } = {}): void {
    const now = new Date().toISOString()
    this.sessions.set(sessionId, {
      sessionId,
      cwd,
      startedAt: now,
      updatedAt: now,
      taskId: metadata.taskId,
      team: metadata.team,
      turnCount: 0,
      history: [],
      status: "idle",
    })
    this.emit()
  }

  recordTurn(sessionId: string, payload: {
    prompt: string
    output: string
    ok: boolean
  }): void {
    const existing = this.sessions.get(sessionId)
    if (!existing) {
      return
    }
    this.sessions.set(sessionId, {
      ...existing,
      updatedAt: new Date().toISOString(),
      turnCount: existing.turnCount + 1,
      lastPrompt: payload.prompt,
      lastOutput: payload.output,
      activeRequestId: undefined,
      history: [
        ...existing.history,
        {
          at: new Date().toISOString(),
          prompt: payload.prompt,
          output: payload.output,
          ok: payload.ok,
        },
      ].slice(-50),
      status: payload.ok ? "completed" : "failed",
    })
    this.emit()
  }

  markRunning(sessionId: string, requestId?: string): void {
    const existing = this.sessions.get(sessionId)
    if (!existing) {
      return
    }
    if (requestId) {
      this.requestToSession.set(requestId, sessionId)
    }
    this.sessions.set(sessionId, {
      ...existing,
      updatedAt: new Date().toISOString(),
      activeRequestId: requestId ?? existing.activeRequestId,
      status: "running",
    })
    this.emit()
  }

  markCancelled(sessionId: string): void {
    const existing = this.sessions.get(sessionId)
    if (!existing) {
      return
    }
    this.sessions.set(sessionId, {
      ...existing,
      updatedAt: new Date().toISOString(),
      activeRequestId: undefined,
      status: "cancelled",
    })
    this.emit()
  }

  markInterrupted(sessionId: string): void {
    const existing = this.sessions.get(sessionId)
    if (!existing) {
      return
    }
    this.sessions.set(sessionId, {
      ...existing,
      updatedAt: new Date().toISOString(),
      activeRequestId: undefined,
      status: "interrupted",
    })
    this.emit()
  }

  get(sessionId: string): BridgeSessionRecord | null {
    return this.sessions.get(sessionId) ?? null
  }

  findByTaskId(taskId: string): BridgeSessionRecord | null {
    for (const session of this.sessions.values()) {
      if (session.taskId === taskId) {
        return session
      }
    }
    return null
  }

  findByRequestId(requestId: string): BridgeSessionRecord | null {
    const indexedSessionId = this.requestToSession.get(requestId)
    if (indexedSessionId) {
      return this.sessions.get(indexedSessionId) ?? null
    }
    for (const session of this.sessions.values()) {
      if (session.activeRequestId === requestId) {
        return session
      }
    }
    return null
  }

  list(): BridgeSessionRecord[] {
    return [...this.sessions.values()].sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    )
  }

  listByTeam(team: string): BridgeSessionRecord[] {
    return this.list().filter(session => session.team === team)
  }

  listActiveRequests(): Array<{
    requestId: string
    sessionId: string
    cwd: string
    updatedAt: string
    status: BridgeSessionRecord["status"]
  }> {
    return this.list()
      .filter(session => typeof session.activeRequestId === "string" && session.activeRequestId.length > 0)
      .map(session => ({
        requestId: session.activeRequestId as string,
        sessionId: session.sessionId,
        cwd: session.cwd,
        updatedAt: session.updatedAt,
        status: session.status,
      }))
  }

  subscribe(subscriber: BridgeSubscriber): () => void {
    this.subscribers.add(subscriber)
    subscriber(this.list())
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  private hydrate(): void {
    if (!this.storagePath || !existsSync(this.storagePath)) {
      return
    }
    try {
      const parsed = JSON.parse(readFileSync(this.storagePath, "utf8")) as BridgeSessionRecord[]
      for (const session of parsed) {
        if (!session?.sessionId || !session?.cwd) {
          continue
        }
        const normalized: BridgeSessionRecord = {
          ...session,
          history: [...(session.history ?? [])],
          turnCount: typeof session.turnCount === "number" ? session.turnCount : 0,
          status: session.status === "running" ? "interrupted" : session.status,
          activeRequestId: undefined,
        }
        this.sessions.set(normalized.sessionId, normalized)
      }
    } catch {
      // ignore malformed persisted state
    }
  }

  private persist(): void {
    if (!this.storagePath) {
      return
    }
    mkdirSync(dirname(this.storagePath), { recursive: true })
    writeFileSync(
      this.storagePath,
      JSON.stringify(this.list(), null, 2),
      "utf8",
    )
  }
}
