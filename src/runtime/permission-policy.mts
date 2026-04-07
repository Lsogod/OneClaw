import { resolve } from "node:path"
import type { PermissionConfig, PermissionDecision, ToolSpec } from "../types.mts"
import { isInsideRoots, isRecord, matchesPattern } from "../utils.mts"

export type ApprovalHandler = (request: {
  tool: string
  reason: string
  input: unknown
}) => Promise<boolean>

function extractPaths(input: unknown): string[] {
  if (!isRecord(input)) {
    return []
  }
  return Object.entries(input)
    .filter(([key, value]) =>
      typeof value === "string" &&
      (key.toLowerCase().includes("path") || key.toLowerCase() === "cwd"),
    )
    .map(([, value]) => String(value))
}

function extractShellCommand(input: unknown): string | null {
  if (!isRecord(input) || typeof input.command !== "string") {
    return null
  }
  return input.command.trim()
}

export class PermissionPolicy {
  constructor(
    private readonly config: PermissionConfig,
    private readonly approvalHandler?: ApprovalHandler,
  ) {}

  async decide(tool: ToolSpec, input: unknown, cwd: string): Promise<PermissionDecision> {
    const extractedPaths = extractPaths(input)
    const candidatePaths = (extractedPaths.length > 0 ? extractedPaths : [cwd])
      .map(pathname => resolve(cwd, pathname))

    if (!candidatePaths.every(pathname => isInsideRoots(pathname, this.config.writableRoots))) {
      return {
        allowed: false,
        reason: "Target path is outside writable roots.",
      }
    }

    for (const pathname of candidatePaths) {
      for (const rule of this.config.pathRules ?? []) {
        if (!matchesPattern(rule.pattern, pathname)) {
          continue
        }
        if (!rule.allow) {
          return {
            allowed: false,
            reason: `Target path matches deny rule: ${rule.pattern}`,
          }
        }
      }
    }

    const shellCommand = extractShellCommand(input)
    if (shellCommand) {
      for (const pattern of this.config.deniedCommands ?? []) {
        if (matchesPattern(pattern, shellCommand)) {
          return {
            allowed: false,
            reason: `Command matches denied pattern: ${pattern}`,
          }
        }
      }
      const firstWord = shellCommand.split(/\s+/)[0]
      if (
        this.config.commandAllowlist.length > 0 &&
        !this.config.commandAllowlist.includes(firstWord)
      ) {
        return {
          allowed: false,
          reason: `Command is not allowlisted: ${firstWord}`,
        }
      }
    }

    if (this.config.mode === "allow") {
      return { allowed: true, reason: "Permission mode is allow." }
    }

    if (tool.readOnly) {
      return { allowed: true, reason: "Read-only tools are allowed." }
    }

    if (this.config.mode === "deny") {
      return {
        allowed: false,
        reason: "Mutating tools are denied by policy.",
      }
    }

    if (!this.approvalHandler) {
      return {
        allowed: false,
        reason: "Approval is required but no approval handler is configured.",
      }
    }

    const approved = await this.approvalHandler({
      tool: tool.name,
      reason: "Mutating tool requires confirmation.",
      input,
    })

    return approved
      ? { allowed: true, reason: "Approved by user." }
      : { allowed: false, reason: "User rejected the tool call." }
  }
}
