import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { createInterface } from "node:readline"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { SessionRecord, SessionRunResult } from "../types.mts"

type KernelResponse = {
  type: "response"
  id: string | null
  ok: boolean
  result?: unknown
  error?: string
}

type KernelEventEnvelope = {
  type: "event"
  requestId: string
  event: Record<string, unknown>
}

type ApprovalRequest = {
  type: "approval_request"
  approvalId: string
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  cwd: string
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
  onEvent?: (event: Record<string, unknown>) => void | Promise<void>
  onApprovalRequest?: (event: ApprovalRequest) => boolean | Promise<boolean>
}

type KernelClientOptions = {
  onStderr?: (chunk: string) => void
}

export class KernelClient {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly pending = new Map<string, PendingRequest>()
  private readonly onStderr: (chunk: string) => void
  private requestCounter = 0
  private closed = false
  private closing = false

  constructor(
    cwd = process.cwd(),
    pythonCommand = process.env.ONECLAW_PYTHON ?? "python3",
    options: KernelClientOptions = {},
  ) {
    const frontendDir = dirname(fileURLToPath(import.meta.url))
    const kernelRoot = join(frontendDir, "..", "..", "kernel")
    const existingPythonPath = process.env.PYTHONPATH
    this.child = spawn(
      pythonCommand,
      ["-u", "-m", "oneclaw_kernel.server"],
      {
        cwd,
        env: {
          ...process.env,
          ONECLAW_FRONTEND_CWD: cwd,
          PYTHONPATH: existingPythonPath
            ? `${kernelRoot}${delimiter}${existingPythonPath}`
            : kernelRoot,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    )
    this.onStderr = options.onStderr ?? (chunk => {
      process.stderr.write(chunk)
    })

    const reader = createInterface({
      input: this.child.stdout,
      crlfDelay: Infinity,
    })
    reader.on("line", line => {
      if (!line.trim()) {
        return
      }
      const message = JSON.parse(line) as KernelResponse | KernelEventEnvelope
      if (message.type === "event") {
        const pending = this.pending.get(message.requestId)
        if (!pending) {
          return
        }
        if (message.event.type === "approval_request") {
          const approvalRequest = message.event as unknown as ApprovalRequest
          void Promise.resolve(
            pending.onApprovalRequest
              ? pending.onApprovalRequest(approvalRequest)
              : false,
          )
            .then(allowed => this.submitApproval(approvalRequest.approvalId, allowed))
            .catch(() => this.submitApproval(approvalRequest.approvalId, false))
        }
        void pending.onEvent?.(message.event)
        return
      }
      if (!message.id) {
        return
      }
      const pending = this.pending.get(message.id)
      if (!pending) {
        return
      }
      this.pending.delete(message.id)
      if (message.ok) {
        pending.resolve(message.result)
      } else {
        pending.reject(new Error(message.error ?? "Kernel request failed"))
      }
    })

    this.child.stderr.on("data", chunk => {
      this.onStderr(String(chunk))
    })

    this.child.on("exit", code => {
      this.closed = true
      if (this.closing && (code === 0 || code === null)) {
        this.pending.clear()
        return
      }
      for (const [id, pending] of this.pending.entries()) {
        this.pending.delete(id)
        pending.reject(new Error(`Kernel process exited with code ${code ?? "unknown"}`))
      }
    })
  }

  private request<T>(
    method: string,
    params: Record<string, unknown> = {},
    options: {
      onEvent?: (event: Record<string, unknown>) => void | Promise<void>
      onApprovalRequest?: (event: ApprovalRequest) => boolean | Promise<boolean>
    } = {},
  ): Promise<T> {
    return this.requestTracked<T>(method, params, options).promise
  }

  private requestTracked<T>(
    method: string,
    params: Record<string, unknown> = {},
    options: {
      onEvent?: (event: Record<string, unknown>) => void | Promise<void>
      onApprovalRequest?: (event: ApprovalRequest) => boolean | Promise<boolean>
    } = {},
  ): { requestId: string; promise: Promise<T> } {
    if (this.closed) {
      return {
        requestId: "",
        promise: Promise.reject(new Error("Kernel client is closed")),
      }
    }
    const id = `req_${++this.requestCounter}`
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: value => resolve(value as T),
        reject,
        onEvent: options.onEvent,
        onApprovalRequest: options.onApprovalRequest,
      })
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    })
    return {
      requestId: id,
      promise,
    }
  }

  private async submitApproval(approvalId: string, allowed: boolean): Promise<void> {
    await this.request("approval_response", {
      approvalId,
      allowed,
    })
  }

  health() {
    return this.request<{ ok: boolean; provider: string; profile: string }>("health")
  }

  providers() {
    return this.request<{
      activeProfile: string
      provider: { kind: string; model: string; label: string }
      providers: Array<Record<string, unknown>>
      profiles: Array<Record<string, unknown>>
    }>("providers")
  }

  providerDiagnostics(target?: string) {
    return this.request<Record<string, unknown>>("provider_diagnostics", { target })
  }

  profileList() {
    return this.request<Array<Record<string, unknown>>>("profile_list")
  }

  profileUse(name: string) {
    return this.request<{ activeProfile: string; path: string }>("profile_use", { name })
  }

  profileSave(
    name: string,
    profile: {
      label?: string
      kind: string
      model: string
      baseUrl?: string
      enterpriseUrl?: string
      description?: string
    },
    options: { activate?: boolean } = {},
  ) {
    return this.request<{
      name: string
      profile: Record<string, unknown>
      activeProfile: string
      path: string
    }>("profile_save", { name, profile, activate: Boolean(options.activate) })
  }

  profileDelete(name: string) {
    return this.request<{
      name: string
      deleted: boolean
      activeProfile: string
      path: string
    }>("profile_delete", { name })
  }

  reload() {
    return this.request<Record<string, unknown>>("reload")
  }

  updateConfigPatch(patch: Record<string, unknown>) {
    return this.request<{
      path: string
      state: Record<string, unknown>
    }>("config_patch", { patch })
  }

  config(section?: string) {
    return this.request<{
      section: string
      value: unknown
    }>("config", { section })
  }

  state() {
    return this.request<Record<string, unknown>>("state")
  }

  status(sessionId?: string) {
    return this.request<Record<string, unknown>>("status", { sessionId })
  }

  context(sessionId?: string) {
    return this.request<Record<string, unknown>>("context", { sessionId })
  }

  compactPolicy(sessionId?: string) {
    return this.request<Record<string, unknown>>("compact_policy", { sessionId })
  }

  usage() {
    return this.request<Record<string, unknown>>("usage")
  }

  tools(options: { summaryOnly?: boolean } = {}) {
    return this.request<Record<string, unknown>>("tools", options)
  }

  observability() {
    return this.request<Record<string, unknown>>("observability")
  }

  hooks() {
    return this.request<Record<string, unknown>>("hooks")
  }

  plugins(options: { name?: string; verbose?: boolean } = {}) {
    return this.request<Record<string, unknown>>("plugins", options)
  }

  skills(options: { query?: string; includeBody?: boolean } = {}) {
    return this.request<Record<string, unknown>>("skills", options)
  }

  tasks() {
    return this.request<Record<string, unknown>>("tasks")
  }

  sessions(options: { cwd?: string; scope?: "project" | "all" } = {}) {
    return this.request<Array<Record<string, unknown>>>("sessions", options)
  }

  sessionGet(sessionId: string) {
    return this.request<SessionRecord | null>("session_get", { sessionId })
  }

  clearSession(sessionId: string, clearMemory = false) {
    return this.request<{
      sessionId: string
      clearedMessages: number
      clearedMemory: boolean
    }>("session_clear", { sessionId, clearMemory })
  }

  deleteSession(sessionId: string) {
    return this.request<{
      sessionId: string
      deleted: boolean
    }>("session_delete", { sessionId })
  }

  compactSession(sessionId: string) {
    return this.request<{
      sessionId: string
      beforeMessages: number
      afterMessages: number
      compactedMessages: number
      memoryUpdated: boolean
    }>("session_compact", { sessionId })
  }

  rewindSession(sessionId: string, turns = 1) {
    return this.request<{
      sessionId: string
      beforeMessages: number
      afterMessages: number
      removedMessages: number
      turns: number
    }>("session_rewind", { sessionId, turns })
  }

  sessionExport(sessionId: string, format: "json" | "markdown" = "json") {
    return this.request<{
      sessionId: string
      format: "json" | "markdown"
      filename: string
      contentType: string
      content: string
    } | null>("session_export", { sessionId, format })
  }

  sessionExportBundle(sessionId: string) {
    return this.request<{
      sessionId: string
      session: SessionRecord
      memory: string
      markdown: string
      provider: string
      activeProfile: string
      usage: Record<string, unknown>
    } | null>("session_export_bundle", { sessionId })
  }

  memory(sessionId: string) {
    return this.request<Record<string, unknown>>("memory", { sessionId })
  }

  todo(sessionId: string) {
    return this.request<Record<string, unknown>>("todo", { sessionId })
  }

  todoUpdate(sessionId: string, items: Array<Record<string, unknown>>) {
    return this.request<Record<string, unknown>>("todo_update", { sessionId, items })
  }

  webFetch(url: string, options: { maxChars?: number; timeoutMs?: number } = {}) {
    return this.request<{
      url: string
      status: number
      contentType: string
      text: string
    }>("web_fetch", { url, ...options })
  }

  codeSymbols(options: { path?: string; query?: string; limit?: number } = {}) {
    return this.request<{
      cwd: string
      path: string
      query: string
      count: number
      symbols: Array<{ name: string; kind: string; file: string; line: number; text: string }>
    }>("code_symbols", options)
  }

  webSearch(query: string, options: { maxResults?: number; timeoutMs?: number } = {}) {
    return this.request<{
      query: string
      url: string
      status: number
      contentType: string
      results: Array<{ title: string; url: string }>
    }>("web_search", { query, ...options })
  }

  mcp(options: { verbose?: boolean } = {}) {
    return this.request<Record<string, unknown>>("mcp", options)
  }

  mcpReconnect(name?: string) {
    return this.request<Record<string, unknown>>("mcp_reconnect", { name })
  }

  mcpAddServer(config: Record<string, unknown>) {
    return this.request<Record<string, unknown>>("mcp_add_server", { config })
  }

  mcpRemoveServer(name: string) {
    return this.request<Record<string, unknown>>("mcp_remove_server", { name })
  }

  mcpReadResource(server: string, uri: string) {
    return this.request<Record<string, unknown>>("mcp_read_resource", { server, uri })
  }

  createSession(cwd = process.cwd(), metadata?: Record<string, unknown>) {
    return this.request<{ id: string; cwd: string }>("create_session", { cwd, metadata })
  }

  runPrompt(
    prompt: string,
    options: {
      sessionId?: string
      cwd?: string
      skillNames?: string[]
      metadata?: Record<string, unknown>
      onEvent?: (event: Record<string, unknown>) => void | Promise<void>
      onApprovalRequest?: (event: ApprovalRequest) => boolean | Promise<boolean>
    } = {},
  ) {
    return this.requestTracked<SessionRunResult>("run_prompt", {
      prompt,
      sessionId: options.sessionId,
      cwd: options.cwd,
      skillNames: options.skillNames ?? [],
      metadata: options.metadata,
    }, {
      onEvent: options.onEvent,
      onApprovalRequest: options.onApprovalRequest,
    }).promise
  }

  runPromptTracked(
    prompt: string,
    options: {
      sessionId?: string
      cwd?: string
      skillNames?: string[]
      metadata?: Record<string, unknown>
      onEvent?: (event: Record<string, unknown>) => void | Promise<void>
      onApprovalRequest?: (event: ApprovalRequest) => boolean | Promise<boolean>
    } = {},
  ) {
    return this.requestTracked<SessionRunResult>("run_prompt", {
      prompt,
      sessionId: options.sessionId,
      cwd: options.cwd,
      skillNames: options.skillNames ?? [],
      metadata: options.metadata,
    }, {
      onEvent: options.onEvent,
      onApprovalRequest: options.onApprovalRequest,
    })
  }

  cancelRequest(requestId: string) {
    return this.request<{ accepted: boolean }>("cancel_request", { requestId })
  }

  cancelSession(sessionId: string) {
    return this.request<{ accepted: boolean }>("cancel_request", { sessionId })
  }

  async close(): Promise<void> {
    if (this.closed || this.closing) {
      return
    }
    this.closing = true
    try {
      await this.request("shutdown")
    } catch {
      this.child.kill("SIGTERM")
    } finally {
      this.closed = true
    }
  }
}
