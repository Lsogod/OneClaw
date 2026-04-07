import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { createSessionBackend } from "../src/session/backend.mts"
import type { SessionRecord } from "../src/types.mts"
import { createTestConfig } from "./test-support.mts"

function sampleSession(id: string, updatedAt: string): SessionRecord {
  return {
    id,
    cwd: "/tmp/workspace",
    createdAt: "2026-04-07T00:00:00Z",
    updatedAt,
    messages: [
      {
        role: "user",
        createdAt: "2026-04-07T00:00:00Z",
        content: [{ type: "text", text: `hello from ${id}` }],
      },
    ],
  }
}

describe("FileSessionBackend", () => {
  test("loads the latest session and deletes persisted sessions", async () => {
    const config = createTestConfig()
    const backend = createSessionBackend(config)
    const older = sampleSession("session_old", "2026-04-07T00:00:00Z")
    const latest = sampleSession("session_latest", "2026-04-07T01:00:00Z")

    await backend.saveSession(older)
    await backend.saveSession(latest)

    const loadedLatest = await backend.loadLatestSession()
    const removed = await backend.deleteSession("session_old")
    const deletedSession = await backend.loadSession("session_old")
    const remaining = await backend.listSessions()

    expect(loadedLatest?.id).toBe("session_latest")
    expect(removed).toBe(true)
    expect(deletedSession).toBe(null)
    expect(remaining.map(session => session.id)).toEqual(["session_latest"])
  })

  test("exports session snapshots as markdown and json artifacts", async () => {
    const config = createTestConfig()
    const backend = createSessionBackend(config)
    const session = sampleSession("session_export", "2026-04-07T02:00:00Z")

    await backend.saveSession(session)
    const jsonPath = await backend.exportJson(session)
    const markdownPath = await backend.exportMarkdown(session)
    const jsonBody = await readFile(jsonPath, "utf8")
    const markdownBody = await readFile(markdownPath, "utf8")

    expect(jsonBody).toContain("\"id\": \"session_export\"")
    expect(markdownBody).toContain("# Session session_export")
    expect(markdownBody).toContain("hello from session_export")
  })
})
