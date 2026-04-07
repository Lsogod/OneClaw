import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { PluginRegistry } from "../src/plugins/registry.mts"

describe("PluginRegistry", () => {
  test("loads manifest plugins once without duplicating their main module", async () => {
    const root = join(tmpdir(), `oneclaw-plugins-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const pluginRoot = join(root, "sample-plugin")
    const skillsDir = join(pluginRoot, "skills")

    await mkdir(skillsDir, { recursive: true })
    await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify({
      name: "sample-plugin",
      main: "main.mjs",
      skillsDir: "skills",
      systemPromptPatches: ["manifest-patch"],
    }, null, 2))
    await writeFile(join(pluginRoot, "main.mjs"), `
      export default {
        name: "sample-plugin",
        tools: [{
          spec: {
            name: "sample_tool",
            description: "Sample tool",
            inputSchema: { type: "object", properties: {} },
            source: "plugin",
          },
          async execute() {
            return { ok: true, output: "ok" }
          },
        }],
        hookDefinitions: [{
          name: "sample-hook",
          event: "before_tool",
          type: "command",
          command: "echo sample",
        }],
        systemPromptPatches: ["module-patch"],
      }
    `)
    await writeFile(join(skillsDir, "note.md"), "# Skill Patch\nFrom skills directory.")

    const registry = new PluginRegistry()
    await registry.load([root])

    expect(registry.plugins.length).toBe(1)
    expect(registry.getTools().length).toBe(1)
    expect(registry.getHookDefinitions().length).toBe(1)
    expect(registry.getSystemPromptPatches()).toEqual([
      "manifest-patch",
      "module-patch",
      "# Skill Patch\nFrom skills directory.",
    ])
  })
})
