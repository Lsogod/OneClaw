import { describe, expect, test } from "bun:test"
import { QueryEngine } from "../src/runtime/query-engine.mts"
import { TaskManager } from "../src/tasks/task-manager.mts"
import type {
  ProviderAdapter,
  ProviderTurnInput,
  ProviderTurnOutput,
  SessionRecord,
  ToolImplementation,
} from "../src/types.mts"
import { MemoryManager } from "../src/memory/manager.mts"
import { createTestConfig, createTestQueryLoop } from "./test-support.mts"

class EventProvider implements ProviderAdapter {
  name = "event-provider"

  async generateTurn(input: ProviderTurnInput): Promise<ProviderTurnOutput> {
    const lastMessage = input.messages.at(-1)
    const hasToolResult = lastMessage?.content.some(block => block.type === "tool_result")
    if (hasToolResult) {
      return {
        content: [{ type: "text", text: "done" }],
        stopReason: "end_turn",
        usage: {
          inputTokens: 10,
          outputTokens: 20,
        },
      }
    }
    return {
      content: [{
        type: "tool_call",
        id: "tool_1",
        name: "echo_tool",
        input: {},
      }],
      stopReason: "tool_use",
      usage: {
        inputTokens: 5,
        outputTokens: 5,
      },
    }
  }
}

describe("QueryEngine", () => {
  test("collects query lifecycle events", async () => {
    const config = createTestConfig()
    const tool: ToolImplementation = {
      spec: {
        name: "echo_tool",
        description: "Echo",
        inputSchema: {},
      },
      async execute() {
        return {
          ok: true,
          output: "ok",
        }
      },
    }
    const loop = createTestQueryLoop(config, new EventProvider(), [tool])
    const engine = new QueryEngine(loop, new MemoryManager(config), new TaskManager())
    const session: SessionRecord = {
      id: "session_events",
      cwd: process.cwd(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    }

    const execution = await engine.run(session, "do work")
    const eventTypes = execution.events.map(event => event.type)

    expect(execution.result.text).toBe("done")
    expect(eventTypes).toContain("user_prompt")
    expect(eventTypes).toContain("model_request")
    expect(eventTypes).toContain("tool_started")
    expect(eventTypes).toContain("tool_finished")
    expect(eventTypes.at(-1)).toBe("completed")
  })

  test("streams query lifecycle events as they happen", async () => {
    const config = createTestConfig()
    const tool: ToolImplementation = {
      spec: {
        name: "echo_tool",
        description: "Echo",
        inputSchema: {},
      },
      async execute() {
        return {
          ok: true,
          output: "ok",
        }
      },
    }
    const loop = createTestQueryLoop(config, new EventProvider(), [tool])
    const engine = new QueryEngine(loop, new MemoryManager(config), new TaskManager())
    const session: SessionRecord = {
      id: "session_stream",
      cwd: process.cwd(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    }

    const execution = engine.stream(session, "do work")
    const eventTypes: string[] = []
    const consume = (async () => {
      for await (const event of execution.events) {
        eventTypes.push(event.type)
      }
    })()
    const result = await execution.result
    await consume

    expect(result.text).toBe("done")
    expect(eventTypes).toContain("user_prompt")
    expect(eventTypes).toContain("tool_started")
    expect(eventTypes.at(-1)).toBe("completed")
  })
})
