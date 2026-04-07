import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { formatOutput } from "./output/registry.mts"
import { KernelClient } from "./frontend/kernel-client.mts"
import { parseFlagValues, promptFromArgs } from "./utils.mts"
import { startBridgeServer } from "./bridge/server.mts"
import { createFrontendCommandRegistry } from "./commands/frontend-registry.mts"
import { startTextUi } from "./tui/app.mts"
import {
  clearCopilotAuth,
  collectProviderAuthStatuses,
  pollCopilotAccessToken,
  requestCopilotDeviceCode,
  saveCopilotAuth,
} from "./providers/auth.mts"

const ONECLAW_NEXT_VERSION = "0.2.0"
type KernelEvent = Record<string, unknown> & {
  type?: string
  sessionId?: string
}

async function askTerminalQuestion(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    return await rl.question(question)
  } finally {
    rl.close()
  }
}

async function interactiveApprovalHandler(request: {
  toolName: string
  input: Record<string, unknown>
}): Promise<boolean> {
  if (!stdin.isTTY) {
    return false
  }
  const answer = await askTerminalQuestion(
    `Allow tool ${request.toolName}? ${JSON.stringify(request.input)} [y/N] `,
  )
  return /^y(es)?$/i.test(answer.trim())
}

function previewText(value: unknown, maxChars = 120): string {
  if (typeof value !== "string") {
    return ""
  }
  if (value.length <= maxChars) {
    return value
  }
  return `${value.slice(0, maxChars - 1)}…`
}

function formatKernelEvent(event: KernelEvent): string | null {
  switch (event.type) {
    case "iteration_started":
      return `[one:event] iteration=${event.iteration} started`
    case "model_request":
      return `[one:event] iteration=${event.iteration} model request`
    case "model_response": {
      const stopReason = typeof event.stopReason === "string" ? event.stopReason : "unknown"
      const preview = previewText(event.text)
      return preview
        ? `[one:event] model response stop=${stopReason} preview=${JSON.stringify(preview)}`
        : `[one:event] model response stop=${stopReason}`
    }
    case "provider_text_delta":
      return `[one:delta] ${JSON.stringify(String(event.delta ?? ""))}`
    case "tool_started":
      return `[one:tool] start ${String(event.toolName ?? "unknown")}`
    case "tool_finished":
      return `[one:tool] ${event.ok ? "ok" : "error"} ${String(event.toolName ?? "unknown")}`
    case "approval_request":
      return `[one:approval] tool=${String(event.toolName ?? "unknown")} requested`
    case "completed": {
      const result = (event.result ?? {}) as {
        iterations?: number
        stopReason?: string
      }
      return `[one:event] completed iterations=${result.iterations ?? "?"} stop=${result.stopReason ?? "unknown"}`
    }
    default:
      return null
  }
}

function createEventLogger(enabled: boolean): (event: KernelEvent) => void {
  if (!enabled) {
    return () => {}
  }
  return event => {
    const line = formatKernelEvent(event)
    if (!line) {
      return
    }
    process.stderr.write(`${line}\n`)
  }
}

async function runInteractive(): Promise<void> {
  const client = new KernelClient(process.cwd())
  const registry = createFrontendCommandRegistry()
  const session = await client.createSession(process.cwd(), {
    via: "interactive",
  })
  let activeSessionId = session.id
  console.log(`session=${activeSessionId}`)
  try {
    while (true) {
      const line = await askTerminalQuestion("oneclaw> ")
      const trimmed = line.trim()
      if (!trimmed) {
        continue
      }
      const lookedUp = registry.lookup(trimmed)
      if (lookedUp) {
        const result = await lookedUp.command.handler(lookedUp.args, {
          client,
          sessionId: activeSessionId,
          cwd: process.cwd(),
          setSessionId: sessionId => {
            activeSessionId = sessionId
          },
          listSessions: async scope => {
            const records = await client.sessions({
              cwd: process.cwd(),
              scope: scope ?? "project",
            }) as Array<{ id: string; updatedAt?: string }>
            return records
          },
        })
        if (result.message) {
          console.log(result.message)
        }
        if (result.shouldExit) {
          break
        }
        continue
      }
      const result = await client.runPrompt(trimmed, {
        sessionId: activeSessionId,
        onApprovalRequest: interactiveApprovalHandler,
        onEvent: createEventLogger(true),
      })
      activeSessionId = result.sessionId
      console.log(formatOutput("text", result.text))
    }
  } finally {
    await client.close()
  }
}

function readFlag(argv: string[], flag: string): string | undefined {
  const index = argv.findIndex(value => value === flag)
  return index >= 0 ? argv[index + 1] : undefined
}

async function runSinglePrompt(argv: string[]): Promise<void> {
  const prompt = promptFromArgs(argv)
  if (!prompt) {
    await runInteractive()
    return
  }
  const client = new KernelClient(process.cwd())
  try {
    const requestedStyleFlag = readFlag(argv, "--output-format") as "text" | "json" | undefined
    const state = await client.state()
    const requestedStyle = requestedStyleFlag ?? String(state.outputStyle ?? "text")
    const onEvent = createEventLogger(requestedStyle !== "json")
    const result = await client.runPrompt(prompt, {
      cwd: process.cwd(),
      skillNames: parseFlagValues(argv, "--skill"),
      metadata: { via: "cli" },
      onApprovalRequest: interactiveApprovalHandler,
      onEvent,
    })
    console.log(formatOutput(requestedStyle as "text" | "json", {
      text: result.text,
      sessionId: result.sessionId,
      iterations: result.iterations,
      stopReason: result.stopReason,
      usage: result.usage,
    }))
    if (requestedStyle !== "json") {
      console.log(`\nsession=${result.sessionId} iterations=${result.iterations} stop=${result.stopReason}`)
    }
  } finally {
    await client.close()
  }
}

async function runDelegate(argv: string[]): Promise<void> {
  const goalParts: string[] = []
  for (let index = 1; index < argv.length; index += 1) {
    if (argv[index] === "--subtask") {
      index += 1
      continue
    }
    if (!argv[index].startsWith("--")) {
      goalParts.push(argv[index])
    }
  }
  const goal = goalParts.join(" ")
  if (!goal) {
    throw new Error("Missing delegate goal.")
  }
  const subtasks = parseFlagValues(argv, "--subtask")
  const tasks = subtasks.length > 0 ? subtasks : [goal]
  const results = await Promise.all(tasks.map(async task => {
    const client = new KernelClient(process.cwd())
    try {
      const result = await client.runPrompt(task, {
        cwd: process.cwd(),
        metadata: { via: "delegate-subtask", goal, prompt: task },
        onApprovalRequest: async () => false,
      })
      return { task, text: result.text }
    } finally {
      await client.close()
    }
  }))
  const summary = [
    `Goal: ${goal}`,
    ...results.map(item => `\n## ${item.task}\n${item.text}`),
  ].join("\n")
  console.log(summary)
}

async function runProviders(): Promise<void> {
  const client = new KernelClient(process.cwd())
  try {
    const providerView = await client.providers()
    const statuses = await collectProviderAuthStatuses()
    console.log(JSON.stringify({
      ...providerView,
      auth: statuses,
    }, null, 2))
  } finally {
    await client.close()
  }
}

async function runSetup(argv: string[]): Promise<void> {
  const target = argv[2]
  const client = new KernelClient(process.cwd())
  try {
    if ((argv[1] ?? "provider") !== "provider") {
      throw new Error("Usage: one setup provider [kind]")
    }
    const [providers, state, auth] = await Promise.all([
      client.providers(),
      client.state(),
      collectProviderAuthStatuses(),
    ])
    const selectedKind = target ?? String(state.provider ?? providers.provider.kind)
    const status = auth.find(item => item.kind === selectedKind)
    const instructions: Record<string, string> = {
      "anthropic-compatible": "Set ONECLAW_API_KEY or ANTHROPIC_API_KEY.",
      "openai-compatible": "Set ONECLAW_API_KEY or OPENAI_API_KEY.",
      "claude-subscription": "Sign in with Claude CLI so ~/.claude/.credentials.json exists.",
      "codex-subscription": "Sign in with Codex so ~/.codex/auth.json exists.",
      "github-copilot": "Run `one auth copilot-login`.",
    }
    console.log(JSON.stringify({
      target: selectedKind,
      activeProfile: state.activeProfile,
      configured: Boolean(status?.configured),
      auth: status ?? null,
      instruction: instructions[selectedKind] ?? "Unknown provider kind.",
      providers,
    }, null, 2))
  } finally {
    await client.close()
  }
}

async function runAuth(argv: string[]): Promise<void> {
  const subcommand = argv[1] ?? "status"
  if (subcommand === "status") {
    const statuses = await collectProviderAuthStatuses()
    console.log(JSON.stringify(statuses, null, 2))
    return
  }
  if (subcommand === "copilot-login") {
    const enterpriseUrl = readFlag(argv, "--enterprise-url")
    const githubDomain = readFlag(argv, "--github-domain") ?? "github.com"
    const device = await requestCopilotDeviceCode(githubDomain)
    console.log(`Open: ${device.verificationUri}`)
    console.log(`Code: ${device.userCode}`)
    const token = await pollCopilotAccessToken(
      device.deviceCode,
      device.interval,
      githubDomain,
      device.expiresIn,
    )
    const savedPath = await saveCopilotAuth(token, enterpriseUrl)
    console.log(`Saved Copilot auth to ${savedPath}`)
    return
  }
  if (subcommand === "copilot-logout") {
    await clearCopilotAuth()
    console.log("Cleared Copilot auth.")
    return
  }
  throw new Error(`Unknown auth subcommand: ${subcommand}`)
}

async function runProfile(argv: string[]): Promise<void> {
  const client = new KernelClient(process.cwd())
  try {
    const subcommand = argv[1] ?? "list"
    if (subcommand === "list") {
      console.log(JSON.stringify(await client.profileList(), null, 2))
      return
    }
    if (subcommand === "use") {
      const name = argv[2]
      if (!name) {
        throw new Error("Usage: one profile use <name>")
      }
      const result = await client.profileUse(name)
      console.log(`Persisted active profile ${result.activeProfile} to ${result.path}`)
      return
    }
    throw new Error(`Unknown profile subcommand: ${subcommand}`)
  } finally {
    await client.close()
  }
}

async function runState(): Promise<void> {
  const client = new KernelClient(process.cwd())
  try {
    console.log(JSON.stringify(await client.state(), null, 2))
  } finally {
    await client.close()
  }
}

async function runUsage(): Promise<void> {
  const client = new KernelClient(process.cwd())
  try {
    console.log(JSON.stringify(await client.usage(), null, 2))
  } finally {
    await client.close()
  }
}

async function runSessions(): Promise<void> {
  const client = new KernelClient(process.cwd())
  try {
    console.log(JSON.stringify(await client.sessions(), null, 2))
  } finally {
    await client.close()
  }
}

async function runMcp(): Promise<void> {
  const client = new KernelClient(process.cwd())
  try {
    console.log(JSON.stringify(await client.mcp(), null, 2))
  } finally {
    await client.close()
  }
}

async function runSmoke(argv: string[]): Promise<void> {
  const prompt = readFlag(argv, "--prompt") ?? "Reply with only: pong"
  const includeBridge = argv.includes("--bridge")
  const client = new KernelClient(process.cwd())
  let server: Awaited<ReturnType<typeof startBridgeServer>> | null = null
  try {
    const [health, providers, state, mcp] = await Promise.all([
      client.health(),
      client.providers(),
      client.state(),
      client.mcp(),
    ])
    const promptResult = await client.runPrompt(prompt, {
      cwd: process.cwd(),
      metadata: { via: "smoke" },
      onApprovalRequest: async () => false,
    })

    let bridge: Record<string, unknown> | undefined
    if (includeBridge) {
      server = await startBridgeServer()
      const baseUrl = `http://${server.hostname}:${server.port}`
      const response = await fetch(`${baseUrl}/health`)
      bridge = {
        baseUrl,
        health: await response.json(),
      }
    }

    console.log(JSON.stringify({
      ok: true,
      prompt,
      health,
      providers,
      state,
      mcp,
      promptResult: {
        text: promptResult.text,
        sessionId: promptResult.sessionId,
        stopReason: promptResult.stopReason,
      },
      bridge,
    }, null, 2))
  } finally {
    await client.close()
    server?.stop()
  }
}

async function runInstall(): Promise<void> {
  const cliDir = dirname(new URL(import.meta.url).pathname)
  const scriptPath = resolve(cliDir, "..", "scripts", "install.mjs")
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [scriptPath], {
      stdio: "inherit",
      env: process.env,
    })
    child.on("exit", code => {
      if (code === 0) {
        resolvePromise()
        return
      }
      rejectPromise(new Error(`Install script failed with exit code ${code ?? "unknown"}`))
    })
    child.on("error", rejectPromise)
  })
}

function printHelp(): void {
  console.log(`OneClaw ${ONECLAW_NEXT_VERSION}

Usage:
  one
  one -p "your prompt"
  one delegate "goal" --subtask "task 1" --subtask "task 2"
  one providers
  one setup provider [kind]
  one profile list
  one profile use <name>
  one auth status
  one auth copilot-login [--enterprise-url URL] [--github-domain DOMAIN]
  one sessions
  one state
  one usage
  one mcp
  one smoke [--bridge] [--prompt "Reply with only: pong"]
  one install
  one bridge
  one ui

Environment:
  ONECLAW_USE_LEGACY=1   Run the legacy OneClaw launcher instead
`)
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const command = argv[0]

  if (command === "--help" || command === "-h" || command === "help") {
    printHelp()
    return
  }
  if (command === "--version" || command === "-v" || command === "-V" || command === "version") {
    console.log(ONECLAW_NEXT_VERSION)
    return
  }
  if (command === "providers") {
    await runProviders()
    return
  }
  if (command === "setup") {
    await runSetup(argv)
    return
  }
  if (command === "auth") {
    await runAuth(argv)
    return
  }
  if (command === "profile") {
    await runProfile(argv)
    return
  }
  if (command === "state") {
    await runState()
    return
  }
  if (command === "usage") {
    await runUsage()
    return
  }
  if (command === "sessions") {
    await runSessions()
    return
  }
  if (command === "mcp") {
    await runMcp()
    return
  }
  if (command === "bridge") {
    await startBridgeServer()
    return
  }
  if (command === "smoke") {
    await runSmoke(argv)
    return
  }
  if (command === "install") {
    await runInstall()
    return
  }
  if (command === "ui") {
    await startTextUi()
    return
  }
  if (command === "delegate") {
    await runDelegate(argv)
    return
  }
  await runSinglePrompt(argv)
}

await main()
