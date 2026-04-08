import { rm, stat } from "node:fs/promises"
import { basename, join } from "node:path"
import { ensureDir, randomId, readJsonIfExists, readTextIfExists, slugify, writeJson, writeText } from "../utils.mts"

export type ArtifactKind =
  | "tool-result"
  | "swarm-summary"
  | "session-export"
  | "diagnostic-bundle"
  | "text"

export type ArtifactRecord = {
  id: string
  kind: ArtifactKind
  name: string
  description?: string
  source?: string
  contentType: string
  path: string
  relativePath: string
  bytes: number
  createdAt: string
  metadata: Record<string, unknown>
}

type ArtifactIndex = {
  version: 1
  artifacts: ArtifactRecord[]
}

export type CreateArtifactInput = {
  kind: ArtifactKind
  name: string
  content: string
  description?: string
  source?: string
  contentType?: string
  extension?: string
  metadata?: Record<string, unknown>
}

function artifactsDir(cwd: string): string {
  return join(cwd, ".oneclaw", "artifacts")
}

function artifactIndexPath(cwd: string): string {
  return join(artifactsDir(cwd), "index.json")
}

function extensionForContentType(contentType: string): string {
  if (contentType.includes("json")) {
    return "json"
  }
  if (contentType.includes("markdown")) {
    return "md"
  }
  return "txt"
}

async function readIndex(cwd: string): Promise<ArtifactIndex> {
  const index = await readJsonIfExists<ArtifactIndex>(artifactIndexPath(cwd))
  return {
    version: 1,
    artifacts: (index?.artifacts ?? [])
      .filter(record => typeof record?.id === "string" && typeof record?.path === "string")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  }
}

async function writeIndex(cwd: string, artifacts: ArtifactRecord[]): Promise<void> {
  await writeJson(artifactIndexPath(cwd), {
    version: 1,
    artifacts: artifacts.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  } satisfies ArtifactIndex)
}

export async function createArtifact(cwd: string, input: CreateArtifactInput): Promise<{
  indexPath: string
  record: ArtifactRecord
}> {
  const now = new Date().toISOString()
  const id = randomId("artifact")
  const contentType = input.contentType ?? "text/plain"
  const extension = input.extension ?? extensionForContentType(contentType)
  const safeName = slugify(input.name)
  const directory = artifactsDir(cwd)
  const filename = `${id}-${safeName}.${extension.replace(/^\./, "")}`
  const path = join(directory, filename)
  await ensureDir(directory)
  await writeText(path, input.content.endsWith("\n") ? input.content : `${input.content}\n`)
  const stats = await stat(path)
  const record: ArtifactRecord = {
    id,
    kind: input.kind,
    name: input.name,
    description: input.description,
    source: input.source,
    contentType,
    path,
    relativePath: join(".oneclaw", "artifacts", basename(path)),
    bytes: stats.size,
    createdAt: now,
    metadata: input.metadata ?? {},
  }
  const index = await readIndex(cwd)
  await writeIndex(cwd, [record, ...index.artifacts.filter(item => item.id !== id)])
  return {
    indexPath: artifactIndexPath(cwd),
    record,
  }
}

export async function listArtifacts(cwd: string, query = ""): Promise<{
  indexPath: string
  count: number
  artifacts: ArtifactRecord[]
}> {
  const index = await readIndex(cwd)
  const normalizedQuery = query.trim().toLowerCase()
  const artifacts = normalizedQuery
    ? index.artifacts.filter(record => [
        record.id,
        record.kind,
        record.name,
        record.description ?? "",
        record.source ?? "",
        JSON.stringify(record.metadata ?? {}),
      ].join("\n").toLowerCase().includes(normalizedQuery))
    : index.artifacts
  return {
    indexPath: artifactIndexPath(cwd),
    count: artifacts.length,
    artifacts,
  }
}

export async function showArtifact(cwd: string, id: string): Promise<ArtifactRecord | null> {
  const index = await readIndex(cwd)
  return index.artifacts.find(record => record.id === id || record.name === id) ?? null
}

export async function readArtifactContent(cwd: string, id: string): Promise<{
  record: ArtifactRecord
  content: string
} | null> {
  const record = await showArtifact(cwd, id)
  if (!record) {
    return null
  }
  return {
    record,
    content: await readTextIfExists(record.path) ?? "",
  }
}

export async function removeArtifact(cwd: string, id: string): Promise<{
  removed: boolean
  record?: ArtifactRecord
  indexPath: string
}> {
  const index = await readIndex(cwd)
  const record = index.artifacts.find(item => item.id === id || item.name === id)
  if (!record) {
    return {
      removed: false,
      indexPath: artifactIndexPath(cwd),
    }
  }
  await rm(record.path, { force: true })
  await writeIndex(cwd, index.artifacts.filter(item => item.id !== record.id))
  return {
    removed: true,
    record,
    indexPath: artifactIndexPath(cwd),
  }
}
