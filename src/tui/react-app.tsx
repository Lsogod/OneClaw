// @ts-nocheck
import React, {
  startTransition,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react"
import { basename } from "node:path"
import { Box, Text, render, useApp, useInput } from "./ink-runtime.js"
import { listArtifacts, readArtifactContent, type ArtifactRecord } from "../artifacts/catalog.mts"
import { createFrontendCommandRegistry } from "../commands/frontend-registry.mts"
import { loadConfig } from "../config.mts"
import { KernelClient } from "../frontend/kernel-client.mts"
import type { ContentBlock, SessionRecord } from "../types.mts"

type UiEvent = {
  at: string
  label: string
}

type ProviderView = {
  activeProfile?: string
  provider?: {
    label?: string
    model?: string
  }
}

type RuntimeStateView = {
  provider?: string
  model?: string
  activeProfile?: string
  pluginCount?: number
  mcpConnected?: number
  bridgeSessions?: number
  estimatedCostUsd?: number
  permissionMode?: string
  totalInputTokens?: number
  totalOutputTokens?: number
  theme?: string
  outputStyle?: string
  keybindings?: Record<string, string>
  fastMode?: boolean
  effort?: string
  maxPasses?: number
  maxTurns?: number
  vimMode?: boolean
  voiceMode?: boolean
  sandbox?: {
    enabled?: boolean
    available?: boolean
  }
}

type UsageView = {
  estimatedCostUsd?: number
  inputTokens?: number
  outputTokens?: number
  totalInputTokens?: number
  totalOutputTokens?: number
}

type BridgeSessionView = {
  sessionId: string
  team?: string
  status?: string
  taskId?: string
}

type BridgeTaskView = {
  id: string
  status?: string
  metadata?: {
    team?: string
  }
}

type BridgeTeamView = {
  name: string
  goal?: string
  status?: string
  plan?: string[]
  roles?: Record<string, string>
  worktrees?: Record<string, string>
  review?: {
    status?: string
  }
  merge?: {
    status?: string
  }
  agents?: string[]
  tasks?: string[]
  messages?: string[]
}

type BridgeSnapshot = {
  reachable: boolean
  sessions: BridgeSessionView[]
  tasks: BridgeTaskView[]
  teams: BridgeTeamView[]
  error?: string
}

type BridgeViewMode = "overview" | "tasks" | "teams" | "sessions"
type McpViewMode = "overview" | "tools" | "resources" | "statuses"
type ArtifactViewMode = "overview" | "all"

type BridgePanelEntry = {
  value: string
  label: string
}

type BridgeActionOption = {
  value: string
  label: string
  description?: string
}

type McpSnapshot = {
  statuses?: Array<Record<string, unknown>>
  resources?: Array<Record<string, unknown>>
  resourceTemplates?: Array<Record<string, unknown>>
  tools?: Array<Record<string, unknown>>
  toolCount?: number
}

type McpPanelEntry = {
  value: string
  label: string
  kind: "status" | "tool" | "resource" | "template"
  server?: string
  uri?: string
  uriTemplate?: string
}

type ArtifactSnapshot = {
  reachable: boolean
  artifacts: ArtifactRecord[]
  count?: number
  error?: string
}

type ArtifactPanelEntry = {
  value: string
  label: string
}

type ArtifactInspectorView = {
  artifact: ArtifactRecord
  renderMode: "json" | "markdown" | "diff" | "text" | "binary"
  content: string
  truncated: boolean
}

type UiPresentation = {
  primaryColor: string
  mutedColor: string
  submitKey: string
  paletteKey: string
  sessionKey: string
  profileKey: string
  mcpKey: string
  bridgeKey: string
  observabilityKey: string
}

type SseFrame = {
  event: string
  data: string
}

type BundleView = {
  sessionId: string
  memory: string
  markdown: string
  provider: string
  activeProfile: string
  usage: Record<string, unknown>
}

type SelectOption = {
  value: string
  label: string
  description?: string
  active?: boolean
}

type SelectModalState = {
  title: string
  options: SelectOption[]
  onSelect: (value: string) => Promise<void> | void
}

type InputModalState = {
  title: string
  placeholder?: string
  submitLabel?: string
  initialValue?: string
  onSubmit: (value: string) => Promise<void> | void
}

type ConfirmModalState = {
  title: string
  body: string
  confirmLabel?: string
  onConfirm: () => Promise<void> | void
}

type ApprovalRequest = {
  type: "approval_request"
  approvalId: string
  sessionId: string
  toolName: string
  input: Record<string, unknown>
  cwd: string
}

type ModalState =
  | {
      kind: "approval"
      request: ApprovalRequest
    }
  | {
      kind: "select"
      modal: SelectModalState
    }
  | {
      kind: "input"
      modal: InputModalState
    }
  | {
      kind: "confirm"
      modal: ConfirmModalState
    }

const WELCOME_LOGO = [
  " ██████╗ ███╗   ██╗███████╗ ██████╗██╗      █████╗ ██╗    ██╗",
  "██╔═══██╗████╗  ██║██╔════╝██╔════╝██║     ██╔══██╗██║    ██║",
  "██║   ██║██╔██╗ ██║█████╗  ██║     ██║     ███████║██║ █╗ ██║",
  "██║   ██║██║╚██╗██║██╔══╝  ██║     ██║     ██╔══██║██║███╗██║",
  "╚██████╔╝██║ ╚████║███████╗╚██████╗███████╗██║  ██║╚███╔███╔╝",
  " ╚═════╝ ╚═╝  ╚═══╝╚══════╝ ╚═════╝╚══════╝╚═╝  ╚═╝ ╚══╝╚══╝ ",
]

type TranscriptRow = {
  kind: "user" | "assistant" | "tool" | "tool_result" | "system" | "meta"
  text: string
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}...` : value
}

function truncateLabel(value: string, maxLength = 28): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

function basenameSafe(value: string): string {
  const trimmed = value.trim()
  return trimmed ? basename(trimmed) : value
}

function providerWizardDefaults(kind: string) {
  const defaults = {
    "anthropic-compatible": {
      model: "claude-sonnet-4-6",
      baseUrl: "https://api.anthropic.com",
      label: "Anthropic-Compatible API",
      env: "ONECLAW_API_KEY or ANTHROPIC_API_KEY",
    },
    "openai-compatible": {
      model: "gpt-5.4",
      baseUrl: "https://api.openai.com/v1",
      label: "OpenAI-Compatible API",
      env: "ONECLAW_API_KEY or OPENAI_API_KEY",
    },
    "claude-subscription": {
      model: "claude-sonnet-4-6",
      baseUrl: "https://api.anthropic.com",
      label: "Claude Subscription",
      env: "~/.claude/.credentials.json",
    },
    "codex-subscription": {
      model: "gpt-5.4",
      baseUrl: "https://chatgpt.com/backend-api",
      label: "Codex Subscription",
      env: "~/.codex/auth.json",
    },
    "github-copilot": {
      model: "gpt-5.4",
      baseUrl: "https://api.githubcopilot.com",
      label: "GitHub Copilot",
      env: "one auth copilot-login",
    },
  }
  return defaults[kind] ?? defaults["codex-subscription"]
}

export function resolveUiPresentation(runtimeState: RuntimeStateView): UiPresentation {
  const theme = runtimeState.theme ?? "neutral"
  const keybindings = runtimeState.keybindings ?? {}
  return {
    primaryColor: theme === "contrast" ? "white" : theme === "neutral" ? "cyan" : "cyan",
    mutedColor: theme === "contrast" ? "cyan" : "gray",
    submitKey: keybindings.submit ?? "enter",
    paletteKey: keybindings.palette ?? "ctrl+k",
    sessionKey: keybindings.sessions ?? keybindings.session ?? "ctrl+o",
    profileKey: keybindings.profiles ?? keybindings.profile ?? "ctrl+t",
    mcpKey: keybindings.mcp ?? "ctrl+m",
    bridgeKey: keybindings.bridge ?? "ctrl+b",
    observabilityKey: keybindings.observability ?? "ctrl+g",
  }
}

export function resolvePromptInputBorderColor(
  running: boolean,
  presentation: Pick<UiPresentation, "primaryColor">,
): string {
  return running ? "yellow" : "blue"
}

function appendUiEvent(previous: UiEvent[], label: string): UiEvent[] {
  return [
    ...previous,
    {
      at: new Date().toISOString(),
      label,
    },
  ].slice(-14)
}

function previewLines(input: string, count = 8): string[] {
  const trimmed = input.trim()
  if (!trimmed) {
    return ["(empty)"]
  }
  return trimmed
    .split(/\r?\n/)
    .slice(-count)
    .map(line => (line.length > 160 ? `${line.slice(0, 159)}...` : line))
}

function previewHeadLines(input: string, count = 8): string[] {
  const trimmed = input.trim()
  if (!trimmed) {
    return []
  }
  return trimmed
    .split(/\r?\n/)
    .slice(0, count)
    .map(line => (line.length > 160 ? `${line.slice(0, 159)}...` : line))
}

function compactStatus(input: string): string {
  return input.trim().split(/\r?\n/)[0] || "Ready"
}

function blockToText(block: ContentBlock): string {
  if (block.type === "text") {
    return block.text
  }
  if (block.type === "tool_call") {
    return `${block.name} ${JSON.stringify(block.input ?? {})}`
  }
  return `${block.name} ${block.result}`
}

export function sessionToTranscript(
  session: SessionRecord | null,
  assistantBuffer: string,
  pendingUserMessages: string[] = [],
): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  if (session) {
    for (const message of session.messages.slice(-16)) {
      const textParts = message.content
        .filter(block => block.type === "text")
        .map(block => block.text.trim())
        .filter(Boolean)
      if (textParts.length > 0) {
        rows.push({
          kind: message.role,
          text: textParts.join("\n"),
        })
      }
      for (const block of message.content) {
        if (block.type === "tool_call") {
          rows.push({
            kind: "tool",
            text: `${block.name} ${JSON.stringify(block.input ?? {})}`,
          })
        } else if (block.type === "tool_result") {
          rows.push({
            kind: "tool_result",
            text: `${block.name} ${block.result}`,
          })
        }
      }
    }
  }
  for (const message of pendingUserMessages) {
    if (message.trim()) {
      rows.push({
        kind: "user",
        text: message,
      })
    }
  }
  if (assistantBuffer.trim()) {
    rows.push({
      kind: "assistant",
      text: assistantBuffer,
    })
  }
  if (rows.length === 0) {
    rows.push({
      kind: "meta",
      text: "Start with a prompt or a slash command. OneClaw will create or continue a session here.",
    })
    rows.push({
      kind: "meta",
      text: "Useful keys: Enter submit, Esc interrupt, ↑/↓ history, Ctrl+O sessions, Ctrl+K palette, Ctrl+R refresh.",
    })
  }
  return rows
}

function hasRealConversation(
  session: SessionRecord | null,
  assistantBuffer: string,
  pendingUserMessages: string[] = [],
): boolean {
  return Boolean(session && session.messages.length > 0)
    || assistantBuffer.trim().length > 0
    || pendingUserMessages.some(message => message.trim().length > 0)
}

export function commandHints(helpText: string, buffer: string): string[] {
  const trimmed = buffer.trim()
  if (!trimmed.startsWith("/")) {
    return []
  }
  if (/\s/.test(trimmed)) {
    return []
  }
  const query = trimmed.toLowerCase()
  return helpText
    .split("\n")
    .filter(line => line.toLowerCase().startsWith(query))
    .slice(0, 6)
}

function commandValueFromHint(hint: string): string {
  return hint.trim().split(/\s+/)[0] ?? hint.trim()
}

function historyValue(history: string[], index: number): string {
  if (index < 0 || index >= history.length) {
    return ""
  }
  return history[index] ?? ""
}

export function resolveStatusBarStats(runtimeState: RuntimeStateView, usage: UsageView) {
  return {
    provider: String(runtimeState.provider ?? "unknown"),
    profile: String(runtimeState.activeProfile ?? "unknown"),
    model: String(runtimeState.model ?? "unknown"),
    permissionMode: String(runtimeState.permissionMode ?? "ask"),
    tokensIn: Number(usage.totalInputTokens ?? usage.inputTokens ?? runtimeState.totalInputTokens ?? 0),
    tokensOut: Number(usage.totalOutputTokens ?? usage.outputTokens ?? runtimeState.totalOutputTokens ?? 0),
    mcpConnected: String(runtimeState.mcpConnected ?? 0),
    pluginCount: String(runtimeState.pluginCount ?? 0),
    estimatedCostUsd: Number(usage.estimatedCostUsd ?? runtimeState.estimatedCostUsd ?? 0),
    effort: String(runtimeState.effort ?? "medium"),
    fastMode: Boolean(runtimeState.fastMode),
    vimMode: Boolean(runtimeState.vimMode),
    voiceMode: Boolean(runtimeState.voiceMode),
  }
}

export function buildInfoPanelLines(selectedSession: SessionRecord | null, inspectorSource: string): string[] {
  if (inspectorSource.trim()) {
    return previewHeadLines(inspectorSource, 10)
  }
  const lines: string[] = []
  if (selectedSession) {
    lines.push(`session ${shortId(selectedSession.id)} · ${basenameSafe(selectedSession.cwd)}`)
  }
  return lines
}

function resolveBridgeAuthHeader(config: {
  authToken?: string
  authTokens?: Array<{
    token: string
    scopes?: string[]
  }>
}): string | null {
  if (config.authToken) {
    return `Bearer ${config.authToken}`
  }
  const scopedToken = config.authTokens?.find(token =>
    (token.scopes ?? []).includes("read") || (token.scopes ?? []).includes("admin"),
  )
  const fallback = scopedToken ?? config.authTokens?.[0]
  return fallback?.token ? `Bearer ${fallback.token}` : null
}

async function loadBridgeSnapshotForUi(cwd: string): Promise<BridgeSnapshot> {
  const config = await loadConfig(cwd)
  const baseUrl = `http://${config.bridge.host}:${config.bridge.port}`
  const authorization = resolveBridgeAuthHeader(config.bridge)
  const headers = authorization ? { authorization } : undefined

  try {
    const [sessionsResponse, tasksResponse, teamsResponse] = await Promise.all([
      fetch(`${baseUrl}/bridge/sessions`, { headers }),
      fetch(`${baseUrl}/tasks`, { headers }),
      fetch(`${baseUrl}/teams`, { headers }),
    ])
    if (!sessionsResponse.ok || !tasksResponse.ok || !teamsResponse.ok) {
      throw new Error(`bridge unreachable (${sessionsResponse.status}/${tasksResponse.status}/${teamsResponse.status})`)
    }
    const [sessions, tasks, teams] = await Promise.all([
      sessionsResponse.json() as Promise<BridgeSessionView[]>,
      tasksResponse.json() as Promise<BridgeTaskView[]>,
      teamsResponse.json() as Promise<BridgeTeamView[]>,
    ])
    return {
      reachable: true,
      sessions,
      tasks,
      teams,
    }
  } catch (error) {
    return {
      reachable: false,
      sessions: [],
      tasks: [],
      teams: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

async function loadArtifactSnapshotForUi(cwd: string): Promise<ArtifactSnapshot> {
  try {
    const payload = await listArtifacts(cwd)
    return {
      reachable: true,
      count: payload.count,
      artifacts: payload.artifacts,
    }
  } catch (error) {
    return {
      reachable: false,
      artifacts: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function buildBridgeSummaryLines(snapshot: BridgeSnapshot): string[] {
  if (!snapshot.reachable) {
    return snapshot.error ? [`bridge offline · ${snapshot.error}`] : ["bridge offline"]
  }
  const runningTasks = snapshot.tasks.filter(task => task.status === "running").length
  const activeSessions = snapshot.sessions.filter(session => session.status === "running").length
  const activeTeams = snapshot.teams.filter(team => team.status === "running").length
  const lines = [
    `bridge ${snapshot.sessions.length} sessions · ${snapshot.tasks.length} tasks · ${snapshot.teams.length} teams`,
    `running ${activeSessions} sessions · ${runningTasks} tasks · ${activeTeams} teams`,
  ]
  const recentTeams = snapshot.teams.slice(0, 3).map(team => {
    const status = team.status ?? "idle"
    return `${team.name}:${status}`
  })
  if (recentTeams.length > 0) {
    lines.push(`teams ${recentTeams.join(", ")}`)
  }
  return lines
}

async function bridgeFetchForUi(
  cwd: string,
  pathname: string,
  options: {
    method?: string
    body?: unknown
    text?: boolean
  } = {},
): Promise<unknown> {
  const config = await loadConfig(cwd)
  const baseUrl = `http://${config.bridge.host}:${config.bridge.port}`
  const authorization = resolveBridgeAuthHeader(config.bridge)
  const headers: HeadersInit = {
    ...(authorization ? { authorization } : {}),
    ...(options.body ? { "content-type": "application/json" } : {}),
  }
  const response = await fetch(`${baseUrl}${pathname}`, {
    headers,
    method: options.method,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  if (!response.ok) {
    throw new Error(`bridge request failed (${response.status})`)
  }
  return options.text ? response.text() : response.json()
}

export function buildArtifactPanelEntries(
  snapshot: ArtifactSnapshot,
  query = "",
  page = 0,
  pageSize = 12,
): ArtifactPanelEntry[] {
  if (!snapshot.reachable) {
    return []
  }
  const normalizedQuery = query.trim().toLowerCase()
  const filtered = normalizedQuery
    ? snapshot.artifacts.filter(artifact => [
        artifact.id,
        artifact.kind,
        artifact.name,
        artifact.source ?? "",
        artifact.contentType,
        JSON.stringify(artifact.metadata ?? {}),
      ].join("\n").toLowerCase().includes(normalizedQuery))
    : snapshot.artifacts
  const start = Math.max(0, page) * Math.max(1, pageSize)
  return filtered.slice(start, start + Math.max(1, pageSize)).map(artifact => ({
    value: artifact.id,
    label: [
      shortId(artifact.id),
      artifact.kind,
      artifact.source ?? artifact.name,
      `${artifact.bytes}b`,
    ].filter(Boolean).join(" · "),
  }))
}

export function buildArtifactPanelLines(
  snapshot: ArtifactSnapshot,
  mode: ArtifactViewMode = "overview",
  query = "",
  page = 0,
  pageSize = 12,
): string[] {
  if (!snapshot.reachable) {
    return [`artifacts offline · ${snapshot.error ?? "unknown error"}`]
  }
  if (snapshot.artifacts.length === 0) {
    return ["no artifacts yet", "/fetch --artifact · /symbols --artifact · /swarm artifact <team>"]
  }
  if (mode === "overview") {
    const byKind = new Map<string, number>()
    for (const artifact of snapshot.artifacts) {
      byKind.set(artifact.kind, (byKind.get(artifact.kind) ?? 0) + 1)
    }
    return [
      `${snapshot.artifacts.length} artifacts · ${[...byKind.entries()].map(([kind, count]) => `${kind}:${count}`).join(" · ")}`,
      ...snapshot.artifacts.slice(0, 5).map(artifact => `${shortId(artifact.id)} · ${artifact.kind} · ${artifact.source ?? artifact.name}`),
    ]
  }
  const entries = buildArtifactPanelEntries(snapshot, query, page, pageSize)
  const filteredCount = query.trim()
    ? buildArtifactPanelEntries(snapshot, query, 0, Number.MAX_SAFE_INTEGER).length
    : snapshot.artifacts.length
  return [
    `page ${page + 1}/${Math.max(1, Math.ceil(filteredCount / Math.max(1, pageSize)))} · ${filteredCount} match(es)${query.trim() ? ` · search "${query.trim()}"` : ""}`,
    ...entries.map(entry => entry.label),
  ]
}

export function formatArtifactContentForInspector(
  payload: { record: ArtifactRecord; content: string },
  maxChars = 12_000,
): ArtifactInspectorView {
  const record = payload.record
  const contentType = record.contentType.toLowerCase()
  const filename = `${record.name}.${record.relativePath}`.toLowerCase()
  const renderMode = payload.content.includes("\0")
    ? "binary"
    : contentType.includes("json") || filename.endsWith(".json")
      ? "json"
      : contentType.includes("markdown") || filename.endsWith(".md")
        ? "markdown"
        : contentType.includes("diff") || filename.endsWith(".diff") || filename.endsWith(".patch")
          ? "diff"
          : "text"
  const content = renderMode === "binary"
    ? `[binary artifact omitted: ${record.bytes} bytes]`
    : payload.content.slice(0, maxChars)
  return {
    artifact: record,
    renderMode,
    content,
    truncated: renderMode !== "binary" && payload.content.length > maxChars,
  }
}

export function buildObservabilityPanelLines(
  runtimeState: RuntimeStateView,
  usage: UsageView,
  events: UiEvent[],
): string[] {
  const cost = Number(usage.estimatedCostUsd ?? runtimeState.estimatedCostUsd ?? 0)
  const inputTokens = Number(usage.inputTokens ?? usage.totalInputTokens ?? runtimeState.totalInputTokens ?? 0)
  const outputTokens = Number(usage.outputTokens ?? usage.totalOutputTokens ?? runtimeState.totalOutputTokens ?? 0)
  return [
    `cost $${cost.toFixed(4)} · tokens ${inputTokens}↓ ${outputTokens}↑`,
    `provider ${runtimeState.provider ?? "unknown"} · profile ${runtimeState.activeProfile ?? "default"} · model ${runtimeState.model ?? "unknown"}`,
    `sandbox ${runtimeState.sandbox?.enabled ? "enabled" : "disabled"} · available ${runtimeState.sandbox?.available ? "yes" : "no"}`,
    ...events.slice(-6).map(event => `${event.at.slice(11, 19)} ${event.label}`),
  ]
}

export function buildBridgePanelEntries(
  snapshot: BridgeSnapshot,
  mode: BridgeViewMode,
  selectedSessionId = "",
): BridgePanelEntry[] {
  if (!snapshot.reachable) {
    return [{
      value: "bridge-offline",
      label: snapshot.error ? `bridge offline · ${snapshot.error}` : "bridge offline",
    }]
  }

  if (mode === "tasks") {
    return snapshot.tasks.slice(0, 8).map(task => ({
      value: task.id,
      label: `${task.id} · ${task.status ?? "unknown"}${task.metadata?.team ? ` · ${task.metadata.team}` : ""}`,
    }))
  }

  if (mode === "teams") {
    return snapshot.teams.slice(0, 8).map(team => ({
      value: team.name,
      label: [
        team.name,
        team.status ?? "idle",
        `${team.agents?.length ?? 0} agents`,
        `${team.tasks?.length ?? 0} tasks`,
        `${team.plan?.length ?? 0} plan`,
        `${Object.keys(team.roles ?? {}).length} roles`,
        team.review?.status ? `review:${team.review.status}` : undefined,
        team.merge?.status ? `merge:${team.merge.status}` : undefined,
        `${team.messages?.length ?? 0} msgs`,
        team.goal ? truncateLabel(team.goal, 26) : undefined,
      ].filter(Boolean).join(" · "),
    }))
  }

  if (mode === "sessions") {
    return snapshot.sessions.slice(0, 8).map(session => ({
      value: session.sessionId,
      label: `${shortId(session.sessionId)} · ${session.status ?? "unknown"}${session.team ? ` · ${session.team}` : ""}${session.sessionId === selectedSessionId ? " *" : ""}`,
    }))
  }

  return buildBridgeSummaryLines(snapshot).map((line, index) => ({
    value: `overview-${index}`,
    label: line,
  }))
}

export function buildBridgePanelLines(
  snapshot: BridgeSnapshot,
  mode: BridgeViewMode,
  selectedSessionId = "",
): string[] {
  const entries = buildBridgePanelEntries(snapshot, mode, selectedSessionId)
  if (entries.length === 0) {
    return [mode === "overview" ? "bridge ready" : `no bridge ${mode}`]
  }
  return entries.map(entry => entry.label)
}

export function buildBridgeActionOptions(
  mode: BridgeViewMode,
  selected: BridgePanelEntry | null,
): BridgeActionOption[] {
  if (mode === "overview") {
    return [
      {
        value: "refresh-bridge",
        label: "Refresh bridge snapshot",
        description: "Reload sessions, tasks, and teams from the control plane",
      },
    ]
  }
  if (!selected || selected.value === "bridge-offline") {
    return []
  }
  if (mode === "tasks") {
    return [
      {
        value: "inspect-task",
        label: "Inspect task",
        description: "Show task details and recent output",
      },
      {
        value: "show-task-session",
        label: "Open task session",
        description: "Inspect the bridge session linked to this task",
      },
      {
        value: "cancel-task",
        label: "Cancel task",
        description: "Stop the running task through bridge control",
      },
    ]
  }
  if (mode === "teams") {
    return [
      {
        value: "inspect-team",
        label: "Inspect team",
        description: "Show team state, tasks, and sessions",
      },
      {
        value: "focus-team-tasks",
        label: "View team tasks",
        description: "Switch the bridge panel to tasks filtered by this team",
      },
      {
        value: "focus-team-sessions",
        label: "View team sessions",
        description: "Switch the bridge panel to sessions for this team",
      },
      {
        value: "set-team-goal",
        label: "Set team goal",
        description: "Update the team's persisted goal",
      },
      {
        value: "run-team-goal",
        label: "Run team goal",
        description: "Launch bridge-managed work for this team",
      },
      {
        value: "message-team",
        label: "Message team",
        description: "Send a control message to this team",
      },
    ]
  }
  return [
    {
      value: "inspect-session",
      label: "Inspect session",
      description: "Show bridge session metadata and history",
    },
    {
      value: "use-session",
      label: "Switch to session",
      description: "Make this bridge session the active local session",
    },
    {
      value: "interrupt-session",
      label: "Interrupt session",
      description: "Send an interrupt through the bridge control plane",
    },
    {
      value: "export-session",
      label: "Export session artifact",
      description: "Create a markdown artifact for this session",
    },
  ]
}

export function buildMcpPanelLines(snapshot: McpSnapshot, mode: McpViewMode): string[] {
  const statuses = Array.isArray(snapshot.statuses) ? snapshot.statuses : []
  const resources = Array.isArray(snapshot.resources) ? snapshot.resources : []
  const resourceTemplates = Array.isArray(snapshot.resourceTemplates) ? snapshot.resourceTemplates : []
  const tools = Array.isArray(snapshot.tools) ? snapshot.tools : []
  if (mode === "statuses") {
    return statuses.length > 0
      ? statuses.slice(0, 8).map(status => `${status.name ?? "server"} · ${status.state ?? "unknown"}${status.detail ? ` · ${status.detail}` : ""}`)
      : ["no MCP servers configured"]
  }
  if (mode === "tools") {
    return tools.length > 0
      ? tools.slice(0, 8).map(tool => `${tool.qualifiedName ?? tool.name ?? "tool"} · ${tool.readOnly ? "read" : "write"}${tool.description ? ` · ${truncateLabel(String(tool.description), 48)}` : ""}`)
      : ["no MCP tools exposed"]
  }
  if (mode === "resources") {
    return resources.length > 0 || resourceTemplates.length > 0
      ? [
        ...resources.slice(0, 6).map(resource => `${resource.server ?? "server"} · ${truncateLabel(String(resource.uri ?? ""), 68)}`),
        ...resourceTemplates.slice(0, 2).map(template => `${template.server ?? "server"} · template · ${truncateLabel(String(template.uriTemplate ?? ""), 56)}`),
      ]
      : ["no MCP resources exposed"]
  }
  const connected = statuses.filter(status => status.state === "connected").length
  const degraded = statuses.filter(status => status.state === "degraded").length
  const failed = statuses.filter(status => status.state === "failed").length
  return [
    `servers ${statuses.length} · connected ${connected} · degraded ${degraded} · failed ${failed}`,
    `tools ${tools.length || snapshot.toolCount || 0} · resources ${resources.length} · templates ${resourceTemplates.length}`,
    "ctrl+m cycle · /mcp tools · /mcp resources · /mcp reconnect [server]",
  ]
}

export function buildMcpPanelEntries(snapshot: McpSnapshot, mode: McpViewMode): McpPanelEntry[] {
  const statuses = Array.isArray(snapshot.statuses) ? snapshot.statuses : []
  const resources = Array.isArray(snapshot.resources) ? snapshot.resources : []
  const resourceTemplates = Array.isArray(snapshot.resourceTemplates) ? snapshot.resourceTemplates : []
  const tools = Array.isArray(snapshot.tools) ? snapshot.tools : []
  if (mode === "statuses") {
    return statuses.map(status => ({
      kind: "status",
      value: String(status.name ?? "server"),
      server: String(status.name ?? ""),
      label: `${status.name ?? "server"} · ${status.state ?? "unknown"}${status.detail ? ` · ${status.detail}` : ""}`,
    }))
  }
  if (mode === "tools") {
    return tools.map(tool => ({
      kind: "tool",
      value: String(tool.qualifiedName ?? tool.name ?? "tool"),
      server: typeof tool.server === "string" ? tool.server : undefined,
      label: `${tool.qualifiedName ?? tool.name ?? "tool"} · ${tool.readOnly ? "read" : "write"}${tool.description ? ` · ${truncateLabel(String(tool.description), 48)}` : ""}`,
    }))
  }
  if (mode === "resources") {
    return [
      ...resources.map(resource => ({
        kind: "resource" as const,
        value: String(resource.uri ?? ""),
        server: String(resource.server ?? ""),
        uri: String(resource.uri ?? ""),
        label: `${resource.server ?? "server"} · ${truncateLabel(String(resource.uri ?? ""), 68)}`,
      })),
      ...resourceTemplates.map(template => ({
        kind: "template" as const,
        value: String(template.uriTemplate ?? ""),
        server: String(template.server ?? ""),
        uriTemplate: String(template.uriTemplate ?? ""),
        label: `${template.server ?? "server"} · template · ${truncateLabel(String(template.uriTemplate ?? ""), 56)}`,
      })),
    ]
  }
  return []
}

export function buildMcpActionOptions(mode: McpViewMode, selected: McpPanelEntry | null): BridgeActionOption[] {
  if (!selected || mode === "overview") {
    return [{ value: "refresh-mcp", label: "Refresh MCP" }]
  }
  if (selected.kind === "status") {
    return [
      { value: "inspect-mcp", label: "Inspect server" },
      { value: "configure-mcp-auth", label: "Configure auth" },
      { value: "reconnect-mcp", label: "Reconnect server" },
    ]
  }
  if (selected.kind === "resource") {
    return [
      { value: "inspect-mcp", label: "Inspect resource" },
      { value: "read-mcp-resource", label: "Read resource" },
    ]
  }
  if (selected.kind === "template") {
    return [
      { value: "inspect-mcp", label: "Inspect template" },
      { value: "read-mcp-template", label: "Fill and read template" },
    ]
  }
  return [{ value: "inspect-mcp", label: "Inspect tool" }]
}

function nextBridgeViewMode(mode: BridgeViewMode): BridgeViewMode {
  switch (mode) {
    case "overview":
      return "tasks"
    case "tasks":
      return "teams"
    case "teams":
      return "sessions"
    default:
      return "overview"
  }
}

export function shouldRenderBridgePanel(mode: BridgeViewMode): boolean {
  return mode !== "overview"
}

export function shouldRenderMcpPanel(mode: McpViewMode): boolean {
  return mode !== "overview"
}

export function extractSseFrames(buffer: string): {
  frames: SseFrame[]
  rest: string
} {
  const normalized = buffer.replace(/\r\n/g, "\n")
  const parts = normalized.split("\n\n")
  const rest = parts.pop() ?? ""
  const frames: SseFrame[] = []
  for (const part of parts) {
    const trimmed = part.trim()
    if (!trimmed) {
      continue
    }
    let event = "message"
    const dataLines: string[] = []
    for (const line of trimmed.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim()
        continue
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart())
      }
    }
    if (dataLines.length > 0) {
      frames.push({
        event,
        data: dataLines.join("\n"),
      })
    }
  }
  return { frames, rest }
}

async function connectJsonSse<T>(
  url: string,
  headers: HeadersInit | undefined,
  eventName: string,
  onData: (value: T) => void,
): Promise<() => void> {
  let disposed = false
  let controller: AbortController | null = null
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null

  const scheduleReconnect = () => {
    if (disposed || reconnectTimer) {
      return
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void run()
    }, 1500)
  }

  const run = async () => {
    controller = new AbortController()
    try {
      const response = await fetch(url, {
        headers,
        signal: controller.signal,
      })
      if (!response.ok || !response.body) {
        scheduleReconnect()
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      while (!disposed) {
        const { done, value } = await reader.read()
        if (done) {
          break
        }
        buffer += decoder.decode(value, { stream: true })
        const parsed = extractSseFrames(buffer)
        buffer = parsed.rest
        for (const frame of parsed.frames) {
          if (frame.event !== eventName) {
            continue
          }
          try {
            onData(JSON.parse(frame.data) as T)
          } catch {
            // ignore malformed SSE payloads
          }
        }
      }
      scheduleReconnect()
    } catch {
      if (!disposed) {
        scheduleReconnect()
      }
    }
  }

  void run()

  return () => {
    disposed = true
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    controller?.abort()
  }
}

async function connectBridgeRealtime(
  cwd: string,
  onUpdate: (patch: Partial<BridgeSnapshot>) => void,
): Promise<() => void> {
  const config = await loadConfig(cwd)
  const baseUrl = `http://${config.bridge.host}:${config.bridge.port}`
  const authorization = resolveBridgeAuthHeader(config.bridge)
  const headers = authorization ? { authorization } : undefined

  const unsubscribers = await Promise.all([
    connectJsonSse<BridgeSessionView[]>(
      `${baseUrl}/bridge/sessions/stream`,
      headers,
      "sessions",
      sessions => onUpdate({ sessions, reachable: true, error: undefined }),
    ),
    connectJsonSse<BridgeTaskView[]>(
      `${baseUrl}/tasks/stream`,
      headers,
      "tasks",
      tasks => onUpdate({ tasks, reachable: true, error: undefined }),
    ),
    connectJsonSse<BridgeTeamView[]>(
      `${baseUrl}/teams/stream`,
      headers,
      "teams",
      teams => onUpdate({ teams, reachable: true, error: undefined }),
    ),
  ])

  return () => {
    for (const unsubscribe of unsubscribers) {
      unsubscribe()
    }
  }
}

function TonePrefix({ kind }: { kind: TranscriptRow["kind"] }) {
  switch (kind) {
    case "user":
      return <Text color="cyan" bold>{"you "}</Text>
    case "assistant":
      return <Text color="green" bold>{"one "}</Text>
    case "tool":
      return <Text color="yellow" bold>{"tool "}</Text>
    case "tool_result":
      return <Text color="magenta" bold>{"done "}</Text>
    case "system":
      return <Text color="red" bold>{"sys "}</Text>
    default:
      return <Text dim>{".. "}</Text>
  }
}

function Frame(props: {
  title: string
  subtitle?: string
  width?: number
  flexGrow?: number
  children: React.ReactNode
}) {
  return (
    <Box
      flexDirection="column"
      width={props.width}
      flexGrow={props.flexGrow ?? 0}
      marginRight={props.width ? 0 : 1}
      marginBottom={1}
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      paddingY={1}
    >
      <Text bold>{props.title}</Text>
      {props.subtitle ? <Text dim>{props.subtitle}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {props.children}
      </Box>
    </Box>
  )
}

function WelcomeBanner() {
  return (
    <Box flexDirection="column" marginBottom={1}>
      {WELCOME_LOGO.map(line => (
        <Text key={line} color="cyan">
          {line}
        </Text>
      ))}
      <Text> </Text>
      <Text dim>{"OneClaw coding agent harness · transcript-first UI"}</Text>
      <Text dim>{"Panels stay folded by default: Ctrl+B bridge · Ctrl+M MCP · Ctrl+A artifacts · Ctrl+G observability"}</Text>
    </Box>
  )
}

function ActivityLine(props: {
  running: boolean
  statusLine: string
  activeRequestId: string | null
}) {
  if (!props.running) {
    return <Text dim>{props.statusLine}</Text>
  }
  return (
    <Text color="yellow">
      {"● "}
      <Text>{props.statusLine}</Text>
      {props.activeRequestId ? <Text dim>{`  ${props.activeRequestId}`}</Text> : null}
    </Text>
  )
}

function CommandPicker(props: {
  title?: string
  hints: string[]
  selectedIndex: number
}) {
  if (props.hints.length === 0) {
    return null
  }
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginTop={1}
    >
      <Text bold color="cyan">{props.title ?? "Commands"}</Text>
      {props.hints.map((hint, index) => {
        const selected = index === props.selectedIndex
        return (
          <Box key={hint}>
            <Text color={selected ? "cyan" : undefined} bold={selected}>
              {selected ? "❯ " : "  "}
              {hint}
            </Text>
          </Box>
        )
      })}
      <Text dim>{"↑↓ navigate  enter select  tab fill  esc dismiss"}</Text>
    </Box>
  )
}

function SelectModal(props: {
  modal: SelectModalState
  selectedIndex: number
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={1}
      marginBottom={1}
    >
      <Text bold color="cyan">{props.modal.title}</Text>
      <Text> </Text>
      {props.modal.options.map((option, index) => {
        const selected = index === props.selectedIndex
        return (
          <Box key={option.value}>
            <Text color={selected ? "cyan" : undefined} bold={selected}>
              {selected ? "❯ " : "  "}
              {option.label}
            </Text>
            {option.active ? <Text color="green"> (current)</Text> : null}
            {option.description ? <Text dim>{`  ${option.description}`}</Text> : null}
          </Box>
        )
      })}
      <Text> </Text>
      <Text dim>{"↑↓ navigate  enter select  esc cancel"}</Text>
    </Box>
  )
}

function InputModal(props: {
  modal: InputModalState
  value: string
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      paddingY={1}
      marginBottom={1}
    >
      <Text bold color="cyan">{props.modal.title}</Text>
      <Text> </Text>
      <Text>{props.value || props.modal.placeholder || ""}</Text>
      <Text> </Text>
      <Text dim>{`${props.modal.submitLabel ?? "enter submit"}  esc cancel`}</Text>
    </Box>
  )
}

function ConfirmModal(props: {
  modal: ConfirmModalState
}) {
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellow"
      paddingX={1}
      paddingY={1}
      marginBottom={1}
    >
      <Text color="yellow" bold>{props.modal.title}</Text>
      <Text> </Text>
      <Text>{props.modal.body}</Text>
      <Text> </Text>
      <Text>
        <Text color="green">{`[enter/y] ${props.modal.confirmLabel ?? "confirm"}`}</Text>
        <Text>{"  "}</Text>
        <Text color="red">{"[n/esc] cancel"}</Text>
      </Text>
    </Box>
  )
}

function ModalHost(props: {
  modalState: ModalState | null
  selectIndex: number
  inputValue: string
}) {
  if (!props.modalState) {
    return null
  }
  if (props.modalState.kind === "select") {
    return <SelectModal modal={props.modalState.modal} selectedIndex={props.selectIndex} />
  }
  if (props.modalState.kind === "input") {
    return <InputModal modal={props.modalState.modal} value={props.inputValue} />
  }
  if (props.modalState.kind === "confirm") {
    return <ConfirmModal modal={props.modalState.modal} />
  }
  const { request } = props.modalState
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="yellow"
      paddingX={1}
      paddingY={1}
      marginBottom={1}
    >
      <Text color="yellow" bold>{"Permission Required"}</Text>
      <Text>{`Allow ${request.toolName}?`}</Text>
      <Text dim>{`cwd: ${request.cwd}`}</Text>
      <Text dim>{JSON.stringify(request.input ?? {})}</Text>
      <Text> </Text>
      <Text>
        <Text color="green">[y] allow</Text>
        <Text>{"  "}</Text>
        <Text color="red">[n] deny</Text>
        <Text>{"  "}</Text>
        <Text dim>{"esc cancel"}</Text>
      </Text>
    </Box>
  )
}

function ConversationPane(props: {
  session: SessionRecord | null
  assistantBuffer: string
  pendingUserMessages: string[]
  showWelcome: boolean
}) {
  if (!props.showWelcome && !props.session && !props.assistantBuffer.trim() && props.pendingUserMessages.length === 0) {
    return <Box flexDirection="column" flexGrow={1} />
  }
  const showWelcome = props.showWelcome && !hasRealConversation(props.session, props.assistantBuffer, props.pendingUserMessages)
  const rows = showWelcome ? [] : sessionToTranscript(props.session, props.assistantBuffer, props.pendingUserMessages)
  return (
    <Box flexDirection="column" flexGrow={1}>
      {showWelcome ? <WelcomeBanner /> : null}
      {rows.map((row, index) => (
        <Box key={`${row.kind}-${index}`} flexDirection="row" marginBottom={row.kind === "meta" ? 0 : 1}>
          <TonePrefix kind={row.kind} />
          <Text wrap="wrap">{row.text}</Text>
        </Box>
      ))}
    </Box>
  )
}

function InfoPanel(props: {
  selectedSession: SessionRecord | null
  sessionCount: number
  profileLabel: string
  inspectorSource: string
  events: UiEvent[]
  bridgeSnapshot: BridgeSnapshot
}) {
  const bridgeLines = props.bridgeSnapshot.reachable ? buildBridgeSummaryLines(props.bridgeSnapshot) : []
  const lines = buildInfoPanelLines(props.selectedSession, props.inspectorSource)
  const hasExtraInfo = lines.length > 0 || props.inspectorSource.trim().length > 0 || props.events.length > 0 || bridgeLines.length > 0
  if (!hasExtraInfo) {
    return null
  }

  const recentEvents = props.events.slice(-3)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
      <Text bold>{props.inspectorSource.trim() ? "Output" : "Context"}</Text>
      <Text dim>{`${props.sessionCount} sessions · profile=${props.profileLabel}`}</Text>
      <Text> </Text>
      {lines.map((line, index) => (
        <Text key={`info-${index}`} dim={index > 0}>{line}</Text>
      ))}
      {bridgeLines.length > 0 ? (
        <>
          <Text> </Text>
          <Text dim>{"Bridge"}</Text>
          {bridgeLines.map((line, index) => (
            <Text key={`bridge-${index}`} dim wrap="truncate-end">
              {line}
            </Text>
          ))}
        </>
      ) : null}
      {recentEvents.length > 0 ? (
        <>
          <Text> </Text>
          <Text dim>{"Recent events"}</Text>
          {recentEvents.map(event => (
            <Text key={`${event.at}-${event.label}`} dim wrap="truncate-end">
              {`${event.at.slice(11, 19)} ${event.label}`}
            </Text>
          ))}
        </>
      ) : null}
    </Box>
  )
}

function BridgePanel(props: {
  snapshot: BridgeSnapshot
  mode: BridgeViewMode
  selectedSessionId: string
  selectionIndex: number
}) {
  const entries = buildBridgePanelEntries(props.snapshot, props.mode, props.selectedSessionId)
  const lines = entries.length > 0
    ? entries.map(entry => entry.label)
    : buildBridgePanelLines(props.snapshot, props.mode, props.selectedSessionId)
  if (lines.length === 0) {
    return null
  }
  const title = props.mode === "overview"
    ? "Bridge"
    : `Bridge ${props.mode}`
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
      <Text bold>{title}</Text>
      <Text dim>{"Ctrl+B cycle  [ ] move  Enter inspect  . actions  X cancel  E export  M/R team actions"}</Text>
      <Text> </Text>
      {lines.map((line, index) => (
        <Text
          key={`bridge-panel-${index}`}
          color={index === props.selectionIndex && props.mode !== "overview" ? "cyan" : undefined}
          bold={index === props.selectionIndex && props.mode !== "overview"}
          dim={index > 0 && !(index === props.selectionIndex && props.mode !== "overview")}
          wrap="truncate-end"
        >
          {line}
        </Text>
      ))}
    </Box>
  )
}

function McpPanel(props: {
  snapshot: McpSnapshot
  mode: McpViewMode
  selectionIndex: number
}) {
  const lines = buildMcpPanelLines(props.snapshot, props.mode)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
      <Text bold>{props.mode === "overview" ? "MCP" : `MCP ${props.mode}`}</Text>
      <Text dim>{"Ctrl+M cycle  [ ] select  . actions  /mcp read-template <server> <template>"}</Text>
      <Text> </Text>
      {lines.map((line, index) => (
        <Text
          key={`mcp-panel-${index}`}
          color={index === props.selectionIndex && props.mode !== "overview" ? "cyan" : undefined}
          bold={index === props.selectionIndex && props.mode !== "overview"}
          dim={index > 0 && props.mode === "overview"}
          wrap="truncate-end"
        >
          {line}
        </Text>
      ))}
    </Box>
  )
}

function ArtifactPanel(props: {
  snapshot: ArtifactSnapshot
  mode: ArtifactViewMode
  selectionIndex: number
  query?: string
  page?: number
  pageSize?: number
}) {
  const lines = buildArtifactPanelLines(props.snapshot, props.mode, props.query ?? "", props.page ?? 0, props.pageSize ?? 12)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
      <Text bold>{props.mode === "overview" ? "Artifacts" : "Artifacts all"}</Text>
      <Text dim>{"Ctrl+A toggle  [ ] select  < > page  / search  Enter read"}</Text>
      <Text> </Text>
      {lines.map((line, index) => (
        <Text
          key={`artifact-panel-${index}`}
          color={index === props.selectionIndex + 1 && props.mode !== "overview" ? "cyan" : undefined}
          bold={index === props.selectionIndex + 1 && props.mode !== "overview"}
          dim={index > 0 && props.mode === "overview"}
          wrap="truncate-end"
        >
          {line}
        </Text>
      ))}
    </Box>
  )
}

function ObservabilityPanel(props: {
  runtimeState: RuntimeStateView
  usage: UsageView
  events: UiEvent[]
}) {
  const lines = buildObservabilityPanelLines(props.runtimeState, props.usage, props.events)
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginTop={1}>
      <Text bold>{"Observability"}</Text>
      <Text dim>{"Ctrl+G toggle · /observability · /doctor bundle"}</Text>
      <Text> </Text>
      {lines.map((line, index) => (
        <Text key={`observability-panel-${index}`} dim={index > 2} wrap="truncate-end">
          {line}
        </Text>
      ))}
    </Box>
  )
}

function StatusBar(props: {
  runtimeState: RuntimeStateView
  usage: UsageView
  sessionCount: number
  selectedSessionId: string
  running: boolean
  activeRequestId: string | null
  bridgeSnapshot: BridgeSnapshot
  artifactSnapshot: ArtifactSnapshot
}) {
  const stats = resolveStatusBarStats(props.runtimeState, props.usage)
  const presentation = resolveUiPresentation(props.runtimeState)
  const bridgeSummary = props.bridgeSnapshot.reachable
    ? `bridge: ${props.bridgeSnapshot.sessions.length}s/${props.bridgeSnapshot.tasks.length}t/${props.bridgeSnapshot.teams.length}tm`
    : "bridge: offline"
  const artifactSummary = props.artifactSnapshot.reachable
    ? `artifacts: ${props.artifactSnapshot.artifacts.length}`
    : "artifacts: offline"
  return (
    <Box flexDirection="column">
      <Text color={presentation.mutedColor}>{"─".repeat(96)}</Text>
      <Text color={presentation.mutedColor}>
        {`provider: ${stats.provider} │ profile: ${stats.profile} │ model: ${stats.model} │ mode: ${stats.permissionMode} │ effort: ${stats.effort}${stats.fastMode ? " fast" : ""}${stats.vimMode ? " vim" : ""}${stats.voiceMode ? " voice" : ""} │ tokens: ${stats.tokensIn}↓ ${stats.tokensOut}↑ │ mcp: ${stats.mcpConnected} │ plugins: ${stats.pluginCount} │ sessions: ${props.sessionCount} │ ${bridgeSummary} │ ${artifactSummary} │ cost: $${stats.estimatedCostUsd.toFixed(4)}${props.running ? ` │ running ${props.activeRequestId ?? props.selectedSessionId}` : ""}`}
      </Text>
    </Box>
  )
}

function PromptInputBox(props: {
  running: boolean
  inputBuffer: string
  presentation: UiPresentation
}) {
  const borderColor = resolvePromptInputBorderColor(props.running, props.presentation)
  const rule = "─".repeat(96)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={borderColor}>{rule}</Text>
      <Box>
        {props.running ? (
          <Text color="yellow" bold>{"● "}</Text>
        ) : (
          <Text color={props.presentation.primaryColor} bold>{"> "}</Text>
        )}
        <Text>{props.inputBuffer}</Text>
      </Box>
    </Box>
  )
}

export function OneClawInkApp({ cwd }: { cwd: string }) {
  const { exit } = useApp()
  const clientRef = useRef<KernelClient | null>(null)
  const registryRef = useRef(createFrontendCommandRegistry())
  const helpText = useMemo(() => registryRef.current.helpText(), [])
  const [ready, setReady] = useState(false)
  const [running, setRunning] = useState(false)
  const [inputBuffer, setInputBuffer] = useState("")
  const [history, setHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [pickerIndex, setPickerIndex] = useState(0)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [selectModal, setSelectModal] = useState<SelectModalState | null>(null)
  const [selectIndex, setSelectIndex] = useState(0)
  const [modalInputValue, setModalInputValue] = useState("")
  const [modalState, setModalState] = useState<ModalState | null>(null)
  const [statusLine, setStatusLine] = useState("Booting kernel...")
  const [selectedSessionId, setSelectedSessionId] = useState("")
  const [activeRequestId, setActiveRequestId] = useState<string | null>(null)
  const [sessions, setSessions] = useState<SessionRecord[]>([])
  const [selectedSession, setSelectedSession] = useState<SessionRecord | null>(null)
  const [selectedBundle, setSelectedBundle] = useState<BundleView | null>(null)
  const [providerView, setProviderView] = useState<ProviderView>({})
  const [runtimeState, setRuntimeState] = useState<RuntimeStateView>({})
  const [usage, setUsage] = useState<UsageView>({})
  const [events, setEvents] = useState<UiEvent[]>([])
  const [assistantBuffer, setAssistantBuffer] = useState("")
  const [pendingUserMessages, setPendingUserMessages] = useState<string[]>([])
  const [inspectorText, setInspectorText] = useState("")
  const [bridgeSnapshot, setBridgeSnapshot] = useState<BridgeSnapshot>({
    reachable: false,
    sessions: [],
    tasks: [],
    teams: [],
  })
  const [bridgeViewMode, setBridgeViewMode] = useState<BridgeViewMode>("overview")
  const [bridgeSelectionIndex, setBridgeSelectionIndex] = useState(0)
  const [mcpSnapshot, setMcpSnapshot] = useState<McpSnapshot>({})
  const [mcpViewMode, setMcpViewMode] = useState<McpViewMode>("overview")
  const [mcpSelectionIndex, setMcpSelectionIndex] = useState(0)
  const [artifactSnapshot, setArtifactSnapshot] = useState<ArtifactSnapshot>({
    reachable: true,
    artifacts: [],
  })
  const [artifactViewMode, setArtifactViewMode] = useState<ArtifactViewMode>("overview")
  const [artifactSelectionIndex, setArtifactSelectionIndex] = useState(0)
  const [artifactPanelVisible, setArtifactPanelVisible] = useState(false)
  const [artifactSearch, setArtifactSearch] = useState("")
  const [artifactPage, setArtifactPage] = useState(0)
  const [observabilityPanelVisible, setObservabilityPanelVisible] = useState(false)
  const approvalResolverRef = useRef<((allowed: boolean) => void) | null>(null)
  const bridgeViewModeRef = useRef<BridgeViewMode>("overview")

  const hints = useMemo(() => commandHints(helpText, inputBuffer), [helpText, inputBuffer])
  const paletteHints = useMemo(() => helpText.split("\n").slice(0, 12), [helpText])
  const bridgeEntries = useMemo(
    () => buildBridgePanelEntries(bridgeSnapshot, bridgeViewMode, selectedSessionId),
    [bridgeSnapshot, bridgeViewMode, selectedSessionId],
  )
  const mcpEntries = useMemo(
    () => buildMcpPanelEntries(mcpSnapshot, mcpViewMode),
    [mcpSnapshot, mcpViewMode],
  )
  const artifactEntries = useMemo(
    () => buildArtifactPanelEntries(artifactSnapshot, artifactSearch, artifactPage),
    [artifactSnapshot, artifactSearch, artifactPage],
  )
  const presentation = resolveUiPresentation(runtimeState)

  useEffect(() => {
    setPickerIndex(0)
  }, [inputBuffer, hints.length, paletteOpen])

  useEffect(() => {
    setBridgeSelectionIndex(previous => {
      const maxIndex = Math.max(0, bridgeEntries.length - 1)
      return Math.min(previous, maxIndex)
    })
  }, [bridgeEntries.length, bridgeViewMode])

  useEffect(() => {
    setMcpSelectionIndex(previous => {
      const maxIndex = Math.max(0, mcpEntries.length - 1)
      return Math.min(previous, maxIndex)
    })
  }, [mcpEntries.length, mcpViewMode])

  useEffect(() => {
    setArtifactSelectionIndex(previous => {
      const maxIndex = Math.max(0, artifactEntries.length - 1)
      return Math.min(previous, maxIndex)
    })
  }, [artifactEntries.length, artifactViewMode, artifactSearch, artifactPage])

  const pushEvent = useEffectEvent((label: string) => {
    const trimmed = label.trim()
    if (!trimmed) {
      return
    }
    startTransition(() => {
      setEvents(previous => appendUiEvent(previous, trimmed))
    })
  })

  const refreshSnapshot = useEffectEvent(async (preferredSessionId?: string) => {
    const client = clientRef.current
    if (!client) {
      return
    }
    const [state, providers, sessionListRaw, usageSummary] = await Promise.all([
      client.state(),
      client.providers(),
      client.sessions(),
      client.usage(),
    ])
    const mcp = await client.mcp({ verbose: true }).catch(() => ({}))
    const sessionList = sessionListRaw as SessionRecord[]
    const nextSessionId = preferredSessionId
      ?? selectedSessionId
      ?? sessionList[0]?.id
      ?? ""
    const [session, bundle] = nextSessionId
      ? await Promise.all([
        client.sessionGet(nextSessionId),
        client.sessionExportBundle(nextSessionId),
      ])
      : [null, null]

    startTransition(() => {
      setProviderView(providers as ProviderView)
      setRuntimeState(state as RuntimeStateView)
      setUsage(usageSummary as UsageView)
      setMcpSnapshot(mcp as McpSnapshot)
      setSessions(sessionList)
      setSelectedSessionId(nextSessionId)
      setSelectedSession(session)
      setSelectedBundle(bundle as BundleView | null)
      setReady(true)
    })
  })

  const refreshBridgeSnapshot = useEffectEvent(async () => {
    const snapshot = await loadBridgeSnapshotForUi(cwd)
    startTransition(() => {
      setBridgeSnapshot(snapshot)
    })
  })

  const refreshArtifactSnapshot = useEffectEvent(async () => {
    const snapshot = await loadArtifactSnapshotForUi(cwd)
    startTransition(() => {
      setArtifactSnapshot(snapshot)
    })
  })

  const rotateSession = useEffectEvent(async (direction: 1 | -1) => {
    if (sessions.length === 0) {
      pushEvent("No sessions available")
      return
    }
    const ids = sessions.map(session => session.id)
    const currentIndex = ids.indexOf(selectedSessionId)
    const fallbackIndex = currentIndex >= 0 ? currentIndex : 0
    const targetId = ids[(fallbackIndex + direction + ids.length) % ids.length]
    startTransition(() => {
      setSelectedSessionId(targetId)
      setStatusLine(`Selected session ${shortId(targetId)}`)
    })
    await refreshSnapshot(targetId)
  })

  const interruptActiveRun = useEffectEvent(async () => {
    const client = clientRef.current
    if (!client) {
      return
    }
    const result = activeRequestId
      ? await client.cancelRequest(activeRequestId)
      : await client.cancelSession(selectedSessionId)
    pushEvent(result.accepted ? "Interrupt requested" : "No running request")
    startTransition(() => {
      setStatusLine(result.accepted ? "Interrupt requested" : "No active request")
    })
  })

  const openSessionPicker = useEffectEvent(async () => {
    const client = clientRef.current
    if (!client) {
      return
    }
    const sessionList = await client.sessions() as SessionRecord[]
    if (sessionList.length === 0) {
      startTransition(() => {
        setStatusLine("No sessions available")
      })
      return
    }
    const options = sessionList.slice(0, 24).map(session => ({
      value: session.id,
      label: shortId(session.id),
      description: basenameSafe(session.cwd),
      active: session.id === selectedSessionId,
    }))
    startTransition(() => {
      setSelectIndex(Math.max(0, options.findIndex(option => option.active)))
      const nextModal = {
        title: "Select Session",
        options,
        onSelect: async value => {
          setSelectedSessionId(value)
          setStatusLine(`Selected session ${shortId(value)}`)
          await refreshSnapshot(value)
        },
      }
      setSelectModal(nextModal)
      setModalState({ kind: "select", modal: nextModal })
    })
  })

  const openProfilePicker = useEffectEvent(async () => {
    const client = clientRef.current
    if (!client) {
      return
    }
    const profiles = await client.profileList() as Array<{
      name: string
      active?: boolean
      profile?: {
        label?: string
        description?: string
      }
    }>
    const options = profiles.map(entry => ({
      value: entry.name,
      label: entry.profile?.label ?? entry.name,
      description: entry.profile?.description ?? entry.name,
      active: Boolean(entry.active),
    }))
    const setupOptions = [
      "anthropic-compatible",
      "openai-compatible",
      "claude-subscription",
      "codex-subscription",
      "github-copilot",
    ].map(kind => ({
      value: `setup:${kind}`,
      label: `Setup ${kind}`,
      description: "Create profile without storing secrets",
    }))
    startTransition(() => {
      setSelectIndex(Math.max(0, options.findIndex(option => option.active)))
      const nextModal = {
        title: "Select Provider Profile",
        options: [...options, ...setupOptions],
        onSelect: async value => {
          if (value.startsWith("setup:")) {
            const kind = value.slice("setup:".length)
            const defaults = providerWizardDefaults(kind)
            openInputModal({
              title: `Setup ${kind}`,
              placeholder: "<profile-name> <model> <baseUrl>",
              submitLabel: "enter save",
              initialValue: `${kind}-custom ${defaults.model} ${defaults.baseUrl}`,
              onSubmit: async rawValue => {
                const [profileName, model, baseUrl] = rawValue.trim().split(/\s+/)
                if (!profileName || !model || !baseUrl) {
                  setStatusLine("Provider setup needs: <profile-name> <model> <baseUrl>")
                  return
                }
                const result = await client.profileSave(profileName, {
                  kind,
                  model,
                  baseUrl,
                  label: defaults.label,
                  description: `Configured by TUI provider setup wizard for ${kind}.`,
                }, { activate: true })
                const diagnostics = await client.providerDiagnostics(kind)
                startTransition(() => {
                  setInspectorText(JSON.stringify({
                    saved: result,
                    diagnostics,
                    secretPolicy: `Set ${defaults.env}; no API key was written to config.`,
                  }, null, 2))
                  setStatusLine(`Configured ${profileName}; set ${defaults.env}`)
                })
                await refreshSnapshot(selectedSessionId)
              },
            })
            return
          }
          const result = await client.profileUse(value)
          setStatusLine(`Persisted active profile ${result.activeProfile}`)
          await refreshSnapshot(selectedSessionId)
        },
      }
      setSelectModal(nextModal)
      setModalState({ kind: "select", modal: nextModal })
    })
  })

  const openCommandPalette = useEffectEvent(() => {
    startTransition(() => {
      setPaletteOpen(true)
      setPickerIndex(0)
    })
  })

  const openInputModal = useEffectEvent((modal: InputModalState) => {
    startTransition(() => {
      setModalInputValue(modal.initialValue ?? "")
      setModalState({
        kind: "input",
        modal,
      })
    })
  })

  const openConfirmModal = useEffectEvent((modal: ConfirmModalState) => {
    startTransition(() => {
      setModalState({
        kind: "confirm",
        modal,
      })
    })
  })

  const cycleBridgeView = useEffectEvent(() => {
    const nextMode = nextBridgeViewMode(bridgeViewModeRef.current)
    startTransition(() => {
      bridgeViewModeRef.current = nextMode
      setBridgeViewMode(nextMode)
      setBridgeSelectionIndex(0)
      setStatusLine(`Bridge view: ${nextMode}`)
    })
  })

  const cycleMcpView = useEffectEvent(() => {
    const modes: McpViewMode[] = ["overview", "statuses", "tools", "resources"]
    startTransition(() => {
      setMcpSelectionIndex(0)
      setMcpViewMode(previous => {
        const nextMode = modes[(modes.indexOf(previous) + 1) % modes.length]
        setStatusLine(`MCP view: ${nextMode}`)
        return nextMode
      })
    })
  })

  const moveMcpSelection = useEffectEvent((delta: 1 | -1) => {
    if (mcpViewMode === "overview" || mcpEntries.length === 0) {
      return
    }
    startTransition(() => {
      setMcpSelectionIndex(previous => {
        const maxIndex = mcpEntries.length - 1
        const next = Math.max(0, Math.min(maxIndex, previous + delta))
        const selected = mcpEntries[next]
        if (selected) {
          setStatusLine(`MCP ${mcpViewMode}: ${selected.value}`)
        }
        return next
      })
    })
  })

  const toggleArtifactPanel = useEffectEvent(() => {
    startTransition(() => {
      setArtifactPanelVisible(previous => !previous)
      setArtifactViewMode("all")
      setArtifactSelectionIndex(0)
      setStatusLine("Artifacts panel toggled")
    })
    void refreshArtifactSnapshot()
  })

  const toggleObservabilityPanel = useEffectEvent(() => {
    startTransition(() => {
      setObservabilityPanelVisible(previous => !previous)
      setStatusLine("Observability panel toggled")
    })
  })

  const moveArtifactSelection = useEffectEvent((delta: 1 | -1) => {
    if (!artifactPanelVisible || artifactViewMode === "overview" || artifactEntries.length === 0) {
      return
    }
    startTransition(() => {
      setArtifactSelectionIndex(previous => {
        const maxIndex = artifactEntries.length - 1
        const next = Math.max(0, Math.min(maxIndex, previous + delta))
        const selected = artifactEntries[next]
        if (selected) {
          setStatusLine(`Artifact ${selected.value}`)
        }
        return next
      })
    })
  })

  const moveArtifactPage = useEffectEvent((delta: 1 | -1) => {
    if (!artifactPanelVisible || artifactViewMode === "overview") {
      return
    }
    const filteredCount = buildArtifactPanelEntries(artifactSnapshot, artifactSearch, 0, Number.MAX_SAFE_INTEGER).length
    const maxPage = Math.max(0, Math.ceil(filteredCount / 12) - 1)
    startTransition(() => {
      setArtifactPage(previous => {
        const next = Math.max(0, Math.min(maxPage, previous + delta))
        setArtifactSelectionIndex(0)
        setStatusLine(`Artifact page ${next + 1}/${maxPage + 1}`)
        return next
      })
    })
  })

  const openArtifactSearch = useEffectEvent(() => {
    openInputModal({
      title: "Search Artifacts",
      placeholder: "kind, name, source, id, metadata",
      submitLabel: "enter search",
      initialValue: artifactSearch,
      onSubmit: async value => {
        const query = value.trim()
        startTransition(() => {
          setArtifactSearch(query)
          setArtifactPage(0)
          setArtifactSelectionIndex(0)
          setStatusLine(query ? `Artifact search: ${query}` : "Artifact search cleared")
        })
      },
    })
  })

  const inspectArtifactSelection = useEffectEvent(async () => {
    if (!artifactPanelVisible || artifactEntries.length === 0) {
      return
    }
    const selected = artifactEntries[artifactSelectionIndex]
    if (!selected) {
      return
    }
    const payload = await readArtifactContent(cwd, selected.value)
    startTransition(() => {
      setInspectorText(payload
        ? JSON.stringify(formatArtifactContentForInspector(payload), null, 2)
        : `Artifact not found: ${selected.value}`)
      setStatusLine(payload ? `Artifact ${selected.value}` : `Artifact missing ${selected.value}`)
    })
  })

  const inspectMcpSelection = useEffectEvent(async () => {
    if (mcpViewMode === "overview" || mcpEntries.length === 0) {
      return
    }
    const selected = mcpEntries[mcpSelectionIndex]
    if (!selected) {
      return
    }
    if (selected.kind === "resource" && selected.server && selected.uri) {
      const payload = await clientRef.current?.mcpReadResource(selected.server, selected.uri)
      startTransition(() => {
        setInspectorText(JSON.stringify({ selected, payload }, null, 2))
        setStatusLine(`Read MCP resource ${truncateLabel(selected.uri ?? "", 32)}`)
      })
      return
    }
    startTransition(() => {
      setInspectorText(JSON.stringify(selected, null, 2))
      setStatusLine(`MCP ${selected.kind}: ${selected.value}`)
    })
  })

  const openMcpActionPalette = useEffectEvent(() => {
    const client = clientRef.current
    const selected = mcpViewMode === "overview" ? null : mcpEntries[mcpSelectionIndex] ?? null
    const options = buildMcpActionOptions(mcpViewMode, selected)
    startTransition(() => {
      setSelectIndex(0)
      const nextModal = {
        title: mcpViewMode === "overview" ? "MCP Actions" : `MCP ${mcpViewMode} Actions`,
        options,
        onSelect: async value => {
          if (!client) {
            return
          }
          if (value === "refresh-mcp") {
            const mcp = await client.mcp({ verbose: true })
            startTransition(() => {
              setMcpSnapshot(mcp as McpSnapshot)
              setStatusLine("MCP snapshot refreshed")
            })
            return
          }
          if (!selected) {
            return
          }
          if (value === "inspect-mcp") {
            await inspectMcpSelection()
            return
          }
          if (value === "reconnect-mcp" && selected.server) {
            const payload = await client.mcpReconnect(selected.server)
            const mcp = await client.mcp({ verbose: true })
            startTransition(() => {
              setInspectorText(JSON.stringify(payload, null, 2))
              setMcpSnapshot(mcp as McpSnapshot)
              setStatusLine(`Reconnected MCP ${selected.server}`)
            })
            return
          }
          if (value === "configure-mcp-auth" && selected.server) {
            openInputModal({
              title: `MCP Auth ${selected.server}`,
              placeholder: "env MCP_TOKEN or bearer <token>",
              submitLabel: "enter save",
              initialValue: "env MCP_AUTH_TOKEN",
              onSubmit: async rawValue => {
                const [mode, value, ...rest] = rawValue.trim().split(/\s+/)
                if ((mode !== "env" && mode !== "bearer") || !value) {
                  setStatusLine("MCP auth needs: env <ENV_KEY> or bearer <token>")
                  return
                }
                const payload = await client.mcpConfigureAuth({
                  name: selected.server!,
                  mode,
                  value,
                  ...(mode === "env" ? { key: rest[0] || value } : {}),
                })
                const mcp = await client.mcp({ verbose: true })
                startTransition(() => {
                  setInspectorText(JSON.stringify({
                    configured: payload,
                    secretPolicy: mode === "env" ? `Use environment variable ${value}.` : "Bearer token stored through MCP auth config; output is redacted.",
                  }, null, 2))
                  setMcpSnapshot(mcp as McpSnapshot)
                  setStatusLine(`Configured MCP auth for ${selected.server}`)
                })
              },
            })
            return
          }
          if (value === "read-mcp-resource" && selected.server && selected.uri) {
            const payload = await client.mcpReadResource(selected.server, selected.uri)
            startTransition(() => {
              setInspectorText(String(payload.content ?? ""))
              setStatusLine(`Read MCP resource ${truncateLabel(selected.uri ?? "", 32)}`)
            })
            return
          }
          if (value === "read-mcp-template" && selected.server && selected.uriTemplate) {
            openInputModal({
              title: `Read Template ${selected.server}`,
              placeholder: "URI with template values filled",
              submitLabel: "enter read",
              initialValue: selected.uriTemplate,
              onSubmit: async rawValue => {
                const uri = rawValue.trim()
                if (!uri) {
                  setStatusLine("MCP template URI cannot be empty")
                  return
                }
                const payload = await client.mcpReadResource(selected.server!, uri)
                startTransition(() => {
                  setInspectorText(String(payload.content ?? ""))
                  setStatusLine(`Read MCP template ${truncateLabel(uri, 32)}`)
                })
              },
            })
          }
        },
      }
      setSelectModal(nextModal)
      setModalState({ kind: "select", modal: nextModal })
    })
  })

  const focusBridgeEntry = useEffectEvent((mode: BridgeViewMode, value?: string) => {
    const nextEntries = buildBridgePanelEntries(bridgeSnapshot, mode, selectedSessionId)
    const matchIndex = value
      ? nextEntries.findIndex(entry => entry.value === value)
      : 0
    startTransition(() => {
      bridgeViewModeRef.current = mode
      setBridgeViewMode(mode)
      setBridgeSelectionIndex(matchIndex >= 0 ? matchIndex : 0)
      setStatusLine(value ? `Bridge ${mode}: ${value}` : `Bridge view: ${mode}`)
    })
  })

  const moveBridgeSelection = useEffectEvent((delta: 1 | -1) => {
    if (bridgeViewMode === "overview" || bridgeEntries.length === 0) {
      return
    }
    startTransition(() => {
      setBridgeSelectionIndex(previous => {
        const maxIndex = bridgeEntries.length - 1
        const next = Math.max(0, Math.min(maxIndex, previous + delta))
        const selected = bridgeEntries[next]
        if (selected) {
          setStatusLine(`Bridge ${bridgeViewMode}: ${selected.value}`)
        }
        return next
      })
    })
  })

  const inspectBridgeSelection = useEffectEvent(async () => {
    if (bridgeViewMode === "overview" || bridgeEntries.length === 0) {
      return
    }
    const selected = bridgeEntries[bridgeSelectionIndex]
    if (!selected) {
      return
    }
    try {
      if (bridgeViewMode === "tasks") {
        const [task, output] = await Promise.all([
          bridgeFetchForUi(cwd, `/tasks/${selected.value}`),
          bridgeFetchForUi(cwd, `/tasks/${selected.value}/output`, { text: true }),
        ])
        startTransition(() => {
          setInspectorText(JSON.stringify({
            task,
            output,
          }, null, 2))
          setStatusLine(`Bridge task ${selected.value}`)
        })
        pushEvent(`bridge task ${selected.value}`)
        return
      }
      if (bridgeViewMode === "teams") {
        const team = await bridgeFetchForUi(cwd, `/teams/${selected.value}`)
        startTransition(() => {
          setInspectorText(JSON.stringify(team, null, 2))
          setStatusLine(`Bridge team ${selected.value}`)
        })
        pushEvent(`bridge team ${selected.value}`)
        return
      }
      if (bridgeViewMode === "sessions") {
        const bridgeSession = await bridgeFetchForUi(cwd, `/bridge/sessions/${selected.value}`)
        startTransition(() => {
          setInspectorText(JSON.stringify(bridgeSession, null, 2))
          setSelectedSessionId(selected.value)
          setStatusLine(`Bridge session ${shortId(selected.value)}`)
        })
        await refreshSnapshot(selected.value)
        pushEvent(`bridge session ${selected.value}`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      startTransition(() => {
        setStatusLine(`Bridge inspect failed: ${message}`)
        setInspectorText(message)
      })
    }
  })

  const cancelBridgeSelection = useEffectEvent(async () => {
    if (bridgeViewMode === "overview" || bridgeViewMode === "teams" || bridgeEntries.length === 0) {
      return
    }
    const selected = bridgeEntries[bridgeSelectionIndex]
    if (!selected) {
      return
    }
    try {
      if (bridgeViewMode === "tasks") {
        const result = await bridgeFetchForUi(cwd, `/tasks/${selected.value}/cancel`, {
          method: "POST",
        })
        startTransition(() => {
          setInspectorText(JSON.stringify(result, null, 2))
          setStatusLine(`Cancelled bridge task ${selected.value}`)
        })
        pushEvent(`bridge cancel task ${selected.value}`)
      } else if (bridgeViewMode === "sessions") {
        const result = await bridgeFetchForUi(cwd, `/sessions/${selected.value}/interrupt`, {
          method: "POST",
        })
        startTransition(() => {
          setInspectorText(JSON.stringify(result, null, 2))
          setStatusLine(`Interrupted bridge session ${shortId(selected.value)}`)
        })
        pushEvent(`bridge interrupt ${selected.value}`)
      }
      await refreshBridgeSnapshot()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      startTransition(() => {
        setStatusLine(`Bridge action failed: ${message}`)
        setInspectorText(message)
      })
    }
  })

  const confirmCancelBridgeSelection = useEffectEvent(() => {
    if (bridgeViewMode === "overview" || bridgeViewMode === "teams" || bridgeEntries.length === 0) {
      return
    }
    const selected = bridgeEntries[bridgeSelectionIndex]
    if (!selected) {
      return
    }
    const isTask = bridgeViewMode === "tasks"
    openConfirmModal({
      title: isTask ? "Cancel Bridge Task" : "Interrupt Bridge Session",
      body: isTask
        ? `Cancel task ${selected.value}?`
        : `Interrupt session ${shortId(selected.value)}?`,
      confirmLabel: isTask ? "cancel task" : "interrupt session",
      onConfirm: async () => {
        await cancelBridgeSelection()
      },
    })
  })

  const exportBridgeSelection = useEffectEvent(async () => {
    if (bridgeViewMode !== "sessions" || bridgeEntries.length === 0) {
      return
    }
    const selected = bridgeEntries[bridgeSelectionIndex]
    if (!selected) {
      return
    }
    try {
      const artifact = await bridgeFetchForUi(cwd, `/sessions/${selected.value}/export/artifact`, {
        method: "POST",
        body: {
          format: "markdown",
          name: `tui-${selected.value}`,
        },
      })
      startTransition(() => {
        setInspectorText(JSON.stringify(artifact, null, 2))
        setStatusLine(`Exported artifact for ${shortId(selected.value)}`)
      })
      pushEvent(`bridge export ${selected.value}`)
      await refreshBridgeSnapshot()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      startTransition(() => {
        setStatusLine(`Bridge export failed: ${message}`)
        setInspectorText(message)
      })
    }
  })

  const confirmExportBridgeSelection = useEffectEvent(() => {
    if (bridgeViewMode !== "sessions" || bridgeEntries.length === 0) {
      return
    }
    const selected = bridgeEntries[bridgeSelectionIndex]
    if (!selected) {
      return
    }
    openConfirmModal({
      title: "Export Bridge Session",
      body: `Create a markdown artifact for ${shortId(selected.value)}?`,
      confirmLabel: "export",
      onConfirm: async () => {
        await exportBridgeSelection()
      },
    })
  })

  const seedBridgeCommand = useEffectEvent((kind: "message" | "run") => {
    if (bridgeViewMode !== "teams" || bridgeEntries.length === 0) {
      return
    }
    const selected = bridgeEntries[bridgeSelectionIndex]
    if (!selected) {
      return
    }
    const commandPrefix = kind === "message"
      ? `/bridge team message ${selected.value} `
      : `/bridge team run ${selected.value} `
    startTransition(() => {
      setInputBuffer(commandPrefix)
      setStatusLine(`Prepared ${kind} for team ${selected.value}`)
    })
  })

  const openBridgeActionPalette = useEffectEvent(() => {
    const selected = bridgeViewMode === "overview"
      ? null
      : bridgeEntries[bridgeSelectionIndex] ?? null
    const options = buildBridgeActionOptions(bridgeViewMode, selected)
    if (options.length === 0) {
      startTransition(() => {
        setStatusLine("No bridge actions available")
      })
      return
    }
    startTransition(() => {
      setSelectIndex(0)
      const nextModal = {
        title: bridgeViewMode === "overview" ? "Bridge Actions" : `Bridge ${bridgeViewMode} Actions`,
        options,
        onSelect: async value => {
          if (value === "refresh-bridge") {
            await refreshBridgeSnapshot()
            setStatusLine("Bridge snapshot refreshed")
            return
          }
          if (!selected) {
            return
          }
          if (value === "inspect-task" || value === "inspect-team" || value === "inspect-session") {
            await inspectBridgeSelection()
            return
          }
          if (value === "cancel-task" || value === "interrupt-session") {
            confirmCancelBridgeSelection()
            return
          }
          if (value === "export-session") {
            confirmExportBridgeSelection()
            return
          }
          if (value === "use-session") {
            setSelectedSessionId(selected.value)
            setStatusLine(`Selected session ${shortId(selected.value)}`)
            await refreshSnapshot(selected.value)
            return
          }
          if (value === "show-task-session") {
            const bridgeSession = await bridgeFetchForUi(cwd, `/tasks/${selected.value}/session`)
            startTransition(() => {
              setInspectorText(JSON.stringify(bridgeSession, null, 2))
            })
            if (bridgeSession && typeof bridgeSession === "object" && "sessionId" in bridgeSession && typeof bridgeSession.sessionId === "string") {
              focusBridgeEntry("sessions", bridgeSession.sessionId)
              setSelectedSessionId(bridgeSession.sessionId)
              await refreshSnapshot(bridgeSession.sessionId)
            } else {
              setStatusLine(`Task ${selected.value} has no session`)
            }
            return
          }
          if (value === "focus-team-tasks") {
            const teamTasks = bridgeSnapshot.tasks.filter(task => task.metadata?.team === selected.value)
            focusBridgeEntry("tasks", teamTasks[0]?.id)
            return
          }
          if (value === "focus-team-sessions") {
            const teamSessions = bridgeSnapshot.sessions.filter(session => session.team === selected.value)
            focusBridgeEntry("sessions", teamSessions[0]?.sessionId)
            return
          }
          if (value === "message-team") {
            const team = bridgeSnapshot.teams.find(entry => entry.name === selected.value)
            openInputModal({
              title: `Message Team ${selected.value}`,
              placeholder: "Enter a control message for this team",
              submitLabel: "enter send",
              onSubmit: async rawValue => {
                const message = rawValue.trim()
                if (!message) {
                  setStatusLine("Team message cannot be empty")
                  return
                }
                const result = await bridgeFetchForUi(cwd, `/teams/${selected.value}/messages`, {
                  method: "POST",
                  body: { message },
                })
                startTransition(() => {
                  setInspectorText(JSON.stringify(result, null, 2))
                  setStatusLine(`Messaged team ${selected.value}`)
                })
                pushEvent(`bridge team message ${selected.value}`)
                await refreshBridgeSnapshot()
                if (team) {
                  focusBridgeEntry("teams", team.name)
                }
              },
            })
            return
          }
          if (value === "run-team-goal") {
            openInputModal({
              title: `Run Goal for ${selected.value}`,
              placeholder: "Describe the goal to run for this team",
              submitLabel: "enter launch",
              onSubmit: async rawValue => {
                const goal = rawValue.trim()
                if (!goal) {
                  setStatusLine("Team goal cannot be empty")
                  return
                }
                const result = await bridgeFetchForUi(cwd, `/teams/${selected.value}/run`, {
                  method: "POST",
                  body: {
                    goal,
                    cwd,
                  },
                })
                startTransition(() => {
                  setInspectorText(JSON.stringify(result, null, 2))
                  setStatusLine(`Launched team goal for ${selected.value}`)
                })
                pushEvent(`bridge team run ${selected.value}`)
                await refreshBridgeSnapshot()
                focusBridgeEntry("teams", selected.value)
              },
            })
            return
          }
          if (value === "set-team-goal") {
            const existingGoal = bridgeSnapshot.teams.find(entry => entry.name === selected.value)?.goal ?? ""
            openInputModal({
              title: `Set Goal for ${selected.value}`,
              placeholder: "Persist the goal for this team",
              submitLabel: "enter save",
              initialValue: existingGoal,
              onSubmit: async rawValue => {
                const goal = rawValue.trim()
                if (!goal) {
                  setStatusLine("Team goal cannot be empty")
                  return
                }
                const result = await bridgeFetchForUi(cwd, `/teams/${selected.value}/goal`, {
                  method: "POST",
                  body: { goal },
                })
                startTransition(() => {
                  setInspectorText(JSON.stringify(result, null, 2))
                  setStatusLine(`Updated goal for ${selected.value}`)
                })
                pushEvent(`bridge team goal ${selected.value}`)
                await refreshBridgeSnapshot()
                focusBridgeEntry("teams", selected.value)
              },
            })
          }
        },
      }
      setSelectModal(nextModal)
      setModalState({ kind: "select", modal: nextModal })
    })
  })

  const submitInput = useEffectEvent(async () => {
    const client = clientRef.current
    const trimmed = inputBuffer.trim()
    if (!client || !trimmed || running) {
      return
    }

    startTransition(() => {
      setInputBuffer("")
      setHistory(previous => (
        previous[previous.length - 1] === trimmed
          ? previous
          : [...previous, trimmed].slice(-40)
      ))
      setHistoryIndex(-1)
    })

    if (trimmed === "/session" || trimmed === "/session use" || trimmed === "/resume") {
      await openSessionPicker()
      return
    }
    if (trimmed === "/profile" || trimmed === "/profile use") {
      await openProfilePicker()
      return
    }

    const commandLookup = registryRef.current.lookup(trimmed)
    if (commandLookup) {
      let requestedSessionId = selectedSessionId
      const result = await commandLookup.command.handler(commandLookup.args, {
        client,
        sessionId: selectedSessionId,
        cwd,
        setSessionId: sessionId => {
          requestedSessionId = sessionId
          startTransition(() => {
            setSelectedSessionId(sessionId)
          })
        },
        listSessions: async scope => {
          const records = await client.sessions({
            cwd,
            scope: scope ?? "project",
          }) as Array<{ id: string; updatedAt?: string }>
          return records
        },
      })
      pushEvent(`command /${commandLookup.command.name}`)
      startTransition(() => {
        setStatusLine(compactStatus(result.message ?? `Ran /${commandLookup.command.name}`))
        setInspectorText(result.message ?? "")
      })
      await refreshSnapshot(requestedSessionId)
      await refreshBridgeSnapshot()
      await refreshArtifactSnapshot()
      if (result.shouldExit) {
        exit()
      }
      return
    }

    const tracked = client.runPromptTracked(trimmed, {
      sessionId: selectedSessionId || undefined,
      cwd,
      metadata: { via: "tui-react" },
      onApprovalRequest: async request => {
        pushEvent(`approval requested for ${request.toolName}`)
        startTransition(() => {
          setStatusLine(`Approval required for ${request.toolName}`)
          setModalState({
            kind: "approval",
            request: request as ApprovalRequest,
          })
        })
        return await new Promise<boolean>(resolve => {
          approvalResolverRef.current = allowed => {
            approvalResolverRef.current = null
            startTransition(() => {
              setModalState(null)
            })
            resolve(allowed)
          }
        })
      },
      onEvent: event => {
        const type = typeof event.type === "string" ? event.type : "kernel"
        if (type === "provider_text_delta") {
          startTransition(() => {
            setAssistantBuffer(previous => previous + String(event.delta ?? ""))
          })
          return
        }
        if (type === "tool_started") {
          startTransition(() => {
            setStatusLine(`Running ${String(event.toolName ?? "tool")}...`)
          })
        } else if (type === "iteration_started") {
          startTransition(() => {
            setStatusLine(`Iteration ${String(event.iteration ?? 1)} started`)
          })
        } else if (type === "completed") {
          startTransition(() => {
            setStatusLine("Completed")
          })
        }
        pushEvent(type)
      },
    })

    startTransition(() => {
      setRunning(true)
      setActiveRequestId(tracked.requestId)
      setPendingUserMessages(previous => [...previous, trimmed].slice(-4))
      setAssistantBuffer("")
      setInspectorText("")
      setStatusLine(`Running in ${selectedSessionId || "new session"}...`)
    })

    try {
      const result = await tracked.promise
      startTransition(() => {
        setSelectedSessionId(result.sessionId)
        setStatusLine(`Completed ${result.stopReason} after ${result.iterations} iteration(s)`)
        setAssistantBuffer("")
      })
      pushEvent(`completed ${result.stopReason}`)
      await refreshSnapshot(result.sessionId)
      await refreshBridgeSnapshot()
      await refreshArtifactSnapshot()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      startTransition(() => {
        setStatusLine(`Request failed: ${message}`)
        setAssistantBuffer("")
        setInspectorText(message)
      })
      pushEvent(`error ${message}`)
      await refreshSnapshot(selectedSessionId)
      await refreshBridgeSnapshot()
      await refreshArtifactSnapshot()
    } finally {
      startTransition(() => {
        setRunning(false)
        setActiveRequestId(null)
        setPendingUserMessages([])
      })
    }
  })

  useEffect(() => {
    let disposed = false
    let disposeBridgeRealtime: (() => void) | undefined
    const client = new KernelClient(cwd, process.env.ONECLAW_PYTHON ?? "python3", {
      onStderr: chunk => {
        if (disposed) {
          return
        }
        for (const line of chunk.split(/\r?\n/)) {
          if (line.trim()) {
            pushEvent(`stderr ${line.trim()}`)
          }
        }
      },
    })
    clientRef.current = client

    void (async () => {
      try {
        disposeBridgeRealtime = await connectBridgeRealtime(cwd, patch => {
          if (disposed) {
            return
          }
          startTransition(() => {
            setBridgeSnapshot(previous => ({
              ...previous,
              ...patch,
            }))
          })
        })
        const session = await client.createSession(cwd, { via: "tui" })
        if (disposed) {
          return
        }
        startTransition(() => {
          setSelectedSessionId(session.id)
          setStatusLine(`Ready in ${shortId(session.id)}`)
        })
        await refreshSnapshot(session.id)
        await refreshBridgeSnapshot()
        await refreshArtifactSnapshot()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        startTransition(() => {
          setStatusLine(`Boot failed: ${message}`)
          setInspectorText(message)
        })
        pushEvent(`boot error ${message}`)
      }
    })()

    const interval = setInterval(() => {
      if (!disposed) {
        void refreshSnapshot()
        void refreshBridgeSnapshot()
        void refreshArtifactSnapshot()
      }
    }, 1500)

    return () => {
      disposed = true
      clearInterval(interval)
      disposeBridgeRealtime?.()
      clientRef.current = null
      void client.close()
    }
  }, [cwd])

  useInput((input, key) => {
    if (modalState?.kind === "select" && selectModal) {
      if (key.upArrow) {
        startTransition(() => {
          setSelectIndex(previous => Math.max(0, previous - 1))
        })
        return
      }
      if (key.downArrow) {
        startTransition(() => {
          setSelectIndex(previous => Math.min(selectModal.options.length - 1, previous + 1))
        })
        return
      }
      if (key.return) {
        const selected = selectModal.options[selectIndex]
        if (selected) {
          void Promise.resolve(selectModal.onSelect(selected.value)).finally(() => {
            startTransition(() => {
              setSelectModal(null)
              setModalState(null)
            })
          })
        }
        return
      }
      if (key.escape) {
        startTransition(() => {
          setSelectModal(null)
          setModalState(null)
        })
        return
      }
      return
    }

    if (modalState?.kind === "input") {
      if (key.return) {
        const value = modalInputValue
        void Promise.resolve(modalState.modal.onSubmit(value)).finally(() => {
          startTransition(() => {
            setModalInputValue("")
            setModalState(null)
          })
        })
        return
      }
      if (key.escape) {
        startTransition(() => {
          setModalInputValue("")
          setModalState(null)
        })
        return
      }
      if (key.backspace || key.delete) {
        startTransition(() => {
          setModalInputValue(previous => previous.slice(0, -1))
        })
        return
      }
      if (!key.ctrl && !key.meta && input) {
        startTransition(() => {
          setModalInputValue(previous => previous + input)
        })
      }
      return
    }

    if (modalState?.kind === "confirm") {
      if (key.return || input.toLowerCase() === "y") {
        void Promise.resolve(modalState.modal.onConfirm()).finally(() => {
          startTransition(() => {
            setModalState(null)
          })
        })
        return
      }
      if (input.toLowerCase() === "n" || key.escape) {
        startTransition(() => {
          setModalState(null)
        })
        return
      }
      return
    }

    if (modalState?.kind === "approval") {
      if (input.toLowerCase() === "y") {
        approvalResolverRef.current?.(true)
        startTransition(() => {
          setStatusLine(`Allowed ${modalState.request.toolName}`)
        })
        return
      }
      if (input.toLowerCase() === "n" || key.escape) {
        approvalResolverRef.current?.(false)
        startTransition(() => {
          setStatusLine(`Denied ${modalState.request.toolName}`)
        })
        return
      }
      return
    }

    if (key.ctrl && input === "c") {
      void clientRef.current?.close()
      exit()
      return
    }
    if (key.ctrl && input === "k") {
      openCommandPalette()
      return
    }
    if (key.ctrl && input === "o") {
      void openSessionPicker()
      return
    }
    if (key.ctrl && input === "t") {
      void openProfilePicker()
      return
    }
    if (key.ctrl && input === "b") {
      cycleBridgeView()
      return
    }
    if (key.ctrl && input === "m") {
      cycleMcpView()
      return
    }
    if (key.ctrl && input === "a") {
      toggleArtifactPanel()
      return
    }
    if (key.ctrl && input === "g") {
      toggleObservabilityPanel()
      return
    }
    if (key.escape) {
      if (paletteOpen) {
        startTransition(() => {
          setPaletteOpen(false)
        })
        return
      }
      if (hints.length > 0) {
        startTransition(() => {
          setInputBuffer("")
        })
        return
      }
      void interruptActiveRun()
      return
    }
    if (running) {
      return
    }
    if ((key.upArrow || (key.ctrl && input === "p")) && (paletteOpen || hints.length > 0)) {
      startTransition(() => {
        setPickerIndex(previous => Math.max(0, previous - 1))
      })
      return
    }
    if ((key.downArrow || (key.ctrl && input === "n")) && (paletteOpen || hints.length > 0)) {
      startTransition(() => {
        const maxIndex = (paletteOpen ? paletteHints.length : hints.length) - 1
        setPickerIndex(previous => Math.min(maxIndex, previous + 1))
      })
      return
    }
    if (key.return) {
      if (!inputBuffer.trim() && !paletteOpen && hints.length === 0 && artifactPanelVisible) {
        void inspectArtifactSelection()
        return
      }
      if (!inputBuffer.trim() && !paletteOpen && hints.length === 0 && mcpViewMode !== "overview") {
        void inspectMcpSelection()
        return
      }
      if (!inputBuffer.trim() && !paletteOpen && hints.length === 0 && bridgeViewMode !== "overview") {
        void inspectBridgeSelection()
        return
      }
      if (paletteOpen || hints.length > 0) {
        const selectedHint = (paletteOpen ? paletteHints : hints)[pickerIndex]
        const commandValue = selectedHint ? commandValueFromHint(selectedHint) : inputBuffer.trim()
        if (commandValue && inputBuffer.trim() !== commandValue) {
          startTransition(() => {
            setInputBuffer(commandValue)
            setPaletteOpen(false)
          })
          return
        }
      }
      void submitInput()
      return
    }
    if (key.tab) {
      if (paletteOpen || hints.length > 0) {
        const source = paletteOpen ? paletteHints : hints
        const selectedHint = source[pickerIndex] ?? source[0]
        if (selectedHint) {
          startTransition(() => {
            setInputBuffer(commandValueFromHint(selectedHint))
            setPaletteOpen(false)
          })
        }
        return
      }
      startTransition(() => {
        setInputBuffer(previous => previous || "/help")
      })
      return
    }
    if (!inputBuffer.length && !paletteOpen && hints.length === 0 && !key.ctrl && !key.meta && input === "[") {
      if (artifactPanelVisible) {
        moveArtifactSelection(-1)
      } else if (mcpViewMode !== "overview") {
        moveMcpSelection(-1)
      } else {
        moveBridgeSelection(-1)
      }
      return
    }
    if (!inputBuffer.length && !paletteOpen && hints.length === 0 && !key.ctrl && !key.meta && input === "]") {
      if (artifactPanelVisible) {
        moveArtifactSelection(1)
      } else if (mcpViewMode !== "overview") {
        moveMcpSelection(1)
      } else {
        moveBridgeSelection(1)
      }
      return
    }
    if (!inputBuffer.length && !paletteOpen && hints.length === 0 && !key.ctrl && !key.meta && artifactPanelVisible && input === "<") {
      moveArtifactPage(-1)
      return
    }
    if (!inputBuffer.length && !paletteOpen && hints.length === 0 && !key.ctrl && !key.meta && artifactPanelVisible && input === ">") {
      moveArtifactPage(1)
      return
    }
    if (!inputBuffer.length && !paletteOpen && hints.length === 0 && !key.ctrl && !key.meta && artifactPanelVisible && input === "/") {
      openArtifactSearch()
      return
    }
    if (!inputBuffer.length && !paletteOpen && hints.length === 0 && !key.ctrl && !key.meta && input === ".") {
      if (mcpViewMode !== "overview") {
        openMcpActionPalette()
      } else {
        openBridgeActionPalette()
      }
      return
    }
    if (!inputBuffer.length && !paletteOpen && hints.length === 0 && !key.ctrl && !key.meta && (input === "x" || input === "X")) {
      confirmCancelBridgeSelection()
      return
    }
    if (!inputBuffer.length && !paletteOpen && hints.length === 0 && !key.ctrl && !key.meta && (input === "e" || input === "E")) {
      confirmExportBridgeSelection()
      return
    }
    if (!inputBuffer.length && !paletteOpen && hints.length === 0 && !key.ctrl && !key.meta && (input === "m" || input === "M")) {
      seedBridgeCommand("message")
      return
    }
    if (!inputBuffer.length && !paletteOpen && hints.length === 0 && !key.ctrl && !key.meta && (input === "r" || input === "R")) {
      seedBridgeCommand("run")
      return
    }
    if (key.upArrow || (key.ctrl && input === "p")) {
      if (history.length === 0) {
        return
      }
      startTransition(() => {
        const nextIndex = historyIndex < 0
          ? history.length - 1
          : Math.max(0, historyIndex - 1)
        setHistoryIndex(nextIndex)
        setInputBuffer(historyValue(history, nextIndex))
      })
      return
    }
    if (key.downArrow || (key.ctrl && input === "n")) {
      if (history.length === 0) {
        return
      }
      startTransition(() => {
        const nextIndex = historyIndex < 0
          ? -1
          : historyIndex >= history.length - 1
            ? -1
            : historyIndex + 1
        setHistoryIndex(nextIndex)
        setInputBuffer(historyValue(history, nextIndex))
      })
      return
    }
    if ((key.ctrl && input === "r") || (key.ctrl && input === "l")) {
      void refreshSnapshot()
      return
    }
    if (key.backspace || key.delete) {
      startTransition(() => {
        setInputBuffer(previous => previous.slice(0, -1))
        setHistoryIndex(-1)
      })
      return
    }
    if (!key.ctrl && !key.meta && input) {
      startTransition(() => {
        setInputBuffer(previous => previous + input)
        setHistoryIndex(-1)
      })
    }
  })

  const providerLabel = String(runtimeState.provider ?? providerView.provider?.label ?? "unknown")
  const profileLabel = String(runtimeState.activeProfile ?? providerView.activeProfile ?? selectedBundle?.activeProfile ?? "unknown")
  const modelLabel = String(providerView.provider?.model ?? "unknown")
  const inspectorSource = inspectorText

  return (
    <Box flexDirection="column" paddingX={1} height="100%">
      <Box flexDirection="column" flexGrow={1}>
        <ConversationPane
          session={selectedSession}
          assistantBuffer={assistantBuffer}
          pendingUserMessages={pendingUserMessages}
          showWelcome={ready}
        />
      </Box>

      <ModalHost modalState={modalState} selectIndex={selectIndex} inputValue={modalInputValue} />

      {paletteOpen ? (
        <CommandPicker
          title="Command Palette"
          hints={paletteHints}
          selectedIndex={pickerIndex}
        />
      ) : hints.length > 0 ? (
        <CommandPicker hints={hints} selectedIndex={pickerIndex} />
      ) : null}

      {ready ? (
        <InfoPanel
          selectedSession={selectedSession}
          sessionCount={sessions.length}
          profileLabel={profileLabel}
          inspectorSource={inspectorSource}
          events={events}
          bridgeSnapshot={bridgeSnapshot}
        />
      ) : null}

      {ready && shouldRenderBridgePanel(bridgeViewMode) ? (
        <BridgePanel
          snapshot={bridgeSnapshot}
          mode={bridgeViewMode}
          selectedSessionId={selectedSessionId}
          selectionIndex={bridgeSelectionIndex}
        />
      ) : null}

      {ready && shouldRenderMcpPanel(mcpViewMode) ? (
        <McpPanel
          snapshot={mcpSnapshot}
          mode={mcpViewMode}
          selectionIndex={mcpSelectionIndex}
        />
      ) : null}

      {ready && artifactPanelVisible ? (
        <ArtifactPanel
          snapshot={artifactSnapshot}
          mode={artifactViewMode}
          selectionIndex={artifactSelectionIndex}
          query={artifactSearch}
          page={artifactPage}
        />
      ) : null}

      {ready && observabilityPanelVisible ? (
        <ObservabilityPanel
          runtimeState={runtimeState}
          usage={usage}
          events={events}
        />
      ) : null}

      <StatusBar
        runtimeState={runtimeState}
        usage={usage}
        sessionCount={sessions.length}
        selectedSessionId={selectedSessionId}
        running={running}
        activeRequestId={activeRequestId}
        bridgeSnapshot={bridgeSnapshot}
        artifactSnapshot={artifactSnapshot}
      />

      {ready && !modalState && !running ? (
        <Box>
          <Text dim>
            <Text color={presentation.primaryColor}>{presentation.submitKey}</Text>
            {" submit  "}
            <Text color={presentation.primaryColor}>{"/"}</Text>
            {" commands  "}
            <Text color={presentation.primaryColor}>{"↑↓"}</Text>
            {" history  "}
            <Text color={presentation.primaryColor}>{presentation.paletteKey}</Text>
            {" palette  "}
            <Text color={presentation.primaryColor}>{presentation.sessionKey}</Text>
            {" sessions  "}
            <Text color={presentation.primaryColor}>{presentation.profileKey}</Text>
            {" profiles  "}
            <Text color={presentation.primaryColor}>{presentation.mcpKey}</Text>
            {" mcp  "}
            <Text color={presentation.primaryColor}>{presentation.bridgeKey}</Text>
            {" bridge  "}
            <Text color={presentation.primaryColor}>{"ctrl+a"}</Text>
            {" artifacts  "}
            <Text color={presentation.primaryColor}>{presentation.observabilityKey}</Text>
            {" observability  "}
            <Text color={presentation.primaryColor}>{"esc"}</Text>
            {" interrupt  "}
            <Text color={presentation.primaryColor}>{"[ ]"}</Text>
            {" pick  "}
            <Text color={presentation.primaryColor}>{"."}</Text>
            {" actions"}
          </Text>
        </Box>
      ) : null}

      {!ready ? (
        <Box>
          <Text color="yellow">{"Connecting to backend..."}</Text>
        </Box>
      ) : modalState ? null : (
        <PromptInputBox
          running={running}
          inputBuffer={inputBuffer}
          presentation={presentation}
        />
      )}
    </Box>
  )
}

export async function startInkUi(cwd: string): Promise<void> {
  const instance = await render(React.createElement(OneClawInkApp, { cwd }))
  try {
    await instance.waitUntilExit()
  } finally {
    instance.cleanup()
  }
}
