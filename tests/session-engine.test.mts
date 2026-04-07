import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { TaskManager } from "../src/tasks/task-manager.mts"
import type {
  Logger,
  SessionRecord,
  SessionRunResult,
} from "../src/types.mts"
import { QueryEngine } from "../src/runtime/query-engine.mts"
import { createTestConfig, createTestHookExecutor, createTestState } from "./test-support.mts"
import { createSessionBackend } from "../src/session/backend.mts"

describe("SessionEngine", () => {
  test("rejects session cwd outside writable roots", async () => {
    const config = createTestConfig()
    const { SessionEngine } = await import("../src/runtime/session-engine.mts")
    const engine = new SessionEngine(
      config,
      {
        run: async () => {
          throw new Error("not used")
        },
      } as unknown as QueryEngine,
      new TaskManager(),
      console as Logger,
      createSessionBackend(config),
      createTestHookExecutor(config),
      createTestState(config),
    )

    let error: Error | null = null
    try {
      await engine.createSession(tmpdir())
    } catch (caught) {
      error = caught as Error
    }

    expect(error?.message).toContain("outside writable roots")
  })

  test("serializes concurrent prompts for the same session", async () => {
    const config = createTestConfig()
    let activeRuns = 0
    let maxConcurrentRuns = 0
    const { SessionEngine } = await import("../src/runtime/session-engine.mts")
    const engine = new SessionEngine(
      config,
      {
        run: async (
          session: SessionRecord,
          prompt: string,
        ): Promise<{ result: SessionRunResult; events: [] }> => {
          activeRuns += 1
          maxConcurrentRuns = Math.max(maxConcurrentRuns, activeRuns)
          await new Promise(resolve => setTimeout(resolve, 25))
          session.messages.push({
            role: "assistant",
            content: [{ type: "text", text: prompt }],
            createdAt: new Date().toISOString(),
          })
          activeRuns -= 1
          return {
            result: {
              sessionId: session.id,
              text: prompt,
              iterations: 1,
              stopReason: "end_turn",
            },
            events: [],
          }
        },
      } as unknown as QueryEngine,
      new TaskManager(),
      console as Logger,
      createSessionBackend(config),
      createTestHookExecutor(config),
      createTestState(config),
    )

    const session = await engine.createSession(process.cwd())
    const [first, second] = await Promise.all([
      engine.runPrompt(session.id, "first"),
      engine.runPrompt(session.id, "second"),
    ])

    expect(first.text).toBe("first")
    expect(second.text).toBe("second")
    expect(maxConcurrentRuns).toBe(1)
  })

  test("streams session prompt events while preserving the session lock", async () => {
    const config = createTestConfig()
    const { SessionEngine } = await import("../src/runtime/session-engine.mts")
    const engine = new SessionEngine(
      config,
      {
        stream: (session: SessionRecord, prompt: string) => {
          const events: Array<{ type: string; sessionId: string; prompt?: string; result?: SessionRunResult }> = [{
            type: "user_prompt",
            sessionId: session.id,
            prompt,
          }]
          return {
            events: {
              async *[Symbol.asyncIterator]() {
                for (const event of events) {
                  yield event
                }
              },
            },
            result: Promise.resolve({
              sessionId: session.id,
              text: prompt,
              iterations: 1,
              stopReason: "end_turn",
            }),
          }
        },
      } as unknown as QueryEngine,
      new TaskManager(),
      console as Logger,
      createSessionBackend(config),
      createTestHookExecutor(config),
      createTestState(config),
    )

    const session = await engine.createSession(process.cwd())
    const execution = await engine.streamPromptWithEvents(session.id, "streamed")
    const seen: string[] = []
    for await (const event of execution.events) {
      seen.push(event.type)
    }
    const result = await execution.result

    expect(result.text).toBe("streamed")
    expect(seen).toEqual(["user_prompt"])
  })
})
