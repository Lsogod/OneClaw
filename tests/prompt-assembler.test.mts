import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { MemoryManager } from "../src/memory/manager.mts"
import { PluginRegistry } from "../src/plugins/registry.mts"
import { PromptAssembler } from "../src/prompts/assembler.mts"
import { SkillRegistry } from "../src/skills/registry.mts"
import type { SessionRecord } from "../src/types.mts"
import { createTestConfig } from "./test-support.mts"

describe("PromptAssembler", () => {
  test("keeps composed prompt within the configured context budget", async () => {
    const root = join(tmpdir(), `oneclaw-prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const skillDir = join(root, "skills")
    await mkdir(skillDir, { recursive: true })
    await writeFile(join(skillDir, "review.md"), `---
name: review
---
${"review-guidance ".repeat(400)}`)

    const config = createTestConfig({
      skillDirs: [skillDir],
      context: {
        maxChars: 900,
        keepMessages: 4,
      },
    })
    const memory = new MemoryManager(config)
    const skills = new SkillRegistry()
    await skills.load(config.skillDirs)
    const plugins = new PluginRegistry()
    plugins.plugins.push({
      name: "prompt-patch",
      systemPromptPatches: ["plugin-guidance ".repeat(200)],
    })

    const session: SessionRecord = {
      id: "session_prompt",
      cwd: process.cwd(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `message-${index} ${"context ".repeat(80)}` }],
        createdAt: new Date().toISOString(),
      })),
    }

    await memory.append("global", "global ".repeat(500), {
      cwd: session.cwd,
      sessionId: session.id,
    })
    await memory.append("project", "project ".repeat(500), {
      cwd: session.cwd,
      sessionId: session.id,
    })
    await memory.append("session", "session ".repeat(500), {
      cwd: session.cwd,
      sessionId: session.id,
    })

    const assembler = new PromptAssembler(config, memory, skills, plugins)
    const prompt = await assembler.build(session, "Please use $review")

    expect(prompt.length <= config.context.maxChars).toBe(true)
    expect(prompt).toContain("## Environment")
    expect(prompt).toContain("## Recent Context")
  })
})
