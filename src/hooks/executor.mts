import { spawn } from "node:child_process"
import { type HookDefinition, type HookEventName, type Logger, type OneClawConfig } from "../types.mts"
import { buildShellInvocation, defaultShell } from "../sandbox/adapter.mts"
import { isRecord, matchesPattern } from "../utils.mts"

export type HookExecutionResult = {
  hook: string
  success: boolean
  blocked: boolean
  output: string
  reason: string
}

function interpolate(template: string, payload: Record<string, unknown>): string {
  return template.replace(/\{([\w.]+)\}/g, (_full, key) => {
    const value = payload[key]
    if (value === undefined) {
      return ""
    }
    if (typeof value === "string") {
      return value
    }
    return JSON.stringify(value)
  })
}

function matcherSubject(payload: Record<string, unknown>): string {
  if (typeof payload.toolName === "string") {
    return payload.toolName
  }
  if (typeof payload.prompt === "string") {
    return payload.prompt
  }
  if (typeof payload.sessionId === "string") {
    return payload.sessionId
  }
  return ""
}

async function runCommandHook(
  definition: HookDefinition,
  payload: Record<string, unknown>,
  cwd: string,
  config: OneClawConfig,
): Promise<HookExecutionResult> {
  const shell = defaultShell()
  const invocation = buildShellInvocation(
    config,
    shell,
    interpolate(definition.command ?? "", payload),
  )
  return new Promise(resolve => {
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: {
        ...process.env,
        ONECLAW_HOOK_EVENT: String(payload.event ?? definition.event),
        ONECLAW_HOOK_PAYLOAD: JSON.stringify(payload),
      },
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
    }, definition.timeoutMs ?? 5_000)

    child.stdout.on("data", chunk => {
      stdout += String(chunk)
    })
    child.stderr.on("data", chunk => {
      stderr += String(chunk)
    })
    child.on("close", code => {
      clearTimeout(timer)
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n")
      resolve({
        hook: definition.name,
        success: code === 0,
        blocked: Boolean(definition.blockOnFailure) && code !== 0,
        output,
        reason: output || `command hook exited with code ${code}`,
      })
    })
  })
}

async function runHttpHook(
  definition: HookDefinition,
  payload: Record<string, unknown>,
): Promise<HookExecutionResult> {
  const response = await fetch(definition.url!, {
    method: definition.method ?? "POST",
    headers: {
      "content-type": "application/json",
      ...(definition.headers ?? {}),
    },
    body: JSON.stringify({
      event: definition.event,
      payload,
    }),
  })
  const output = await response.text()
  return {
    hook: definition.name,
    success: response.ok,
    blocked: Boolean(definition.blockOnFailure) && !response.ok,
    output,
    reason: output || `http hook returned ${response.status}`,
  }
}

export class HookExecutor {
  constructor(
    private readonly config: OneClawConfig,
    private readonly logger: Logger,
    private readonly definitions: HookDefinition[],
  ) {}

  list(): HookDefinition[] {
    return [...this.definitions]
  }

  async execute(
    event: HookEventName,
    payload: Record<string, unknown>,
    cwd: string,
  ): Promise<HookExecutionResult[]> {
    const results: HookExecutionResult[] = []
    for (const definition of this.definitions.filter(item => item.event === event)) {
      if (
        definition.matcher &&
        !matchesPattern(definition.matcher, matcherSubject(payload))
      ) {
        continue
      }

      const safePayload = isRecord(payload) ? payload : {}
      const result = definition.type === "http" && definition.url
        ? await runHttpHook(definition, safePayload)
        : await runCommandHook(definition, safePayload, cwd, this.config)
      if (!result.success) {
        this.logger.warn(`[hook] ${definition.name} failed: ${result.reason}`)
      }
      results.push(result)
      if (result.blocked) {
        throw new Error(`Hook blocked execution: ${definition.name}: ${result.reason}`)
      }
    }
    return results
  }
}
