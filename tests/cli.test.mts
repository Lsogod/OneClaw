import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const cliPath = fileURLToPath(new URL("../src/cli.mts", import.meta.url))

describe("CLI output", () => {
  test("single prompt JSON output stays parseable on stdout", async () => {
    const root = join(tmpdir(), `oneclaw-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const homeDir = join(root, "home")
    await mkdir(homeDir, { recursive: true })

    const processResult = spawnSync("bun", [
      cliPath,
      "-p",
      "hello",
      "--output-format",
      "json",
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ONECLAW_HOME: homeDir,
        ONECLAW_PROVIDER: "internal-test",
      },
      encoding: "utf8",
    })

    expect(processResult.status).toBe(0)
    const stdout = processResult.stdout.trim()
    const parsed = JSON.parse(stdout) as {
      text?: string
      stopReason?: string
    }
    expect(parsed.text).toBe("Internal test provider response for: hello")
    expect(parsed.stopReason).toBe("end_turn")
  })

  test("non-interactive CLI auto-denies approval requests instead of hanging", async () => {
    const root = join(tmpdir(), `oneclaw-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const homeDir = join(root, "home")
    await mkdir(homeDir, { recursive: true })
    await writeFile(join(homeDir, "oneclaw.config.json"), JSON.stringify({
      permissions: {
        mode: "ask",
      },
    }, null, 2))

    const processResult = spawnSync("bun", [
      cliPath,
      "-p",
      "run shell pwd",
      "--output-format",
      "json",
    ], {
      cwd: root,
      env: {
        ...process.env,
        ONECLAW_HOME: homeDir,
        ONECLAW_PROVIDER: "internal-test",
      },
      encoding: "utf8",
    })

    expect(processResult.status).toBe(0)
    const parsed = JSON.parse(processResult.stdout.trim()) as {
      text?: string
      stopReason?: string
    }
    expect(parsed.text).toContain("denied")
    expect(parsed.stopReason).toBe("end_turn")
  })

  test("text output streams kernel progress to stderr while keeping stdout human-readable", async () => {
    const root = join(tmpdir(), `oneclaw-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const homeDir = join(root, "home")
    await mkdir(homeDir, { recursive: true })

    const processResult = spawnSync("bun", [
      cliPath,
      "-p",
      "hello",
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ONECLAW_HOME: homeDir,
        ONECLAW_PROVIDER: "internal-test",
      },
      encoding: "utf8",
    })

    expect(processResult.status).toBe(0)
    expect(processResult.stdout).toContain("Internal test provider response for: hello")
    expect(processResult.stderr).toContain("[one:delta]")
    expect(processResult.stderr).toContain("[one:event] iteration=1 started")
    expect(processResult.stderr).toContain("[one:event] completed")
  })

  test("smoke command exercises provider, mcp, and bridge health paths", async () => {
    const root = join(tmpdir(), `oneclaw-cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const homeDir = join(root, "home")
    await mkdir(homeDir, { recursive: true })

    const processResult = spawnSync("bun", [
      cliPath,
      "smoke",
      "--bridge",
      "--prompt",
      "Reply with only: pong",
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        ONECLAW_HOME: homeDir,
        ONECLAW_PROVIDER: "internal-test",
        ONECLAW_BRIDGE_PORT: "0",
      },
      encoding: "utf8",
    })

    expect(processResult.status).toBe(0)
    const parsed = JSON.parse(processResult.stdout.trim()) as {
      ok?: boolean
      promptResult?: { text?: string }
      bridge?: { health?: { ok?: boolean } }
    }
    expect(parsed.ok).toBe(true)
    expect(parsed.promptResult?.text).toContain("pong")
    expect(parsed.bridge?.health?.ok).toBe(true)
  })
})
