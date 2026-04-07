import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { mkdirSync } from "node:fs"

export type TeamRecord = {
  name: string
  description: string
  goal?: string
  plan: string[]
  roles: Record<string, string>
  worktrees: Record<string, string>
  review?: {
    status: "pending" | "approved" | "changes_requested"
    note: string
    updatedAt: string
  }
  merge?: {
    status: "pending" | "ready" | "merged" | "blocked"
    note: string
    updatedAt: string
  }
  status: "idle" | "running" | "completed" | "failed" | "cancelled"
  createdAt: string
  updatedAt: string
  agents: string[]
  tasks: string[]
  messages: string[]
}

type TeamSubscriber = (teams: TeamRecord[]) => void

export class TeamRegistry {
  private readonly teams = new Map<string, TeamRecord>()
  private readonly storagePath?: string
  private readonly subscribers = new Set<TeamSubscriber>()

  constructor(storagePath?: string) {
    this.storagePath = storagePath
    this.hydrate()
  }

  list(): TeamRecord[] {
    return [...this.teams.values()].sort((left, right) => left.name.localeCompare(right.name))
  }

  get(name: string): TeamRecord | null {
    return this.teams.get(name) ?? null
  }

  create(name: string, description = "", options: { goal?: string; plan?: string[] } = {}): TeamRecord {
    if (this.teams.has(name)) {
      throw new Error(`Team '${name}' already exists`)
    }
    const now = new Date().toISOString()
    const team: TeamRecord = {
      name,
      description,
      goal: options.goal,
      plan: [...(options.plan ?? [])],
      roles: {},
      worktrees: {},
      status: "idle",
      createdAt: now,
      updatedAt: now,
      agents: [],
      tasks: [],
      messages: [],
    }
    this.teams.set(name, team)
    this.persist()
    this.emit()
    return team
  }

  delete(name: string): boolean {
    const deleted = this.teams.delete(name)
    if (deleted) {
      this.persist()
      this.emit()
    }
    return deleted
  }

  addAgent(name: string, sessionId: string): TeamRecord {
    const team = this.require(name)
    if (!team.agents.includes(sessionId)) {
      team.agents.push(sessionId)
      team.updatedAt = new Date().toISOString()
      this.persist()
      this.emit()
    }
    return team
  }

  setRole(name: string, agentId: string, role: string): TeamRecord {
    const team = this.require(name)
    team.roles[agentId] = role
    team.updatedAt = new Date().toISOString()
    this.persist()
    this.emit()
    return team
  }

  setWorktree(name: string, agentId: string, path: string): TeamRecord {
    const team = this.require(name)
    team.worktrees[agentId] = path
    team.updatedAt = new Date().toISOString()
    this.persist()
    this.emit()
    return team
  }

  addTask(name: string, taskId: string): TeamRecord {
    const team = this.require(name)
    if (!team.tasks.includes(taskId)) {
      team.tasks.push(taskId)
      team.updatedAt = new Date().toISOString()
      this.persist()
      this.emit()
    }
    return team
  }

  setGoal(name: string, goal: string): TeamRecord {
    const team = this.require(name)
    team.goal = goal
    team.updatedAt = new Date().toISOString()
    this.persist()
    this.emit()
    return team
  }

  setPlan(name: string, plan: string[]): TeamRecord {
    const team = this.require(name)
    team.plan = [...plan]
    team.updatedAt = new Date().toISOString()
    this.persist()
    this.emit()
    return team
  }

  setReview(name: string, status: NonNullable<TeamRecord["review"]>["status"], note = ""): TeamRecord {
    const team = this.require(name)
    team.review = {
      status,
      note,
      updatedAt: new Date().toISOString(),
    }
    team.updatedAt = team.review.updatedAt
    this.persist()
    this.emit()
    return team
  }

  setMerge(name: string, status: NonNullable<TeamRecord["merge"]>["status"], note = ""): TeamRecord {
    const team = this.require(name)
    team.merge = {
      status,
      note,
      updatedAt: new Date().toISOString(),
    }
    team.updatedAt = team.merge.updatedAt
    this.persist()
    this.emit()
    return team
  }

  setStatus(name: string, status: TeamRecord["status"]): TeamRecord {
    const team = this.require(name)
    if (team.status !== status) {
      team.status = status
      team.updatedAt = new Date().toISOString()
      this.persist()
      this.emit()
    }
    return team
  }

  sendMessage(name: string, message: string): TeamRecord {
    const team = this.require(name)
    team.messages.push(message)
    team.updatedAt = new Date().toISOString()
    this.persist()
    this.emit()
    return team
  }

  replace(team: TeamRecord): TeamRecord {
    this.teams.set(team.name, {
      ...team,
      status: team.status ?? "idle",
      createdAt: team.createdAt ?? new Date().toISOString(),
      updatedAt: team.updatedAt ?? new Date().toISOString(),
      plan: [...(team.plan ?? [])],
      roles: { ...(team.roles ?? {}) },
      worktrees: { ...(team.worktrees ?? {}) },
      review: team.review,
      merge: team.merge,
      tasks: [...(team.tasks ?? [])],
      agents: [...(team.agents ?? [])],
      messages: [...(team.messages ?? [])],
    })
    this.persist()
    this.emit()
    return this.require(team.name)
  }

  subscribe(subscriber: TeamSubscriber): () => void {
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
      const parsed = JSON.parse(readFileSync(this.storagePath, "utf8")) as TeamRecord[]
      for (const team of parsed) {
        if (team?.name) {
          this.teams.set(team.name, {
            name: team.name,
            description: team.description ?? "",
            goal: team.goal,
            plan: [...(team.plan ?? [])],
            roles: { ...(team.roles ?? {}) },
            worktrees: { ...(team.worktrees ?? {}) },
            review: team.review,
            merge: team.merge,
            status: team.status ?? "idle",
            createdAt: team.createdAt ?? new Date().toISOString(),
            updatedAt: team.updatedAt ?? new Date().toISOString(),
            agents: [...(team.agents ?? [])],
            tasks: [...(team.tasks ?? [])],
            messages: [...(team.messages ?? [])],
          })
        }
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

  private emit(): void {
    const snapshot = this.list()
    for (const subscriber of this.subscribers) {
      subscriber(snapshot)
    }
  }

  private require(name: string): TeamRecord {
    const team = this.teams.get(name)
    if (!team) {
      throw new Error(`Team '${name}' does not exist`)
    }
    return team
  }
}
