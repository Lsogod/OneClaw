import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, extname, join } from "node:path"
import { TeamRegistry } from "../agents/team-registry.mts"
import { BridgeSessionManager } from "./manager.mts"
import {
  listChannelMessages,
  listChannels,
  recordChannelMessage,
  removeChannel,
  upsertChannel,
  type ChannelKind,
} from "../channels/registry.mts"
import { deliverChannelMessage, verifyChannelSignature } from "../channels/connectors.mts"
import { loadConfig } from "../config.mts"
import { KernelClient } from "../frontend/kernel-client.mts"
import { TaskManager } from "../tasks/task-manager.mts"
import type { TaskRecord } from "../types.mts"
import type { BridgeAuthScope, BridgeAuthTokenConfig, OneClawConfig } from "../types.mts"
import { ensureDir, safeJsonParse, slugify } from "../utils.mts"

const encoder = new TextEncoder()

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  })
}

function notFound(): Response {
  return json({ error: "Not found" }, 404)
}

function unauthorized(): Response {
  return json({ error: "Unauthorized" }, 401)
}

function forbidden(): Response {
  return json({ error: "Forbidden" }, 403)
}

function splitPath(pathname: string): string[] {
  return pathname.split("/").filter(Boolean)
}

const MAX_REQUEST_BODY_BYTES = 1_048_576 // 1 MB

class RequestBodyTooLargeError extends Error {}

function payloadTooLarge(): Response {
  return json({ error: "Request body too large" }, 413)
}

async function readLimitedBodyText(request: Request): Promise<string> {
  if (!request.body) {
    return ""
  }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      total += value.byteLength
      if (total > MAX_REQUEST_BODY_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new RequestBodyTooLargeError()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

async function safeParseBody<T = Record<string, unknown>>(request: Request): Promise<{ ok: true; body: T } | { ok: false; response: Response }> {
  const contentLength = request.headers.get("content-length")
  if (contentLength && Number(contentLength) > MAX_REQUEST_BODY_BYTES) {
    return { ok: false, response: payloadTooLarge() }
  }
  try {
    const text = await readLimitedBodyText(request)
    return { ok: true, body: (text ? JSON.parse(text) : {}) as T }
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return { ok: false, response: payloadTooLarge() }
    }
    return { ok: true, body: {} as T }
  }
}

function sse(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function streamHeaders(): HeadersInit {
  return {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
  }
}

function isInterruptError(message: string): boolean {
  return /cancel|interrupt/i.test(message)
}

function renderHistoryMarkdown(payload: {
  sessionId: string
  messages: Array<{
    role: string
    content: Array<Record<string, unknown>>
  }>
}): string {
  const lines = [`# Session History ${payload.sessionId}`, ""]
  for (const message of payload.messages) {
    lines.push(`## ${message.role}`)
    lines.push("")
    for (const block of message.content) {
      if (block.type === "text") {
        lines.push(String(block.text ?? ""))
        continue
      }
      if (block.type === "tool_call") {
        lines.push(`- tool_call \`${String(block.name ?? "unknown")}\``)
        continue
      }
      if (block.type === "tool_result") {
        lines.push(`- tool_result \`${String(block.name ?? "unknown")}\``)
        lines.push("```text")
        lines.push(String(block.result ?? ""))
        lines.push("```")
      }
    }
    lines.push("")
  }
  return lines.join("\n").trim() + "\n"
}

type ArtifactFormat = "json" | "markdown" | "bundle"

type ArtifactRecord = {
  id: string
  sessionId: string
  kind: "session-export"
  format: ArtifactFormat
  filename: string
  contentType: string
  createdAt: string
  path: string
  bytes: number
}

type StreamUnsubscribe = () => void

function extractBridgeToken(request: Request): string | null {
  const bearer = request.headers.get("authorization")
  if (bearer?.startsWith("Bearer ")) {
    return bearer.slice("Bearer ".length)
  }
  const fallback = request.headers.get("x-oneclaw-token")
  return fallback?.trim() || null
}

function normalizeScopes(scopes: BridgeAuthScope[] | undefined): BridgeAuthScope[] {
  const normalized = new Set<BridgeAuthScope>(scopes ?? [])
  if (normalized.has("admin")) {
    normalized.add("read")
    normalized.add("write")
    normalized.add("control")
  }
  return [...normalized]
}

function resolveBridgeTokens(bridge: OneClawConfig["bridge"]): BridgeAuthTokenConfig[] {
  const tokens = [...(bridge.authTokens ?? [])]
  if (bridge.authToken) {
    tokens.unshift({
      token: bridge.authToken,
      scopes: ["admin"],
      label: "legacy-admin",
    })
  }
  return tokens
}

function authorizeScope(
  request: Request,
  bridge: OneClawConfig["bridge"],
  requiredScope: BridgeAuthScope,
): Response | null {
  const configuredTokens = resolveBridgeTokens(bridge)
  if (configuredTokens.length === 0) {
    return null
  }
  const presentedToken = extractBridgeToken(request)
  if (!presentedToken) {
    return unauthorized()
  }
  const matched = configuredTokens.find(candidate => candidate.token === presentedToken)
  if (!matched) {
    return unauthorized()
  }
  const scopes = normalizeScopes(matched.scopes)
  if (scopes.includes(requiredScope) || scopes.includes("admin")) {
    return null
  }
  return forbidden()
}

function artifactDirectory(config: OneClawConfig): string {
  return join(config.homeDir, "artifacts")
}

function artifactMetadataPath(config: OneClawConfig, artifactId: string): string {
  return join(artifactDirectory(config), `${artifactId}.meta.json`)
}

async function writeArtifact(
  config: OneClawConfig,
  sessionId: string,
  format: ArtifactFormat,
  payload: {
    filename: string
    contentType: string
    content: string
  },
  displayName?: string,
): Promise<ArtifactRecord> {
  const dir = artifactDirectory(config)
  await ensureDir(dir)
  const id = `artifact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  const extension = extname(payload.filename) || (format === "markdown" ? ".md" : ".json")
  const stem = slugify(displayName || basename(payload.filename, extname(payload.filename)) || `${sessionId}-${format}`)
  const filename = `${stem}${extension}`
  const contentPath = join(dir, `${id}-${filename}`)
  await writeFile(contentPath, payload.content, "utf8")
  const stats = await stat(contentPath)
  const record: ArtifactRecord = {
    id,
    sessionId,
    kind: "session-export",
    format,
    filename,
    contentType: payload.contentType,
    createdAt: new Date().toISOString(),
    path: contentPath,
    bytes: stats.size,
  }
  await writeFile(artifactMetadataPath(config, id), JSON.stringify(record, null, 2), "utf8")
  return record
}

async function readArtifactRecord(
  config: OneClawConfig,
  artifactId: string,
): Promise<ArtifactRecord | null> {
  try {
    const raw = await readFile(artifactMetadataPath(config, artifactId), "utf8")
    return safeJsonParse<ArtifactRecord | null>(raw, null)
  } catch {
    return null
  }
}

async function listArtifacts(
  config: OneClawConfig,
  sessionId?: string,
): Promise<ArtifactRecord[]> {
  const dir = artifactDirectory(config)
  await mkdir(dir, { recursive: true })
  const entries = await readdir(dir)
  const records: ArtifactRecord[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".meta.json")) {
      continue
    }
    const raw = await readFile(join(dir, entry), "utf8").catch(() => null)
    if (!raw) {
      continue
    }
    const parsed = safeJsonParse<ArtifactRecord | null>(raw, null)
    if (!parsed) {
      continue
    }
    if (sessionId && parsed.sessionId !== sessionId) {
      continue
    }
    records.push(parsed)
  }
  return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

function createSnapshotStream<T>(
  subscribe: (push: (snapshot: T) => void) => StreamUnsubscribe,
  event: string,
): ReadableStream<Uint8Array> {
  let unsubscribe: StreamUnsubscribe | undefined
  return new ReadableStream<Uint8Array>({
    start(controller) {
      unsubscribe = subscribe(snapshot => {
        controller.enqueue(sse(event, snapshot))
      })
    },
    cancel() {
      unsubscribe?.()
    },
  })
}

function buildTeamSnapshot(
  name: string,
  bridgeTeams: TeamRegistry,
  bridgeTasks: TaskManager,
  bridge: BridgeSessionManager,
) {
  const team = bridgeTeams.get(name)
  if (!team) {
    return null
  }
  return {
    ...team,
    tasks: bridgeTasks.list().filter(task => task.metadata?.team === name),
    sessions: bridge.listByTeam(name),
  }
}

function deriveTeamStatus(tasks: TaskRecord[]): "idle" | "running" | "completed" | "failed" | "cancelled" {
  if (tasks.length === 0) {
    return "idle"
  }
  if (tasks.some(task => task.status === "running" || task.status === "pending")) {
    return "running"
  }
  if (tasks.some(task => task.status === "failed")) {
    return "failed"
  }
  if (tasks.some(task => task.status === "killed")) {
    return "cancelled"
  }
  return "completed"
}

async function startBridgeManagedTask(
  taskManager: TaskManager,
  bridge: BridgeSessionManager,
  options: {
    cwd: string
    goal: string
    prompt: string
    team?: string
    onSessionCreated?: (sessionId: string, cwd: string) => void
  },
) {
  return taskManager.start(options.prompt, async task => {
    const worker = new KernelClient(options.cwd)
    try {
      const metadata = {
        via: "bridge-subtask",
        goal: options.goal,
        prompt: options.prompt,
        team: options.team,
      }
      await task.setStatusNote("creating session")
      const session = await worker.createSession(options.cwd, metadata)
      bridge.recordSession(session.id, options.cwd, {
        taskId: task.taskId,
        team: options.team,
      })
      options.onSessionCreated?.(session.id, session.cwd)
      await task.setMetadata("sessionId", session.id)
      await task.setMetadata("goal", options.goal)
      if (options.team) {
        await task.setMetadata("team", options.team)
      }
      await task.log(`session: ${session.id}`)
      await task.setStatusNote("running prompt")
      const tracked = worker.runPromptTracked(options.prompt, {
        cwd: options.cwd,
        sessionId: session.id,
        metadata,
        onApprovalRequest: async () => false,
        onEvent: async event => {
          const eventType = typeof event.type === "string" ? event.type : "kernel"
          if (eventType !== "provider_text_delta") {
            await task.log(`[event] ${eventType}`)
          }
        },
      })
      bridge.markRunning(session.id, tracked.requestId)
      await task.setMetadata("requestId", tracked.requestId)

      const abortHandler = () => {
        void worker.cancelRequest(tracked.requestId)
        void task.log(`[cancel] request ${tracked.requestId}`)
      }
      task.signal.addEventListener("abort", abortHandler, { once: true })

      try {
        const result = await tracked.promise
        bridge.recordTurn(session.id, {
          prompt: options.prompt,
          output: result.text,
          ok: true,
        })
        await task.setStatusNote("completed")
        await task.log(`[done] ${result.stopReason}`)
        return result.text
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        bridge.recordTurn(session.id, {
          prompt: options.prompt,
          output: message,
          ok: false,
        })
        if (isInterruptError(message)) {
          bridge.markInterrupted(session.id)
        }
        await task.log(`[error] ${message}`)
        throw error
      } finally {
        task.signal.removeEventListener("abort", abortHandler)
      }
    } finally {
      await worker.close()
    }
  }, {
    cwd: options.cwd,
    description: `Bridge task for ${options.goal}`,
    metadata: options.team ? { team: options.team, goal: options.goal } : { goal: options.goal },
  })
}

export async function startBridgeServer() {
  const config = await loadConfig(process.cwd())
  const client = new KernelClient(process.cwd())
  const bridge = new BridgeSessionManager(join(config.homeDir, "bridge", "sessions.json"))
  const bridgeTasks = new TaskManager({
    storageDir: join(config.homeDir, "bridge", "tasks"),
  })
  const bridgeTeams = new TeamRegistry(join(config.homeDir, "bridge", "teams.json"))

  const syncTeamStatuses = () => {
    for (const team of bridgeTeams.list()) {
      const relatedTasks = bridgeTasks.list().filter(task =>
        task.metadata?.team === team.name || team.tasks.includes(task.id),
      )
      const next = bridgeTeams.get(team.name)
      if (!next) {
        continue
      }
      const taskIds = relatedTasks.map(task => task.id)
      const normalized = {
        ...next,
        tasks: taskIds,
      }
      bridgeTeams.replace(normalized)
      bridgeTeams.setStatus(team.name, deriveTeamStatus(relatedTasks))
    }
  }

  bridgeTasks.subscribe(() => {
    syncTeamStatuses()
  })
  syncTeamStatuses()

  const server = Bun.serve({
    hostname: config.bridge.host,
    port: config.bridge.port,
    async fetch(request) {
      const url = new URL(request.url)
      const parts = splitPath(url.pathname)
      const requireScope = (scope: BridgeAuthScope): Response | null => (
        url.pathname === "/health" ? null : authorizeScope(request, config.bridge, scope)
      )

      if (request.method !== "GET" && request.method !== "HEAD") {
        const parsed = await safeParseBody(request)
        if (!parsed.ok) {
          return parsed.response
        }
        Object.defineProperty(request, "json", {
          value: async () => parsed.body,
        })
      }

      if (request.method === "GET" && url.pathname === "/health") {
        return json(await client.health())
      }

      if (request.method === "GET" && url.pathname === "/state") {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        return json(await client.state())
      }

      if (request.method === "GET" && url.pathname === "/mcp") {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        return json(await client.mcp())
      }

      if (request.method === "GET" && url.pathname === "/channels") {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        return json(await listChannels(config, url.searchParams.get("query") ?? ""))
      }

      if (request.method === "POST" && url.pathname === "/channels") {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        const body = await request.json().catch(() => ({})) as {
          name?: string
          kind?: ChannelKind
          label?: string
          secretEnv?: string
          webhookPath?: string
          enabled?: boolean
          metadata?: Record<string, unknown>
        }
        if (!body.name || !body.kind) {
          return json({ error: "name and kind are required" }, 400)
        }
        return json(await upsertChannel(config, {
          name: body.name,
          kind: body.kind,
          label: body.label,
          secretEnv: body.secretEnv,
          webhookPath: body.webhookPath,
          enabled: body.enabled,
          metadata: body.metadata,
        }), 201)
      }

      if (request.method === "GET" && url.pathname === "/channels/messages") {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        return json(await listChannelMessages(config, url.searchParams.get("query") ?? ""))
      }

      if (request.method === "DELETE" && parts.length === 2 && parts[0] === "channels") {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        return json(await removeChannel(config, parts[1]))
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[0] === "channels" &&
        parts[2] === "messages"
      ) {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        const body = await request.json().catch(() => ({})) as {
          text?: string
          prompt?: string
          sender?: string
          threadId?: string
          run?: boolean
          metadata?: Record<string, unknown>
        }
        const text = body.text ?? body.prompt ?? ""
        if (!text.trim()) {
          return json({ error: "text or prompt is required" }, 400)
        }
        const recorded = await recordChannelMessage(config, {
          channel: parts[1],
          direction: "inbound",
          text,
          sender: body.sender,
          threadId: body.threadId,
          metadata: body.metadata,
        })
        if (!body.run) {
          return json(recorded, 202)
        }
        const task = await startBridgeManagedTask(bridgeTasks, bridge, {
          cwd: process.cwd(),
          goal: `channel:${parts[1]}`,
          prompt: text,
          team: typeof body.metadata?.team === "string" ? body.metadata.team : undefined,
        })
        return json({
          ...recorded,
          task,
        }, 202)
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[0] === "channels" &&
        parts[2] === "deliver"
      ) {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        const body = await request.json().catch(() => ({})) as { messageId?: string }
        if (!body.messageId) {
          return json({ error: "messageId is required" }, 400)
        }
        return json(await deliverChannelMessage(config, body.messageId))
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[0] === "channels" &&
        parts[2] === "verify"
      ) {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        const body = await request.json().catch(() => ({})) as { signature?: string; payload?: string }
        if (!body.signature || typeof body.payload !== "string") {
          return json({ error: "signature and payload are required" }, 400)
        }
        return json(await verifyChannelSignature(config, parts[1], body.signature, body.payload))
      }

      if (request.method === "GET" && url.pathname === "/bridge/sessions") {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        const team = url.searchParams.get("team")
        return json(team ? bridge.listByTeam(team) : bridge.list())
      }

      if (request.method === "GET" && url.pathname === "/bridge/requests") {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        return json(bridge.listActiveRequests())
      }

      if (request.method === "GET" && url.pathname === "/sessions") {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        return json(await client.sessions())
      }

      if (request.method === "GET" && url.pathname === "/bridge/sessions/stream") {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        const team = url.searchParams.get("team")
        const stream = createSnapshotStream(
          push => bridge.subscribe(snapshot => {
            push(team ? snapshot.filter(record => record.team === team) : snapshot)
          }),
          "sessions",
        )
        return new Response(stream, {
          headers: streamHeaders(),
        })
      }

      if (request.method === "GET" && url.pathname === "/tasks/stream") {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        const team = url.searchParams.get("team")
        const status = url.searchParams.get("status")
        const stream = createSnapshotStream(
          push => bridgeTasks.subscribe(snapshot => {
            const filtered = snapshot.filter(task => {
              if (team && task.metadata?.team !== team) {
                return false
              }
              if (status && task.status !== status) {
                return false
              }
              return true
            })
            push(filtered)
          }),
          "tasks",
        )
        return new Response(stream, {
          headers: streamHeaders(),
        })
      }

      if (request.method === "GET" && url.pathname === "/teams/stream") {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        const stream = createSnapshotStream(
          push => bridgeTeams.subscribe(push),
          "teams",
        )
        return new Response(stream, {
          headers: streamHeaders(),
        })
      }

      if (request.method === "POST" && url.pathname === "/sessions") {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        const body = await request.json().catch(() => ({}))
        const session = await client.createSession(
          (body as { cwd?: string }).cwd ?? process.cwd(),
          { via: "bridge" },
        )
        bridge.recordSession(session.id, session.cwd)
        return json({ sessionId: session.id }, 201)
      }

      if (
        request.method === "GET" &&
        parts.length === 2 &&
        parts[0] === "sessions"
      ) {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        const session = await client.sessionGet(parts[1])
        if (!session) {
          return notFound()
        }
        return json(session)
      }

      if (
        request.method === "GET" &&
        parts.length === 3 &&
        parts[0] === "sessions" &&
        parts[2] === "history"
      ) {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        const session = await client.sessionGet(parts[1])
        if (!session) {
          return notFound()
        }
        return json({
          sessionId: session.id,
          messages: session.messages,
          updatedAt: session.updatedAt,
        })
      }

      if (
        request.method === "GET" &&
        parts.length === 4 &&
        parts[0] === "sessions" &&
        parts[2] === "history" &&
        parts[3] === "export"
      ) {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        const session = await client.sessionGet(parts[1])
        if (!session) {
          return notFound()
        }
        const payload = {
          sessionId: session.id,
          messages: session.messages,
          updatedAt: session.updatedAt,
        }
        const format = url.searchParams.get("format") === "markdown" ? "markdown" : "json"
        if (format === "markdown") {
          const content = renderHistoryMarkdown(payload)
          return new Response(content, {
            headers: {
              "content-type": "text/markdown; charset=utf-8",
              "content-disposition": `inline; filename="${session.id}.history.md"`,
            },
          })
        }
        return new Response(JSON.stringify(payload, null, 2), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `inline; filename="${session.id}.history.json"`,
          },
        })
      }

      if (
        request.method === "GET" &&
        parts.length === 4 &&
        parts[0] === "sessions" &&
        parts[2] === "export" &&
        parts[3] === "bundle"
      ) {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        const exported = await client.sessionExportBundle(parts[1])
        if (!exported) {
          return notFound()
        }
        return json(exported)
      }

      if (
        request.method === "GET" &&
        parts.length === 3 &&
        parts[0] === "sessions" &&
        parts[2] === "export"
      ) {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        const exported = await client.sessionExport(
          parts[1],
          url.searchParams.get("format") === "markdown" ? "markdown" : "json",
        )
        if (!exported) {
          return notFound()
        }
        return new Response(exported.content, {
          headers: {
            "content-type": exported.contentType,
            "content-disposition": `inline; filename="${exported.filename}"`,
          },
        })
      }

      if (
        request.method === "POST" &&
        parts.length === 4 &&
        parts[0] === "sessions" &&
        parts[2] === "export" &&
        parts[3] === "artifact"
      ) {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        const sessionId = parts[1]
        const body = await request.json().catch(() => ({})) as {
          format?: ArtifactFormat
          name?: string
        }
        const format = body.format === "bundle" || body.format === "json" || body.format === "markdown"
          ? body.format
          : "markdown"
        if (format === "bundle") {
          const bundle = await client.sessionExportBundle(sessionId)
          if (!bundle) {
            return notFound()
          }
          const record = await writeArtifact(config, sessionId, "bundle", {
            filename: `${sessionId}.bundle.json`,
            contentType: "application/json; charset=utf-8",
            content: JSON.stringify(bundle, null, 2),
          }, body.name)
          return json(record, 201)
        }
        const exported = await client.sessionExport(sessionId, format)
        if (!exported) {
          return notFound()
        }
        const record = await writeArtifact(config, sessionId, format, exported, body.name)
        return json(record, 201)
      }

      if (
        request.method === "GET" &&
        parts.length === 3 &&
        parts[0] === "sessions" &&
        parts[2] === "artifacts"
      ) {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        return json(await listArtifacts(config, parts[1]))
      }

      if (
        request.method === "GET" &&
        url.pathname === "/artifacts"
      ) {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        return json(await listArtifacts(config))
      }

      if (
        request.method === "GET" &&
        parts.length === 2 &&
        parts[0] === "artifacts"
      ) {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        const artifact = await readArtifactRecord(config, parts[1])
        if (!artifact) {
          return notFound()
        }
        return json(artifact)
      }

      if (
        request.method === "GET" &&
        parts.length === 3 &&
        parts[0] === "artifacts" &&
        parts[2] === "content"
      ) {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        const artifact = await readArtifactRecord(config, parts[1])
        if (!artifact) {
          return notFound()
        }
        const content = await readFile(artifact.path, "utf8").catch(() => null)
        if (content === null) {
          return notFound()
        }
        return new Response(content, {
          headers: {
            "content-type": artifact.contentType,
            "content-disposition": `inline; filename="${artifact.filename}"`,
          },
        })
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[0] === "sessions" &&
        parts[2] === "interrupt"
      ) {
        const denied = requireScope("control")
        if (denied) {
          return denied
        }
        const sessionId = parts[1]
        const interrupted = await client.cancelSession(sessionId)
        if (interrupted.accepted) {
          bridge.markInterrupted(sessionId)
        }
        return json(interrupted)
      }

      if (
        request.method === "POST" &&
        parts.length === 4 &&
        parts[0] === "bridge" &&
        parts[1] === "requests" &&
        parts[3] === "interrupt"
      ) {
        const denied = requireScope("control")
        if (denied) {
          return denied
        }
        const requestId = parts[2]
        const interrupted = await client.cancelRequest(requestId)
        if (interrupted.accepted) {
          const record = bridge.findByRequestId(requestId)
          if (record) {
            bridge.markInterrupted(record.sessionId)
          }
        }
        return json(interrupted)
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[0] === "sessions" &&
        parts[2] === "query"
      ) {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        const sessionId = parts[1]
        const body = await request.json() as { prompt: string; skills?: string[] }
        const activeControllerSend = new Map<string, (event: string, data: unknown) => void>()
        const tracked = client.runPromptTracked(body.prompt, {
          sessionId,
          skillNames: body.skills ?? [],
          onApprovalRequest: async () => false,
        })
        bridge.markRunning(sessionId, tracked.requestId)
        const result = await tracked.promise
        bridge.recordTurn(sessionId, {
          prompt: body.prompt,
          output: result.text,
          ok: true,
        })
        return json(result)
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[0] === "sessions" &&
        parts[2] === "resume"
      ) {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        const sessionId = parts[1]
        const body = await request.json() as { prompt: string; skills?: string[] }
        const activeControllerSend = new Map<string, (event: string, data: unknown) => void>()
        const tracked = client.runPromptTracked(body.prompt, {
          sessionId,
          skillNames: body.skills ?? [],
          onApprovalRequest: async () => false,
        })
        bridge.markRunning(sessionId, tracked.requestId)
        const result = await tracked.promise
        bridge.recordTurn(sessionId, {
          prompt: body.prompt,
          output: result.text,
          ok: true,
        })
        return json(result)
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[0] === "sessions" &&
        parts[2] === "cancel"
      ) {
        const denied = requireScope("control")
        if (denied) {
          return denied
        }
        const sessionId = parts[1]
        const cancelled = await client.cancelSession(sessionId)
        if (cancelled.accepted) {
          bridge.markCancelled(sessionId)
        }
        return json(cancelled)
      }

      if (
        request.method === "POST" &&
        parts.length === 4 &&
        parts[0] === "sessions" &&
        parts[2] === "query" &&
        parts[3] === "stream"
      ) {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        const sessionId = parts[1]
        const body = await request.json() as { prompt: string; skills?: string[] }
        const activeControllerSend = new Map<string, (event: string, data: unknown) => void>()
        const tracked = client.runPromptTracked(body.prompt, {
          sessionId,
          skillNames: body.skills ?? [],
          onEvent: event => {
            const type = typeof event.type === "string" ? event.type : "kernel"
            const send = activeControllerSend.get(sessionId)
            send?.(type, event)
          },
          onApprovalRequest: async requestPayload => {
            const send = activeControllerSend.get(sessionId)
            send?.("approval_request", requestPayload)
            return false
          },
        })
        bridge.markRunning(sessionId, tracked.requestId)
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (event: string, data: unknown) => {
              controller.enqueue(sse(event, data))
            }
            activeControllerSend.set(sessionId, send)
            void tracked.promise
              .then(result => {
                bridge.recordTurn(sessionId, {
                  prompt: body.prompt,
                  output: result.text,
                  ok: true,
                })
                send("result", result)
                send("done", { ok: true, sessionId })
                controller.close()
              })
              .catch(error => {
                const message = error instanceof Error ? error.message : String(error)
                bridge.recordTurn(sessionId, {
                  prompt: body.prompt,
                  output: message,
                  ok: false,
                })
                if (isInterruptError(message)) {
                  bridge.markInterrupted(sessionId)
                }
                send("error", { message, sessionId })
                controller.close()
              })
              .finally(() => {
                activeControllerSend.delete(sessionId)
              })
          },
          cancel() {
            void client.cancelSession(sessionId)
            bridge.markCancelled(sessionId)
          },
        })
        return new Response(stream, {
          headers: streamHeaders(),
        })
      }

      if (request.method === "POST" && url.pathname === "/tasks") {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        const body = await request.json() as { goal: string; subtasks?: string[] }
        const subtasks = body.subtasks ?? [body.goal]
        const results = await Promise.all(subtasks.map(async task => {
          const worker = new KernelClient(process.cwd())
          try {
            const result = await worker.runPrompt(task, {
              cwd: process.cwd(),
              metadata: { via: "bridge-subtask", goal: body.goal, prompt: task },
              onApprovalRequest: async () => false,
            })
            bridge.recordSession(result.sessionId, process.cwd())
            bridge.recordTurn(result.sessionId, {
              prompt: task,
              output: result.text,
              ok: true,
            })
            return { task, text: result.text }
          } finally {
            await worker.close()
          }
        }))
        return json({
          goal: body.goal,
          results,
          summary: [
            `Goal: ${body.goal}`,
            ...results.map(item => `\n## ${item.task}\n${item.text}`),
          ].join("\n"),
        })
      }

      if (
        request.method === "GET" &&
        parts.length === 4 &&
        parts[0] === "bridge" &&
        parts[1] === "requests"
      ) {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        const record = bridge.findByRequestId(parts[2])
        if (!record || parts[3] !== "session") {
          return notFound()
        }
        return json(record)
      }

      if (
        request.method === "GET" &&
        parts.length === 3 &&
        parts[0] === "bridge" &&
        parts[1] === "sessions"
      ) {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        const record = bridge.get(parts[2])
        if (!record) {
          return notFound()
        }
        return json(record)
      }

      if (request.method === "GET" && url.pathname === "/teams") {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        return json(bridgeTeams.list())
      }

      if (request.method === "POST" && url.pathname === "/teams") {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        const body = await request.json().catch(() => ({})) as {
          name?: string
          description?: string
          goal?: string
          plan?: string[]
        }
        if (!body.name) {
          return json({ error: "name is required" }, 400)
        }
        return json(bridgeTeams.create(body.name, body.description ?? "", {
          goal: body.goal,
          plan: body.plan,
        }), 201)
      }

      if (
        request.method === "GET" &&
        parts.length === 2 &&
        parts[0] === "teams"
      ) {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        const team = bridgeTeams.get(parts[1])
        if (!team) {
          return notFound()
        }
        return json(buildTeamSnapshot(parts[1], bridgeTeams, bridgeTasks, bridge))
      }

      if (
        request.method === "GET" &&
        parts.length === 3 &&
        parts[0] === "teams" &&
        parts[2] === "stream"
      ) {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        if (!bridgeTeams.get(parts[1])) {
          return notFound()
        }
        const stream = createSnapshotStream(
          push => {
            const emit = () => {
              const snapshot = buildTeamSnapshot(parts[1], bridgeTeams, bridgeTasks, bridge)
              if (snapshot) {
                push(snapshot)
              }
            }
            const unsubscribers = [
              bridgeTeams.subscribe(() => emit()),
              bridgeTasks.subscribe(() => emit()),
              bridge.subscribe(() => emit()),
            ]
            emit()
            return () => {
              for (const unsubscribe of unsubscribers) {
                unsubscribe()
              }
            }
          },
          "team",
        )
        return new Response(stream, {
          headers: streamHeaders(),
        })
      }

      if (
        request.method === "GET" &&
        parts.length === 3 &&
        parts[0] === "teams" &&
        parts[2] === "tasks"
      ) {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        if (!bridgeTeams.get(parts[1])) {
          return notFound()
        }
        return json(bridgeTasks.list().filter(task => task.metadata?.team === parts[1]))
      }

      if (
        request.method === "GET" &&
        parts.length === 3 &&
        parts[0] === "teams" &&
        parts[2] === "sessions"
      ) {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        if (!bridgeTeams.get(parts[1])) {
          return notFound()
        }
        return json(bridge.listByTeam(parts[1]))
      }

      if (
        request.method === "DELETE" &&
        parts.length === 2 &&
        parts[0] === "teams"
      ) {
        const denied = requireScope("control")
        if (denied) {
          return denied
        }
        return json({
          deleted: bridgeTeams.delete(parts[1]),
        })
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[0] === "teams" &&
        parts[2] === "agents"
      ) {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        const body = await request.json().catch(() => ({})) as {
          sessionId?: string
        }
        if (!body.sessionId) {
          return json({ error: "sessionId is required" }, 400)
        }
        return json(bridgeTeams.addAgent(parts[1], body.sessionId))
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[0] === "teams" &&
        parts[2] === "messages"
      ) {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        const body = await request.json().catch(() => ({})) as {
          message?: string
        }
        if (!body.message) {
          return json({ error: "message is required" }, 400)
        }
        return json(bridgeTeams.sendMessage(parts[1], body.message))
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[0] === "teams" &&
        parts[2] === "goal"
      ) {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        const body = await request.json().catch(() => ({})) as {
          goal?: string
        }
        if (!body.goal) {
          return json({ error: "goal is required" }, 400)
        }
        const team = bridgeTeams.setGoal(parts[1], body.goal)
        return json(team)
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[0] === "teams" &&
        parts[2] === "plan"
      ) {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        const body = await request.json().catch(() => ({})) as {
          plan?: string[]
        }
        const plan = (body.plan ?? []).map(item => String(item).trim()).filter(Boolean)
        if (plan.length === 0) {
          return json({ error: "plan is required" }, 400)
        }
        return json(bridgeTeams.setPlan(parts[1], plan))
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[0] === "teams" &&
        parts[2] === "roles"
      ) {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        const body = await request.json().catch(() => ({})) as {
          agentId?: string
          role?: string
        }
        if (!body.agentId || !body.role) {
          return json({ error: "agentId and role are required" }, 400)
        }
        return json(bridgeTeams.setRole(parts[1], body.agentId, body.role))
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[0] === "teams" &&
        parts[2] === "worktrees"
      ) {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        const body = await request.json().catch(() => ({})) as {
          agentId?: string
          path?: string
        }
        if (!body.agentId || !body.path) {
          return json({ error: "agentId and path are required" }, 400)
        }
        return json(bridgeTeams.setWorktree(parts[1], body.agentId, body.path))
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[0] === "teams" &&
        parts[2] === "review"
      ) {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        const body = await request.json().catch(() => ({})) as {
          status?: "pending" | "approved" | "changes_requested"
          note?: string
        }
        const status = body.status ?? "pending"
        if (!["pending", "approved", "changes_requested"].includes(status)) {
          return json({ error: "invalid review status" }, 400)
        }
        return json(bridgeTeams.setReview(parts[1], status, body.note ?? ""))
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[0] === "teams" &&
        parts[2] === "merge"
      ) {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        const body = await request.json().catch(() => ({})) as {
          status?: "pending" | "ready" | "merged" | "blocked"
          note?: string
        }
        const status = body.status ?? "pending"
        if (!["pending", "ready", "merged", "blocked"].includes(status)) {
          return json({ error: "invalid merge status" }, 400)
        }
        return json(bridgeTeams.setMerge(parts[1], status, body.note ?? ""))
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[0] === "teams" &&
        parts[2] === "run"
      ) {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        const body = await request.json().catch(() => ({})) as {
          goal?: string
          subtasks?: string[]
          cwd?: string
        }
        if (!body.goal) {
          return json({ error: "goal is required" }, 400)
        }
        const subtasks = body.subtasks?.length ? body.subtasks : [body.goal]
        if (!bridgeTeams.get(parts[1])) {
          bridgeTeams.create(parts[1], `Bridge team ${parts[1]}`, {
            goal: body.goal,
            plan: subtasks,
          })
        } else {
          bridgeTeams.setGoal(parts[1], body.goal)
          bridgeTeams.setPlan(parts[1], subtasks)
        }
        bridgeTeams.setStatus(parts[1], "running")
        const cwd = body.cwd ?? process.cwd()
        const tasks = await Promise.all(subtasks.map(subtask =>
          startBridgeManagedTask(bridgeTasks, bridge, {
            cwd,
            goal: body.goal as string,
            prompt: subtask,
            team: parts[1],
            onSessionCreated: (sessionId, sessionCwd) => {
              bridgeTeams.addAgent(parts[1], sessionId)
              bridgeTeams.setRole(parts[1], sessionId, `worker-${subtasks.indexOf(subtask) + 1}`)
              bridgeTeams.setWorktree(parts[1], sessionId, sessionCwd)
            },
          }),
        ))
        for (const task of tasks) {
          bridgeTeams.addTask(parts[1], task.id)
        }
        syncTeamStatuses()
        return json({
          team: parts[1],
          goal: body.goal,
          tasks,
        }, 202)
      }

      if (request.method === "GET" && url.pathname === "/tasks") {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        const status = url.searchParams.get("status")
        const team = url.searchParams.get("team")
        return json(
          bridgeTasks.list(
            status && ["pending", "running", "completed", "failed", "killed"].includes(status)
              ? status as "pending" | "running" | "completed" | "failed" | "killed"
              : undefined,
          ).filter(task => !team || task.metadata?.team === team),
        )
      }

      if (
        request.method === "GET" &&
        parts.length === 2 &&
        parts[0] === "tasks"
      ) {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        const task = bridgeTasks.get(parts[1])
        if (!task) {
          return notFound()
        }
        return json(task)
      }

      if (
        request.method === "GET" &&
        parts.length === 3 &&
        parts[0] === "tasks" &&
        parts[2] === "session"
      ) {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        const task = bridgeTasks.get(parts[1])
        if (!task) {
          return notFound()
        }
        const sessionId = task.metadata?.sessionId
        if (typeof sessionId !== "string" || !sessionId) {
          return json(null)
        }
        return json(bridge.get(sessionId) ?? { sessionId })
      }

      if (
        request.method === "GET" &&
        parts.length === 3 &&
        parts[0] === "tasks" &&
        parts[2] === "output"
      ) {
        const denied = requireScope("read")
        if (denied) {
          return denied
        }
        const task = bridgeTasks.get(parts[1])
        if (!task) {
          return notFound()
        }
        return new Response(await bridgeTasks.readOutput(parts[1]), {
          headers: {
            "content-type": "text/plain; charset=utf-8",
          },
        })
      }

      if (
        request.method === "POST" &&
        parts.length === 3 &&
        parts[0] === "tasks" &&
        parts[2] === "cancel"
      ) {
        const denied = requireScope("control")
        if (denied) {
          return denied
        }
        const task = await bridgeTasks.stop(parts[1])
        if (!task) {
          return notFound()
        }
        return json(task)
      }

      if (
        request.method === "POST" &&
        parts.length === 2 &&
        parts[0] === "tasks" &&
        parts[1] === "launch"
      ) {
        const denied = requireScope("write")
        if (denied) {
          return denied
        }
        const body = await request.json() as {
          goal: string
          subtasks?: string[]
          cwd?: string
          team?: string
        }
        const cwd = body.cwd ?? process.cwd()
        const subtasks = body.subtasks?.length ? body.subtasks : [body.goal]
        if (body.team && !bridgeTeams.get(body.team)) {
          bridgeTeams.create(body.team, `Bridge team ${body.team}`, {
            goal: body.goal,
            plan: subtasks,
          })
        } else if (body.team) {
          bridgeTeams.setGoal(body.team, body.goal)
          bridgeTeams.setPlan(body.team, subtasks)
        }
        if (body.team) {
          bridgeTeams.setStatus(body.team, "running")
        }
        const tasks = await Promise.all(subtasks.map(subtask =>
          startBridgeManagedTask(bridgeTasks, bridge, {
            cwd,
            goal: body.goal,
            prompt: subtask,
            team: body.team,
            onSessionCreated: (sessionId, sessionCwd) => {
              if (body.team) {
                bridgeTeams.addAgent(body.team, sessionId)
                bridgeTeams.setRole(body.team, sessionId, `worker-${subtasks.indexOf(subtask) + 1}`)
                bridgeTeams.setWorktree(body.team, sessionId, sessionCwd)
              }
            },
          }),
        ))
        if (body.team) {
          for (const task of tasks) {
            bridgeTeams.addTask(body.team, task.id)
          }
          syncTeamStatuses()
        }
        return json({
          goal: body.goal,
          team: body.team,
          tasks,
        }, 202)
      }

      return notFound()
    },
  })

  process.stderr.write(`[bridge] listening on http://${server.hostname}:${server.port}\n`)

  const originalStop = server.stop.bind(server)
  ;(server as typeof server & { stop(closeActiveConnections?: boolean): void }).stop = (closeActiveConnections?: boolean) => {
    void client.close()
    void closeActiveConnections
    originalStop()
  }

  const shutdown = async () => {
    await client.close()
    server.stop()
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  return server
}

if (import.meta.main) {
  await startBridgeServer()
}
