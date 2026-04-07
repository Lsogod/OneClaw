import { basename } from "node:path"
import { collectFilesByExtension, limitText, readTextIfExists } from "../utils.mts"

export type SkillRecord = {
  name: string
  description: string
  body: string
  sourcePath: string
}

function parseFrontmatter(raw: string): {
  meta: Record<string, string>
  body: string
} {
  if (!raw.startsWith("---\n")) {
    return { meta: {}, body: raw }
  }

  const endIndex = raw.indexOf("\n---\n", 4)
  if (endIndex < 0) {
    return { meta: {}, body: raw }
  }

  const metaBlock = raw.slice(4, endIndex)
  const body = raw.slice(endIndex + 5)
  const meta: Record<string, string> = {}
  for (const line of metaBlock.split("\n")) {
    const separator = line.indexOf(":")
    if (separator < 0) continue
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim()
    meta[key] = value
  }
  return { meta, body }
}

export class SkillRegistry {
  private readonly skills = new Map<string, SkillRecord>()

  async load(skillDirs: string[]): Promise<void> {
    const files = await collectFilesByExtension(skillDirs, [".md"], 3)
    for (const file of files) {
      const raw = await readTextIfExists(file)
      if (!raw) {
        continue
      }
      const parsed = parseFrontmatter(raw)
      const fallbackName = basename(file).replace(/\.md$/i, "")
      const skill: SkillRecord = {
        name: parsed.meta.name ?? fallbackName,
        description: parsed.meta.description ?? "",
        body: parsed.body.trim(),
        sourcePath: file,
      }
      this.skills.set(skill.name.toLowerCase(), skill)
    }
  }

  list(): SkillRecord[] {
    return [...this.skills.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    )
  }

  resolve(prompt: string, explicitNames: string[] = []): SkillRecord[] {
    const wanted = new Set<string>()
    for (const skillName of explicitNames) {
      wanted.add(skillName.toLowerCase())
    }

    for (const token of prompt.match(/[$@][\w-]+/g) ?? []) {
      wanted.add(token.slice(1).toLowerCase())
    }

    const matches: SkillRecord[] = []
    for (const name of wanted) {
      const hit = this.skills.get(name)
      if (hit) {
        matches.push(hit)
      }
    }
    return matches
  }

  buildPromptSection(
    prompt: string,
    explicitNames: string[] = [],
    maxChars = 6000,
  ): string {
    const matches = this.resolve(prompt, explicitNames)
    if (matches.length === 0) {
      return ""
    }

    const rendered = matches.map(
      skill =>
        `## Skill: ${skill.name}\nSource: ${skill.sourcePath}\n${limitText(skill.body, 6000)}`,
    )
    return limitText(rendered.join("\n\n"), maxChars)
  }
}
