import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { loadConfig } from "../src/config.mts"

const ENV_KEYS = [
  "ONECLAW_HOME",
  "ONECLAW_CONFIG",
  "ONECLAW_PROVIDER",
  "ONECLAW_PROFILE",
  "ONECLAW_MODEL",
  "ONECLAW_BASE_URL",
  "ONECLAW_API_KEY",
  "ONECLAW_ENTERPRISE_URL",
  "ONECLAW_MAX_TOKENS",
] as const

async function writeJson(pathname: string, value: unknown): Promise<void> {
  await mkdir(dirname(pathname), { recursive: true })
  await writeFile(pathname, JSON.stringify(value, null, 2))
}

describe("loadConfig", () => {
  test("applies config precedence as home < cwd < explicit", async () => {
    const originalEnv = Object.fromEntries(
      ENV_KEYS.map(key => [key, process.env[key]]),
    ) as Record<(typeof ENV_KEYS)[number], string | undefined>
    const root = join(tmpdir(), `oneclaw-config-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const homeDir = join(root, "home")
    const cwd = join(root, "workspace")
    const explicitPath = join(root, "explicit.json")

    try {
      await mkdir(homeDir, { recursive: true })
      await mkdir(cwd, { recursive: true })
      await writeJson(join(homeDir, "oneclaw.config.json"), {
        bridge: { port: 4100 },
        output: { theme: "contrast" },
        provider: { baseUrl: "https://home.example.com" },
      })
      await writeJson(join(cwd, "oneclaw.config.json"), {
        bridge: { port: 4200 },
        output: { theme: "neutral" },
        provider: { baseUrl: "https://cwd.example.com" },
      })
      await writeJson(explicitPath, {
        bridge: { port: 4300 },
        provider: { baseUrl: "https://explicit.example.com" },
      })

      process.env.ONECLAW_HOME = homeDir
      process.env.ONECLAW_CONFIG = explicitPath

      const config = await loadConfig(cwd)

      expect(config.output.theme).toBe("neutral")
      expect(config.bridge.port).toBe(4300)
      expect(config.provider.baseUrl).toBe("https://explicit.example.com")
    } finally {
      for (const key of ENV_KEYS) {
        const value = originalEnv[key]
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })

  test("syncs activeProfile and provider defaults when provider kind is overridden by env", async () => {
    const originalEnv = Object.fromEntries(
      ENV_KEYS.map(key => [key, process.env[key]]),
    ) as Record<(typeof ENV_KEYS)[number], string | undefined>
    const root = join(tmpdir(), `oneclaw-config-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const homeDir = join(root, "home")
    const cwd = join(root, "workspace")

    try {
      await mkdir(homeDir, { recursive: true })
      await mkdir(cwd, { recursive: true })
      await writeJson(join(homeDir, "oneclaw.config.json"), {
        activeProfile: "codex-subscription",
        provider: {
          kind: "codex-subscription",
          model: "gpt-5.4",
          maxTokens: 2048,
        },
      })

      process.env.ONECLAW_HOME = homeDir
      process.env.ONECLAW_PROVIDER = "internal-test"

      const config = await loadConfig(cwd)

      expect(config.activeProfile).toBe("internal-test")
      expect(config.provider.kind).toBe("internal-test")
      expect(config.provider.model).toBe("internal-test")
    } finally {
      for (const key of ENV_KEYS) {
        const value = originalEnv[key]
        if (value === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = value
        }
      }
    }
  })
})
