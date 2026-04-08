import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { mkdirSync } from "node:fs"

export type TeamLifecycleStage =
  | "created"
  | "planned"
  | "running"
  | "reviewing"
  | "ready_to_merge"
  | "merged"
  | "blocked"
  | "failed"

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
  lifecycle: {
    stage: TeamLifecycleStage
    note?: string
    updatedAt: string
  }
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
      lifecycle: {
        stage: options.plan?.length ? "planned" : "created",
        updatedAt: now,
      },
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

  pruneStaleTaskIds(validTaskIds: Set<string>): number {
    let pruned = 0
    for (const team of this.teams.values()) {
      const before = team.tasks.length
      team.tasks = team.tasks.filter(id => validTaskIds.has(id))
      if (team.tasks.length < before) {
        pruned += before - team.tasks.length
        team.updatedAt = new Date().toISOString()
      }
    }
    if (pruned > 0) {
      this.persist()
      this.emit()
    }
    return pruned
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
    this.setLifecycle(team, plan.length > 0 ? "planned" : "created")
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
    this.setLifecycle(team, status === "approved" ? "ready_to_merge" : status === "changes_requested" ? "blocked" : "reviewing", note)
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
    this.setLifecycle(team, status === "merged" ? "merged" : status === "blocked" ? "blocked" : status === "ready" ? "ready_to_merge" : "reviewing", note)
    this.persist()
    this.emit()
    return team
  }

  setStatus(name: string, status: TeamRecord["status"]): TeamRecord {
    const team = this.require(name)
    if (team.status !== status) {
      team.status = status
      const stage = status === "running"
        ? "running"
        : status === "failed"
          ? "failed"
          : status === "cancelled"
            ? "blocked"
            : status === "completed"
              ? "reviewing"
              : team.lifecycle?.stage ?? "created"
      this.setLifecycle(team, stage)
      this.persist()
      this.emit()
    }
    return team
  }

  advance(name: string, note = ""): TeamRecord {
    const team = this.require(name)
    const current = team.lifecycle?.stage ?? "created"
    const next = (() => {
      if (current === "created") {
        return team.plan.length > 0 ? "planned" : "created"
      }
      if (current === "planned") {
        return "running"
      }
      if (current === "running") {
        return "reviewing"
      }
      if (current === "reviewing") {
        return team.review?.status === "approved" ? "ready_to_merge" : "reviewing"
      }
      if (current === "ready_to_merge") {
        return "merged"
      }
      return current
    })()
    this.setLifecycle(team, next, note)
    this.persist()
    this.emit()
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
      lifecycle: normalizeLifecycle(team),
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
            lifecycle: normalizeLifecycle(team),
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

  private setLifecycle(team: TeamRecord, stage: TeamLifecycleStage, note = ""): void {
    const updatedAt = new Date().toISOString()
    team.lifecycle = {
      stage,
      note: note || team.lifecycle?.note,
      updatedAt,
    }
    team.updatedAt = updatedAt
  }
}

function normalizeLifecycle(team: Partial<TeamRecord>): TeamRecord["lifecycle"] {
  if (team.lifecycle?.stage) {
    return {
      stage: team.lifecycle.stage,
      note: team.lifecycle.note,
      updatedAt: team.lifecycle.updatedAt ?? team.updatedAt ?? new Date().toISOString(),
    }
  }
  if (team.merge?.status === "merged") {
    return { stage: "merged", note: team.merge.note, updatedAt: team.merge.updatedAt }
  }
  if (team.merge?.status === "ready") {
    return { stage: "ready_to_merge", note: team.merge.note, updatedAt: team.merge.updatedAt }
  }
  if (team.review?.status === "approved") {
    return { stage: "ready_to_merge", note: team.review.note, updatedAt: team.review.updatedAt }
  }
  if (team.status === "running") {
    return { stage: "running", updatedAt: team.updatedAt ?? new Date().toISOString() }
  }
  if (team.plan?.length) {
    return { stage: "planned", updatedAt: team.updatedAt ?? new Date().toISOString() }
  }
  return { stage: "created", updatedAt: team.updatedAt ?? new Date().toISOString() }
}
