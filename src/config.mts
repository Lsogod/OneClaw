import { join } from "node:path"
import type {
  BridgeAuthTokenConfig,
  OneClawConfig,
  ProviderKind,
  ProviderProfile,
} from "./types.mts"
import {
  BUILTIN_PROVIDER_PROFILES,
  INTERNAL_PROVIDER_PROFILES,
} from "./providers/profiles.mts"
import {
  deepMergeConfig,
  ensureDir,
  expandHome,
  readJsonIfExists,
  writeJson,
} from "./utils.mts"

export const DEFAULT_KEYBINDINGS = {
  submit: "enter",
  exit: "ctrl+c",
  help: "/help",
}

const DEFAULT_SYSTEM_PROMPT = [
  "You are OneClaw, a pragmatic coding agent.",
  "Prefer concrete answers over general advice.",
  "When tools are available, use them to gather evidence before making claims.",
  "Keep reasoning grounded in the current workspace and return concise engineering output.",
].join(" ")

function getConfigCandidates(cwd: string, homeDir: string): string[] {
  const explicitConfigPath = process.env.ONECLAW_CONFIG
  return [...new Set([
    join(homeDir, "oneclaw.config.json"),
    join(cwd, "oneclaw.config.json"),
    explicitConfigPath ? expandHome(explicitConfigPath) : undefined,
  ].filter(Boolean) as string[])]
}

function parseNumberEnv(name: string): number | undefined {
  const raw = process.env[name]
  if (!raw) {
    return undefined
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : undefined
}

function parseBridgeAuthTokensEnv(): BridgeAuthTokenConfig[] | undefined {
  const raw = process.env.ONECLAW_BRIDGE_AUTH_TOKENS
  if (!raw) {
    return undefined
  }
  try {
    const parsed = JSON.parse(raw) as BridgeAuthTokenConfig[]
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function selectProfileName(
  profiles: Record<string, ProviderProfile>,
  requestedName: string,
): string {
  if (profiles[requestedName]) {
    return requestedName
  }
  if (profiles["codex-subscription"]) {
    return "codex-subscription"
  }
  return Object.keys(profiles).sort()[0] ?? "codex-subscription"
}

function resolveProfileNameForKind(
  profiles: Record<string, ProviderProfile>,
  kind: ProviderKind,
  preferredName?: string,
): string {
  if (preferredName && profiles[preferredName]?.kind === kind) {
    return preferredName
  }
  if (profiles[kind]?.kind === kind) {
    return kind
  }
  const match = Object.entries(profiles)
    .find(([, profile]) => profile.kind === kind)
  return match?.[0] ?? kind
}

export async function loadConfig(cwd = process.cwd()): Promise<OneClawConfig> {
  const homeDir = expandHome(process.env.ONECLAW_HOME ?? "~/.oneclaw")
  const defaults: OneClawConfig = {
    homeDir,
    sessionDir: join(homeDir, "sessions"),
    activeProfile: "codex-subscription",
    providerProfiles: { ...BUILTIN_PROVIDER_PROFILES },
    provider: {
      kind: "codex-subscription",
      model: "gpt-5.4",
      maxTokens: 4096,
    },
    permissions: {
      mode: "ask",
      writableRoots: [cwd],
      commandAllowlist: [],
      deniedCommands: [],
      pathRules: [],
    },
    mcpServers: [],
    skillDirs: [
      join(cwd, "skills"),
      join(homeDir, "skills"),
    ],
    pluginDirs: [
      join(cwd, "plugins"),
      join(homeDir, "plugins"),
    ],
    disabledPlugins: [],
    hooks: {
      files: [
        join(cwd, ".oneclaw", "hooks.json"),
        join(homeDir, "hooks.json"),
      ],
    },
    memory: {
      enabled: true,
      includeSession: true,
      includeProject: true,
      includeGlobal: true,
      projectDirName: ".oneclaw",
      projectFileName: "memory.md",
      globalFile: join(homeDir, "memory", "global.md"),
    },
    sessionBackend: {
      kind: "file",
    },
    sandbox: {
      enabled: false,
      strategy: "auto",
      profile: "workspace-write",
      args: [],
      failIfUnavailable: false,
    },
    budget: {},
    output: {
      style: "text",
      theme: "neutral",
      keybindings: { ...DEFAULT_KEYBINDINGS },
    },
    worktree: {
      enabled: false,
      baseDir: join(homeDir, "worktrees"),
      cleanup: true,
    },
    bridge: {
      host: "127.0.0.1",
      port: 4520,
      authToken: undefined,
      authTokens: [],
    },
    context: {
      maxChars: 24000,
      keepMessages: 8,
    },
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
  }

  await ensureDir(defaults.homeDir)
  await ensureDir(defaults.sessionDir)
  await ensureDir(join(defaults.homeDir, "memory"))
  await ensureDir(defaults.worktree.baseDir)

  const configCandidates = getConfigCandidates(cwd, homeDir)

  let merged = defaults

  for (const candidate of configCandidates) {
    const loaded = await readJsonIfExists<Partial<OneClawConfig>>(candidate)
    if (loaded) {
      merged = deepMergeConfig(merged, loaded)
    }
  }

  if (merged.permissions.writableRoots.length === 0) {
    merged.permissions.writableRoots = [cwd]
  }

  const visibleProfiles = {
    ...BUILTIN_PROVIDER_PROFILES,
    ...merged.providerProfiles,
  }
  const allProfiles = {
    ...INTERNAL_PROVIDER_PROFILES,
    ...visibleProfiles,
  }
  merged.providerProfiles = visibleProfiles

  const requestedProfileName = selectProfileName(
    visibleProfiles,
    process.env.ONECLAW_PROFILE ?? merged.activeProfile,
  )
  const envProviderKind = process.env.ONECLAW_PROVIDER as ProviderKind | undefined
  const effectiveProfileName = envProviderKind
    ? resolveProfileNameForKind(allProfiles, envProviderKind, requestedProfileName)
    : requestedProfileName
  const activeProfile = allProfiles[effectiveProfileName]
    ?? BUILTIN_PROVIDER_PROFILES["codex-subscription"]
    ?? INTERNAL_PROVIDER_PROFILES["internal-test"]
  const preserveProviderOverrides = !envProviderKind || merged.provider.kind === envProviderKind
  merged.activeProfile = effectiveProfileName
  merged.provider = {
    kind: envProviderKind ?? activeProfile.kind,
    model: process.env.ONECLAW_MODEL
      ?? (preserveProviderOverrides ? (merged.provider.model || activeProfile.model) : activeProfile.model),
    baseUrl: process.env.ONECLAW_BASE_URL
      ?? (preserveProviderOverrides ? (merged.provider.baseUrl ?? activeProfile.baseUrl) : activeProfile.baseUrl),
    enterpriseUrl: process.env.ONECLAW_ENTERPRISE_URL
      ?? (preserveProviderOverrides ? (merged.provider.enterpriseUrl ?? activeProfile.enterpriseUrl) : activeProfile.enterpriseUrl),
    apiKey: process.env.ONECLAW_API_KEY ?? merged.provider.apiKey,
    maxTokens: parseNumberEnv("ONECLAW_MAX_TOKENS") ?? merged.provider.maxTokens ?? defaults.provider.maxTokens,
  }
  merged.permissions.mode = (process.env.ONECLAW_PERMISSION_MODE as OneClawConfig["permissions"]["mode"])
    ?? merged.permissions.mode
  merged.sandbox.enabled = process.env.ONECLAW_SANDBOX === "1"
    ? true
    : merged.sandbox.enabled
  merged.sandbox.strategy = (process.env.ONECLAW_SANDBOX_STRATEGY as OneClawConfig["sandbox"]["strategy"])
    ?? merged.sandbox.strategy
  merged.sandbox.profile = (process.env.ONECLAW_SANDBOX_PROFILE as OneClawConfig["sandbox"]["profile"])
    ?? merged.sandbox.profile
  merged.sandbox.command = process.env.ONECLAW_SANDBOX_COMMAND ?? merged.sandbox.command
  merged.budget.warnUsd = parseNumberEnv("ONECLAW_BUDGET_WARN_USD") ?? merged.budget.warnUsd
  merged.budget.maxUsd = parseNumberEnv("ONECLAW_BUDGET_MAX_USD") ?? merged.budget.maxUsd
  merged.output = {
    ...merged.output,
    style: (process.env.ONECLAW_OUTPUT_STYLE as OneClawConfig["output"]["style"]) ?? merged.output.style,
    theme: (process.env.ONECLAW_THEME as OneClawConfig["output"]["theme"]) ?? merged.output.theme,
    keybindings: {
      ...DEFAULT_KEYBINDINGS,
      ...merged.output.keybindings,
    },
  }
  merged.worktree.enabled = process.env.ONECLAW_ENABLE_WORKTREES === "1"
    ? true
    : merged.worktree.enabled
  merged.bridge.host = process.env.ONECLAW_BRIDGE_HOST ?? merged.bridge.host
  merged.bridge.port = parseNumberEnv("ONECLAW_BRIDGE_PORT") ?? merged.bridge.port
  merged.bridge.authToken = process.env.ONECLAW_BRIDGE_TOKEN ?? merged.bridge.authToken
  merged.bridge.authTokens = parseBridgeAuthTokensEnv() ?? merged.bridge.authTokens ?? []
  merged.context.maxChars = parseNumberEnv("ONECLAW_MAX_CONTEXT_CHARS") ?? merged.context.maxChars
  merged.context.keepMessages = parseNumberEnv("ONECLAW_KEEP_MESSAGES") ?? merged.context.keepMessages

  return merged
}

export async function saveUserConfigPatch(
  patch: Partial<OneClawConfig>,
  cwd = process.cwd(),
): Promise<string> {
  const config = await loadConfig(cwd)
  const targetPath = join(config.homeDir, "oneclaw.config.json")
  const existing = await readJsonIfExists<Record<string, unknown>>(targetPath) ?? {}
  const merged = deepMergeConfig(existing, patch as Record<string, unknown>)
  await writeJson(targetPath, merged)
  return targetPath
}
