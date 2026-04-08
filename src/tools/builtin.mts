import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import type { OneClawConfig, ToolImplementation, ToolExecution } from "../types.mts"
import { buildShellInvocation, defaultShell } from "../sandbox/adapter.mts"
import {
  displayPath,
  isRecord,
  limitText,
  walkFiles,
} from "../utils.mts"

function normalizePath(cwd: string, rawPath?: string): string {
  return resolve(cwd, rawPath ?? ".")
}

function asObject(input: unknown): Record<string, unknown> {
  return isRecord(input) ? input : {}
}

const SENSITIVE_ENV_PATTERNS = [
  /^ANTHROPIC_API_KEY$/i,
  /^OPENAI_API_KEY$/i,
  /^ONECLAW_BRIDGE_AUTH/i,
  /API_KEY$/i,
  /API_SECRET$/i,
  /^SECRET_/i,
  /TOKEN$/i,
  /PASSWORD$/i,
  /CREDENTIAL/i,
]

function filterSensitiveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(env)) {
    if (!SENSITIVE_ENV_PATTERNS.some(pattern => pattern.test(key))) {
      filtered[key] = value
    }
  }
  return filtered
}

async function execCommand(
  command: string,
  cwd: string,
  config: OneClawConfig,
  timeoutMs = 20_000,
): Promise<ToolExecution> {
  return new Promise(resolvePromise => {
    const shell = defaultShell()
    const invocation = buildShellInvocation(config, shell, command)
    const child = spawn(invocation.command, invocation.args, {
      cwd,
      env: filterSensitiveEnv(process.env),
    })

    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill("SIGTERM")
    }, timeoutMs)

    child.stdout.on("data", chunk => {
      stdout += String(chunk)
    })
    child.stderr.on("data", (chunk: unknown) => {
      stderr += String(chunk)
    })
    child.on("close", (code: number | null) => {
      clearTimeout(timer)
      resolvePromise({
        ok: code === 0,
        output: limitText(
          [`exit_code=${code}`, stdout.trim(), stderr.trim()].filter(Boolean).join("\n"),
          10_000,
        ),
      })
    })
  })
}

export function createBuiltinTools(_config: OneClawConfig): ToolImplementation[] {
  return [
    {
      spec: {
        name: "list_files",
        description: "List files under a directory.",
        readOnly: true,
        source: "builtin",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            depth: { type: "number" },
          },
        },
      },
      async execute(input, context) {
        const values = asObject(input)
        const targetPath = normalizePath(context.cwd, values.path as string | undefined)
        const depth = Number(values.depth ?? 3)
        const files = await walkFiles(targetPath, depth)
        return {
          ok: true,
          output: files.length > 0
            ? files.join("\n")
            : "(empty directory)",
          metadata: {
            path: targetPath,
          },
        }
      },
    },
    {
      spec: {
        name: "read_file",
        description: "Read a file with optional line slicing.",
        readOnly: true,
        source: "builtin",
        inputSchema: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string" },
            startLine: { type: "number" },
            endLine: { type: "number" },
          },
        },
      },
      async execute(input, context) {
        const values = asObject(input)
        const targetPath = normalizePath(context.cwd, values.path as string | undefined)
        const raw = await readFile(targetPath, "utf8")
        const lines = raw.split("\n")
        const startLine = Math.max(1, Number(values.startLine ?? 1))
        const endLine = Math.min(lines.length, Number(values.endLine ?? lines.length))
        const selection = lines
          .slice(startLine - 1, endLine)
          .map((line: string, index: number) => `${startLine + index}: ${line}`)
          .join("\n")
        return {
          ok: true,
          output: selection,
          metadata: {
            path: targetPath,
          },
        }
      },
    },
    {
      spec: {
        name: "search_files",
        description: "Search text in files using ripgrep when available.",
        readOnly: true,
        source: "builtin",
        inputSchema: {
          type: "object",
          required: ["pattern"],
          properties: {
            pattern: { type: "string" },
            path: { type: "string" },
          },
        },
      },
      async execute(input, context) {
        const values = asObject(input)
        const pattern = String(values.pattern ?? "")
        const targetPath = normalizePath(context.cwd, values.path as string | undefined)
        if (!pattern) {
          return {
            ok: false,
            output: "Missing required field: pattern",
          }
        }
        return execCommand(
          `rg --line-number --smart-case ${JSON.stringify(pattern)} ${JSON.stringify(targetPath)}`,
          context.cwd,
          _config,
        )
      },
    },
    {
      spec: {
        name: "write_file",
        description: "Write a file, creating parent directories when needed.",
        readOnly: false,
        source: "builtin",
        inputSchema: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string" },
            content: { type: "string" },
          },
        },
      },
      async execute(input, context) {
        const values = asObject(input)
        const targetPath = normalizePath(context.cwd, values.path as string | undefined)
        const content = String(values.content ?? "")
        await mkdir(dirname(targetPath), { recursive: true })
        await writeFile(targetPath, content)
        return {
          ok: true,
          output: `Wrote ${displayPath(context.cwd, targetPath)} (${content.length} chars)`,
          metadata: {
            path: targetPath,
          },
        }
      },
    },
    {
      spec: {
        name: "run_shell",
        description: "Run a shell command in the current workspace.",
        readOnly: false,
        source: "builtin",
        inputSchema: {
          type: "object",
          required: ["command"],
          properties: {
            command: { type: "string" },
            cwd: { type: "string" },
            timeoutMs: { type: "number" },
          },
        },
      },
      async execute(input, context) {
        const values = asObject(input)
        const command = String(values.command ?? "")
        const cwd = normalizePath(context.cwd, values.cwd as string | undefined)
        const timeoutMs = Number(values.timeoutMs ?? 20_000)
        if (!command) {
          return {
            ok: false,
            output: "Missing required field: command",
          }
        }
        return execCommand(command, cwd, _config, timeoutMs)
      },
    },
    {
      spec: {
        name: "show_memory",
        description: "Read the current session memory.",
        readOnly: true,
        source: "builtin",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      async execute(_input, context) {
        const memory = await context.memory.read()
        return {
          ok: true,
          output: memory || "(no memory yet)",
        }
      },
    },
  ]
}
