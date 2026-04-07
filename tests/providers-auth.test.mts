import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  buildCodexHeaders,
  clearCopilotAuth,
  extractCodexAccountId,
  getCopilotApiBase,
} from "../src/providers/auth.mts"
import { createProvider } from "../src/providers/index.mts"
import { PROVIDERS } from "../src/providers/registry.mts"
import { createTestConfig } from "./test-support.mts"

function fakeJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`
}

describe("provider auth helpers", () => {
  test("registry includes the expected provider kinds", () => {
    expect(PROVIDERS.map(provider => provider.kind)).toEqual([
      "anthropic-compatible",
      "claude-subscription",
      "openai-compatible",
      "codex-subscription",
      "github-copilot",
    ])
  })

  test("resolves copilot public and enterprise base urls", () => {
    expect(getCopilotApiBase()).toBe("https://api.githubcopilot.com")
    expect(getCopilotApiBase("https://github.example.com")).toBe(
      "https://copilot-api.github.example.com",
    )
  })

  test("extracts codex account headers from auth token", async () => {
    const token = fakeJwt({
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct_123",
      },
    })
    expect(extractCodexAccountId(token)).toBe("acct_123")
    const headers = await buildCodexHeaders(token)
    expect(headers["chatgpt-account-id"]).toBe("acct_123")
  })

  test("copilot logout clears both local and OpenHarness fallback auth files", async () => {
    const originalHome = process.env.HOME
    const originalPath = process.env.ONECLAW_COPILOT_AUTH_PATH
    const originalFallbackPath = process.env.OPENHARNESS_COPILOT_AUTH_PATH
    const root = join(tmpdir(), `oneclaw-copilot-${Date.now()}`)
    const oneclawPath = join(root, "oneclaw", "copilot_auth.json")
    const fallbackPath = join(root, ".openharness", "copilot_auth.json")

    process.env.HOME = root
    process.env.ONECLAW_COPILOT_AUTH_PATH = oneclawPath
    process.env.OPENHARNESS_COPILOT_AUTH_PATH = fallbackPath

    try {
      await mkdir(join(root, "oneclaw"), { recursive: true })
      await mkdir(join(root, ".openharness"), { recursive: true })
      await writeFile(oneclawPath, JSON.stringify({ github_token: "oneclaw-token" }))
      await writeFile(fallbackPath, JSON.stringify({ github_token: "openharness-token" }))

      await clearCopilotAuth()

      expect(existsSync(oneclawPath)).toBe(false)
      expect(existsSync(fallbackPath)).toBe(false)
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME
      } else {
        process.env.HOME = originalHome
      }
      if (originalPath === undefined) {
        delete process.env.ONECLAW_COPILOT_AUTH_PATH
      } else {
        process.env.ONECLAW_COPILOT_AUTH_PATH = originalPath
      }
      if (originalFallbackPath === undefined) {
        delete process.env.OPENHARNESS_COPILOT_AUTH_PATH
      } else {
        process.env.OPENHARNESS_COPILOT_AUTH_PATH = originalFallbackPath
      }
    }
  })

  test("openai-compatible provider tolerates malformed tool arguments", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{
        message: {
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: {
              name: "run_shell",
              arguments: "{invalid-json",
            },
          }],
        },
      }],
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
      },
    })) as typeof fetch

    try {
      const provider = createProvider(createTestConfig({
        activeProfile: "openai-compatible",
        providerProfiles: {
          "openai-compatible": {
            label: "OpenAI-Compatible API",
            kind: "openai-compatible",
            model: "gpt-5.4-mini",
            baseUrl: "https://example.com/v1",
          },
        },
        provider: {
          kind: "openai-compatible",
          model: "gpt-5.4-mini",
          apiKey: "test-key",
          baseUrl: "https://example.com/v1",
          maxTokens: 1000,
        },
      }))

      const result = await provider.generateTurn({
        systemPrompt: "test",
        messages: [{
          role: "user",
          content: [{ type: "text", text: "hello" }],
          createdAt: new Date().toISOString(),
        }],
        tools: [{
          name: "run_shell",
          description: "Run a shell command",
          inputSchema: { type: "object" },
        }],
        model: "gpt-5.4-mini",
        maxTokens: 1000,
      })

      expect(result.content).toEqual([{
        type: "tool_call",
        id: "call_1",
        name: "run_shell",
        input: {},
      }])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
