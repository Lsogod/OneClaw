import { describe, expect, test } from "bun:test"
import { FileMemoryStore } from "../src/memory/store.mts"
import { TaskManager } from "../src/tasks/task-manager.mts"
import type {
  ProviderAdapter,
  ProviderTurnInput,
  ProviderTurnOutput,
  SessionRecord,
  ToolImplementation,
} from "../src/types.mts"
import { createTestConfig, createTestQueryLoop } from "./test-support.mts"

class FakeProvider implements ProviderAdapter {
  name = "fake"

  async generateTurn(input: ProviderTurnInput): Promise<ProviderTurnOutput> {
    const lastMessage = input.messages.at(-1)
    const hasToolResult = lastMessage?.content.some(block => block.type === "tool_result")
    if (hasToolResult) {
      return {
        content: [{
          type: "text",
          text: "Final answer after tool execution.",
        }],
        stopReason: "end_turn",
      }
    }

    return {
      content: [{
        type: "tool_call",
        id: "tool_1",
        name: "echo_tool",
        input: { value: "hello" },
      }],
      stopReason: "tool_use",
    }
  }
}

class MultiToolProvider implements ProviderAdapter {
  name = "multi-tool"

  async generateTurn(input: ProviderTurnInput): Promise<ProviderTurnOutput> {
    const lastMessage = input.messages.at(-1)
    const toolResultCount = lastMessage?.content.filter(block => block.type === "tool_result").length ?? 0
    if (toolResultCount >= 2) {
      return {
        content: [{
          type: "text",
          text: "Both tool calls completed.",
        }],
        stopReason: "end_turn",
      }
    }

    return {
      content: [
        {
          type: "tool_call",
          id: "tool_1",
          name: "echo_tool",
          input: { value: "first" },
        },
        {
          type: "tool_call",
          id: "tool_2",
          name: "echo_tool",
          input: { value: "second" },
        },
      ],
      stopReason: "tool_use",
    }
  }
}

describe("QueryLoop", () => {
  test("executes tool calls and returns final text", async () => {
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
          output: "hello",
        }
      },
    }

    const queryLoop = createTestQueryLoop(config, new FakeProvider(), [tool])

    const session: SessionRecord = {
      id: "session_1",
      cwd: process.cwd(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    }
    const memory = new FileMemoryStore(config, session.id)
    const result = await queryLoop.run(session, "do the thing", memory, new TaskManager())
    expect(result.text).toBe("Final answer after tool execution.")
    expect(session.messages.some(message =>
      message.content.some(block => block.type === "tool_result"),
    )).toBe(true)
  })

  test("executes tool calls sequentially within a turn", async () => {
    const config = createTestConfig()

    let activeExecutions = 0
    let maxConcurrentExecutions = 0
    const tool: ToolImplementation = {
      spec: {
        name: "echo_tool",
        description: "Echo",
        inputSchema: {},
      },
      async execute() {
        activeExecutions += 1
        maxConcurrentExecutions = Math.max(maxConcurrentExecutions, activeExecutions)
        await new Promise(resolve => setTimeout(resolve, 20))
        activeExecutions -= 1
        return {
          ok: true,
          output: "hello",
        }
      },
    }

    const queryLoop = createTestQueryLoop(config, new MultiToolProvider(), [tool])

    const session: SessionRecord = {
      id: "session_2",
      cwd: process.cwd(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
    }
    const memory = new FileMemoryStore(config, session.id)
    const result = await queryLoop.run(session, "do the thing", memory, new TaskManager())

    expect(result.text).toBe("Both tool calls completed.")
    expect(maxConcurrentExecutions).toBe(1)
  })
})
