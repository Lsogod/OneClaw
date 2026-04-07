import { existsSync } from "node:fs"
import { platform } from "node:os"
import { basename, isAbsolute } from "node:path"
import type { OneClawConfig } from "../types.mts"

export type SandboxStatus = {
  enabled: boolean
  active: boolean
  reason: string
  command?: string
}

export function defaultShell(): string {
  if (process.env.SHELL) {
    return process.env.SHELL
  }
  if (platform() === "win32") {
    return process.env.COMSPEC ?? process.env.ComSpec ?? "cmd.exe"
  }
  return "sh"
}

function shellCommandArgs(shell: string, command: string): string[] {
  const shellName = basename(shell).toLowerCase()
  if (shellName === "cmd" || shellName === "cmd.exe") {
    return [shell, "/d", "/s", "/c", command]
  }
  if (["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(shellName)) {
    return [shell, "-NoProfile", "-Command", command]
  }
  return [shell, "-lc", command]
}

function quoteWindowsArg(value: string): string {
  if (!/[\s"]/u.test(value)) {
    return value
  }
  return `"${value.replace(/(["\\])/gu, "\\$1")}"`
}

function quotePosixArg(value: string): string {
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/u.test(value)) {
    return value
  }
  return `'${value.replace(/'/gu, "'\\''")}'`
}

export function joinShellCommand(parts: string[]): string {
  return parts
    .map(part => platform() === "win32" ? quoteWindowsArg(part) : quotePosixArg(part))
    .join(" ")
}

export function getSandboxStatus(config: OneClawConfig): SandboxStatus {
  if (!config.sandbox.enabled) {
    return {
      enabled: false,
      active: false,
      reason: "sandbox disabled",
    }
  }

  const command = config.sandbox.command ?? process.env.ONECLAW_SANDBOX_COMMAND
  if (!command) {
    return {
      enabled: true,
      active: false,
      reason: "no sandbox command configured",
    }
  }

  const looksPathLike = isAbsolute(command) || command.includes("/") || command.includes("\\")
  if (!existsSync(command) && !looksPathLike) {
    return {
      enabled: true,
      active: true,
      reason: "sandbox command resolved via PATH at runtime",
      command,
    }
  }

  if (!existsSync(command)) {
    return {
      enabled: true,
      active: false,
      reason: `sandbox command not found: ${command}`,
      command,
    }
  }

  return {
    enabled: true,
    active: true,
    reason: "sandbox command is configured",
    command,
  }
}

export function buildShellInvocation(
  config: OneClawConfig,
  shell: string,
  command: string,
): { command: string; args: string[] } {
  const status = getSandboxStatus(config)
  if (!status.active) {
    if (config.sandbox.enabled && config.sandbox.failIfUnavailable) {
      throw new Error(status.reason)
    }
    const shellArgs = shellCommandArgs(shell, command)
    return {
      command: shellArgs[0]!,
      args: shellArgs.slice(1),
    }
  }

  const shellArgs = shellCommandArgs(shell, command)
  return {
    command: status.command!,
    args: [...config.sandbox.args, ...shellArgs],
  }
}
