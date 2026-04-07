import { describe, expect, test } from "bun:test"
import { createRuntime } from "../src/runtime/assembler.mts"
import type { Logger } from "../src/types.mts"
import { createTestConfig } from "./test-support.mts"

const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
}

describe("runtime bridge state", () => {
  test("keeps app state in sync with bridge session manager updates", async () => {
    const runtime = await createRuntime({
      config: createTestConfig(),
      logger: silentLogger,
    })

    try {
      expect(runtime.state.get().bridgeSessions).toBe(0)
      runtime.bridge.recordSession("bridge_session_1", process.cwd())
      expect(runtime.state.get().bridgeSessions).toBe(1)
      runtime.bridge.markRunning("bridge_session_1")
      expect(runtime.state.get().bridgeSessions).toBe(1)
      runtime.bridge.recordTurn("bridge_session_1", {
        prompt: "hi",
        output: "ok",
        ok: true,
      })
      expect(runtime.state.get().bridgeSessions).toBe(1)
    } finally {
      await runtime.shutdown()
    }
  })
})
