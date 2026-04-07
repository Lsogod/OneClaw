import { unlink, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir, platform } from "node:os"
import { dirname, join, resolve } from "node:path"
import type { PublicProviderKind } from "../types.mts"
import { ensureDir, expandHome, readJsonIfExists } from "../utils.mts"

const CODEX_DEFAULT_PATH = "~/.codex/auth.json"
const CLAUDE_DEFAULT_PATH = "~/.claude/.credentials.json"
const COPILOT_DEFAULT_PATH = "~/.oneclaw/copilot_auth.json"
const OPENHARNESS_COPILOT_PATH = "~/.openharness/copilot_auth.json"

const CLAUDE_OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const CLAUDE_OAUTH_TOKEN_ENDPOINTS = [
  "https://platform.claude.com/v1/oauth/token",
  "https://console.anthropic.com/v1/oauth/token",
]
const CLAUDE_COMMON_BETAS = [
  "interleaved-thinking-2025-05-14",
  "fine-grained-tool-streaming-2025-05-14",
]
const CLAUDE_OAUTH_ONLY_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
]
const COPILOT_CLIENT_ID = "Ov23li8tweQw6odWQebz"

let cachedClaudeSessionId: string | null = null

export type ProviderAuthStatus = {
  kind: PublicProviderKind
  configured: boolean
  source: string
  detail: string
}

export type CodexCredential = {
  accessToken: string
  refreshToken?: string
  sourcePath: string
}

export type ClaudeCredential = {
  accessToken: string
  refreshToken?: string
  expiresAtMs?: number
  sourcePath: string
}

export type CopilotAuthInfo = {
  githubToken: string
  enterpriseUrl?: string
  sourcePath: string
}

export type DeviceCodeResponse = {
  deviceCode: string
  userCode: string
  verificationUri: string
  interval: number
  expiresIn: number
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".")
  if (parts.length !== 3) {
    return null
  }
  try {
    const raw = `${parts[1]}${"=".repeat((4 - (parts[1].length % 4 || 4)) % 4)}`
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>
  } catch {
    return null
  }
}

function getCodeXAuthPath(): string {
  return expandHome(process.env.CODEX_HOME
    ? join(process.env.CODEX_HOME, "auth.json")
    : CODEX_DEFAULT_PATH)
}

function getClaudeCredentialsPath(): string {
  return expandHome(process.env.CLAUDE_HOME
    ? join(process.env.CLAUDE_HOME, ".credentials.json")
    : CLAUDE_DEFAULT_PATH)
}

function getCopilotAuthPath(): string {
  return expandHome(process.env.ONECLAW_COPILOT_AUTH_PATH ?? COPILOT_DEFAULT_PATH)
}

function getOpenHarnessCopilotAuthPath(): string {
  return expandHome(process.env.OPENHARNESS_COPILOT_AUTH_PATH ?? OPENHARNESS_COPILOT_PATH)
}

export function getClaudeOAuthBetas(): string[] {
  return [...CLAUDE_COMMON_BETAS, ...CLAUDE_OAUTH_ONLY_BETAS]
}

export function getClaudeCodeSessionId(): string {
  if (!cachedClaudeSessionId) {
    cachedClaudeSessionId = crypto.randomUUID()
  }
  return cachedClaudeSessionId
}

export async function getClaudeCodeVersion(): Promise<string> {
  const candidates = ["claude", "claude-code"]
  for (const candidate of candidates) {
    const proc = Bun.spawn([candidate, "--version"], {
      stdout: "pipe",
      stderr: "ignore",
    })
    const code = await proc.exited
    if (code === 0) {
      const text = await new Response(proc.stdout).text()
      const version = text.trim().split(/\s+/)[0]
      if (version) {
        return version
      }
    }
  }
  return "2.1.92"
}

export async function getClaudeOAuthHeaders(): Promise<Record<string, string>> {
  const version = await getClaudeCodeVersion()
  return {
    "anthropic-beta": getClaudeOAuthBetas().join(","),
    "user-agent": `claude-cli/${version} (external, cli)`,
    "x-app": "cli",
    "X-Claude-Code-Session-Id": getClaudeCodeSessionId(),
  }
}

export async function getClaudeAttributionHeader(): Promise<string> {
  const version = await getClaudeCodeVersion()
  return `x-anthropic-billing-header: cc_version=${version}; cc_entrypoint=cli;`
}

export async function loadCodexCredential(): Promise<CodexCredential> {
  const sourcePath = getCodeXAuthPath()
  const payload = await readJsonIfExists<Record<string, unknown>>(sourcePath)
  if (!payload) {
    throw new Error(`Codex auth source not found: ${sourcePath}`)
  }

  const tokens = payload.tokens as Record<string, unknown> | undefined
  const accessToken = typeof tokens?.access_token === "string"
    ? tokens.access_token
    : typeof payload.OPENAI_API_KEY === "string"
      ? payload.OPENAI_API_KEY
      : ""
  if (!accessToken) {
    throw new Error(`Codex auth source does not contain an access token: ${sourcePath}`)
  }

  return {
    accessToken,
    refreshToken: typeof tokens?.refresh_token === "string" ? tokens.refresh_token : undefined,
    sourcePath,
  }
}

function coerceTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim())
  }
  return undefined
}

export async function loadClaudeCredential(refreshIfNeeded = true): Promise<ClaudeCredential> {
  const sourcePath = getClaudeCredentialsPath()
  const payload = await readJsonIfExists<Record<string, unknown>>(sourcePath)
  if (!payload) {
    throw new Error(`Claude credentials not found: ${sourcePath}`)
  }
  const oauth = payload.claudeAiOauth as Record<string, unknown> | undefined
  if (!oauth || typeof oauth.accessToken !== "string") {
    throw new Error(`Claude credentials missing claudeAiOauth.accessToken: ${sourcePath}`)
  }

  let credential: ClaudeCredential = {
    accessToken: oauth.accessToken,
    refreshToken: typeof oauth.refreshToken === "string" ? oauth.refreshToken : undefined,
    expiresAtMs: coerceTimestamp(oauth.expiresAt),
    sourcePath,
  }

  if (
    refreshIfNeeded &&
    credential.expiresAtMs &&
    credential.expiresAtMs <= Date.now() &&
    credential.refreshToken
  ) {
    const refreshed = await refreshClaudeCredential(credential.refreshToken)
    await writeClaudeCredential({
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAtMs: refreshed.expiresAtMs,
      sourcePath,
    })
    credential = refreshed
  }

  return credential
}

export async function refreshClaudeCredential(refreshToken: string): Promise<ClaudeCredential> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLAUDE_OAUTH_CLIENT_ID,
  })
  const version = await getClaudeCodeVersion()

  let lastError = "Unknown Claude OAuth refresh failure"
  for (const endpoint of CLAUDE_OAUTH_TOKEN_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "user-agent": `claude-cli/${version} (external, cli)`,
        },
        body,
      })
      if (!response.ok) {
        lastError = await response.text()
        continue
      }
      const payload = await response.json() as {
        access_token?: string
        refresh_token?: string
        expires_in?: number
      }
      if (!payload.access_token) {
        lastError = "Claude OAuth refresh response missing access_token"
        continue
      }
      return {
        accessToken: payload.access_token,
        refreshToken: payload.refresh_token ?? refreshToken,
        expiresAtMs: Date.now() + (payload.expires_in ?? 3600) * 1000,
        sourcePath: getClaudeCredentialsPath(),
      }
    } catch (error) {
      lastError = String(error)
    }
  }

  throw new Error(`Claude OAuth refresh failed: ${lastError}`)
}

export async function writeClaudeCredential(credential: ClaudeCredential): Promise<void> {
  const sourcePath = credential.sourcePath
  const existing = await readJsonIfExists<Record<string, unknown>>(sourcePath) ?? {}
  const previous = existing.claudeAiOauth as Record<string, unknown> | undefined
  existing.claudeAiOauth = {
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken ?? "",
    expiresAt: credential.expiresAtMs ?? Date.now() + 3600 * 1000,
    ...(previous?.scopes ? { scopes: previous.scopes } : {}),
    ...(previous?.rateLimitTier ? { rateLimitTier: previous.rateLimitTier } : {}),
    ...(previous?.subscriptionType ? { subscriptionType: previous.subscriptionType } : {}),
  }
  await ensureDir(dirname(sourcePath))
  await writeFile(sourcePath, JSON.stringify(existing, null, 2))
}

export async function loadCopilotAuth(): Promise<CopilotAuthInfo | null> {
  for (const sourcePath of [getCopilotAuthPath(), getOpenHarnessCopilotAuthPath()]) {
    if (!existsSync(sourcePath)) {
      continue
    }
    const payload = await readJsonIfExists<Record<string, unknown>>(sourcePath)
    if (!payload || typeof payload.github_token !== "string") {
      continue
    }
    return {
      githubToken: payload.github_token,
      enterpriseUrl: typeof payload.enterprise_url === "string" ? payload.enterprise_url : undefined,
      sourcePath,
    }
  }
  return null
}

export async function saveCopilotAuth(token: string, enterpriseUrl?: string): Promise<string> {
  const sourcePath = getCopilotAuthPath()
  await ensureDir(dirname(sourcePath))
  await writeFile(sourcePath, JSON.stringify({
    github_token: token,
    ...(enterpriseUrl ? { enterprise_url: enterpriseUrl } : {}),
  }, null, 2))
  return sourcePath
}

export async function clearCopilotAuth(): Promise<void> {
  const sourcePaths = [
    getCopilotAuthPath(),
    getOpenHarnessCopilotAuthPath(),
  ]

  for (const sourcePath of sourcePaths) {
    if (!existsSync(sourcePath)) {
      continue
    }
    await unlink(sourcePath)
  }
}

export function getCopilotApiBase(enterpriseUrl?: string): string {
  if (!enterpriseUrl) {
    return "https://api.githubcopilot.com"
  }
  const domain = enterpriseUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")
  return `https://copilot-api.${domain}`
}

export async function requestCopilotDeviceCode(
  githubDomain = "github.com",
): Promise<DeviceCodeResponse> {
  const response = await fetch(`https://${githubDomain}/login/device/code`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_id: COPILOT_CLIENT_ID,
      scope: "read:user",
    }),
  })
  if (!response.ok) {
    throw new Error(`Copilot device-code request failed: ${response.status} ${await response.text()}`)
  }
  const payload = await response.json() as {
    device_code: string
    user_code: string
    verification_uri: string
    interval?: number
    expires_in?: number
  }
  return {
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUri: payload.verification_uri,
    interval: payload.interval ?? 5,
    expiresIn: payload.expires_in ?? 900,
  }
}

export async function pollCopilotAccessToken(
  deviceCode: string,
  intervalSeconds: number,
  githubDomain = "github.com",
  timeoutSeconds = 900,
): Promise<string> {
  const startedAt = Date.now()
  let intervalMs = intervalSeconds * 1000
  while (Date.now() - startedAt < timeoutSeconds * 1000) {
    await Bun.sleep(intervalMs + 3000)
    const response = await fetch(`https://${githubDomain}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_id: COPILOT_CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    })
    if (!response.ok) {
      throw new Error(`Copilot OAuth polling failed: ${response.status} ${await response.text()}`)
    }
    const payload = await response.json() as {
      access_token?: string
      error?: string
      error_description?: string
      interval?: number
    }

    if (payload.access_token) {
      return payload.access_token
    }
    if (payload.error === "authorization_pending") {
      continue
    }
    if (payload.error === "slow_down") {
      intervalMs = (payload.interval ?? intervalSeconds + 5) * 1000
      continue
    }
    throw new Error(payload.error_description ?? payload.error ?? "Unknown Copilot OAuth error")
  }
  throw new Error("Copilot OAuth device flow timed out waiting for authorisation.")
}

export async function collectProviderAuthStatuses(): Promise<ProviderAuthStatus[]> {
  const result: ProviderAuthStatus[] = []

  result.push({
    kind: "anthropic-compatible",
    configured: Boolean(process.env.ONECLAW_API_KEY || process.env.ANTHROPIC_API_KEY),
    source: process.env.ONECLAW_API_KEY || process.env.ANTHROPIC_API_KEY ? "env" : "missing",
    detail: process.env.ONECLAW_API_KEY || process.env.ANTHROPIC_API_KEY
      ? "API key available in environment"
      : "Set ONECLAW_API_KEY or ANTHROPIC_API_KEY",
  })

  result.push({
    kind: "openai-compatible",
    configured: Boolean(process.env.ONECLAW_API_KEY || process.env.OPENAI_API_KEY),
    source: process.env.ONECLAW_API_KEY || process.env.OPENAI_API_KEY ? "env" : "missing",
    detail: process.env.ONECLAW_API_KEY || process.env.OPENAI_API_KEY
      ? "API key available in environment"
      : "Set ONECLAW_API_KEY or OPENAI_API_KEY",
  })

  try {
    const codex = await loadCodexCredential()
    result.push({
      kind: "codex-subscription",
      configured: true,
      source: "file",
      detail: codex.sourcePath,
    })
  } catch (error) {
    result.push({
      kind: "codex-subscription",
      configured: false,
      source: "missing",
      detail: String(error),
    })
  }

  try {
    const claude = await loadClaudeCredential(false)
    const expired = claude.expiresAtMs ? claude.expiresAtMs <= Date.now() : false
    result.push({
      kind: "claude-subscription",
      configured: !expired || Boolean(claude.refreshToken),
      source: "file",
      detail: expired
        ? `${claude.sourcePath} (expired, refreshable=${Boolean(claude.refreshToken)})`
        : claude.sourcePath,
    })
  } catch (error) {
    result.push({
      kind: "claude-subscription",
      configured: false,
      source: "missing",
      detail: String(error),
    })
  }

  const copilot = await loadCopilotAuth()
  result.push({
    kind: "github-copilot",
    configured: Boolean(copilot),
    source: copilot ? "file" : "missing",
    detail: copilot?.sourcePath ?? "Run `one auth copilot-login`",
  })
  return result
}

export function extractCodexAccountId(accessToken: string): string {
  const payload = decodeJwtPayload(accessToken)
  const auth = payload?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined
  const accountId = typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : ""
  if (!accountId) {
    throw new Error("Codex access token is missing chatgpt_account_id.")
  }
  return accountId
}

export async function buildCodexHeaders(accessToken: string): Promise<Record<string, string>> {
  return {
    authorization: `Bearer ${accessToken}`,
    "chatgpt-account-id": extractCodexAccountId(accessToken),
    originator: "oneclaw",
    "user-agent": `oneclaw (${platform()} bun)`,
    "openai-beta": "responses=experimental",
    accept: "text/event-stream",
    "content-type": "application/json",
  }
}
