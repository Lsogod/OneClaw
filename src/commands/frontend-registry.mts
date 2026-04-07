import { mkdir, readdir } from "node:fs/promises"
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { basename, join } from "node:path"
import { collectProviderAuthStatuses } from "../providers/auth.mts"
import { TeamRegistry } from "../agents/team-registry.mts"
import { Coordinator } from "../coordinator/coordinator.mts"
import { loadConfig } from "../config.mts"
import type { KernelClient } from "../frontend/kernel-client.mts"
import { MemoryManager } from "../memory/manager.mts"
import {
  getUserPluginDir,
  installPluginFromPath,
  pluginLifecycleState,
  setPluginEnabled,
  uninstallPlugin,
  updatePlugin,
  validatePluginDirectory,
} from "../plugins/installer.mts"
import { TaskManager } from "../tasks/task-manager.mts"
import { appendText, ensureDir, expandHome, readTextIfExists, slugify, writeText } from "../utils.mts"

const ONECLAW_NEXT_VERSION = "0.2.0"
const VALID_PERMISSION_MODES = new Set(["allow", "ask", "deny"])
const VALID_THEMES = new Set(["neutral", "contrast"])
const VALID_OUTPUT_STYLES = new Set(["text", "json"])
const VALID_HOOK_EVENTS = new Set([
  "session_start",
  "session_end",
  "before_model",
  "after_model",
  "before_tool",
  "after_tool",
])
const VALID_HOOK_TYPES = new Set(["command", "http"])
const THEME_CATALOG = {
  neutral: "Default low-noise terminal theme.",
  contrast: "Higher contrast theme for dim terminals and projectors.",
} as const
const OUTPUT_STYLE_CATALOG = {
  text: "Human-readable CLI/TUI output.",
  json: "Machine-readable stdout for automation.",
} as const

export type FrontendCommandResult = {
  message?: string
  shouldExit?: boolean
}

export type FrontendCommandContext = {
  client: KernelClient
  sessionId: string
  cwd: string
  setSessionId?: (sessionId: string) => void
  listSessions?: (scope?: "project" | "all") => Promise<Array<{ id: string; updatedAt?: string }>>
}

type FrontendCommandHandler = (
  args: string,
  context: FrontendCommandContext,
) => Promise<FrontendCommandResult>

type FrontendSlashCommand = {
  name: string
  description: string
  handler: FrontendCommandHandler
}

type ProfileEntry = {
  name: string
  active?: boolean
  kind?: string
  label?: string
  model?: string
  description?: string
}

type SessionListing = {
  id: string
  cwd?: string
  updatedAt?: string
}

type GitResult = {
  ok: boolean
  output: string
}

let commandTaskManager: TaskManager | null = null
let commandCoordinator: Coordinator | null = null
const commandTeamRegistry = new TeamRegistry()

function getCommandTaskManager(): TaskManager {
  if (!commandTaskManager) {
    commandTaskManager = new TaskManager({
      storageDir: join(expandHome(process.env.ONECLAW_HOME ?? "~/.oneclaw"), "tasks"),
    })
  }
  return commandTaskManager
}

function getCommandCoordinator(): Coordinator {
  if (!commandCoordinator) {
    commandCoordinator = new Coordinator(getCommandTaskManager())
  }
  return commandCoordinator
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function words(args: string): string[] {
  return args.trim().split(/\s+/).filter(Boolean)
}

function quote(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value)
}

function extractString(record: Record<string, unknown>, key: string, fallback = "unknown"): string {
  const value = record[key]
  return typeof value === "string" && value.trim() ? value : fallback
}

async function listSessions(
  context: FrontendCommandContext,
  scope: "project" | "all" = "project",
): Promise<SessionListing[]> {
  const sessions = await (context.listSessions?.(scope) ?? context.client.sessions({
    cwd: context.cwd,
    scope,
  }))
  return sessions as SessionListing[]
}

async function resolveSession(context: FrontendCommandContext, sessionId: string) {
  const session = await context.client.sessionGet(sessionId)
  if (!session) {
    return {
      message: `Session not found: ${sessionId}`,
    }
  }
  context.setSessionId?.(sessionId)
  return {
    message: `Active session set to ${sessionId}`,
  }
}

async function resolveProfile(context: FrontendCommandContext, target: string): Promise<ProfileEntry | null> {
  const profiles = await context.client.profileList() as ProfileEntry[]
  return profiles.find(profile => profile.name === target)
    ?? profiles.find(profile => profile.kind === target)
    ?? null
}

function runGit(cwd: string, ...args: string[]): GitResult {
  try {
    const completed = spawnSync("git", args, {
      cwd,
      encoding: "utf8",
    })
    const output = (completed.stdout || completed.stderr || "").trim()
    if (completed.status !== 0) {
      return {
        ok: false,
        output: output || `git ${args.join(" ")} failed`,
      }
    }
    return {
      ok: true,
      output,
    }
  } catch {
    return {
      ok: false,
      output: "git is not installed.",
    }
  }
}

function oneclawHome(): string {
  return expandHome(process.env.ONECLAW_HOME ?? "~/.oneclaw")
}

function timestampForFile(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-")
}

function messageToPlainText(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content : []
  return content.map(block => {
    if (!block || typeof block !== "object") {
      return ""
    }
    const record = block as Record<string, unknown>
    if (record.type === "text") {
      return typeof record.text === "string" ? record.text : ""
    }
    if (record.type === "tool_result") {
      return typeof record.result === "string" ? record.result : ""
    }
    return ""
  }).filter(Boolean).join("\n")
}

async function latestAssistantText(context: FrontendCommandContext): Promise<string> {
  const session = await context.client.sessionGet(context.sessionId)
  const messages = Array.isArray(session?.messages) ? session.messages as unknown[] : []
  for (const message of [...messages].reverse()) {
    if (!message || typeof message !== "object") {
      continue
    }
    const record = message as Record<string, unknown>
    if (record.role !== "assistant") {
      continue
    }
    const text = messageToPlainText(record).trim()
    if (text) {
      return text
    }
  }
  return ""
}

async function copyToClipboard(text: string): Promise<{ copied: boolean; target: string }> {
  const candidates = process.platform === "darwin"
    ? [{ command: "pbcopy", args: [] as string[], shell: false }]
    : process.platform === "win32"
      ? [{ command: "clip", args: [] as string[], shell: true }]
      : [
          { command: "wl-copy", args: [] as string[], shell: false },
          { command: "xclip", args: ["-selection", "clipboard"], shell: false },
          { command: "xsel", args: ["--clipboard", "--input"], shell: false },
        ]
  for (const candidate of candidates) {
    try {
      const completed = spawnSync(candidate.command, candidate.args, {
        input: text,
        encoding: "utf8",
        shell: candidate.shell,
      })
      if (completed.status === 0) {
        return {
          copied: true,
          target: candidate.command,
        }
      }
    } catch {
      // Fall back to the durable file below.
    }
  }
  const fallbackPath = join(oneclawHome(), "last_copy.txt")
  await writeText(fallbackPath, text)
  return {
    copied: false,
    target: fallbackPath,
  }
}

async function writeSessionSnapshot(
  context: FrontendCommandContext,
  directory: string,
  label: string,
): Promise<Record<string, unknown>> {
  await ensureDir(directory)
  const [markdown, json] = await Promise.all([
    context.client.sessionExport(context.sessionId, "markdown"),
    context.client.sessionExport(context.sessionId, "json"),
  ])
  const written: string[] = []
  if (markdown?.content) {
    const markdownPath = join(directory, `${label}.md`)
    await writeText(markdownPath, markdown.content)
    written.push(markdownPath)
  }
  if (json?.content) {
    const jsonPath = join(directory, `${label}.json`)
    await writeText(jsonPath, json.content)
    written.push(jsonPath)
  }
  return {
    sessionId: context.sessionId,
    directory,
    written,
  }
}

async function initializeProject(cwd: string, force = false): Promise<Record<string, unknown>> {
  const oneclawDir = join(cwd, ".oneclaw")
  const created: string[] = []
  const skipped: string[] = []
  const files = [
    {
      path: join(oneclawDir, "memory.md"),
      content: "# Project Memory\n\nAdd stable project facts, conventions, and decisions here.\n",
    },
    {
      path: join(oneclawDir, "hooks.json"),
      content: `${JSON.stringify({ hooks: [] }, null, 2)}\n`,
    },
    {
      path: join(oneclawDir, "README.md"),
      content: [
        "# OneClaw Project Runtime",
        "",
        "- `memory.md`: project-level memory injected into prompts.",
        "- `hooks.json`: local hook definitions.",
        "- `tags/`: named session snapshots created by `/tag`.",
        "",
      ].join("\n"),
    },
  ]
  await mkdir(oneclawDir, { recursive: true })
  for (const file of files) {
    if (!force && existsSync(file.path)) {
      skipped.push(file.path)
      continue
    }
    await writeText(file.path, file.content)
    created.push(file.path)
  }
  return {
    oneclawDir,
    created,
    skipped,
  }
}

function projectHooksPath(cwd: string): string {
  return join(cwd, ".oneclaw", "hooks.json")
}

function normalizeHooksDocument(raw: unknown): { hooks: Array<Record<string, unknown>> } {
  if (Array.isArray(raw)) {
    return {
      hooks: raw.filter(item => typeof item === "object" && item !== null) as Array<Record<string, unknown>>,
    }
  }
  if (raw && typeof raw === "object" && Array.isArray((raw as { hooks?: unknown }).hooks)) {
    return {
      hooks: ((raw as { hooks: unknown[] }).hooks)
        .filter(item => typeof item === "object" && item !== null) as Array<Record<string, unknown>>,
    }
  }
  return { hooks: [] }
}

function validateHooksDocument(raw: unknown): Record<string, unknown> {
  const normalized = normalizeHooksDocument(raw)
  const errors: string[] = []
  normalized.hooks.forEach((hook, index) => {
    const prefix = `hooks[${index}]`
    if (typeof hook.name !== "string" || !hook.name.trim()) {
      errors.push(`${prefix}.name must be a non-empty string`)
    }
    if (typeof hook.event !== "string" || !VALID_HOOK_EVENTS.has(hook.event)) {
      errors.push(`${prefix}.event must be one of ${[...VALID_HOOK_EVENTS].join(", ")}`)
    }
    if (typeof hook.type !== "string" || !VALID_HOOK_TYPES.has(hook.type)) {
      errors.push(`${prefix}.type must be command or http`)
    }
    if (hook.type === "command" && typeof hook.command !== "string") {
      errors.push(`${prefix}.command must be a string for command hooks`)
    }
    if (hook.type === "http" && typeof hook.url !== "string") {
      errors.push(`${prefix}.url must be a string for http hooks`)
    }
  })
  return {
    valid: errors.length === 0,
    count: normalized.hooks.length,
    errors,
  }
}

async function readHooksDocument(pathname: string): Promise<{ hooks: Array<Record<string, unknown>> }> {
  const raw = await readTextIfExists(pathname)
  if (!raw) {
    return { hooks: [] }
  }
  return normalizeHooksDocument(JSON.parse(raw))
}

async function writeHooksDocument(pathname: string, hooks: Array<Record<string, unknown>>): Promise<void> {
  await writeText(pathname, `${JSON.stringify({ hooks }, null, 2)}\n`)
}

async function hooksFileSummary(context: FrontendCommandContext): Promise<Record<string, unknown>> {
  const config = await loadConfig(context.cwd)
  const files = await Promise.all(config.hooks.files.map(async file => {
    const raw = await readTextIfExists(file)
    if (!raw) {
      return {
        path: file,
        exists: false,
        valid: true,
        count: 0,
      }
    }
    try {
      return {
        path: file,
        exists: true,
        ...validateHooksDocument(JSON.parse(raw)),
      }
    } catch (error) {
      return {
        path: file,
        exists: true,
        valid: false,
        count: 0,
        errors: [error instanceof Error ? error.message : String(error)],
      }
    }
  }))
  return {
    files,
    configured: await context.client.hooks(),
  }
}

async function writeDiagnosticBundle(context: FrontendCommandContext): Promise<Record<string, unknown>> {
  const directory = join(oneclawHome(), "diagnostics")
  const path = join(directory, `${timestampForFile()}-diagnostic.json`)
  const payload = {
    createdAt: new Date().toISOString(),
    cwd: context.cwd,
    sessionId: context.sessionId,
    doctor: await doctorSummary(context),
    status: await context.client.status(context.sessionId),
    context: await context.client.context(context.sessionId),
    usage: await context.client.usage(),
    observability: await context.client.observability(),
    tools: await context.client.tools({ summaryOnly: true }),
  }
  await writeText(path, `${JSON.stringify(payload, null, 2)}\n`)
  return {
    path,
    bytes: JSON.stringify(payload).length,
  }
}

async function releaseNotes(cwd: string): Promise<string> {
  const candidates = [
    join(cwd, "RELEASE_NOTES.md"),
    join(cwd, "CHANGELOG.md"),
  ]
  for (const candidate of candidates) {
    const raw = await readTextIfExists(candidate)
    if (raw) {
      return `${basename(candidate)}\n\n${raw}`
    }
  }
  return [
    `OneClaw ${ONECLAW_NEXT_VERSION}`,
    "",
    "- Python kernel + TypeScript frontend.",
    "- OpenHarness-style provider, tool, MCP, plugin, memory, bridge, and TUI layers.",
    "- Cross-platform launcher and CI smoke checks.",
  ].join("\n")
}

async function listWorkspaceFiles(cwd: string, depth = 2, prefix = ""): Promise<string[]> {
  if (depth < 0) {
    return []
  }
  const ignored = new Set([".git", "node_modules", "dist", "release", "__pycache__"])
  const entries = await readdir(cwd, { withFileTypes: true })
  const results: string[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (ignored.has(entry.name)) {
      continue
    }
    const display = prefix ? `${prefix}/${entry.name}` : entry.name
    results.push(display)
    if (entry.isDirectory() && depth > 0) {
      results.push(...await listWorkspaceFiles(join(cwd, entry.name), depth - 1, display))
    }
  }
  return results
}

async function doctorSummary(context: FrontendCommandContext): Promise<Record<string, unknown>> {
  const [health, state, providerView, auth, mcp, hooks, plugins, skills] = await Promise.all([
    context.client.health(),
    context.client.state(),
    context.client.providers(),
    collectProviderAuthStatuses(),
    context.client.mcp(),
    context.client.hooks(),
    context.client.plugins(),
    context.client.skills(),
  ])
  const gitStatus = runGit(context.cwd, "status", "--short", "--branch")
  return {
    health,
    state,
    auth,
    git: {
      ok: gitStatus.ok,
      status: gitStatus.output || "(clean)",
    },
    providers: providerView,
    mcp,
    hooks,
    plugins,
    skills,
  }
}

async function providerSetupSummary(context: FrontendCommandContext, target?: string): Promise<Record<string, unknown>> {
  const [providerView, statuses, state, diagnostics] = await Promise.all([
    context.client.providers(),
    collectProviderAuthStatuses(),
    context.client.state(),
    context.client.providerDiagnostics(target),
  ])
  const provider = target
    ? statuses.find(status => status.kind === target)
    : statuses.find(status => status.kind === extractString(state, "provider", "codex-subscription"))
  const instructions: Record<string, string> = {
    "anthropic-compatible": "Set ONECLAW_API_KEY or ANTHROPIC_API_KEY, then run `/provider use anthropic-compatible`.",
    "openai-compatible": "Set ONECLAW_API_KEY or OPENAI_API_KEY, then run `/provider use openai-compatible`.",
    "claude-subscription": "Sign in with Claude CLI so ~/.claude/.credentials.json exists, then run `/provider use claude-subscription`.",
    "codex-subscription": "Sign in with Codex so ~/.codex/auth.json exists, then run `/provider use codex-subscription`.",
    "github-copilot": "Run `one auth copilot-login`, then run `/provider use github-copilot`.",
  }
  return {
    active: state.provider,
    activeProfile: state.activeProfile,
    target: target ?? state.provider,
    configured: provider?.configured ?? false,
    auth: provider ?? null,
    diagnostics,
    instruction: instructions[target ?? extractString(state, "provider", "codex-subscription")] ?? "Unknown provider target.",
    providers: providerView,
  }
}

async function providerTestSummary(context: FrontendCommandContext, target?: string): Promise<Record<string, unknown>> {
  const diagnostics = await context.client.providerDiagnostics(target)
  if (target && diagnostics.provider && typeof diagnostics.provider === "object") {
    const provider = diagnostics.provider as Record<string, unknown>
    const state = await context.client.state()
    if (provider.kind !== extractString(state, "provider")) {
      return {
        ok: false,
        diagnostics,
        detail: "Provider tests run against the active provider. Use `/provider use <profile>` first, then run `/provider test`.",
      }
    }
  }
  if (diagnostics.configured === false) {
    return {
      ok: false,
      diagnostics,
      detail: "Provider is not configured.",
    }
  }
  const session = await context.client.createSession(context.cwd, { via: "provider-test" })
  const startedAt = Date.now()
  const result = await context.client.runPrompt("Reply with only: ok", {
    sessionId: session.id,
    cwd: context.cwd,
    metadata: { via: "provider-test" },
  })
  return {
    ok: true,
    diagnostics,
    sessionId: session.id,
    elapsedMs: Date.now() - startedAt,
    response: result.text,
  }
}

async function memoryManagerFor(cwd: string): Promise<MemoryManager> {
  return new MemoryManager(await loadConfig(cwd))
}

async function findMemoryEntry(
  manager: MemoryManager,
  scope: "project" | "global",
  cwd: string,
  name: string,
) {
  const entries = await manager.listEntries(scope, cwd)
  return entries.find(entry =>
    entry.name === name
    || entry.title === name
    || entry.path.endsWith(`/${name}`)
    || entry.path.endsWith(`/${name}.md`),
  ) ?? null
}

function parseTitleAndBody(input: string): { title: string; content: string } | null {
  const [title, ...rest] = input.split("::")
  const normalizedTitle = title?.trim()
  const normalizedBody = rest.join("::").trim()
  if (!normalizedTitle || !normalizedBody) {
    return null
  }
  return {
    title: normalizedTitle,
    content: normalizedBody,
  }
}

async function bridgeConfigView(cwd: string) {
  const config = await loadConfig(cwd)
  const scopes = (config.bridge.authTokens ?? []).map(token => ({
    label: token.label ?? "(unnamed)",
    scopes: token.scopes,
  }))
  if (config.bridge.authToken) {
    scopes.unshift({
      label: "legacy-admin",
      scopes: ["admin"],
    })
  }
  return {
    host: config.bridge.host,
    port: config.bridge.port,
    baseUrl: `http://${config.bridge.host}:${config.bridge.port}`,
    authEnabled: Boolean(config.bridge.authToken) || (config.bridge.authTokens?.length ?? 0) > 0,
    authTokens: scopes,
  }
}

async function bridgeRequest(
  cwd: string,
  pathname: string,
  options: {
    method?: string
    body?: unknown
  } = {},
) {
  const view = await bridgeConfigView(cwd)
  const config = await loadConfig(cwd)
  const token = config.bridge.authTokens?.[0]?.token ?? config.bridge.authToken
  const headers: Record<string, string> = {}
  if (token) {
    headers.authorization = `Bearer ${token}`
  }
  if (options.body !== undefined) {
    headers["content-type"] = "application/json"
  }
  const response = await fetch(`${view.baseUrl}${pathname}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  })
  const raw = await response.text()
  let parsed: unknown = raw
  try {
    parsed = JSON.parse(raw)
  } catch {
    // keep text payload
  }
  return {
    ok: response.ok,
    status: response.status,
    body: parsed,
    baseUrl: view.baseUrl,
  }
}

async function lastUserPrompt(context: FrontendCommandContext): Promise<string> {
  const session = await context.client.sessionGet(context.sessionId)
  const messages = session?.messages ?? []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== "user") {
      continue
    }
    const text = message.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("\n")
      .trim()
    if (text) {
      return text
    }
  }
  return ""
}

async function runCommandPrompt(
  context: FrontendCommandContext,
  prompt: string,
  metadata: Record<string, unknown>,
): Promise<string> {
  const result = await context.client.runPrompt(prompt, {
    sessionId: context.sessionId,
    cwd: context.cwd,
    metadata,
    onApprovalRequest: async () => false,
  })
  context.setSessionId?.(result.sessionId)
  return result.text
}

async function agentsSummary(context: FrontendCommandContext): Promise<Record<string, unknown>> {
  const [state, worktree, sessions] = await Promise.all([
    context.client.state(),
    context.client.config("worktree"),
    listSessions(context),
  ])
  const detailed = await Promise.all(
    sessions.slice(0, 12).map(async session => ({
      id: session.id,
      session: await context.client.sessionGet(session.id),
    })),
  )
  const agentSessions = detailed
    .map(item => {
      const metadata = item.session?.metadata ?? {}
      const via = typeof metadata.via === "string" ? metadata.via : ""
      const worktreeInfo = metadata.worktree
      return {
        id: item.id,
        via,
        isolated: Boolean(worktreeInfo && typeof worktreeInfo === "object" && "isolated" in worktreeInfo),
      }
    })
    .filter(item => item.via.includes("delegate") || item.via.includes("subtask") || item.isolated)
  return {
    state,
    worktree,
    agentSessions,
    tasks: getCommandTaskManager().list(),
    teams: commandTeamRegistry.list(),
  }
}

async function runManagedGoal(
  context: FrontendCommandContext,
  goal: string,
  options: {
    via: string
    isolateWorktree: boolean
  },
) {
  return getCommandCoordinator().run(goal, [], async (subtask, task) => {
    const metadata = {
      via: options.via,
      goal,
      prompt: subtask,
      isolateWorktree: options.isolateWorktree,
    }
    await task.setStatusNote("creating session")
    const session = await context.client.createSession(context.cwd, metadata)
    await task.setMetadata("sessionId", session.id)
    await task.log(`session: ${session.id}`)
    await task.setStatusNote("running prompt")
    const tracked = context.client.runPromptTracked(subtask, {
      sessionId: session.id,
      cwd: context.cwd,
      metadata,
      onApprovalRequest: async () => false,
      onEvent: async event => {
        if (event.type === "provider_text_delta") {
          return
        }
        await task.log(`[event] ${String(event.type ?? "unknown")}`)
      },
    })
    await task.setMetadata("requestId", tracked.requestId)
    const handleAbort = () => {
      void context.client.cancelRequest(tracked.requestId)
      void task.log(`[cancel] request ${tracked.requestId}`)
    }
    task.signal.addEventListener("abort", handleAbort, { once: true })
    try {
      const reply = await tracked.promise
      await task.setStatusNote("completed")
      await task.log(`[done] ${reply.stopReason}`)
      return reply.text
    } finally {
      task.signal.removeEventListener("abort", handleAbort)
    }
  })
}

export class FrontendCommandRegistry {
  private readonly commands = new Map<string, FrontendSlashCommand>()

  register(command: FrontendSlashCommand): void {
    this.commands.set(command.name, command)
  }

  lookup(input: string): { command: FrontendSlashCommand; args: string } | null {
    if (!input.startsWith("/")) {
      return null
    }
    const [name, ...rest] = input.slice(1).split(" ")
    const command = this.commands.get(name)
    if (!command) {
      return null
    }
    return {
      command,
      args: rest.join(" ").trim(),
    }
  }

  helpText(): string {
    return [...this.commands.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(command => `/${command.name.padEnd(12)} ${command.description}`)
      .join("\n")
  }
}

export function createFrontendCommandRegistry(): FrontendCommandRegistry {
  const registry = new FrontendCommandRegistry()

  registry.register({
    name: "help",
    description: "Show available slash commands",
    handler: async () => ({
      message: registry.helpText(),
    }),
  })

  registry.register({
    name: "exit",
    description: "Exit interactive mode",
    handler: async () => ({
      shouldExit: true,
    }),
  })

  registry.register({
    name: "version",
    description: "Show the current OneClaw version",
    handler: async () => ({
      message: `OneClaw ${ONECLAW_NEXT_VERSION}`,
    }),
  })

  registry.register({
    name: "init",
    description: "Create project-local OneClaw memory and hook files",
    handler: async (args, context) => ({
      message: pretty(await initializeProject(context.cwd, words(args).includes("force"))),
    }),
  })

  registry.register({
    name: "privacy-settings",
    description: "Show local storage, auth, and network/privacy boundaries",
    handler: async (_args, context) => {
      const config = await loadConfig(context.cwd)
      return {
        message: pretty({
          workspace: context.cwd,
          homeDir: config.homeDir,
          sessionDir: config.sessionDir,
          projectRuntimeDir: join(context.cwd, ".oneclaw"),
          feedbackLog: join(config.homeDir, "feedback.log"),
          providerKind: config.provider.kind,
          auth: {
            bridgeAuthEnabled: Boolean(config.bridge.authToken || (config.bridge.authTokens ?? []).length > 0),
            providerSecretsStoredExternally: [
              "~/.codex/auth.json",
              "~/.claude/.credentials.json",
              "~/.oneclaw/copilot_auth.json",
            ],
          },
          network: {
            modelProviderRequests: "enabled by the selected provider",
            mcpServers: config.mcpServers.map(server => ({
              name: server.name,
              transport: server.transport,
              command: server.command,
            })),
          },
          localPersistence: [
            "session transcripts",
            "project/global/session memory",
            "plugin lifecycle state",
            "task/team records",
            "named snapshots created by /share and /tag",
          ],
        }),
      }
    },
  })

  registry.register({
    name: "rate-limit-options",
    description: "Show provider and runtime levers for rate-limit mitigation",
    handler: async (_args, context) => {
      const [state, usage, policy, providers] = await Promise.all([
        context.client.state(),
        context.client.usage(),
        context.client.compactPolicy(context.sessionId),
        context.client.providers(),
      ])
      return {
        message: pretty({
          provider: {
            activeProfile: providers.activeProfile,
            kind: providers.provider.kind,
            model: providers.provider.model,
          },
          usage,
          compactPolicy: policy,
          runtimeLevers: [
            "/compact to reduce current session context",
            "/model <model-name> to switch models within the active provider",
            "/provider use <profile-or-kind> to switch provider profile",
            "ONECLAW_BUDGET_WARN_USD / ONECLAW_BUDGET_MAX_USD for local budget gates",
            "Tune context.maxChars and context.keepMessages in oneclaw.config.json",
          ],
          state,
        }),
      }
    },
  })

  registry.register({
    name: "feedback",
    description: "Append local product feedback for later triage",
    handler: async (args, context) => {
      const feedback = args.trim()
      if (!feedback) {
        return { message: "Usage: /feedback <what happened, what you expected>" }
      }
      const path = join(oneclawHome(), "feedback.log")
      await appendText(path, `${new Date().toISOString()}\tcwd=${context.cwd}\tsession=${context.sessionId}\t${feedback}\n`)
      return {
        message: `Feedback recorded at ${path}`,
      }
    },
  })

  registry.register({
    name: "release-notes",
    description: "Show local release notes or built-in version notes",
    handler: async (_args, context) => ({
      message: await releaseNotes(context.cwd),
    }),
  })

  registry.register({
    name: "upgrade",
    description: "Show source checkout upgrade commands",
    handler: async (_args, context) => {
      const remote = runGit(context.cwd, "remote", "get-url", "origin")
      return {
        message: [
          "Source checkout upgrade path:",
          "",
          `repo: ${remote.ok ? remote.output : "(origin remote not found)"}`,
          "1. git pull --ff-only",
          "2. bun install",
          "3. bun run ci",
          "4. one install",
          "",
          "If this is an npm/global install, reinstall from the package source you use.",
        ].join("\n"),
      }
    },
  })

  registry.register({
    name: "copy",
    description: "Copy text or the latest assistant response to clipboard",
    handler: async (args, context) => {
      const text = args.trim() || await latestAssistantText(context)
      if (!text) {
        return { message: "Nothing to copy. Pass text or run after an assistant response." }
      }
      const result = await copyToClipboard(text)
      return {
        message: result.copied
          ? `Copied ${text.length} chars via ${result.target}.`
          : `Clipboard unavailable; wrote ${text.length} chars to ${result.target}.`,
      }
    },
  })

  registry.register({
    name: "share",
    description: "Write a durable session snapshot under OneClaw home",
    handler: async (_args, context) => {
      const label = `${timestampForFile()}-${slugify(context.sessionId)}`
      const directory = join(oneclawHome(), "shares", label)
      return {
        message: pretty(await writeSessionSnapshot(context, directory, "session")),
      }
    },
  })

  registry.register({
    name: "tag",
    description: "Create a named session snapshot",
    handler: async (args, context) => {
      const name = args.trim()
      if (!name) {
        return { message: "Usage: /tag <name>" }
      }
      const label = `${timestampForFile()}-${slugify(context.sessionId)}`
      const directory = join(oneclawHome(), "tags", slugify(name), label)
      return {
        message: pretty({
          tag: name,
          ...await writeSessionSnapshot(context, directory, "session"),
        }),
      }
    },
  })

  registry.register({
    name: "commit",
    description: "Create a git commit from current workspace changes",
    handler: async (args, context) => {
      const message = args.trim()
      if (!message) {
        return { message: "Usage: /commit <message>" }
      }
      const status = runGit(context.cwd, "status", "--short")
      if (!status.ok) {
        return { message: status.output }
      }
      if (!status.output) {
        return { message: "No changes to commit." }
      }
      const add = runGit(context.cwd, "add", "-A")
      if (!add.ok) {
        return { message: add.output }
      }
      const commit = runGit(context.cwd, "commit", "-m", message)
      return {
        message: commit.output,
      }
    },
  })

  registry.register({
    name: "providers",
    description: "Show provider profiles and auth status",
    handler: async (_args, context) => {
      const payload = await context.client.providers()
      const statuses = await collectProviderAuthStatuses()
      return {
        message: pretty({
          ...payload,
          auth: statuses,
        }),
      }
    },
  })

  registry.register({
    name: "provider",
    description: "Show provider info or switch by profile/provider kind",
    handler: async (args, context) => {
      const parts = words(args)
      if (parts.length === 0 || parts[0] === "show" || parts[0] === "current" || parts[0] === "list") {
        const payload = await context.client.providers()
        return { message: pretty(payload) }
      }
      if (parts[0] === "doctor" || parts[0] === "check" || parts[0] === "setup" || parts[0] === "repair") {
        return {
          message: pretty(await providerSetupSummary(context, parts[1])),
        }
      }
      if (parts[0] === "test") {
        return {
          message: pretty(await providerTestSummary(context, parts[1])),
        }
      }
      if (parts[0] !== "use" || !parts[1]) {
        return { message: "Usage: /provider [show|list|doctor|setup|check|repair|test [kind]] | /provider use <profile-or-kind>" }
      }
      const profile = await resolveProfile(context, parts[1])
      if (!profile) {
        return { message: `Provider/profile not found: ${parts[1]}` }
      }
      const result = await context.client.profileUse(profile.name)
      return {
        message: `Persisted provider profile ${result.activeProfile} to ${result.path}`,
      }
    },
  })

  registry.register({
    name: "profile",
    description: "List or persist the active provider profile",
    handler: async (args, context) => {
      const parts = words(args)
      if (parts.length === 0 || parts[0] === "list") {
        return {
          message: pretty(await context.client.profileList()),
        }
      }
      if (parts[0] === "current" || parts[0] === "show") {
        const state = await context.client.state()
        return {
          message: extractString(state, "activeProfile"),
        }
      }
      if (parts[0] !== "use" || !parts[1]) {
        return {
          message: "Usage: /profile list | /profile current | /profile use <name>",
        }
      }
      const result = await context.client.profileUse(parts[1])
      return {
        message: `Persisted active profile ${result.activeProfile} to ${result.path}`,
      }
    },
  })

  registry.register({
    name: "model",
    description: "Show or persist the active model name",
    handler: async (args, context) => {
      const value = args.trim()
      if (!value || value === "show" || value === "current") {
        const state = await context.client.state()
        return { message: extractString(state, "model") }
      }
      const nextModel = value.startsWith("set ") ? value.slice(4).trim() : value
      if (!nextModel) {
        return { message: "Usage: /model [current] | /model <model-name>" }
      }
      const result = await context.client.updateConfigPatch({
        provider: { model: nextModel },
      })
      return {
        message: `Persisted model ${extractString(result.state, "model", nextModel)} to ${result.path}`,
      }
    },
  })

  registry.register({
    name: "theme",
    description: "Show or persist the active output theme",
    handler: async (args, context) => {
      const parts = words(args)
      const value = args.trim()
      if (parts[0] === "list") {
        return { message: pretty(THEME_CATALOG) }
      }
      if (parts[0] === "preview") {
        const themeName = parts[1] ?? "neutral"
        if (!VALID_THEMES.has(themeName)) {
          return { message: "Usage: /theme preview <neutral|contrast>" }
        }
        return {
          message: [
            `theme: ${themeName}`,
            `description: ${THEME_CATALOG[themeName as keyof typeof THEME_CATALOG]}`,
            "",
            themeName === "contrast"
              ? "Status: HIGH CONTRAST | Prompt: > | Accent: cyan"
              : "Status: neutral | Prompt: > | Accent: muted cyan",
          ].join("\n"),
        }
      }
      if (!value || value === "show" || value === "current") {
        const state = await context.client.state()
        const current = extractString(state, "theme")
        return {
          message: `${current}\n${THEME_CATALOG[current as keyof typeof THEME_CATALOG] ?? ""}`.trim(),
        }
      }
      const nextTheme = value.startsWith("set ") ? value.slice(4).trim() : value
      if (!VALID_THEMES.has(nextTheme)) {
        return { message: "Usage: /theme [current|list|preview <name>] | /theme <neutral|contrast>" }
      }
      const result = await context.client.updateConfigPatch({
        output: { theme: nextTheme },
      })
      return {
        message: `Persisted theme ${extractString(result.state, "theme", nextTheme)} to ${result.path}`,
      }
    },
  })

  registry.register({
    name: "output-style",
    description: "Show or persist the default output style",
    handler: async (args, context) => {
      const parts = words(args)
      const value = args.trim()
      if (parts[0] === "list") {
        return { message: pretty(OUTPUT_STYLE_CATALOG) }
      }
      if (parts[0] === "show" && parts[1]) {
        if (!VALID_OUTPUT_STYLES.has(parts[1])) {
          return { message: "Usage: /output-style show <text|json>" }
        }
        return {
          message: `${parts[1]}\n${OUTPUT_STYLE_CATALOG[parts[1] as keyof typeof OUTPUT_STYLE_CATALOG]}`,
        }
      }
      if (!value || value === "show" || value === "current") {
        const state = await context.client.state()
        const current = extractString(state, "outputStyle")
        return {
          message: `${current}\n${OUTPUT_STYLE_CATALOG[current as keyof typeof OUTPUT_STYLE_CATALOG] ?? ""}`.trim(),
        }
      }
      const nextStyle = value.startsWith("set ") ? value.slice(4).trim() : value
      if (!VALID_OUTPUT_STYLES.has(nextStyle)) {
        return { message: "Usage: /output-style [current|list|show <style>] | /output-style <text|json>" }
      }
      const result = await context.client.updateConfigPatch({
        output: { style: nextStyle },
      })
      return {
        message: `Persisted output style ${extractString(result.state, "outputStyle", nextStyle)} to ${result.path}`,
      }
    },
  })

  registry.register({
    name: "keybindings",
    description: "Show the active keybinding map",
    handler: async (args, context) => {
      const parts = words(args)
      if (parts[0] === "path") {
        return {
          message: join(oneclawHome(), "oneclaw.config.json"),
        }
      }
      if (parts[0] === "set" && parts[1] && parts[2]) {
        const state = await context.client.state() as { keybindings?: Record<string, string> }
        const result = await context.client.updateConfigPatch({
          output: {
            keybindings: {
              ...(state.keybindings ?? {}),
              [parts[1]]: parts.slice(2).join(" "),
            },
          },
        })
        return {
          message: `Persisted keybinding ${parts[1]} to ${parts.slice(2).join(" ")} in ${result.path}`,
        }
      }
      if (parts[0] === "reset") {
        const result = await context.client.updateConfigPatch({
          output: {
            keybindings: {
              submit: "enter",
              exit: "ctrl+c",
              help: "/help",
            },
          },
        })
        return {
          message: `Reset keybindings in ${result.path}`,
        }
      }
      if (parts.length > 0 && parts[0] !== "show" && parts[0] !== "list") {
        return { message: "Usage: /keybindings [show|list|path|set <action> <binding>|reset]" }
      }
      const state = await context.client.state()
      return {
        message: pretty(state.keybindings ?? {}),
      }
    },
  })

  registry.register({
    name: "permissions",
    description: "Show or persist the permission mode",
    handler: async (args, context) => {
      const value = args.trim()
      if (!value || value === "show" || value === "current") {
        return {
          message: pretty(await context.client.context(context.sessionId)),
        }
      }
      const nextMode = value.startsWith("set ") ? value.slice(4).trim() : value
      if (!VALID_PERMISSION_MODES.has(nextMode)) {
        return { message: "Usage: /permissions [current] | /permissions <allow|ask|deny>" }
      }
      const result = await context.client.updateConfigPatch({
        permissions: { mode: nextMode },
      })
      return {
        message: `Persisted permission mode ${extractString(result.state, "permissionMode", nextMode)} to ${result.path}`,
      }
    },
  })

  registry.register({
    name: "config",
    description: "Show the effective runtime config or one section",
    handler: async (args, context) => {
      const parts = words(args)
      const section = parts[0] === "show" ? parts[1] : parts[0]
      const result = await context.client.config(section)
      return {
        message: pretty(result),
      }
    },
  })

  registry.register({
    name: "doctor",
    description: "Run runtime, auth, git, plugin, and MCP checks",
    handler: async (args, context) => {
      if (args.trim() === "bundle") {
        return {
          message: pretty(await writeDiagnosticBundle(context)),
        }
      }
      return {
        message: pretty(await doctorSummary(context)),
      }
    },
  })

  registry.register({
    name: "bridge",
    description: "Inspect or use the bridge control plane",
    handler: async (args, context) => {
      const parts = words(args)
      const action = parts[0] ?? "status"
      if (action === "auth") {
        return {
          message: pretty(await bridgeConfigView(context.cwd)),
        }
      }
      if (action === "status") {
        const config = await bridgeConfigView(context.cwd)
        try {
          const [health, state] = await Promise.all([
            bridgeRequest(context.cwd, "/health"),
            bridgeRequest(context.cwd, "/state"),
          ])
          return {
            message: pretty({
              config,
              health: health.body,
              state: state.body,
            }),
          }
        } catch (error) {
          return {
            message: pretty({
              config,
              reachable: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          }
        }
      }
      if (action === "sessions") {
        const team = parts[1]
        const suffix = team ? `?team=${encodeURIComponent(team)}` : ""
        return {
          message: pretty((await bridgeRequest(context.cwd, `/bridge/sessions${suffix}`)).body),
        }
      }
      if (action === "requests") {
        return {
          message: pretty((await bridgeRequest(context.cwd, "/bridge/requests")).body),
        }
      }
      if (action === "tasks") {
        const params = new URLSearchParams()
        for (let index = 1; index < parts.length; index += 1) {
          const part = parts[index]
          if (!part) {
            continue
          }
          if (part === "team" && parts[index + 1]) {
            params.set("team", parts[index + 1]!)
            index += 1
            continue
          }
          if (!params.has("status")) {
            params.set("status", part)
          }
        }
        const suffix = params.size > 0 ? `?${params.toString()}` : ""
        return {
          message: pretty((await bridgeRequest(context.cwd, `/tasks${suffix}`)).body),
        }
      }
      if (action === "teams") {
        return {
          message: pretty((await bridgeRequest(context.cwd, "/teams")).body),
        }
      }
      if (action === "show" && parts[1]) {
        return {
          message: pretty((await bridgeRequest(context.cwd, `/bridge/sessions/${parts[1]}`)).body),
        }
      }
      if (action === "request" && parts[1]) {
        return {
          message: pretty((await bridgeRequest(context.cwd, `/bridge/requests/${parts[1]}/session`)).body),
        }
      }
      if (action === "artifacts") {
        const sessionId = parts[1]
        return {
          message: pretty((await bridgeRequest(
            context.cwd,
            sessionId ? `/sessions/${sessionId}/artifacts` : "/artifacts",
          )).body),
        }
      }
      if (action === "task") {
        const subaction = parts[1] ?? "run"
        if (subaction === "show" && parts[2]) {
          const [task, session] = await Promise.all([
            bridgeRequest(context.cwd, `/tasks/${parts[2]}`),
            bridgeRequest(context.cwd, `/tasks/${parts[2]}/session`),
          ])
          return {
            message: pretty({
              task: task.body,
              session: session.body,
            }),
          }
        }
        if (subaction === "tail" && parts[2]) {
          const response = await bridgeRequest(context.cwd, `/tasks/${parts[2]}/output`)
          return {
            message: typeof response.body === "string" ? response.body : pretty(response.body),
          }
        }
        if (subaction === "cancel" && parts[2]) {
          return {
            message: pretty((await bridgeRequest(context.cwd, `/tasks/${parts[2]}/cancel`, {
              method: "POST",
            })).body),
          }
        }
        const goal = subaction === "run"
          ? args.replace(/^task\s+run\s+/, "").trim()
          : args.replace(/^task\s+/, "").trim()
        if (!goal) {
          return { message: "Usage: /bridge task [run] <goal> | /bridge task show <id> | /bridge task tail <id> | /bridge task cancel <id>" }
        }
        return {
          message: pretty((await bridgeRequest(context.cwd, "/tasks/launch", {
            method: "POST",
            body: { goal },
          })).body),
        }
      }
      if (action === "team") {
        const subaction = parts[1] ?? "list"
        if (subaction === "list") {
          return {
            message: pretty((await bridgeRequest(context.cwd, "/teams")).body),
          }
        }
        if (subaction === "create" && parts[2]) {
          const description = args.split(/\s+/).slice(3).join(" ")
          return {
            message: pretty((await bridgeRequest(context.cwd, "/teams", {
              method: "POST",
              body: { name: parts[2], description },
            })).body),
          }
        }
        if (subaction === "show" && parts[2]) {
          const [team, tasks, sessions] = await Promise.all([
            bridgeRequest(context.cwd, `/teams/${parts[2]}`),
            bridgeRequest(context.cwd, `/teams/${parts[2]}/tasks`),
            bridgeRequest(context.cwd, `/teams/${parts[2]}/sessions`),
          ])
          return {
            message: pretty({
              team: team.body,
              tasks: tasks.body,
              sessions: sessions.body,
            }),
          }
        }
        if (subaction === "tasks" && parts[2]) {
          return {
            message: pretty((await bridgeRequest(context.cwd, `/teams/${parts[2]}/tasks`)).body),
          }
        }
        if (subaction === "sessions" && parts[2]) {
          return {
            message: pretty((await bridgeRequest(context.cwd, `/teams/${parts[2]}/sessions`)).body),
          }
        }
        if (subaction === "delete" && parts[2]) {
          return {
            message: pretty((await bridgeRequest(context.cwd, `/teams/${parts[2]}`, {
              method: "DELETE",
            })).body),
          }
        }
        if (subaction === "add" && parts[2] && parts[3]) {
          return {
            message: pretty((await bridgeRequest(context.cwd, `/teams/${parts[2]}/agents`, {
              method: "POST",
              body: { sessionId: parts[3] },
            })).body),
          }
        }
        if (subaction === "message" && parts[2]) {
          const message = args.split(/\s+/).slice(3).join(" ").trim()
          if (!message) {
            return { message: "Usage: /bridge team message <team> <message>" }
          }
          return {
            message: pretty((await bridgeRequest(context.cwd, `/teams/${parts[2]}/messages`, {
              method: "POST",
              body: { message },
            })).body),
          }
        }
        if (subaction === "run" && parts[2]) {
          const goal = args.split(/\s+/).slice(3).join(" ").trim()
          if (!goal) {
            return { message: "Usage: /bridge team run <team> <goal>" }
          }
          return {
            message: pretty((await bridgeRequest(context.cwd, `/teams/${parts[2]}/run`, {
              method: "POST",
              body: { goal },
            })).body),
          }
        }
        if (subaction === "goal" && parts[2]) {
          const goal = args.split(/\s+/).slice(3).join(" ").trim()
          if (!goal) {
            return { message: "Usage: /bridge team goal <team> <goal>" }
          }
          return {
            message: pretty((await bridgeRequest(context.cwd, `/teams/${parts[2]}/goal`, {
              method: "POST",
              body: { goal },
            })).body),
          }
        }
        if (subaction === "plan" && parts[2]) {
          const planText = args.split(/\s+/).slice(3).join(" ").trim()
          const plan = planText.split(/\s*::\s*/).map(item => item.trim()).filter(Boolean)
          if (plan.length === 0) {
            return { message: "Usage: /bridge team plan <team> <task 1 :: task 2>" }
          }
          return {
            message: pretty((await bridgeRequest(context.cwd, `/teams/${parts[2]}/plan`, {
              method: "POST",
              body: { plan },
            })).body),
          }
        }
        if (subaction === "role" && parts[2] && parts[3]) {
          const role = args.split(/\s+/).slice(4).join(" ").trim()
          if (!role) {
            return { message: "Usage: /bridge team role <team> <agent> <role>" }
          }
          return {
            message: pretty((await bridgeRequest(context.cwd, `/teams/${parts[2]}/roles`, {
              method: "POST",
              body: { agentId: parts[3], role },
            })).body),
          }
        }
        if (subaction === "worktree" && parts[2] && parts[3]) {
          const path = args.split(/\s+/).slice(4).join(" ").trim()
          if (!path) {
            return { message: "Usage: /bridge team worktree <team> <agent> <path>" }
          }
          return {
            message: pretty((await bridgeRequest(context.cwd, `/teams/${parts[2]}/worktrees`, {
              method: "POST",
              body: { agentId: parts[3], path },
            })).body),
          }
        }
        if (subaction === "review" && parts[2]) {
          const status = parts[3] ?? "pending"
          const note = args.split(/\s+/).slice(4).join(" ").trim()
          return {
            message: pretty((await bridgeRequest(context.cwd, `/teams/${parts[2]}/review`, {
              method: "POST",
              body: { status, note },
            })).body),
          }
        }
        if (subaction === "merge" && parts[2]) {
          const status = parts[3] ?? "pending"
          const note = args.split(/\s+/).slice(4).join(" ").trim()
          return {
            message: pretty((await bridgeRequest(context.cwd, `/teams/${parts[2]}/merge`, {
              method: "POST",
              body: { status, note },
            })).body),
          }
        }
        return {
          message: "Usage: /bridge team [list|create <name> [description]|show <name>|tasks <name>|sessions <name>|goal <name> <goal>|plan <name> <task 1 :: task 2>|role <team> <agent> <role>|worktree <team> <agent> <path>|review <team> <status> [note]|merge <team> <status> [note]|run <name> <goal>|delete <name>|add <team> <session>|message <team> <message>]",
        }
      }
      return {
        message: "Usage: /bridge [status|auth|sessions [team]|requests|tasks [status] [team <name>]|teams|show <session>|request <request>|artifacts [session]|task [run] <goal>|task show <id>|task tail <id>|task cancel <id>|team ...]",
      }
    },
  })

  registry.register({
    name: "stats",
    description: "Show condensed runtime, usage, and session statistics",
    handler: async (_args, context) => {
      const [state, usage, sessions, skills, plugins] = await Promise.all([
        context.client.state(),
        context.client.usage(),
        listSessions(context),
        context.client.skills(),
        context.client.plugins(),
      ])
      return {
        message: pretty({
          state,
          usage,
          sessions: {
            total: sessions.length,
            latest: sessions.slice(0, 5),
          },
          skills,
          plugins,
        }),
      }
    },
  })

  registry.register({
    name: "observability",
    description: "Show trace events, failures, usage, and project-level counters",
    handler: async (_args, context) => ({
      message: pretty(await context.client.observability()),
    }),
  })

  registry.register({
    name: "plan",
    description: "Draft an engineering plan in the current session",
    handler: async (args, context) => {
      const goal = args.trim() || await lastUserPrompt(context)
      if (!goal) {
        return { message: "Usage: /plan <goal>" }
      }
      const prompt = [
        "Create a concise engineering plan for the following goal.",
        "Focus on implementation steps, risks, validation, and sequencing.",
        "Return a direct actionable plan, not motivational framing.",
        "",
        goal,
      ].join("\n")
      return {
        message: await runCommandPrompt(context, prompt, {
          via: "slash-plan",
          goal,
        }),
      }
    },
  })

  registry.register({
    name: "review",
    description: "Run a code review-style analysis in the current session",
    handler: async (args, context) => {
      const target = args.trim() || "."
      const prompt = [
        `Review the current workspace target: ${target}`,
        "Prioritize bugs, risks, regressions, and missing tests.",
        "Present findings first, ordered by severity, with concrete evidence.",
        "Use tools when needed, but keep the final answer concise and technical.",
      ].join("\n")
      return {
        message: await runCommandPrompt(context, prompt, {
          via: "slash-review",
          target,
        }),
      }
    },
  })

  registry.register({
    name: "agents",
    description: "Inspect or run parallel delegate-style subtasks",
    handler: async (args, context) => {
      const parts = words(args)
      if (parts[0] === "tasks") {
        return {
          message: pretty(getCommandTaskManager().list()),
        }
      }
      if (parts[0] === "show" && parts[1]) {
        return {
          message: pretty(
            await context.client.sessionExportBundle(parts[1])
            ?? await context.client.sessionGet(parts[1]),
          ),
        }
      }
      if (parts[0] === "team") {
        const action = parts[1] ?? "list"
        if (action === "list") {
          return {
            message: pretty(commandTeamRegistry.list()),
          }
        }
        if (action === "create" && parts[2]) {
          const name = parts[2]
          const description = args.split(/\s+/).slice(3).join(" ")
          return {
            message: pretty(commandTeamRegistry.create(name, description)),
          }
        }
        if (action === "delete" && parts[2]) {
          return {
            message: commandTeamRegistry.delete(parts[2])
              ? `Deleted team ${parts[2]}`
              : `Team not found: ${parts[2]}`,
          }
        }
        if (action === "add" && parts[2] && parts[3]) {
          return {
            message: pretty(commandTeamRegistry.addAgent(parts[2], parts[3])),
          }
        }
        if (action === "message" && parts[2]) {
          const message = args.split(/\s+/).slice(3).join(" ").trim()
          if (!message) {
            return { message: "Usage: /agents team message <team> <message>" }
          }
          return {
            message: pretty(commandTeamRegistry.sendMessage(parts[2], message)),
          }
        }
        if (action === "role" && parts[2] && parts[3]) {
          const role = args.split(/\s+/).slice(4).join(" ").trim()
          if (!role) {
            return { message: "Usage: /agents team role <team> <agent> <role>" }
          }
          return {
            message: pretty(commandTeamRegistry.setRole(parts[2], parts[3], role)),
          }
        }
        if (action === "worktree" && parts[2] && parts[3]) {
          const path = args.split(/\s+/).slice(4).join(" ").trim()
          if (!path) {
            return { message: "Usage: /agents team worktree <team> <agent> <path>" }
          }
          return {
            message: pretty(commandTeamRegistry.setWorktree(parts[2], parts[3], path)),
          }
        }
        if (action === "review" && parts[2]) {
          return {
            message: pretty(commandTeamRegistry.setReview(
              parts[2],
              (parts[3] as "pending" | "approved" | "changes_requested") ?? "pending",
              args.split(/\s+/).slice(4).join(" ").trim(),
            )),
          }
        }
        if (action === "merge" && parts[2]) {
          return {
            message: pretty(commandTeamRegistry.setMerge(
              parts[2],
              (parts[3] as "pending" | "ready" | "merged" | "blocked") ?? "pending",
              args.split(/\s+/).slice(4).join(" ").trim(),
            )),
          }
        }
        return {
          message: "Usage: /agents team [list|create <name> [description]|delete <name>|add <team> <session>|message <team> <message>|role <team> <agent> <role>|worktree <team> <agent> <path>|review <team> <status> [note]|merge <team> <status> [note]]",
        }
      }
      if (parts[0] === "use" && parts[1]) {
        return resolveSession(context, parts[1])
      }
      if (parts[0] !== "run") {
        return {
          message: pretty(await agentsSummary(context)),
        }
      }
      const goal = args.replace(/^run\s+/, "").trim()
      if (!goal) {
        return { message: "Usage: /agents run <goal>" }
      }
      const result = await runManagedGoal(context, goal, {
        via: "delegate-subtask",
        isolateWorktree: true,
      })
      return {
        message: pretty({
          goal,
          tasks: result.tasks,
          summary: result.summary,
        }),
      }
    },
  })

  registry.register({
    name: "sessions",
    description: "List, inspect, or delete known session snapshots",
    handler: async (args, context) => {
      const parts = words(args)
      const scope = parts.includes("all") || parts[0] === "all" ? "all" : "project"
      const sessions = await listSessions(context, scope)
      if (parts.length === 0 || parts[0] === "list" || parts[0] === "all") {
        return {
          message: pretty(sessions),
        }
      }
      if (parts[0] === "latest") {
        return {
          message: pretty(sessions[0] ?? null),
        }
      }
      if (parts[0] === "show" && parts[1]) {
        return {
          message: pretty(await context.client.sessionGet(parts[1])),
        }
      }
      if (parts[0] === "search") {
        const query = args.replace(/^search\s+/, "").trim().toLowerCase()
        if (!query) {
          return { message: "Usage: /sessions search <query>" }
        }
        const detailed = await Promise.all(sessions.map(async session => ({
          ...session,
          snapshot: await context.client.sessionGet(session.id),
        })))
        const matches = detailed.filter(session => {
          const haystack = JSON.stringify(session).toLowerCase()
          return haystack.includes(query)
        })
        return {
          message: pretty(matches),
        }
      }
      if (parts[0] === "export" && parts[1]) {
        const format = (parts[2] ?? "json") as "json" | "markdown" | "bundle"
        if (!["json", "markdown", "bundle"].includes(format)) {
          return { message: "Usage: /sessions export <id> [json|markdown|bundle]" }
        }
        const exported = format === "bundle"
          ? await context.client.sessionExportBundle(parts[1])
          : await context.client.sessionExport(parts[1], format)
        return {
          message: pretty(exported),
        }
      }
      if (parts[0] === "delete" && parts[1]) {
        const result = await context.client.deleteSession(parts[1])
        return {
          message: result.deleted
            ? `Deleted session ${parts[1]}`
            : `Session not found: ${parts[1]}`,
        }
      }
      if (parts[0] === "prune") {
        const keep = Number.parseInt(parts[1] ?? "10", 10)
        if (!Number.isFinite(keep) || keep < 1) {
          return { message: "Usage: /sessions prune <keep-count>" }
        }
        const toDelete = sessions.slice(keep)
        const deleted: string[] = []
        for (const session of toDelete) {
          const result = await context.client.deleteSession(session.id)
          if (result.deleted) {
            deleted.push(session.id)
          }
        }
        return {
          message: pretty({
            kept: keep,
            deleted,
          }),
        }
      }
      return {
        message: "Usage: /sessions [list|all|latest|show <id>|search <query>|export <id> [json|markdown|bundle]|delete <id>|prune <keep-count>]",
      }
    },
  })

  registry.register({
    name: "resume",
    description: "Switch to a previous session or show available sessions",
    handler: async (args, context) => {
      const parts = words(args)
      const sessions = await listSessions(context)
      if (parts[0] === "list") {
        return { message: pretty(sessions) }
      }
      if (sessions.length === 0) {
        return { message: "No sessions available." }
      }
      if (parts.length === 0 || parts[0] === "latest") {
        const target = sessions.find(session => session.id !== context.sessionId) ?? sessions[0]
        return resolveSession(context, target.id)
      }
      return resolveSession(context, parts[0])
    },
  })

  registry.register({
    name: "branch",
    description: "Show git branch and short status for the current cwd",
    handler: async (_args, context) => {
      const branch = runGit(context.cwd, "rev-parse", "--abbrev-ref", "HEAD")
      const status = runGit(context.cwd, "status", "--short", "--branch")
      if (!branch.ok && !status.ok) {
        return { message: status.output || branch.output }
      }
      return {
        message: [
          `branch: ${branch.ok ? branch.output : "(unknown)"}`,
          "",
          status.output || "(clean)",
        ].join("\n"),
      }
    },
  })

  registry.register({
    name: "diff",
    description: "Show git diff summary, names, or full patch",
    handler: async (args, context) => {
      const mode = args.trim()
      let result: GitResult
      if (!mode || mode === "stat") {
        result = runGit(context.cwd, "diff", "--stat")
      } else if (mode === "cached") {
        result = runGit(context.cwd, "diff", "--cached", "--stat")
      } else if (mode === "name-only" || mode === "names") {
        result = runGit(context.cwd, "diff", "--name-only")
      } else if (mode === "full") {
        result = runGit(context.cwd, "diff")
      } else {
        return { message: "Usage: /diff [stat|cached|names|full]" }
      }
      return {
        message: result.output || "(no diff)",
      }
    },
  })

  registry.register({
    name: "files",
    description: "Show a shallow workspace file tree",
    handler: async (args, context) => {
      const rawDepth = args.trim()
      const depth = rawDepth ? Number.parseInt(rawDepth, 10) : 2
      if (!Number.isFinite(depth) || depth < 0 || depth > 6) {
        return { message: "Usage: /files [depth: 0-6]" }
      }
      const files = await listWorkspaceFiles(context.cwd, depth)
      return {
        message: files.slice(0, 300).join("\n") || "(no files)",
      }
    },
  })

  registry.register({
    name: "history",
    description: "Show current session message history",
    handler: async (_args, context) => {
      const session = await context.client.sessionGet(context.sessionId)
      return {
        message: session
          ? pretty(session.messages)
          : "(session not found)",
      }
    },
  })

  registry.register({
    name: "status",
    description: "Show runtime, provider, usage, and session status",
    handler: async (_args, context) => ({
      message: pretty(await context.client.status(context.sessionId)),
    }),
  })

  registry.register({
    name: "state",
    description: "Show current runtime state snapshot",
    handler: async (_args, context) => ({
      message: pretty(await context.client.state()),
    }),
  })

  registry.register({
    name: "context",
    description: "Show current context and permission envelope",
    handler: async (args, context) => {
      const parts = words(args)
      if (!parts[0] || parts[0] === "show" || parts[0] === "snapshot") {
        return { message: pretty(await context.client.context(context.sessionId)) }
      }
      if (parts[0] === "policy" || parts[0] === "compact") {
        return { message: pretty(await context.client.compactPolicy(context.sessionId)) }
      }
      return { message: "Usage: /context [show|snapshot|policy|compact]" }
    },
  })

  registry.register({
    name: "summary",
    description: "Show the current session context summary",
    handler: async (_args, context) => {
      const payload = await context.client.context(context.sessionId) as {
        session?: { recentSummary?: string }
      }
      return {
        message: payload.session?.recentSummary || "No conversation content to summarize.",
      }
    },
  })

  registry.register({
    name: "session",
    description: "Show or switch the active session in UI/interactive mode",
    handler: async (args, context) => {
      if (!args || args === "current") {
        const session = await context.client.sessionGet(context.sessionId)
        return {
          message: session
            ? pretty({
              id: session.id,
              cwd: session.cwd,
              updatedAt: session.updatedAt,
              messageCount: session.messages.length,
            })
            : "(session not found)",
        }
      }
      const [subcommand, value] = args.split(/\s+/, 2)
      if (subcommand === "next" || subcommand === "prev") {
        const sessions = await listSessions(context)
        const ids = sessions.map(session => session.id)
        const currentIndex = ids.indexOf(context.sessionId)
        if (currentIndex < 0 || ids.length === 0) {
          return {
            message: "No sessions available.",
          }
        }
        const offset = subcommand === "next" ? 1 : -1
        const target = ids[(currentIndex + offset + ids.length) % ids.length]
        context.setSessionId?.(target)
        return {
          message: `Active session set to ${target}`,
        }
      }
      if (subcommand !== "use" || !value) {
        return {
          message: "Usage: /session current | /session use <session-id> | /session next | /session prev",
        }
      }
      return resolveSession(context, value)
    },
  })

  registry.register({
    name: "memory",
    description: "Show or manage session, project, and global memory",
    handler: async (args, context) => {
      const payload = await context.client.memory(context.sessionId) as Record<string, {
        path?: string
        content?: string
      }>
      const parts = words(args)
      const action = parts[0] ?? ""
      const manager = await memoryManagerFor(context.cwd)
      if (!action) {
        return { message: pretty(payload) }
      }
      if (["session", "project", "global"].includes(action)) {
        const section = payload[action]
        if (!section) {
          return { message: `${action} memory is unavailable.` }
        }
        return {
          message: `${action} memory\npath: ${section.path ?? "(unknown)"}\n\n${section.content || "(empty)"}`,
        }
      }
      if (action === "list") {
        const scope = (parts[1] as "project" | "global" | undefined) ?? "project"
        if (!["project", "global"].includes(scope)) {
          return { message: "Usage: /memory list [project|global]" }
        }
        return {
          message: pretty(await manager.listEntries(scope, context.cwd)),
        }
      }
      if (action === "show") {
        const scope = parts[1] as "project" | "global" | undefined
        const name = parts.slice(2).join(" ").trim()
        if (!scope || !["project", "global"].includes(scope) || !name) {
          return { message: "Usage: /memory show <project|global> <name>" }
        }
        const entry = await findMemoryEntry(manager, scope, context.cwd, name)
        return {
          message: entry
            ? `${entry.title}\npath: ${entry.path}\n\n${entry.content}`
            : `Memory entry not found: ${name}`,
        }
      }
      if (action === "index") {
        const scope = (parts[1] as "project" | "global" | undefined) ?? "project"
        if (!["project", "global"].includes(scope)) {
          return { message: "Usage: /memory index [project|global]" }
        }
        const indexPath = scope === "project"
          ? join(context.cwd, ".oneclaw", "MEMORY.md")
          : join((await loadConfig(context.cwd)).homeDir, "memory", "MEMORY.md")
        const raw = await readTextIfExists(indexPath)
        return {
          message: raw
            ? `${scope} memory index\npath: ${indexPath}\n\n${raw}`
            : `Memory index not found: ${indexPath}`,
        }
      }
      if (action === "search") {
        const query = args.replace(/^search\s+/, "").trim()
        if (!query) {
          return { message: "Usage: /memory search <query>" }
        }
        return {
          message: pretty(await manager.searchEntries(query, {
            cwd: context.cwd,
            sessionId: context.sessionId,
          })),
        }
      }
      if (action === "add") {
        const scope = parts[1] as "project" | "global" | undefined
        if (!scope || !["project", "global"].includes(scope)) {
          return { message: "Usage: /memory add <project|global> <title> :: <content>" }
        }
        const parsed = parseTitleAndBody(args.replace(/^add\s+\S+\s+/, ""))
        if (!parsed) {
          return { message: "Usage: /memory add <project|global> <title> :: <content>" }
        }
        const entry = await manager.addEntry(scope, parsed.title, parsed.content, context.cwd)
        return {
          message: `Added ${scope} memory entry ${entry.name} at ${entry.path}`,
        }
      }
      if (action === "remove") {
        const scope = parts[1] as "project" | "global" | undefined
        const name = parts.slice(2).join(" ").trim()
        if (!scope || !["project", "global"].includes(scope) || !name) {
          return { message: "Usage: /memory remove <project|global> <name>" }
        }
        const removed = await manager.removeEntry(scope, name, context.cwd)
        return {
          message: removed
            ? `Removed ${scope} memory entry ${name}`
            : `Memory entry not found: ${name}`,
        }
      }
      return { message: "Usage: /memory [session|project|global|list|show|index|search|add|remove]" }
    },
  })

  registry.register({
    name: "hooks",
    description: "Show runtime and plugin hook registrations",
    handler: async (args, context) => {
      const parts = words(args)
      const action = parts[0] ?? ""
      if (!action || action === "show" || action === "list") {
        return {
          message: pretty(await context.client.hooks()),
        }
      }
      if (action === "files") {
        return {
          message: pretty(await hooksFileSummary(context)),
        }
      }
      if (action === "init") {
        const scope = parts[1] === "global" ? "global" : "project"
        const target = scope === "global"
          ? join(oneclawHome(), "hooks.json")
          : projectHooksPath(context.cwd)
        if (!existsSync(target)) {
          await writeHooksDocument(target, [])
        }
        return {
          message: `Initialized ${scope} hooks file at ${target}`,
        }
      }
      if (action === "validate") {
        const target = args.replace(/^validate\s*/, "").trim() || projectHooksPath(context.cwd)
        const raw = await readTextIfExists(target)
        if (!raw) {
          return { message: `Hook file not found: ${target}` }
        }
        return {
          message: pretty(validateHooksDocument(JSON.parse(raw))),
        }
      }
      if (action === "add") {
        const hookType = parts[1]
        const event = parts[2]
        const name = parts[3]
        const commandOrUrl = args.split(/\s+/).slice(4).join(" ").trim()
        if (hookType !== "command" || !event || !name || !commandOrUrl) {
          return { message: "Usage: /hooks add command <event> <name> <command>" }
        }
        if (!VALID_HOOK_EVENTS.has(event)) {
          return { message: `Invalid hook event: ${event}` }
        }
        const target = projectHooksPath(context.cwd)
        const document = await readHooksDocument(target)
        document.hooks = document.hooks.filter(hook => hook.name !== name)
        document.hooks.push({
          name,
          event,
          type: "command",
          command: commandOrUrl,
          timeoutMs: 5000,
          blockOnFailure: false,
        })
        await writeHooksDocument(target, document.hooks)
        await context.client.reload()
        return {
          message: `Added command hook ${name} to ${target} and reloaded runtime.`,
        }
      }
      if (action === "remove" && parts[1]) {
        const target = projectHooksPath(context.cwd)
        const document = await readHooksDocument(target)
        const before = document.hooks.length
        document.hooks = document.hooks.filter(hook => hook.name !== parts[1])
        await writeHooksDocument(target, document.hooks)
        await context.client.reload()
        return {
          message: before === document.hooks.length
            ? `Hook not found in project hooks: ${parts[1]}`
            : `Removed hook ${parts[1]} from ${target} and reloaded runtime.`,
        }
      }
      if (action === "reload") {
        await context.client.reload()
        return {
          message: pretty(await context.client.hooks()),
        }
      }
      return { message: "Usage: /hooks [list|files|init [project|global]|validate [path]|add command <event> <name> <command>|remove <name>|reload]" }
    },
  })

  registry.register({
    name: "tools",
    description: "Show tool registry grouped by builtin/plugin/MCP source",
    handler: async (args, context) => {
      const parts = words(args)
      const payload = await context.client.tools({ summaryOnly: parts[0] === "summary" })
      if (!parts[0] || parts[0] === "list" || parts[0] === "summary") {
        return { message: pretty(payload) }
      }
      if (parts[0] === "source" && parts[1]) {
        const tools = Array.isArray(payload.tools) ? payload.tools as Array<Record<string, unknown>> : []
        return {
          message: pretty(tools.filter(tool => tool.source === parts[1])),
        }
      }
      return { message: "Usage: /tools [list|summary|source <builtin|plugin|mcp>]" }
    },
  })

  registry.register({
    name: "plugin",
    description: "Show, install, uninstall, or reload plugins",
    handler: async (args, context) => {
      const parts = words(args)
      const action = parts[0] ?? ""
      const config = await loadConfig(context.cwd)
      if (action === "reload") {
        const state = await context.client.reload()
        return {
          message: `Reloaded runtime with ${extractString(state, "provider")} / ${extractString(state, "activeProfile")}`,
        }
      }
      if (action === "dir") {
        return {
          message: getUserPluginDir(config),
        }
      }
      if (action === "state") {
        return {
          message: pretty(await pluginLifecycleState(config)),
        }
      }
      if (action === "validate") {
        const sourcePath = args.replace(/^validate\s+/, "").trim()
        if (!sourcePath) {
          return { message: "Usage: /plugin validate <path>" }
        }
        return {
          message: pretty(await validatePluginDirectory(sourcePath)),
        }
      }
      if (action === "install") {
        const sourcePath = args.replace(/^install\s+/, "").trim()
        if (!sourcePath) {
          return { message: "Usage: /plugin install <path>" }
        }
        const installed = await installPluginFromPath(config, sourcePath)
        await context.client.reload()
        return {
          message: `Installed plugin ${installed.name}\n${pretty({
            installed,
            reloaded: true,
          })}`,
        }
      }
      if (action === "update" && parts[1]) {
        const updated = await updatePlugin(config, parts[1])
        if (updated.updated) {
          await context.client.reload()
        }
        return {
          message: pretty(updated),
        }
      }
      if ((action === "enable" || action === "disable") && parts[1]) {
        const result = await setPluginEnabled(config, parts[1], action === "enable")
        await context.client.reload()
        return {
          message: pretty(result),
        }
      }
      if (action === "uninstall" && parts[1]) {
        const removed = await uninstallPlugin(config, parts[1])
        if (removed.removed) {
          await context.client.reload()
        }
        return {
          message: removed.removed
            ? `Removed plugin ${parts[1]} from ${removed.destination}`
            : `Plugin not found: ${parts[1]}`,
        }
      }
      if (action === "show" && parts[1]) {
        return {
          message: pretty(await context.client.plugins({
            name: parts[1],
            verbose: true,
          })),
        }
      }
      if (action === "tools" && parts[1]) {
        const payload = await context.client.plugins({
          name: parts[1],
          verbose: true,
        }) as { plugins?: Array<{ toolNames?: string[] }> }
        return {
          message: (payload.plugins?.[0]?.toolNames ?? []).join("\n") || "(no tools)",
        }
      }
      if (action === "hooks" && parts[1]) {
        return {
          message: pretty(await context.client.plugins({
            name: parts[1],
            verbose: true,
          })),
        }
      }
      return {
        message: pretty(await context.client.plugins()),
      }
    },
  })

  registry.register({
    name: "skills",
    description: "Show discovered skills or reload the runtime",
    handler: async (args, context) => {
      const parts = words(args)
      const action = parts[0] ?? ""
      if (action === "reload") {
        await context.client.reload()
        return {
          message: pretty(await context.client.skills()),
        }
      }
      if (action === "search" && parts[1]) {
        return {
          message: pretty(await context.client.skills({
            query: parts.slice(1).join(" "),
          })),
        }
      }
      if (action === "show" && parts[1]) {
        const payload = await context.client.skills({
          query: parts.slice(1).join(" "),
          includeBody: true,
        }) as { skills?: Array<Record<string, unknown>> }
        return {
          message: pretty(payload.skills?.[0] ?? null),
        }
      }
      return {
        message: pretty(await context.client.skills()),
      }
    },
  })

  registry.register({
    name: "tasks",
    description: "Show, run, tail, cancel, or clear local managed task records",
    handler: async (args, context) => {
      const parts = words(args)
      const action = parts[0] ?? ""
      if (action === "run") {
        const goal = args.replace(/^run\s+/, "").trim()
        if (!goal) {
          return { message: "Usage: /tasks run <goal>" }
        }
        const result = await runManagedGoal(context, goal, {
          via: "task-run",
          isolateWorktree: false,
        })
        return {
          message: pretty({
            goal,
            tasks: result.tasks,
            summary: result.summary,
          }),
        }
      }
      if (action === "show" && parts[1]) {
        const taskManager = getCommandTaskManager()
        const record = taskManager.get(parts[1]) ?? null
        const output = record ? await taskManager.readOutput(parts[1], 4000) : ""
        return {
          message: pretty({
            task: record,
            output,
          }),
        }
      }
      if (action === "tail" && parts[1]) {
        const taskManager = getCommandTaskManager()
        const maxChars = parts[2] ? Number.parseInt(parts[2], 10) : 4000
        if (!Number.isFinite(maxChars) || maxChars < 64) {
          return { message: "Usage: /tasks tail <id> [maxChars>=64]" }
        }
        const output = await taskManager.readOutput(parts[1], maxChars)
        return {
          message: output || "(no task output)",
        }
      }
      if (action === "cancel" && parts[1]) {
        const stopped = await getCommandTaskManager().stop(parts[1])
        return {
          message: stopped
            ? `Cancellation requested for ${parts[1]}`
            : `Task not found: ${parts[1]}`,
        }
      }
      if (action === "clear") {
        const scope = (parts[1] as "completed" | "failed" | "killed" | "all" | undefined) ?? "completed"
        if (!["completed", "failed", "killed", "all"].includes(scope)) {
          return { message: "Usage: /tasks clear [completed|failed|killed|all]" }
        }
        const cleared = await getCommandTaskManager().clear(scope)
        return {
          message: pretty(cleared),
        }
      }
      if (action === "status" && parts[1]) {
        const scope = parts[1] as "pending" | "running" | "completed" | "failed" | "killed"
        if (!["pending", "running", "completed", "failed", "killed"].includes(scope)) {
          return { message: "Usage: /tasks status <pending|running|completed|failed|killed>" }
        }
        return {
          message: pretty(getCommandTaskManager().list(scope)),
        }
      }
      return {
        message: pretty({
          runtime: await context.client.tasks(),
          local: getCommandTaskManager().list(),
        }),
      }
    },
  })

  registry.register({
    name: "clear",
    description: "Clear session messages, optionally clearing session memory",
    handler: async (args, context) => {
      const clearMemory = args.trim() === "memory" || args.trim() === "all"
      const result = await context.client.clearSession(context.sessionId, clearMemory)
      return {
        message: `Cleared ${result.clearedMessages} messages from ${result.sessionId}${result.clearedMemory ? " and reset session memory" : ""}.`,
      }
    },
  })

  registry.register({
    name: "rewind",
    description: "Remove the latest assistant turn(s) from the current session",
    handler: async (args, context) => {
      const rawTurns = args.trim()
      const turns = rawTurns ? Number.parseInt(rawTurns, 10) : 1
      if (!Number.isFinite(turns) || turns < 1 || turns > 20) {
        return { message: "Usage: /rewind [turns: 1-20]" }
      }
      const result = await context.client.rewindSession(context.sessionId, turns)
      return {
        message: `Rewound ${result.removedMessages} messages from ${result.sessionId}; ${result.afterMessages} messages remain.`,
      }
    },
  })

  registry.register({
    name: "compact",
    description: "Manually compact the current session into memory",
    handler: async (args, context) => {
      const parts = words(args)
      if (parts[0] === "policy" || parts[0] === "status") {
        return {
          message: pretty(await context.client.compactPolicy(context.sessionId)),
        }
      }
      const result = await context.client.compactSession(context.sessionId)
      return {
        message: `Compacted ${result.compactedMessages} messages in ${result.sessionId}; ${result.afterMessages} messages remain.`,
      }
    },
  })

  registry.register({
    name: "cost",
    description: "Show cumulative token usage and estimated cost",
    handler: async (_args, context) => {
      const usage = await context.client.usage() as {
        inputTokens?: number
        outputTokens?: number
        estimatedCostUsd?: number
      }
      return {
        message: [
          `inputTokens: ${usage.inputTokens ?? 0}`,
          `outputTokens: ${usage.outputTokens ?? 0}`,
          `estimatedCostUsd: ${quote(usage.estimatedCostUsd ?? 0)}`,
        ].join("\n"),
      }
    },
  })

  registry.register({
    name: "usage",
    description: "Show cumulative usage and budget summary",
    handler: async (_args, context) => ({
      message: pretty(await context.client.usage()),
    }),
  })

  registry.register({
    name: "mcp",
    description: "Show MCP statuses and resources",
    handler: async (args, context) => {
      const parts = words(args)
      if (!parts[0] || parts[0] === "status" || parts[0] === "list") {
        return { message: pretty(await context.client.mcp({ verbose: false })) }
      }
      if (parts[0] === "tools") {
        return { message: pretty(await context.client.mcp({ verbose: true })) }
      }
      if (parts[0] === "resources") {
        const payload = await context.client.mcp({ verbose: true }) as { resources?: unknown }
        return { message: pretty(payload.resources ?? []) }
      }
      if (parts[0] === "reconnect") {
        return { message: pretty(await context.client.mcpReconnect(parts[1])) }
      }
      if (parts[0] === "add" && parts[1] && parts[2]) {
        return {
          message: pretty(await context.client.mcpAddServer({
            name: parts[1],
            transport: "stdio",
            command: parts[2],
            args: parts.slice(3),
          })),
        }
      }
      if (parts[0] === "remove" && parts[1]) {
        return { message: pretty(await context.client.mcpRemoveServer(parts[1])) }
      }
      if (parts[0] === "templates") {
        const payload = await context.client.mcp({ verbose: true }) as { resourceTemplates?: unknown }
        return { message: pretty(payload.resourceTemplates ?? []) }
      }
      if (parts[0] === "read" && parts[1] && parts[2]) {
        const payload = await context.client.mcpReadResource(parts[1], parts.slice(2).join(" "))
        return { message: String(payload.content ?? "") }
      }
      return { message: "Usage: /mcp [status|tools|resources|templates|reconnect [server]|add <name> <command> [args...]|remove <server>|read <server> <uri>]" }
    },
  })

  registry.register({
    name: "export",
    description: "Export the current session as json, markdown, or bundle",
    handler: async (args, context) => {
      const format = (args || "markdown").trim()
      if (format === "bundle") {
        const bundle = await context.client.sessionExportBundle(context.sessionId)
        return {
          message: bundle ? pretty(bundle) : "(session not found)",
        }
      }
      if (format !== "json" && format !== "markdown") {
        return {
          message: "Usage: /export [json|markdown|bundle]",
        }
      }
      const exported = await context.client.sessionExport(context.sessionId, format)
      return {
        message: exported?.content ?? "(session not found)",
      }
    },
  })

  registry.register({
    name: "interrupt",
    description: "Interrupt the current session if a request is running",
    handler: async (_args, context) => {
      const result = await context.client.cancelSession(context.sessionId)
      return {
        message: result.accepted
          ? `Interrupt signal sent for ${context.sessionId}`
          : `No active request for ${context.sessionId}`,
      }
    },
  })

  registry.register({
    name: "refresh",
    description: "Refresh or reload the current runtime snapshot",
    handler: async (args, context) => {
      if (args.trim() === "runtime") {
        const state = await context.client.reload()
        return {
          message: `Reloaded runtime for ${extractString(state, "activeProfile")}.`,
        }
      }
      const status = await context.client.status(context.sessionId) as { session?: { id?: string } }
      return {
        message: `Refreshed ${status.session?.id ?? context.sessionId}.`,
      }
    },
  })

  return registry
}
