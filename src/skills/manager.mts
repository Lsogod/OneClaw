import { existsSync } from "node:fs"
import { rm } from "node:fs/promises"
import { basename, join } from "node:path"
import type { OneClawConfig } from "../types.mts"
import {
  collectFilesByExtension,
  ensureDir,
  limitText,
  readTextIfExists,
  slugify,
  writeText,
} from "../utils.mts"

export type SkillScope = "project" | "user"

export type ManagedSkill = {
  name: string
  description: string
  scope: SkillScope
  path: string
  chars: number
  body?: string
}

type ParsedSkill = {
  metadata: Record<string, string>
  body: string
}

export function projectSkillDir(cwd: string): string {
  return join(cwd, "skills")
}

export function userSkillDir(config: OneClawConfig): string {
  return join(config.homeDir, "skills")
}

function parseSkillDocument(raw: string): ParsedSkill {
  if (!raw.startsWith("---")) {
    return { metadata: {}, body: raw.trim() }
  }

  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    return { metadata: {}, body: raw.trim() }
  }

  const metadata: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":")
    if (separator <= 0) {
      continue
    }
    const key = line.slice(0, separator).trim()
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "")
    if (key) {
      metadata[key] = value
    }
  }
  return { metadata, body: match[2].trim() }
}

function skillPathFor(directory: string, name: string): string {
  return join(directory, `${slugify(name)}.md`)
}

function skillNameFromPath(path: string): string {
  return basename(path).replace(/\.md$/i, "")
}

async function readSkill(path: string, scope: SkillScope, includeBody: boolean): Promise<ManagedSkill> {
  const raw = await readTextIfExists(path) ?? ""
  const parsed = parseSkillDocument(raw)
  const name = parsed.metadata.name?.trim() || skillNameFromPath(path)
  const description = parsed.metadata.description?.trim()
    || parsed.body.split(/\r?\n/).find(line => line.trim())?.trim()
    || ""
  return {
    name,
    description,
    scope,
    path,
    chars: raw.length,
    ...(includeBody ? { body: limitText(parsed.body, 8000) } : {}),
  }
}

async function listSkillFiles(directory: string, scope: SkillScope): Promise<Array<{ path: string; scope: SkillScope }>> {
  const files = await collectFilesByExtension([directory], [".md"], 3)
  return files.map(path => ({ path, scope }))
}

export async function listManagedSkills(
  config: OneClawConfig,
  cwd: string,
  options: { query?: string; includeBody?: boolean } = {},
): Promise<{ skills: ManagedSkill[]; roots: Record<SkillScope, string> }> {
  const roots = {
    project: projectSkillDir(cwd),
    user: userSkillDir(config),
  }
  const files = [
    ...await listSkillFiles(roots.project, "project"),
    ...await listSkillFiles(roots.user, "user"),
  ]

  const query = options.query?.trim().toLowerCase()
  const skills = await Promise.all(
    files.map(file => readSkill(file.path, file.scope, options.includeBody ?? false)),
  )
  const filtered = query
    ? skills.filter(skill => [
      skill.name,
      skill.description,
      skill.scope,
      skill.path,
      skill.body ?? "",
    ].join("\n").toLowerCase().includes(query))
    : skills

  return {
    roots,
    skills: filtered.sort((left, right) => {
      const scopeOrder = left.scope.localeCompare(right.scope)
      return scopeOrder || left.name.localeCompare(right.name)
    }),
  }
}

export async function showManagedSkill(
  config: OneClawConfig,
  cwd: string,
  name: string,
): Promise<ManagedSkill | null> {
  const listing = await listManagedSkills(config, cwd, {
    query: name,
    includeBody: true,
  })
  const normalized = name.trim().toLowerCase()
  return listing.skills.find(skill => skill.name.toLowerCase() === normalized)
    ?? listing.skills.find(skill => slugify(skill.name) === slugify(name))
    ?? listing.skills[0]
    ?? null
}

export async function initSkill(
  cwd: string,
  name = "project-context",
): Promise<{ path: string; created: boolean }> {
  const path = skillPathFor(projectSkillDir(cwd), name)
  if (existsSync(path)) {
    return { path, created: false }
  }
  const title = name.trim() || "project-context"
  await writeText(path, [
    "---",
    `name: ${title}`,
    "description: Project-specific OneClaw skill.",
    "---",
    "",
    "# Skill",
    "",
    "Describe when OneClaw should apply this skill and the concrete workflow it should follow.",
    "",
  ].join("\n"))
  return { path, created: true }
}

export async function addSkill(
  config: OneClawConfig,
  cwd: string,
  scope: SkillScope,
  name: string,
  body: string,
  description = "",
): Promise<{ path: string; scope: SkillScope; name: string; updated: boolean }> {
  const trimmedName = name.trim()
  if (!trimmedName) {
    throw new Error("Skill name is required")
  }
  const trimmedBody = body.trim()
  if (!trimmedBody) {
    throw new Error("Skill body is required")
  }
  const directory = scope === "project" ? projectSkillDir(cwd) : userSkillDir(config)
  const path = skillPathFor(directory, trimmedName)
  const updated = existsSync(path)
  await ensureDir(directory)
  await writeText(path, [
    "---",
    `name: ${trimmedName}`,
    `description: ${description.trim() || trimmedBody.split(/\r?\n/)[0].slice(0, 160)}`,
    "---",
    "",
    trimmedBody,
    "",
  ].join("\n"))
  return { path, scope, name: trimmedName, updated }
}

export async function removeSkill(
  config: OneClawConfig,
  cwd: string,
  scope: SkillScope,
  name: string,
): Promise<{ path: string; scope: SkillScope; removed: boolean }> {
  const directory = scope === "project" ? projectSkillDir(cwd) : userSkillDir(config)
  const path = skillPathFor(directory, name)
  if (!existsSync(path)) {
    return { path, scope, removed: false }
  }
  await rm(path)
  return { path, scope, removed: true }
}
