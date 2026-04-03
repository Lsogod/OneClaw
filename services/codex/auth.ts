import { execa } from 'execa'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import {
  type CodexAuthMode,
  getCodexOpenAIApiKeyEnvVar,
  normalizeCodexAuthMode,
} from '../../utils/model/providers.js'
import { logForDebugging } from '../../utils/debug.js'
import { errorMessage } from '../../utils/errors.js'

export type CodexAuthStatus = {
  loggedIn: boolean
  authMode: CodexAuthMode | null
  accountId: string | null
  email: string | null
  name: string | null
  plan: string | null
  planSource: 'live_usage' | 'auth_json' | null
  organizationTitle: string | null
  subscriptionLastChecked: string | null
  subscriptionActiveStart: string | null
  subscriptionActiveUntil: string | null
  lastRefresh: string | null
  usageFetchedAt: string | null
  usage: CodexNormalizedUsage | null
  rawStatus: string | null
}

export type CodexUsageWindow = {
  label: string
  usedPercent: number | null
  remainingPercent: number | null
  windowDurationMins: number | null
  resetAt: string | null
}

export type CodexAdditionalRateLimit = {
  label: string
  blocked: boolean
  primary: CodexUsageWindow | null
  secondary: CodexUsageWindow | null
}

export type CodexUsageCredits = {
  hasCredits: boolean
  unlimited: boolean
  balance: number | null
}

export type CodexNormalizedUsage = {
  planType: string | null
  blocked: boolean
  primary: CodexUsageWindow | null
  secondary: CodexUsageWindow | null
  codeReview: CodexUsageWindow | null
  additionalLimits: CodexAdditionalRateLimit[]
  credits: CodexUsageCredits | null
  summary: CodexUsageWindow | null
}

type CodexAuthFile = {
  auth_mode?: string | null
  OPENAI_API_KEY?: string | null
  last_refresh?: string | null
  tokens?: {
    account_id?: string | null
    access_token?: string | null
    id_token?: string | null
  } | null
}

type CodexUsageCache = {
  planType?: string | null
  fetchedAt?: string | null
  email?: string | null
  accountId?: string | null
  usage?: CodexNormalizedUsage | null
}

function getCodexAuthFilePath(): string {
  return join(homedir(), '.codex', 'auth.json')
}

function getCodexUsageCachePath(): string {
  return join(homedir(), '.codex', '.one-claw-usage.json')
}

function decodeJwtPayload(token: string | null | undefined): Record<string, unknown> | null {
  if (!token) {
    return null
  }

  const parts = token.split('.')
  if (parts.length < 2) {
    return null
  }

  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const padded = base64 + '='.repeat((4 - base64.length % 4) % 4)
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return null
  }
}

function readCodexAuthFile(): CodexAuthFile | null {
  const file = getCodexAuthFilePath()
  if (!existsSync(file)) {
    return null
  }

  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CodexAuthFile
  } catch (error) {
    logForDebugging(
      `[codex-auth] Failed to parse ${file}: ${errorMessage(error)}`,
    )
    return null
  }
}

function readCodexUsageCache(): CodexUsageCache | null {
  const file = getCodexUsageCachePath()
  if (!existsSync(file)) {
    return null
  }

  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CodexUsageCache
  } catch (error) {
    logForDebugging(
      `[codex-auth] Failed to parse ${file}: ${errorMessage(error)}`,
    )
    return null
  }
}

function writeCodexUsageCache(cache: CodexUsageCache): void {
  try {
    writeFileSync(getCodexUsageCachePath(), JSON.stringify(cache, null, 2))
  } catch (error) {
    logForDebugging(
      `[codex-auth] Failed to write usage cache: ${errorMessage(error)}`,
    )
  }
}

export function clearCodexUsageCache(): void {
  const file = getCodexUsageCachePath()
  if (!existsSync(file)) {
    return
  }

  try {
    unlinkSync(file)
  } catch (error) {
    logForDebugging(
      `[codex-auth] Failed to clear usage cache: ${errorMessage(error)}`,
    )
  }
}

export function getCodexAuthSnapshot(): Omit<CodexAuthStatus, 'rawStatus'> {
  const authFile = readCodexAuthFile()
  const usageCache = readCodexUsageCache()
  const accessPayload = decodeJwtPayload(authFile?.tokens?.access_token)
  const idPayload = decodeJwtPayload(authFile?.tokens?.id_token)
  const authMode =
    normalizeCodexAuthMode(authFile?.auth_mode) ??
    (typeof authFile?.OPENAI_API_KEY === 'string' && authFile.OPENAI_API_KEY
      ? 'api_key'
      : null)
  const loggedIn =
    !!authFile?.tokens?.access_token ||
    !!(typeof authFile?.OPENAI_API_KEY === 'string' && authFile.OPENAI_API_KEY)
  const tokenPlan =
    getPlanFromPayload(accessPayload) ?? getPlanFromPayload(idPayload)
  const livePlan =
    loggedIn && typeof usageCache?.planType === 'string'
      ? usageCache.planType
      : null

  return {
    loggedIn,
    authMode,
    accountId:
      typeof authFile?.tokens?.account_id === 'string'
        ? authFile.tokens.account_id
        : null,
    email: getEmailFromPayload(accessPayload) ?? getEmailFromPayload(idPayload),
    name: getNameFromPayload(accessPayload) ?? getNameFromPayload(idPayload),
    plan: livePlan ?? tokenPlan,
    planSource: livePlan ? 'live_usage' : tokenPlan ? 'auth_json' : null,
    organizationTitle:
      getOrganizationTitleFromPayload(accessPayload) ??
      getOrganizationTitleFromPayload(idPayload),
    subscriptionLastChecked:
      getSubscriptionLastCheckedFromPayload(accessPayload) ??
      getSubscriptionLastCheckedFromPayload(idPayload),
    subscriptionActiveStart:
      getSubscriptionActiveStartFromPayload(accessPayload) ??
      getSubscriptionActiveStartFromPayload(idPayload),
    subscriptionActiveUntil:
      getSubscriptionActiveUntilFromPayload(accessPayload) ??
      getSubscriptionActiveUntilFromPayload(idPayload),
    lastRefresh:
      typeof authFile?.last_refresh === 'string' ? authFile.last_refresh : null,
    usageFetchedAt:
      loggedIn && typeof usageCache?.fetchedAt === 'string'
        ? usageCache.fetchedAt
        : null,
    usage: loggedIn ? usageCache?.usage ?? null : null,
  }
}

function formatWindowLabel(windowDurationMins: number | null): string {
  if (!Number.isFinite(windowDurationMins) || windowDurationMins === null || windowDurationMins <= 0) {
    return 'Usage limit'
  }

  if (windowDurationMins >= 1440) {
    return 'Weekly usage'
  }

  if (windowDurationMins >= 60) {
    const hours = Math.round(windowDurationMins / 60)
    return `${hours}-hour usage`
  }

  return `${windowDurationMins}-minute usage`
}

function clampPercent(value: unknown): number | null {
  if (!Number.isFinite(value)) {
    return null
  }

  return Math.max(0, Math.min(100, Math.round(Number(value))))
}

function toIsoFromUnixSeconds(value: unknown): string | null {
  if (!Number.isFinite(value) || Number(value) <= 0) {
    return null
  }

  return new Date(Number(value) * 1000).toISOString()
}

function normalizeUsageWindow(
  window: Record<string, unknown> | null | undefined,
  fallbackName: string | null = null,
): CodexUsageWindow | null {
  if (!window || typeof window !== 'object') {
    return null
  }

  const usedPercent = clampPercent(window.used_percent)
  const remainingPercent =
    usedPercent === null ? null : clampPercent(100 - usedPercent)
  const windowDurationMins = Number.isFinite(window.limit_window_seconds)
    ? Math.round(Number(window.limit_window_seconds) / 60)
    : null

  return {
    label: fallbackName || formatWindowLabel(windowDurationMins),
    usedPercent,
    remainingPercent,
    windowDurationMins,
    resetAt: toIsoFromUnixSeconds(window.reset_at),
  }
}

function normalizeUsageResponse(
  usage: Record<string, unknown> | null,
): CodexNormalizedUsage | null {
  if (!usage || typeof usage !== 'object') {
    return null
  }

  const rateLimit =
    usage.rate_limit && typeof usage.rate_limit === 'object'
      ? (usage.rate_limit as Record<string, unknown>)
      : null
  const codeReviewRateLimit =
    usage.code_review_rate_limit &&
    typeof usage.code_review_rate_limit === 'object'
      ? (usage.code_review_rate_limit as Record<string, unknown>)
      : null

  const primary = normalizeUsageWindow(
    rateLimit?.primary_window as Record<string, unknown> | null | undefined,
  )
  const secondary = normalizeUsageWindow(
    rateLimit?.secondary_window as Record<string, unknown> | null | undefined,
  )
  const codeReview = normalizeUsageWindow(
    codeReviewRateLimit?.primary_window as
      | Record<string, unknown>
      | null
      | undefined,
    'Code review usage',
  )

  const additionalLimits = Array.isArray(usage.additional_rate_limits)
    ? usage.additional_rate_limits
        .map(entry => {
          if (!entry || typeof entry !== 'object') {
            return null
          }

          const record = entry as Record<string, unknown>
          const label =
            typeof record.limit_name === 'string' && record.limit_name.trim()
              ? record.limit_name.trim()
              : 'Additional usage'
          const limit =
            record.rate_limit && typeof record.rate_limit === 'object'
              ? (record.rate_limit as Record<string, unknown>)
              : null

          return {
            label,
            blocked:
              limit?.limit_reached === true || limit?.allowed === false,
            primary: normalizeUsageWindow(
              limit?.primary_window as Record<string, unknown> | null | undefined,
              label,
            ),
            secondary: normalizeUsageWindow(
              limit?.secondary_window as Record<string, unknown> | null | undefined,
              label,
            ),
          } satisfies CodexAdditionalRateLimit
        })
        .filter(
          (entry): entry is CodexAdditionalRateLimit =>
            entry !== null && (!!entry.primary || !!entry.secondary),
        )
    : []

  const credits =
    usage.credits && typeof usage.credits === 'object'
      ? {
          hasCredits: usage.credits.has_credits === true,
          unlimited: usage.credits.unlimited === true,
          balance: Number.isFinite(usage.credits.balance)
            ? Number(usage.credits.balance)
            : null,
        }
      : null

  return {
    planType: typeof usage.plan_type === 'string' ? usage.plan_type : null,
    blocked: rateLimit?.limit_reached === true || rateLimit?.allowed === false,
    primary,
    secondary,
    codeReview,
    additionalLimits,
    credits,
    summary: primary || secondary || codeReview || additionalLimits[0]?.primary || null,
  }
}

function getPlanFromPayload(payload: Record<string, unknown> | null): string | null {
  const auth = payload?.['https://api.openai.com/auth']
  if (!auth || typeof auth !== 'object') {
    return null
  }

  const plan = (auth as Record<string, unknown>).chatgpt_plan_type
  return typeof plan === 'string' ? plan : null
}

function getEmailFromPayload(payload: Record<string, unknown> | null): string | null {
  const email = payload?.email
  return typeof email === 'string' ? email : null
}

function getNameFromPayload(payload: Record<string, unknown> | null): string | null {
  const name = payload?.name
  return typeof name === 'string' ? name : null
}

function getOrganizationTitleFromPayload(
  payload: Record<string, unknown> | null,
): string | null {
  const auth = payload?.['https://api.openai.com/auth']
  if (!auth || typeof auth !== 'object') {
    return null
  }

  const organizations = (auth as Record<string, unknown>).organizations
  if (!Array.isArray(organizations)) {
    return null
  }

  for (const item of organizations) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const record = item as Record<string, unknown>
    if (record.is_default === true && typeof record.title === 'string') {
      return record.title
    }
  }

  for (const item of organizations) {
    if (!item || typeof item !== 'object') {
      continue
    }
    const title = (item as Record<string, unknown>).title
    if (typeof title === 'string') {
      return title
    }
  }

  return null
}

function getSubscriptionLastCheckedFromPayload(
  payload: Record<string, unknown> | null,
): string | null {
  const auth = payload?.['https://api.openai.com/auth']
  if (!auth || typeof auth !== 'object') {
    return null
  }

  const value = (auth as Record<string, unknown>).chatgpt_subscription_last_checked
  return typeof value === 'string' ? value : null
}

function getSubscriptionActiveStartFromPayload(
  payload: Record<string, unknown> | null,
): string | null {
  const auth = payload?.['https://api.openai.com/auth']
  if (!auth || typeof auth !== 'object') {
    return null
  }

  const value = (auth as Record<string, unknown>).chatgpt_subscription_active_start
  return typeof value === 'string' ? value : null
}

function getSubscriptionActiveUntilFromPayload(
  payload: Record<string, unknown> | null,
): string | null {
  const auth = payload?.['https://api.openai.com/auth']
  if (!auth || typeof auth !== 'object') {
    return null
  }

  const value = (auth as Record<string, unknown>).chatgpt_subscription_active_until
  return typeof value === 'string' ? value : null
}

type CodexUsageResponse = {
  plan_type?: string | null
  email?: string | null
  account_id?: string | null
  rate_limit?: Record<string, unknown> | null
  code_review_rate_limit?: Record<string, unknown> | null
  additional_rate_limits?: Array<Record<string, unknown>> | null
  credits?: Record<string, unknown> | null
}

export async function refreshCodexUsageCache(): Promise<CodexUsageCache | null> {
  const authFile = readCodexAuthFile()
  if (
    normalizeCodexAuthMode(authFile?.auth_mode) !== 'chatgpt' ||
    !authFile.tokens?.access_token ||
    !authFile.tokens?.account_id
  ) {
    clearCodexUsageCache()
    return null
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3_000)

  try {
    const response = await fetch('https://chatgpt.com/backend-api/wham/usage', {
      headers: {
        Authorization: `Bearer ${authFile.tokens.access_token}`,
        'ChatGPT-Account-Id': authFile.tokens.account_id,
        Accept: 'application/json',
        'User-Agent': 'one-claw',
      },
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`wham usage HTTP ${response.status}`)
    }

    const usage = (await response.json()) as CodexUsageResponse
    const normalizedUsage = normalizeUsageResponse(
      usage as unknown as Record<string, unknown>,
    )
    const cache: CodexUsageCache = {
      planType:
        typeof usage.plan_type === 'string' ? usage.plan_type : null,
      fetchedAt: new Date().toISOString(),
      email: typeof usage.email === 'string' ? usage.email : null,
      accountId:
        typeof usage.account_id === 'string' ? usage.account_id : null,
      usage: normalizedUsage,
    }
    writeCodexUsageCache(cache)
    return cache
  } catch (error) {
    logForDebugging(
      `[codex-auth] Failed to refresh live usage: ${errorMessage(error)}`,
    )
    return readCodexUsageCache()
  } finally {
    clearTimeout(timeout)
  }
}

export async function getCodexLoginStatus(): Promise<CodexAuthStatus> {
  let rawStatus: string | null = null
  let loggedIn = false

  try {
    const result = await execa('codex', ['login', 'status'], {
      reject: false,
      timeout: 10_000,
    })
    rawStatus = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    loggedIn =
      result.exitCode === 0 &&
      /logged in/i.test(result.stdout || result.stderr || '')
  } catch (error) {
    rawStatus = errorMessage(error)
  }

  await refreshCodexUsageCache()
  const snapshot = getCodexAuthSnapshot()

  return {
    ...snapshot,
    loggedIn: loggedIn || snapshot.loggedIn,
    rawStatus,
  }
}

export async function loginWithCodexCli(): Promise<void> {
  await loginWithCodexCliWithOptions()
}

export async function logoutFromCodexCli(): Promise<void> {
  await execa('codex', ['logout'], {
    stdio: 'inherit',
  })
  clearCodexUsageCache()
}

export function getCodexAuthModeDisplayName(
  authMode: string | null | undefined,
): string {
  switch (normalizeCodexAuthMode(authMode)) {
    case 'chatgpt':
      return 'ChatGPT'
    case 'api_key':
      return 'API key'
    default:
      return 'Codex'
  }
}

export async function loginWithCodexCliWithOptions(options: {
  mode?: string | null
  apiKeyEnvVar?: string | null
} = {}): Promise<void> {
  const authMode = normalizeCodexAuthMode(options.mode) ?? 'chatgpt'

  if (authMode === 'api_key') {
    const apiKeyEnvVar = options.apiKeyEnvVar?.trim() || getCodexOpenAIApiKeyEnvVar()
    const apiKey = process.env[apiKeyEnvVar]?.trim()

    if (!apiKey) {
      throw new Error(
        `Missing ${apiKeyEnvVar}. Export your OpenAI API key, then rerun one auth login --api-key.`,
      )
    }

    await execa('codex', ['login', '--with-api-key'], {
      input: `${apiKey}\n`,
      stdio: ['pipe', 'inherit', 'inherit'],
    })
    clearCodexUsageCache()
    return
  }

  await execa('codex', ['login'], {
    stdio: 'inherit',
  })
  await refreshCodexUsageCache()
}
