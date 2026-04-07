import { describe, expect, test } from "bun:test"
import { McpRegistry } from "../src/mcp/registry.mts"
import type { Logger, McpServerConfig } from "../src/types.mts"
import { createTestConfig } from "./test-support.mts"

const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
}

describe("McpRegistry", () => {
  test("keeps tools available when resource discovery degrades", async () => {
    const registry = new McpRegistry(silentLogger, {
      createTransport: () => ({
        close: async () => {},
      }),
      createClient: () => ({
        async connect() {},
        async listTools() {
          return {
            tools: [{
              name: "echo",
              description: "Echo tool",
              annotations: { readOnlyHint: true },
              inputSchema: { type: "object", properties: {} },
            }],
          }
        },
        async callTool() {
          return {
            content: [{ type: "text", text: "ok" }],
          }
        },
        async listResources() {
          throw new Error("resources disabled")
        },
      }),
    })

    const config: McpServerConfig = {
      name: "fake",
      transport: "stdio",
      command: "fake-server",
    }

    await registry.connect([config])

    const statuses = registry.listStatuses()
    const tools = await registry.toTools()

    expect(statuses[0].state).toBe("degraded")
    expect(statuses[0].detail).toContain("resources unavailable")
    expect(tools.length).toBe(1)
    const toolResult = await tools[0].execute({}, {
      cwd: process.cwd(),
      config: createTestConfig(),
      sessionId: "session",
      logger: silentLogger,
      memory: {
        read: async () => "",
        append: async () => {},
      },
      tasks: {
        list: () => [],
      },
    })
    expect(toolResult.ok).toBe(true)
    expect(toolResult.output).toContain("ok")
  })
})
