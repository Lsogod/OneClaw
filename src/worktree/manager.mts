import { rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { spawn } from "node:child_process"
import type { Logger, OneClawConfig } from "../types.mts"
import { ensureDir, randomId, slugify } from "../utils.mts"

export type PreparedWorktree = {
  cwd: string
  isolated: boolean
  cleanup(): Promise<void>
}

function runGit(args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolvePromise => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let output = ""
    child.stdout.on("data", chunk => {
      output += String(chunk)
    })
    child.stderr.on("data", chunk => {
      output += String(chunk)
    })
    child.on("error", error => {
      resolvePromise({
        ok: false,
        output: String(error),
      })
    })
    child.on("close", code => {
      resolvePromise({
        ok: code === 0,
        output: output.trim(),
      })
    })
  })
}

export class WorktreeManager {
  constructor(
    private readonly config: OneClawConfig,
    private readonly logger: Logger,
  ) {}

  async prepare(label: string, cwd: string): Promise<PreparedWorktree> {
    const resolvedCwd = resolve(cwd)
    if (!this.config.worktree.enabled) {
      return {
        cwd: resolvedCwd,
        isolated: false,
        cleanup: async () => {},
      }
    }

    await ensureDir(this.config.worktree.baseDir)
    const targetPath = join(
      this.config.worktree.baseDir,
      `${slugify(label)}-${randomId("wt")}`,
    )
    const probe = await runGit(["rev-parse", "--is-inside-work-tree"], resolvedCwd)
    if (!probe.ok) {
      this.logger.warn(`[worktree] fallback to source cwd; git not available for ${resolvedCwd}`)
      return {
        cwd: resolvedCwd,
        isolated: false,
        cleanup: async () => {},
      }
    }

    const created = await runGit(["worktree", "add", "--detach", targetPath, "HEAD"], resolvedCwd)
    if (!created.ok) {
      this.logger.warn(`[worktree] failed to create isolated worktree: ${created.output}`)
      return {
        cwd: resolvedCwd,
        isolated: false,
        cleanup: async () => {},
      }
    }

    return {
      cwd: targetPath,
      isolated: true,
      cleanup: async () => {
        if (!this.config.worktree.cleanup) {
          return
        }
        await runGit(["worktree", "remove", "--force", targetPath], resolvedCwd)
        await rm(targetPath, { recursive: true, force: true })
      },
    }
  }
}
