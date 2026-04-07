import { describe, expect, test } from "bun:test"
import { FileMemoryStore } from "../src/memory/store.mts"
import { createTestConfig } from "./test-support.mts"

describe("FileMemoryStore", () => {
  test("appends and reads memory", async () => {
    const config = createTestConfig()
    const memory = new FileMemoryStore(config, "session_test")
    await memory.append("hello")
    await memory.append("world")
    const content = await memory.read()
    expect(content.includes("hello")).toBe(true)
    expect(content.includes("world")).toBe(true)
  })
})
