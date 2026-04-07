import { describe, expect, test } from "bun:test"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { TaskManager } from "../src/tasks/task-manager.mts"
import { createTestConfig } from "./test-support.mts"

describe("TaskManager", () => {
  test("captures task logs, metadata, and persists artifacts when configured", async () => {
    const config = createTestConfig()
    const manager = new TaskManager({
      storageDir: join(config.homeDir, "tasks"),
    })

    const record = await manager.run("Collect context", async task => {
      await task.log("step: scan files")
      await task.setStatusNote("indexing")
      await task.setMetadata("sessionId", "session_123")
      return "done"
    }, {
      cwd: "/tmp/workspace",
      description: "Collect relevant repository context",
    })

    const output = await manager.readOutput(record.id)
    const persisted = await readFile(join(config.homeDir, "tasks", `${record.id}.json`), "utf8")

    expect(record.status).toBe("completed")
    expect(record.metadata?.statusNote).toBe("indexing")
    expect(record.metadata?.sessionId).toBe("session_123")
    expect(output).toContain("step: scan files")
    expect(persisted).toContain("\"label\": \"Collect context\"")
  })

  test("supports cancellation and clearing killed task records", async () => {
    const manager = new TaskManager()
    const running = manager.run("Long task", async task => {
      await task.log("waiting")
      await new Promise<string>((_, reject) => {
        task.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })
      })
      return "never"
    })

    await new Promise(resolve => setTimeout(resolve, 20))
    const activeTask = manager.list()[0]
    const stopped = await manager.stop(activeTask.id)
    const record = await running
    const output = await manager.readOutput(activeTask.id)
    const cleared = await manager.clear("killed")

    expect(stopped?.status).toBe("killed")
    expect(record.status).toBe("killed")
    expect(output).toContain("waiting")
    expect(cleared.removed).toEqual([activeTask.id])
    expect(manager.get(activeTask.id)).toBe(undefined)
  })

  test("hydrates persisted task records from the storage directory", async () => {
    const config = createTestConfig()
    const storageDir = join(config.homeDir, "tasks")
    const first = new TaskManager({ storageDir })
    const record = await first.run("Persist me", async task => {
      await task.log("hello persisted world")
      return "done"
    })

    const reloaded = new TaskManager({ storageDir })
    const restored = reloaded.get(record.id)
    const output = await reloaded.readOutput(record.id)

    expect(restored?.label).toBe("Persist me")
    expect(restored?.status).toBe("completed")
    expect(output).toContain("hello persisted world")
  })

  test("marks recovered running tasks as killed after process restart", async () => {
    const config = createTestConfig()
    const storageDir = join(config.homeDir, "tasks")
    await mkdir(storageDir, { recursive: true })
    await writeFile(join(storageDir, "task_recovered.json"), JSON.stringify({
      id: "task_recovered",
      label: "Recovered task",
      status: "running",
      startedAt: new Date().toISOString(),
    }, null, 2))

    const manager = new TaskManager({ storageDir })
    const record = manager.get("task_recovered")

    expect(record?.status).toBe("killed")
    expect(typeof record?.endedAt).toBe("string")
    expect(record?.error).toContain("Recovered from previous process shutdown")
  })
})
