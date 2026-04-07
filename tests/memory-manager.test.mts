import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { MemoryManager } from "../src/memory/manager.mts"
import { createTestConfig } from "./test-support.mts"

describe("MemoryManager", () => {
  test("builds prompt sections from session, project, and global memory", async () => {
    const config = createTestConfig()
    const memory = new MemoryManager(config)
    const sessionId = "session_memory"
    await memory.append("session", "session note", {
      cwd: process.cwd(),
      sessionId,
    })
    await memory.append("project", "project note", {
      cwd: process.cwd(),
      sessionId,
    })
    await memory.append("global", "global note", {
      cwd: process.cwd(),
      sessionId,
    })

    const sections = await memory.buildPromptSections({
      cwd: process.cwd(),
      sessionId,
    })

    expect(sections.join("\n")).toContain("Session Memory")
    expect(sections.join("\n")).toContain("Project Memory")
    expect(sections.join("\n")).toContain("Global Memory")
  })

  test("manages project and global memory entries with search support", async () => {
    const config = createTestConfig()
    const memory = new MemoryManager(config)
    const cwd = process.cwd()

    const projectEntry = await memory.addEntry(
      "project",
      "Architecture",
      "Capture project decisions",
      cwd,
    )
    const globalEntry = await memory.addEntry(
      "global",
      "Shell Tips",
      "Use rg before grep",
      cwd,
    )

    const projectEntries = await memory.listEntries("project", cwd)
    const globalEntries = await memory.listEntries("global", cwd)
    const search = await memory.searchEntries("project decisions", {
      cwd,
      sessionId: "session_memory",
    })
    const projectIndex = await readFile(join(cwd, ".oneclaw", "MEMORY.md"), "utf8")
    const globalIndex = await readFile(join(config.homeDir, "memory", "MEMORY.md"), "utf8")
    const removedProject = await memory.removeEntry("project", projectEntry.name, cwd)
    const removedGlobal = await memory.removeEntry("global", globalEntry.title, cwd)
    const afterProjectEntries = await memory.listEntries("project", cwd)
    const afterGlobalEntries = await memory.listEntries("global", cwd)

    expect(projectEntries.map(entry => entry.name)).toContain(projectEntry.name)
    expect(globalEntries.map(entry => entry.name)).toContain(globalEntry.name)
    expect(search.map(entry => entry.title)).toContain("Architecture")
    expect(projectIndex).toContain("[Architecture](memory/architecture.md)")
    expect(globalIndex).toContain("[Shell Tips](memory/shell-tips.md)")
    expect(removedProject).toBe(true)
    expect(removedGlobal).toBe(true)
    expect(afterProjectEntries.some(entry => entry.name === projectEntry.name)).toBe(false)
    expect(afterGlobalEntries.some(entry => entry.name === globalEntry.name)).toBe(false)
  })
})
