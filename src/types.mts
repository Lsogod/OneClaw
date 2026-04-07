export type Role = "user" | "assistant"

export type TextBlock = {
  type: "text"
  text: string
}

export type ToolCallBlock = {
  type: "tool_call"
  id: string
  name: string
  input: unknown
}

export type ToolResultBlock = {
  type: "tool_result"
  toolCallId: string
  name: string
  result: string
  isError?: boolean
}

export type ContentBlock = TextBlock | ToolCallBlock | ToolResultBlock

export type Message = {
  role: Role
  content: ContentBlock[]
  createdAt: string
}

export type JsonSchema = Record<string, unknown>

export type ProviderKind =
  | "anthropic-compatible"
  | "claude-subscription"
  | "openai-compatible"
  | "codex-subscription"
  | "github-copilot"
  | "internal-test"

export type PublicProviderKind = Exclude<ProviderKind, "internal-test">

export type PermissionMode = "allow" | "ask" | "deny"
export type OutputStyle = "text" | "json"
export type ThemeName = "neutral" | "contrast"
export type RuntimeEffort = "low" | "medium" | "high" | "xhigh"
export type MemoryScope = "session" | "project" | "global"
export type BridgeAuthScope = "read" | "write" | "control" | "admin"
export type HookEventName =
  | "session_start"
  | "session_end"
  | "before_model"
  | "after_model"
  | "before_tool"
  | "after_tool"

export type ProviderConfig = {
  kind: ProviderKind
  model: string
  baseUrl?: string
  apiKey?: string
  enterpriseUrl?: string
  maxTokens: number
}

export type ProviderProfile = {
  label: string
  kind: ProviderKind
  model: string
  baseUrl?: string
  enterpriseUrl?: string
  description?: string
}

export type PathPermissionRule = {
  pattern: string
  allow: boolean
}

export type PermissionConfig = {
  mode: PermissionMode
  writableRoots: string[]
  commandAllowlist: string[]
  deniedCommands?: string[]
  pathRules?: PathPermissionRule[]
}

export type McpServerConfig = {
  name: string
  transport: "stdio"
  command: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
}

export type HookDefinition = {
  name: string
  event: HookEventName
  type: "command" | "http"
  command?: string
  url?: string
  method?: "GET" | "POST"
  headers?: Record<string, string>
  matcher?: string
  timeoutMs?: number
  blockOnFailure?: boolean
  description?: string
}

export type MemoryConfig = {
  enabled: boolean
  includeSession: boolean
  includeProject: boolean
  includeGlobal: boolean
  projectDirName: string
  projectFileName: string
  globalFile: string
}

export type SessionBackendConfig = {
  kind: "file"
}

export type SandboxConfig = {
  enabled: boolean
  strategy?: "auto" | "command" | "macos" | "linux-bwrap"
  profile?: "workspace-write" | "workspace-readonly"
  command?: string
  args: string[]
  failIfUnavailable: boolean
}

export type BudgetConfig = {
  warnUsd?: number
  maxUsd?: number
}

export type OutputConfig = {
  style: OutputStyle
  theme: ThemeName
  keybindings: Record<string, string>
}

export type RuntimeConfig = {
  fastMode: boolean
  effort: RuntimeEffort
  maxPasses?: number
  maxTurns?: number
  vimMode: boolean
  voiceMode: boolean
  voiceKeyterms: string[]
}

export type WorktreeConfig = {
  enabled: boolean
  baseDir: string
  cleanup: boolean
}

export type BridgeAuthTokenConfig = {
  token: string
  scopes: BridgeAuthScope[]
  label?: string
}

export type OneClawConfig = {
  homeDir: string
  sessionDir: string
  activeProfile: string
  providerProfiles: Record<string, ProviderProfile>
  provider: ProviderConfig
  permissions: PermissionConfig
  mcpServers: McpServerConfig[]
  skillDirs: string[]
  pluginDirs: string[]
  disabledPlugins?: string[]
  hooks: {
    files: string[]
  }
  memory: MemoryConfig
  sessionBackend: SessionBackendConfig
  sandbox: SandboxConfig
  budget: BudgetConfig
  output: OutputConfig
  runtime: RuntimeConfig
  worktree: WorktreeConfig
  bridge: {
    host: string
    port: number
    authToken?: string
    authTokens?: BridgeAuthTokenConfig[]
  }
  context: {
    maxChars: number
    keepMessages: number
  }
  systemPrompt: string
}

export type ToolSpec = {
  name: string
  description: string
  inputSchema: JsonSchema
  readOnly?: boolean
  source?: "builtin" | "mcp" | "plugin"
}

export type ToolExecution = {
  ok: boolean
  output: string
  metadata?: Record<string, unknown>
}

export type ToolExecutionContext = {
  cwd: string
  config: OneClawConfig
  sessionId: string
  logger: Logger
  memory: {
    read(): Promise<string>
    append(note: string): Promise<void>
  }
  tasks: {
    list(): TaskRecord[]
  }
}

export type ToolImplementation = {
  spec: ToolSpec
  execute(input: unknown, context: ToolExecutionContext): Promise<ToolExecution>
}

export type ProviderTurnInput = {
  systemPrompt: string
  messages: Message[]
  tools: ToolSpec[]
  model: string
  maxTokens: number
}

export type ProviderTurnOutput = {
  content: Array<TextBlock | ToolCallBlock>
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence"
  usage?: {
    inputTokens?: number
    outputTokens?: number
  }
  raw?: unknown
}

export interface ProviderAdapter {
  name: string
  generateTurn(input: ProviderTurnInput): Promise<ProviderTurnOutput>
}

export type PermissionDecision = {
  allowed: boolean
  reason: string
}

export type RuntimeHook = {
  beforeModelCall?: (payload: {
    sessionId: string
    messages: Message[]
    prompt: string
  }) => Promise<void> | void
  afterModelCall?: (payload: {
    sessionId: string
    output: ProviderTurnOutput
  }) => Promise<void> | void
  beforeTool?: (payload: {
    sessionId: string
    toolCall: ToolCallBlock
  }) => Promise<void> | void
  afterTool?: (payload: {
    sessionId: string
    toolCall: ToolCallBlock
    result: ToolExecution
  }) => Promise<void> | void
}

export type PluginDefinition = {
  name: string
  tools?: ToolImplementation[]
  hooks?: RuntimeHook
  hookDefinitions?: HookDefinition[]
  systemPromptPatches?: string[]
}

export type SessionRecord = {
  id: string
  cwd: string
  createdAt: string
  updatedAt: string
  messages: Message[]
  metadata?: Record<string, unknown>
}

export type SessionRunResult = {
  sessionId: string
  text: string
  iterations: number
  stopReason: ProviderTurnOutput["stopReason"]
  usage?: ProviderTurnOutput["usage"]
}

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "killed"

export type TaskRecord = {
  id: string
  label: string
  status: TaskStatus
  startedAt: string
  endedAt?: string
  cwd?: string
  description?: string
  outputPath?: string
  parentTaskId?: string
  metadata?: Record<string, string>
  result?: string
  error?: string
}

export type Logger = {
  info(message: string): void
  warn(message: string): void
  error(message: string): void
  debug?(message: string): void
}
