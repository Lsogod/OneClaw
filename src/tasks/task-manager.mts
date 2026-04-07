import { existsSync, readdirSync, readFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { randomId, ensureDir, appendText, readTextIfExists, writeJson } from "../utils.mts"
import type { TaskRecord, TaskStatus } from "../types.mts"

export type ManagedTaskContext = {
  taskId: string
  signal: AbortSignal
  log: (message: string) => Promise<void>
  setStatusNote: (note: string) => Promise<void>
  setMetadata: (key: string, value: string) => Promise<void>
}

type TaskSubscriber = (tasks: TaskRecord[]) => void

type TaskRunOptions = {
  cwd?: string
  description?: string
  parentTaskId?: string
  metadata?: Record<string, string>
}

type TaskManagerOptions = {
  storageDir?: string
}

export class TaskManager {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly outputs = new Map<string, string>()
  private readonly waiters = new Map<string, Promise<TaskRecord>>()
  private readonly subscribers = new Set<TaskSubscriber>()
  private readonly storageDir?: string

  constructor(options: TaskManagerOptions = {}) {
    this.storageDir = options.storageDir
    this.hydrateFromDisk()
  }

  list(status?: TaskStatus): TaskRecord[] {
    const records = [...this.tasks.values()]
    const filtered = status ? records.filter(record => record.status === status) : records
    return filtered.sort((left, right) =>
      right.startedAt.localeCompare(left.startedAt),
    )
  }

  get(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId)
  }

  async readOutput(taskId: string, maxChars = 12000): Promise<string> {
    const record = this.tasks.get(taskId)
    if (!record) {
      return ""
    }
    const raw = record.outputPath
      ? ((await readTextIfExists(record.outputPath)) ?? this.outputs.get(taskId) ?? "")
      : (this.outputs.get(taskId) ?? "")
    if (raw.length <= maxChars) {
      return raw
    }
    return raw.slice(-maxChars)
  }

  async stop(taskId: string): Promise<TaskRecord | undefined> {
    const record = this.tasks.get(taskId)
    if (!record) {
      return undefined
    }
    const controller = this.controllers.get(taskId)
    if (controller && !controller.signal.aborted) {
      controller.abort()
    }
    if (record.status === "running" || record.status === "pending") {
      record.status = "killed"
      record.endedAt = new Date().toISOString()
      await this.persist(record)
    }
    return record
  }

  async wait(taskId: string): Promise<TaskRecord | undefined> {
    const waiter = this.waiters.get(taskId)
    if (waiter) {
      return waiter
    }
    return this.tasks.get(taskId)
  }

  async clear(status: TaskStatus | "all" = "completed"): Promise<{ removed: string[] }> {
    const removed: string[] = []
    for (const [taskId, record] of this.tasks.entries()) {
      const matches = status === "all" ? true : record.status === status
      if (!matches || record.status === "running" || record.status === "pending") {
        continue
      }
      this.tasks.delete(taskId)
      this.controllers.delete(taskId)
      this.outputs.delete(taskId)
      if (record.outputPath) {
        await rm(record.outputPath, { force: true }).catch(() => undefined)
      }
      if (this.storageDir) {
        await rm(join(this.storageDir, `${taskId}.json`), { force: true }).catch(() => undefined)
      }
      removed.push(taskId)
    }
    if (removed.length > 0) {
      this.emit()
    }
    return { removed }
  }

  async start(
    label: string,
    work: (context: ManagedTaskContext) => Promise<string>,
    options: TaskRunOptions = {},
  ): Promise<TaskRecord> {
    const taskId = randomId("task")
    const controller = new AbortController()
    const outputPath = this.storageDir ? join(this.storageDir, `${taskId}.log`) : undefined
    const record: TaskRecord = {
      id: taskId,
      label,
      status: "running",
      startedAt: new Date().toISOString(),
      cwd: options.cwd,
      description: options.description ?? label,
      outputPath,
      parentTaskId: options.parentTaskId,
      metadata: { ...(options.metadata ?? {}) },
    }
    this.tasks.set(taskId, record)
    this.controllers.set(taskId, controller)
    this.outputs.set(taskId, "")
    await this.persist(record)

    const context: ManagedTaskContext = {
      taskId,
      signal: controller.signal,
      log: async message => {
        const rendered = message.endsWith("\n") ? message : `${message}\n`
        this.outputs.set(taskId, `${this.outputs.get(taskId) ?? ""}${rendered}`)
        if (!outputPath) {
          return
        }
        await ensureDir(this.storageDir!)
        await appendText(outputPath, rendered)
      },
      setStatusNote: async note => {
        record.metadata = {
          ...(record.metadata ?? {}),
          statusNote: note,
        }
        await this.persist(record)
      },
      setMetadata: async (key, value) => {
        record.metadata = {
          ...(record.metadata ?? {}),
          [key]: value,
        }
        await this.persist(record)
      },
    }

    const waiter = (async () => {
      try {
        record.result = await work(context)
        if (record.status !== "killed") {
          record.status = "completed"
        }
      } catch (error) {
        if (controller.signal.aborted) {
          record.status = "killed"
          record.error = String(error)
        } else {
          record.error = String(error)
          record.status = "failed"
        }
      } finally {
        record.endedAt = new Date().toISOString()
        this.controllers.delete(taskId)
        this.waiters.delete(taskId)
        await this.persist(record)
      }
      return record
    })()
    this.waiters.set(taskId, waiter)
    return record
  }

  async run(
    label: string,
    work: (context: ManagedTaskContext) => Promise<string>,
    options: TaskRunOptions = {},
  ): Promise<TaskRecord> {
    const record = await this.start(label, work, options)
    return (await this.wait(record.id)) as TaskRecord
  }

  subscribe(subscriber: TaskSubscriber): () => void {
    this.subscribers.add(subscriber)
    subscriber(this.list())
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  private async persist(record: TaskRecord): Promise<void> {
    if (!this.storageDir) {
      this.emit()
      return
    }
    await ensureDir(this.storageDir)
    await writeJson(join(this.storageDir, `${record.id}.json`), record)
    this.emit()
  }

  private hydrateFromDisk(): void {
    if (!this.storageDir || !existsSync(this.storageDir)) {
      return
    }
    for (const entry of readdirSync(this.storageDir)) {
      if (!entry.endsWith(".json")) {
        continue
      }
      try {
        const record = JSON.parse(readFileSync(join(this.storageDir, entry), "utf8")) as TaskRecord
        if (record.status === "running" || record.status === "pending") {
          record.status = "killed"
          record.endedAt = record.endedAt ?? new Date().toISOString()
          record.error = record.error ?? "Recovered from previous process shutdown"
        }
        this.tasks.set(record.id, record)
      } catch {
        // ignore malformed task records
      }
    }
    this.emit()
  }

  private emit(): void {
    const snapshot = this.list()
    for (const subscriber of this.subscribers) {
      subscriber(snapshot)
    }
  }
}
