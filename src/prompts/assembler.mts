import { basename } from "node:path"
import { type OneClawConfig, type SessionRecord } from "../types.mts"
import { MemoryManager } from "../memory/manager.mts"
import { PluginRegistry } from "../plugins/registry.mts"
import { SkillRegistry } from "../skills/registry.mts"
import { formatSessionSummary, limitText } from "../utils.mts"

function environmentSection(config: OneClawConfig, cwd: string): string {
  return [
    "## Environment",
    `- cwd: ${cwd}`,
    `- workspace: ${basename(cwd) || cwd}`,
    `- provider_profile: ${config.activeProfile}`,
    `- provider_kind: ${config.provider.kind}`,
    `- model: ${config.provider.model}`,
    `- output_style: ${config.output.style}`,
    `- theme: ${config.output.theme}`,
    `- date: ${new Date().toISOString()}`,
  ].join("\n")
}

export class PromptAssembler {
  constructor(
    private readonly config: OneClawConfig,
    private readonly memory: MemoryManager,
    private readonly skills: SkillRegistry,
    private readonly plugins: PluginRegistry,
  ) {}

  async build(
    session: SessionRecord,
    prompt: string,
    options: {
      skillNames?: string[]
    } = {},
  ): Promise<string> {
    const baseSections = [
      this.config.systemPrompt,
      environmentSection(this.config, session.cwd),
    ]
    const sections = [...baseSections]
    const joinedBase = baseSections.join("\n\n")
    let remainingBudget = Math.max(
      256,
      this.config.context.maxChars - joinedBase.length - 128,
    )

    const memorySections = await this.memory.buildPromptSections({
      cwd: session.cwd,
      sessionId: session.id,
      maxChars: Math.max(96, Math.floor(remainingBudget * 0.4)),
    })
    if (memorySections.length > 0) {
      sections.push(...memorySections)
      remainingBudget = Math.max(
        96,
        remainingBudget - memorySections.join("\n\n").length - 2,
      )
    }

    const skillSection = this.skills.buildPromptSection(
      prompt,
      options.skillNames ?? [],
      Math.max(96, Math.floor(remainingBudget * 0.5)),
    )
    if (skillSection) {
      sections.push(`## Active Skills\n${skillSection}`)
      remainingBudget = Math.max(96, remainingBudget - skillSection.length - 20)
    }

    const pluginGuidance = this.plugins.getSystemPromptPatches()
    if (pluginGuidance.length > 0) {
      const renderedPluginGuidance = limitText(
        pluginGuidance.join("\n"),
        Math.max(64, Math.floor(remainingBudget * 0.35)),
      )
      sections.push(`## Plugin Guidance\n${renderedPluginGuidance}`)
      remainingBudget = Math.max(64, remainingBudget - renderedPluginGuidance.length - 20)
    }

    const recentContext = formatSessionSummary(
      session.messages,
      Math.max(64, remainingBudget),
    )
    if (recentContext.trim()) {
      sections.push(`## Recent Context\n${recentContext}`)
    }

    return limitText(sections.join("\n\n"), this.config.context.maxChars)
  }
}
