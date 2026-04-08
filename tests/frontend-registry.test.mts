import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createFrontendCommandRegistry } from "../src/commands/frontend-registry.mts"
import type { KernelClient } from "../src/frontend/kernel-client.mts"

function createFakeClient(overrides: Record<string, unknown> = {}): KernelClient {
  return {
    providers: async () => ({
      activeProfile: "codex-subscription",
      provider: {
        kind: "codex-subscription",
        model: "gpt-5.4",
        label: "Codex Subscription",
      },
      profiles: [
        {
          name: "codex-subscription",
          active: true,
          kind: "codex-subscription",
          label: "Codex Subscription",
          model: "gpt-5.4",
        },
        {
          name: "openai-compatible",
          active: false,
          kind: "openai-compatible",
          label: "OpenAI-Compatible API",
          model: "gpt-5.4",
        },
      ],
    }),
    providerDiagnostics: async (target?: string) => ({
      target: target ?? "codex-subscription",
      configured: target === "github-copilot" ? false : true,
      provider: {
        kind: target ?? "codex-subscription",
        model: "gpt-5.4",
      },
      checks: [],
      repair: target === "github-copilot"
        ? ["Run `one auth copilot-login`, then run `/provider use github-copilot`."]
        : [],
    }),
    profileList: async () => [
      {
        name: "codex-subscription",
        active: true,
        kind: "codex-subscription",
        label: "Codex Subscription",
        model: "gpt-5.4",
      },
      {
        name: "openai-compatible",
        active: false,
        kind: "openai-compatible",
        label: "OpenAI-Compatible API",
        model: "gpt-5.4",
      },
    ],
    profileUse: async (name: string) => ({
      activeProfile: name,
      path: "/tmp/oneclaw.config.json",
    }),
    profileSave: async (name: string, profile: Record<string, unknown>, options?: { activate?: boolean }) => ({
      name,
      profile,
      activeProfile: options?.activate ? name : "codex-subscription",
      path: "/tmp/oneclaw.config.json",
    }),
    profileDelete: async (name: string) => ({
      name,
      deleted: true,
      activeProfile: "codex-subscription",
      path: "/tmp/oneclaw.config.json",
    }),
    health: async () => ({
      ok: true,
      provider: "codex-subscription",
      profile: "codex-subscription",
    }),
    createSession: async () => ({
      id: "session_agent",
      cwd: "/tmp/workspace",
    }),
    reload: async () => ({
      provider: "codex-subscription",
      activeProfile: "codex-subscription",
    }),
    updateConfigPatch: async (patch: Record<string, unknown>) => ({
      path: "/tmp/oneclaw.config.json",
      state: {
        model: typeof patch.provider === "object" && patch.provider && "model" in patch.provider
          ? (patch.provider as { model?: string }).model
          : "gpt-5.4",
        permissionMode: typeof patch.permissions === "object" && patch.permissions && "mode" in patch.permissions
          ? (patch.permissions as { mode?: string }).mode
          : "ask",
        theme: typeof patch.output === "object" && patch.output && "theme" in patch.output
          ? (patch.output as { theme?: string }).theme
          : "neutral",
        outputStyle: typeof patch.output === "object" && patch.output && "style" in patch.output
          ? (patch.output as { style?: string }).style
          : "text",
        fastMode: typeof patch.runtime === "object" && patch.runtime && "fastMode" in patch.runtime
          ? (patch.runtime as { fastMode?: boolean }).fastMode
          : false,
        effort: typeof patch.runtime === "object" && patch.runtime && "effort" in patch.runtime
          ? (patch.runtime as { effort?: string }).effort
          : "medium",
        maxPasses: typeof patch.runtime === "object" && patch.runtime && "maxPasses" in patch.runtime
          ? (patch.runtime as { maxPasses?: number }).maxPasses
          : undefined,
        maxTurns: typeof patch.runtime === "object" && patch.runtime && "maxTurns" in patch.runtime
          ? (patch.runtime as { maxTurns?: number }).maxTurns
          : undefined,
        vimMode: typeof patch.runtime === "object" && patch.runtime && "vimMode" in patch.runtime
          ? (patch.runtime as { vimMode?: boolean }).vimMode
          : false,
        voiceMode: typeof patch.runtime === "object" && patch.runtime && "voiceMode" in patch.runtime
          ? (patch.runtime as { voiceMode?: boolean }).voiceMode
          : false,
      },
    }),
    config: async (section?: string) => ({
      section: section ?? "root",
      value: section ? { keepMessages: 8 } : { permissions: { mode: "ask" } },
    }),
    state: async () => ({
      activeProfile: "codex-subscription",
      provider: "codex-subscription",
      model: "gpt-5.4",
      theme: "neutral",
      outputStyle: "text",
      fastMode: false,
      effort: "medium",
      maxPasses: undefined,
      maxTurns: undefined,
      vimMode: false,
      voiceMode: false,
      voiceKeyterms: [],
      keybindings: {
        submit: "enter",
      },
    }),
    context: async () => ({
      permissionMode: "ask",
      writableRoots: ["/tmp/workspace"],
      session: {
        recentSummary: "recent context summary",
      },
    }),
    status: async (sessionId?: string) => ({
      session: { id: sessionId ?? "session_1" },
    }),
    sessions: async () => [
      { id: "session_new" },
      { id: "session_old" },
    ],
    sessionGet: async (sessionId: string) => ({
      id: sessionId,
      cwd: "/tmp/workspace",
      createdAt: "2026-04-07T00:00:00Z",
      updatedAt: "2026-04-07T00:00:00Z",
      messages: [{
        role: "assistant",
        createdAt: "2026-04-07T00:00:00Z",
        content: [{ type: "text", text: "latest assistant response" }],
      }],
    }),
    clearSession: async (sessionId: string, clearMemory = false) => ({
      sessionId,
      clearedMessages: 3,
      clearedMemory: clearMemory,
    }),
    compactSession: async (sessionId: string) => ({
      sessionId,
      beforeMessages: 8,
      afterMessages: 2,
      compactedMessages: 6,
      memoryUpdated: true,
    }),
    rewindSession: async (sessionId: string, turns = 1) => ({
      sessionId,
      beforeMessages: 6,
      afterMessages: 4,
      removedMessages: 2,
      turns,
    }),
    compactPolicy: async (sessionId?: string) => ({
      sessionId: sessionId ?? "session_current",
      maxChars: 120000,
      keepMessages: 8,
      wouldCompact: false,
    }),
    memory: async () => ({
      session: {
        path: "/tmp/session-memory.md",
        content: "session memory",
      },
      project: {
        path: "/tmp/project-memory.md",
        content: "project memory",
      },
      global: {
        path: "/tmp/global-memory.md",
        content: "global memory",
      },
    }),
    todo: async () => ({
      sessionId: "session_current",
      count: 1,
      byStatus: { pending: 1 },
      items: [{ id: "todo-1", title: "existing task", status: "pending" }],
    }),
    todoUpdate: async (_sessionId: string, items: Array<Record<string, unknown>>) => ({
      sessionId: "session_current",
      count: items.length,
      byStatus: {},
      items,
    }),
    hooks: async () => ({
      hooks: [{ name: "after_tool", event: "after_tool" }],
      plugins: [{ name: "sample-plugin" }],
    }),
    plugins: async () => ({
      plugins: [{
        name: "sample-plugin",
        toolCount: 1,
        toolNames: ["plugin__sample-plugin__lint"],
        hookDefinitionCount: 1,
        moduleHookEvents: ["before_tool"],
        promptPatchCount: 1,
      }],
    }),
    skills: async () => ({
      skills: [{
        name: "ShipIt",
        sourcePath: "/tmp/skills/shipit.md",
        description: "Ship releases",
        body: "Always verify before release.",
      }],
    }),
    tasks: async () => ({
      attached: false,
      tasks: [],
    }),
    usage: async () => ({
      inputTokens: 100,
      outputTokens: 20,
      estimatedCostUsd: 0.0025,
    }),
    observability: async () => ({
      eventCount: 2,
      recentEvents: [{ type: "model_request" }],
      failureCounts: {},
    }),
    tools: async () => ({
      count: 2,
      bySource: { builtin: 2 },
      tools: [{ name: "read_file", source: "builtin" }],
    }),
    toolSearch: async (query: string, options?: { limit?: number }) => ({
      query,
      count: 1,
      tools: [{ name: "read_file", source: "builtin", description: `matched ${query}`, limit: options?.limit }],
    }),
    cron: async (options?: { name?: string }) => ({
      path: "/tmp/oneclaw/cron/jobs.json",
      count: options?.name ? 1 : 2,
      enabled: 1,
      disabled: 1,
      jobs: [{ name: options?.name ?? "daily", schedule: "0 9 * * 1-5", command: "one smoke", enabled: true }],
    }),
    cronUpsert: async (payload: Record<string, unknown>) => ({
      job: payload,
      count: 1,
      enabled: payload.enabled === false ? 0 : 1,
      jobs: [payload],
    }),
    cronDelete: async (name: string) => ({
      name,
      deleted: true,
      count: 0,
      jobs: [],
    }),
    cronToggle: async (name: string, enabled: boolean) => ({
      name,
      jobEnabled: enabled,
      enabled: enabled ? 1 : 0,
      count: 1,
      jobs: [{ name, enabled }],
    }),
    webFetch: async (url: string, options?: { maxChars?: number }) => ({
      url,
      status: 200,
      contentType: "text/plain",
      text: `fetched ${url} ${options?.maxChars ?? 8000}`,
    }),
    codeSymbols: async (options?: { path?: string; query?: string; limit?: number }) => ({
      cwd: "/tmp/workspace",
      path: options?.path ?? ".",
      query: options?.query ?? "",
      count: 1,
      symbols: [{
        name: "OneClawRuntime",
        kind: "class",
        file: "src/runtime.ts",
        line: 12,
        text: "class OneClawRuntime {}",
      }].slice(0, options?.limit ?? 200),
    }),
    webSearch: async (query: string, options?: { maxResults?: number }) => ({
      query,
      url: `https://search.example/?q=${encodeURIComponent(query)}`,
      status: 200,
      contentType: "text/html",
      results: [
        { title: `result for ${query}`, url: "https://example.test/result" },
      ].slice(0, options?.maxResults ?? 5),
    }),
    mcp: async () => ({
      statuses: [],
      resources: [],
      resourceTemplates: [{ server: "fake", uriTemplate: "file://{path}" }],
      tools: [],
    }),
    mcpReconnect: async () => ({
      results: [],
    }),
    mcpAddServer: async (config: Record<string, unknown>) => ({
      server: config,
      status: { name: config.name, state: "connected" },
    }),
    mcpRemoveServer: async (name: string) => ({
      name,
      removed: true,
    }),
    mcpReadResource: async () => ({
      content: "resource content",
    }),
    sessionExport: async () => ({
      content: "# exported",
    }),
    sessionExportBundle: async () => ({
      sessionId: "session_new",
    }),
    runPrompt: async (prompt: string) => ({
      sessionId: "session_current",
      text: `ran: ${prompt}`,
      iterations: 1,
      stopReason: "end_turn",
    }),
    runPromptTracked: (prompt: string) => ({
      requestId: "req_test",
      promise: Promise.resolve({
        sessionId: "session_current",
        text: `ran: ${prompt}`,
        iterations: 1,
        stopReason: "end_turn",
      }),
    }),
    cancelSession: async () => ({
      accepted: true,
    }),
    cancelRequest: async () => ({
      accepted: true,
    }),
    ...overrides,
  } as unknown as KernelClient
}

describe("Frontend command registry", () => {
  test("help text includes expanded runtime/config command set", () => {
    const registry = createFrontendCommandRegistry()
    const helpText = registry.helpText()

    expect(helpText).toContain("/status")
    expect(helpText).toContain("/context")
    expect(helpText).toContain("/memory")
    expect(helpText).toContain("/permissions")
    expect(helpText).toContain("/model")
    expect(helpText).toContain("/theme")
    expect(helpText).toContain("/output-style")
    expect(helpText).toContain("/fast")
    expect(helpText).toContain("/effort")
    expect(helpText).toContain("/passes")
    expect(helpText).toContain("/turns")
    expect(helpText).toContain("/continue")
    expect(helpText).toContain("/vim")
    expect(helpText).toContain("/voice")
    expect(helpText).toContain("/config")
    expect(helpText).toContain("/doctor")
    expect(helpText).toContain("/bridge")
    expect(helpText).toContain("/plugin")
    expect(helpText).toContain("/skills")
    expect(helpText).toContain("/branch")
    expect(helpText).toContain("/diff")
    expect(helpText).toContain("/files")
    expect(helpText).toContain("/symbols")
    expect(helpText).toContain("/fetch")
    expect(helpText).toContain("/search-web")
    expect(helpText).toContain("/todo")
    expect(helpText).toContain("/tool-search")
    expect(helpText).toContain("/cron")
    expect(helpText).toContain("/stats")
    expect(helpText).toContain("/observability")
    expect(helpText).toContain("/plan")
    expect(helpText).toContain("/review")
    expect(helpText).toContain("/agents")
    expect(helpText).toContain("/init")
    expect(helpText).toContain("/share")
    expect(helpText).toContain("/tag")
    expect(helpText).toContain("/rewind")
    expect(helpText).toContain("/privacy-settings")
    expect(helpText).toContain("/rate-limit-options")
    expect(helpText).toContain("/feedback")
  })

  test("OpenHarness-style utility commands manage project and session snapshots", async () => {
    const originalHome = process.env.ONECLAW_HOME
    const homeDir = join(tmpdir(), `oneclaw-openharness-home-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const workspace = join(tmpdir(), `oneclaw-openharness-workspace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await mkdir(homeDir, { recursive: true })
    await mkdir(workspace, { recursive: true })
    process.env.ONECLAW_HOME = homeDir

    try {
      const registry = createFrontendCommandRegistry()
      const context = {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: workspace,
      } as never

      const initLookup = registry.lookup("/init")
      const shareLookup = registry.lookup("/share")
      const tagLookup = registry.lookup("/tag release candidate")
      const feedbackLookup = registry.lookup("/feedback command parity is useful")
      const copyLookup = registry.lookup("/copy explicit text")
      const privacyLookup = registry.lookup("/privacy-settings")
      const rateLimitLookup = registry.lookup("/rate-limit-options")
      const releaseNotesLookup = registry.lookup("/release-notes")
      const upgradeLookup = registry.lookup("/upgrade")
      const themeLookup = registry.lookup("/theme list")
      const outputStyleLookup = registry.lookup("/output-style list")
      const rewindLookup = registry.lookup("/rewind 2")

      const initResult = await initLookup?.command.handler(initLookup.args, context)
      const shareResult = await shareLookup?.command.handler(shareLookup.args, context)
      const tagResult = await tagLookup?.command.handler(tagLookup.args, context)
      const feedbackResult = await feedbackLookup?.command.handler(feedbackLookup.args, context)
      const copyResult = await copyLookup?.command.handler(copyLookup.args, context)
      const privacyResult = await privacyLookup?.command.handler(privacyLookup.args, context)
      const rateLimitResult = await rateLimitLookup?.command.handler(rateLimitLookup.args, context)
      const releaseNotesResult = await releaseNotesLookup?.command.handler(releaseNotesLookup.args, context)
      const upgradeResult = await upgradeLookup?.command.handler(upgradeLookup.args, context)
      const themeResult = await themeLookup?.command.handler(themeLookup.args, context)
      const outputStyleResult = await outputStyleLookup?.command.handler(outputStyleLookup.args, context)
      const rewindResult = await rewindLookup?.command.handler(rewindLookup.args, context)

      expect(initResult?.message).toContain(".oneclaw")
      expect(existsSync(join(workspace, ".oneclaw", "memory.md"))).toBe(true)
      expect(shareResult?.message).toContain("shares")
      expect(tagResult?.message).toContain("release candidate")
      expect(existsSync(join(homeDir, "feedback.log"))).toBe(true)
      expect(feedbackResult?.message).toContain("Feedback recorded")
      expect(copyResult?.message).toContain("chars")
      expect(privacyResult?.message).toContain("localPersistence")
      expect(rateLimitResult?.message).toContain("runtimeLevers")
      expect(releaseNotesResult?.message).toContain("OneClaw 0.2.0")
      expect(upgradeResult?.message).toContain("git pull --ff-only")
      expect(themeResult?.message).toContain("neutral")
      expect(outputStyleResult?.message).toContain("json")
      expect(rewindResult?.message).toContain("Rewound 2 messages")
    } finally {
      if (originalHome === undefined) {
        delete process.env.ONECLAW_HOME
      } else {
        process.env.ONECLAW_HOME = originalHome
      }
    }
  })

  test("runtime control commands persist hints and continue current session", async () => {
    const registry = createFrontendCommandRegistry()
    const patches: Record<string, unknown>[] = []
    const prompts: string[] = []
    const context = {
      client: createFakeClient({
        state: async () => ({
          fastMode: false,
          effort: "medium",
          maxPasses: undefined,
          maxTurns: undefined,
          vimMode: false,
          voiceMode: false,
          voiceKeyterms: [],
        }),
        updateConfigPatch: async (patch: Record<string, unknown>) => {
          patches.push(patch)
          const runtime = typeof patch.runtime === "object" && patch.runtime
            ? patch.runtime as Record<string, unknown>
            : {}
          return {
            path: "/tmp/oneclaw.config.json",
            state: runtime,
          }
        },
        runPrompt: async (prompt: string) => {
          prompts.push(prompt)
          return {
            sessionId: "session_current",
            text: "continued",
            iterations: 1,
            stopReason: "end_turn",
          }
        },
      }),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never

    const commands = [
      "/fast on",
      "/effort high",
      "/passes 3",
      "/turns 7",
      "/vim on",
      "/voice on",
      "/voice keyterms Review failing provider setup quickly",
      "/continue finish the pending review",
    ]
    const messages: string[] = []
    for (const command of commands) {
      const lookup = registry.lookup(command)
      const result = await lookup?.command.handler(lookup.args, context)
      messages.push(result?.message ?? "")
    }

    expect(JSON.stringify(patches)).toContain("\"fastMode\":true")
    expect(JSON.stringify(patches)).toContain("\"effort\":\"high\"")
    expect(JSON.stringify(patches)).toContain("\"maxPasses\":3")
    expect(JSON.stringify(patches)).toContain("\"maxTurns\":7")
    expect(JSON.stringify(patches)).toContain("\"vimMode\":true")
    expect(JSON.stringify(patches)).toContain("\"voiceMode\":true")
    expect(JSON.stringify(patches)).toContain("\"voiceKeyterms\"")
    expect(messages.join("\n")).toContain("voice keyterm")
    expect(prompts[0]).toContain("Continue from the current session state")
    expect(prompts[0]).toContain("finish the pending review")
  })

  test("provider command resolves provider kind to profile name", async () => {
    const registry = createFrontendCommandRegistry()
    const lookedUp = registry.lookup("/provider use openai-compatible")
    const uses: string[] = []

    const result = await lookedUp?.command.handler(lookedUp.args, {
      client: createFakeClient({
        profileUse: async (name: string) => {
          uses.push(name)
          return {
            activeProfile: name,
            path: "/tmp/oneclaw.config.json",
          }
        },
      }),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    expect(uses).toEqual(["openai-compatible"])
    expect(result?.message).toContain("Persisted provider profile openai-compatible")
  })

  test("profile command saves, shows, and deletes custom provider profiles", async () => {
    const registry = createFrontendCommandRegistry()
    const saved: Array<{ name: string; profile: Record<string, unknown>; activate?: boolean }> = []
    const deleted: string[] = []
    const context = {
      client: createFakeClient({
        profileList: async () => [
          {
            name: "local-openai",
            active: false,
            kind: "openai-compatible",
            label: "LocalOpenAI",
            model: "gpt-local",
            baseUrl: "http://127.0.0.1:8000/v1",
          },
        ],
        profileSave: async (name: string, profile: Record<string, unknown>, options?: { activate?: boolean }) => {
          saved.push({ name, profile, activate: options?.activate })
          return {
            name,
            profile,
            activeProfile: options?.activate ? name : "codex-subscription",
            path: "/tmp/oneclaw.config.json",
          }
        },
        profileDelete: async (name: string) => {
          deleted.push(name)
          return {
            name,
            deleted: true,
            activeProfile: "codex-subscription",
            path: "/tmp/oneclaw.config.json",
          }
        },
      }),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never

    const saveLookup = registry.lookup("/profile save local-openai openai-compatible gpt-local --base-url http://127.0.0.1:8000/v1 --label \"Local OpenAI\" --description \"Local gateway\" --use")
    const showLookup = registry.lookup("/profile show local-openai")
    const deleteLookup = registry.lookup("/profile delete local-openai")

    const saveResult = await saveLookup?.command.handler(saveLookup.args, context)
    const showResult = await showLookup?.command.handler(showLookup.args, context)
    const deleteResult = await deleteLookup?.command.handler(deleteLookup.args, context)

    expect(saved[0]).toEqual({
      name: "local-openai",
      profile: {
        kind: "openai-compatible",
        model: "gpt-local",
        label: "Local OpenAI",
        baseUrl: "http://127.0.0.1:8000/v1",
        description: "Local gateway",
      },
      activate: true,
    })
    expect(saveResult?.message).toContain("local-openai")
    expect(showResult?.message).toContain("gpt-local")
    expect(deleteResult?.message).toContain("\"deleted\": true")
    expect(deleted).toEqual(["local-openai"])
  })

  test("provider setup command returns auth guidance for target providers", async () => {
    const registry = createFrontendCommandRegistry()
    const lookedUp = registry.lookup("/provider setup github-copilot")

    const result = await lookedUp?.command.handler(lookedUp.args, {
      client: createFakeClient({
        state: async () => ({
          provider: "codex-subscription",
          activeProfile: "codex-subscription",
        }),
      }),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    expect(result?.message).toContain("github-copilot")
    expect(result?.message).toContain("one auth copilot-login")
  })

  test("tools, tool-search, cron, and mcp commands expose harness platform registries", async () => {
    const registry = createFrontendCommandRegistry()
    const tools = registry.lookup("/tools source builtin")
    const toolSearch = registry.lookup("/tool-search read --limit 3")
    const cronList = registry.lookup("/cron list")
    const cronCreate = registry.lookup("/cron create daily \"0 9 * * 1-5\" \"one smoke\" --disabled")
    const cronDisable = registry.lookup("/cron disable daily")
    const cronDelete = registry.lookup("/cron delete daily")
    const mcp = registry.lookup("/mcp reconnect fake")
    const mcpAdd = registry.lookup("/mcp add fake python3 server.py")
    const mcpRemove = registry.lookup("/mcp remove fake")
    const mcpTemplates = registry.lookup("/mcp templates")

    const context = {
      client: createFakeClient(),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never

    const toolsResult = await tools?.command.handler(tools.args, context)
    const toolSearchResult = await toolSearch?.command.handler(toolSearch.args, context)
    const cronListResult = await cronList?.command.handler(cronList.args, context)
    const cronCreateResult = await cronCreate?.command.handler(cronCreate.args, context)
    const cronDisableResult = await cronDisable?.command.handler(cronDisable.args, context)
    const cronDeleteResult = await cronDelete?.command.handler(cronDelete.args, context)
    const mcpResult = await mcp?.command.handler(mcp.args, context)
    const mcpAddResult = await mcpAdd?.command.handler(mcpAdd.args, context)
    const mcpRemoveResult = await mcpRemove?.command.handler(mcpRemove.args, context)
    const mcpTemplatesResult = await mcpTemplates?.command.handler(mcpTemplates.args, context)

    expect(toolsResult?.message).toContain("read_file")
    expect(toolSearchResult?.message).toContain("matched read")
    expect(cronListResult?.message).toContain("daily")
    expect(cronCreateResult?.message).toContain("one smoke")
    expect(cronDisableResult?.message).toContain("\"enabled\": false")
    expect(cronDeleteResult?.message).toContain("\"deleted\": true")
    expect(mcpResult?.message).toContain("results")
    expect(mcpAddResult?.message).toContain("python3")
    expect(mcpRemoveResult?.message).toContain("removed")
    expect(mcpTemplatesResult?.message).toContain("file://{path}")
  })

  test("observability command exposes trace and failure summaries", async () => {
    const registry = createFrontendCommandRegistry()
    const lookedUp = registry.lookup("/observability")

    const result = await lookedUp?.command.handler(lookedUp.args, {
      client: createFakeClient(),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    expect(result?.message).toContain("eventCount")
    expect(result?.message).toContain("model_request")
  })

  test("model command persists provider.model via config patch", async () => {
    const registry = createFrontendCommandRegistry()
    const lookedUp = registry.lookup("/model gpt-5.5")
    let receivedPatch: Record<string, unknown> | null = null

    const result = await lookedUp?.command.handler(lookedUp.args, {
      client: createFakeClient({
        updateConfigPatch: async (patch: Record<string, unknown>) => {
          receivedPatch = patch
          return {
            path: "/tmp/oneclaw.config.json",
            state: { model: "gpt-5.5" },
          }
        },
      }),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    expect(receivedPatch).toEqual({
      provider: { model: "gpt-5.5" },
    })
    expect(result?.message).toContain("Persisted model gpt-5.5")
  })

  test("permissions command persists permission mode", async () => {
    const registry = createFrontendCommandRegistry()
    const lookedUp = registry.lookup("/permissions allow")
    let receivedPatch: Record<string, unknown> | null = null

    const result = await lookedUp?.command.handler(lookedUp.args, {
      client: createFakeClient({
        updateConfigPatch: async (patch: Record<string, unknown>) => {
          receivedPatch = patch
          return {
            path: "/tmp/oneclaw.config.json",
            state: { permissionMode: "allow" },
          }
        },
      }),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    expect(receivedPatch).toEqual({
      permissions: { mode: "allow" },
    })
    expect(result?.message).toContain("Persisted permission mode allow")
  })

  test("clear all clears session memory too", async () => {
    const registry = createFrontendCommandRegistry()
    const lookedUp = registry.lookup("/clear all")
    const calls: Array<{ sessionId: string; clearMemory: boolean }> = []

    const result = await lookedUp?.command.handler(lookedUp.args, {
      client: createFakeClient({
        clearSession: async (sessionId: string, clearMemory = false) => {
          calls.push({ sessionId, clearMemory })
          return {
            sessionId,
            clearedMessages: 3,
            clearedMemory: clearMemory,
          }
        },
      }),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    expect(calls).toEqual([{ sessionId: "session_current", clearMemory: true }])
    expect(result?.message).toContain("reset session memory")
  })

  test("resume latest switches to the most recent non-current session", async () => {
    const registry = createFrontendCommandRegistry()
    const lookedUp = registry.lookup("/resume")
    const selected: string[] = []

    const result = await lookedUp?.command.handler(lookedUp.args, {
      client: createFakeClient(),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
      setSessionId: (sessionId: string) => {
        selected.push(sessionId)
      },
      listSessions: async () => [
        { id: "session_latest" },
        { id: "session_current" },
      ],
    } as never)

    expect(selected).toEqual(["session_latest"])
    expect(result?.message).toContain("Active session set to session_latest")
  })

  test("sessions command exposes latest, show, and delete lifecycle actions", async () => {
    const registry = createFrontendCommandRegistry()
    const latestLookup = registry.lookup("/sessions latest")
    const showLookup = registry.lookup("/sessions show session_new")
    const deleteLookup = registry.lookup("/sessions delete session_old")
    const deleted: string[] = []

    const context = {
      client: createFakeClient({
        deleteSession: async (sessionId: string) => {
          deleted.push(sessionId)
          return {
            sessionId,
            deleted: true,
          }
        },
      }),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never

    const latestResult = await latestLookup?.command.handler(latestLookup.args, context)
    const showResult = await showLookup?.command.handler(showLookup.args, context)
    const deleteResult = await deleteLookup?.command.handler(deleteLookup.args, context)

    expect(latestResult?.message).toContain("session_new")
    expect(showResult?.message).toContain("\"id\": \"session_new\"")
    expect(deleteResult?.message).toContain("Deleted session session_old")
    expect(deleted).toEqual(["session_old"])
  })

  test("sessions command supports search, export, and prune actions", async () => {
    const registry = createFrontendCommandRegistry()
    const searchLookup = registry.lookup("/sessions search workspace")
    const exportLookup = registry.lookup("/sessions export session_new markdown")
    const pruneLookup = registry.lookup("/sessions prune 1")
    const deleted: string[] = []

    const context = {
      client: createFakeClient({
        sessions: async () => [
          { id: "session_new", cwd: "/tmp/workspace" },
          { id: "session_old", cwd: "/tmp/legacy" },
        ],
        sessionGet: async (sessionId: string) => ({
          id: sessionId,
          cwd: sessionId === "session_new" ? "/tmp/workspace" : "/tmp/legacy",
          createdAt: "2026-04-07T00:00:00Z",
          updatedAt: "2026-04-07T00:00:00Z",
          messages: [],
          metadata: { note: sessionId === "session_new" ? "workspace match" : "legacy" },
        }),
        sessionExport: async () => ({
          sessionId: "session_new",
          format: "markdown",
          filename: "transcript.md",
          contentType: "text/markdown",
          content: "# Session session_new",
        }),
        deleteSession: async (sessionId: string) => {
          deleted.push(sessionId)
          return {
            sessionId,
            deleted: true,
          }
        },
      }),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never

    const searchResult = await searchLookup?.command.handler(searchLookup.args, context)
    const exportResult = await exportLookup?.command.handler(exportLookup.args, context)
    const pruneResult = await pruneLookup?.command.handler(pruneLookup.args, context)

    expect(searchResult?.message).toContain("session_new")
    expect(exportResult?.message).toContain("transcript.md")
    expect(pruneResult?.message).toContain("session_old")
    expect(deleted).toEqual(["session_old"])
  })

  test("sessions all requests the global session view", async () => {
    const registry = createFrontendCommandRegistry()
    const lookup = registry.lookup("/sessions all")
    const scopes: Array<"project" | "all" | undefined> = []

    const result = await lookup?.command.handler(lookup.args, {
      client: createFakeClient(),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
      listSessions: async (scope?: "project" | "all") => {
        scopes.push(scope)
        return [{ id: "session_global" }]
      },
    } as never)

    expect(scopes).toEqual(["all"])
    expect(result?.message).toContain("session_global")
  })

  test("config command reads a nested config section from kernel", async () => {
    const registry = createFrontendCommandRegistry()
    const lookedUp = registry.lookup("/config context")

    const result = await lookedUp?.command.handler(lookedUp.args, {
      client: createFakeClient(),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    expect(result?.message).toContain("\"section\": \"context\"")
    expect(result?.message).toContain("\"keepMessages\": 8")
  })

  test("plugin reload calls runtime reload", async () => {
    const registry = createFrontendCommandRegistry()
    const lookedUp = registry.lookup("/plugin reload")
    const reloadCalls: number[] = []

    const result = await lookedUp?.command.handler(lookedUp.args, {
      client: createFakeClient({
        reload: async () => {
          reloadCalls.push(1)
          return {
            provider: "codex-subscription",
            activeProfile: "codex-subscription",
          }
        },
      }),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    expect(reloadCalls).toEqual([1])
    expect(result?.message).toContain("Reloaded runtime")
  })

  test("plugin install and uninstall commands manage the user plugin directory", async () => {
    const originalHome = process.env.ONECLAW_HOME
    const homeDir = join(tmpdir(), `oneclaw-plugin-home-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const workspace = join(tmpdir(), `oneclaw-plugin-workspace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const sourceRoot = join(tmpdir(), `oneclaw-plugin-source-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const sourcePlugin = join(sourceRoot, "demo-plugin")
    await mkdir(homeDir, { recursive: true })
    await mkdir(workspace, { recursive: true })
    await mkdir(sourcePlugin, { recursive: true })
    await writeFile(join(sourcePlugin, "plugin.json"), JSON.stringify({ name: "demo-plugin" }, null, 2))
    process.env.ONECLAW_HOME = homeDir

    try {
      const registry = createFrontendCommandRegistry()
      const installLookup = registry.lookup(`/plugin install ${sourcePlugin}`)
      const validateLookup = registry.lookup(`/plugin validate ${sourcePlugin}`)
      const disableLookup = registry.lookup("/plugin disable demo-plugin")
      const enableLookup = registry.lookup("/plugin enable demo-plugin")
      const updateLookup = registry.lookup("/plugin update demo-plugin")
      const stateLookup = registry.lookup("/plugin state")
      const uninstallLookup = registry.lookup("/plugin uninstall demo-plugin")
      let reloadCount = 0

      const context = {
        client: createFakeClient({
          reload: async () => {
            reloadCount += 1
            return {
              provider: "codex-subscription",
              activeProfile: "codex-subscription",
            }
          },
        }),
        sessionId: "session_current",
        cwd: workspace,
      } as never

      const installResult = await installLookup?.command.handler(installLookup.args, context)
      const validateResult = await validateLookup?.command.handler(validateLookup.args, context)
      const disableResult = await disableLookup?.command.handler(disableLookup.args, context)
      const enableResult = await enableLookup?.command.handler(enableLookup.args, context)
      const updateResult = await updateLookup?.command.handler(updateLookup.args, context)
      const stateResult = await stateLookup?.command.handler(stateLookup.args, context)
      const installedPath = join(homeDir, "plugins", "demo-plugin", "plugin.json")
      const installedPlugin = await readFile(installedPath, "utf8")
      const uninstallResult = await uninstallLookup?.command.handler(uninstallLookup.args, context)

      expect(installResult?.message).toContain("Installed plugin")
      expect(validateResult?.message).toContain("demo-plugin")
      expect(disableResult?.message).toContain('"enabled": false')
      expect(existsSync(join(homeDir, "plugins", "demo-plugin", ".oneclaw-disabled"))).toBe(false)
      expect(enableResult?.message).toContain('"enabled": true')
      expect(updateResult?.message).toContain('"updated": true')
      expect(stateResult?.message).toContain("demo-plugin")
      expect(installedPlugin).toContain("demo-plugin")
      expect(uninstallResult?.message).toContain("Removed plugin demo-plugin")
      expect(reloadCount).toBe(5)
    } finally {
      if (originalHome === undefined) {
        delete process.env.ONECLAW_HOME
      } else {
        process.env.ONECLAW_HOME = originalHome
      }
    }
  })

  test("skills command returns discovered skills", async () => {
    const registry = createFrontendCommandRegistry()
    const lookedUp = registry.lookup("/skills")

    const result = await lookedUp?.command.handler(lookedUp.args, {
      client: createFakeClient(),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    expect(result?.message).toContain("ShipIt")
  })

  test("plugin show/tools commands expose plugin detail views", async () => {
    const registry = createFrontendCommandRegistry()
    const showLookup = registry.lookup("/plugin show sample-plugin")
    const toolsLookup = registry.lookup("/plugin tools sample-plugin")

    const showResult = await showLookup?.command.handler(showLookup.args, {
      client: createFakeClient(),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)
    const toolsResult = await toolsLookup?.command.handler(toolsLookup.args, {
      client: createFakeClient(),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    expect(showResult?.message).toContain("sample-plugin")
    expect(toolsResult?.message).toContain("plugin__sample-plugin__lint")
  })

  test("skills show/search commands expose filtered skill detail", async () => {
    const registry = createFrontendCommandRegistry()
    const searchLookup = registry.lookup("/skills search ship")
    const showLookup = registry.lookup("/skills show ShipIt")

    const searchResult = await searchLookup?.command.handler(searchLookup.args, {
      client: createFakeClient(),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)
    const showResult = await showLookup?.command.handler(showLookup.args, {
      client: createFakeClient(),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    expect(searchResult?.message).toContain("ShipIt")
    expect(showResult?.message).toContain("Always verify before release.")
  })

  test("memory add/search/remove commands manage persisted project memory entries", async () => {
    const originalHome = process.env.ONECLAW_HOME
    const homeDir = join(tmpdir(), `oneclaw-memory-home-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const workspace = join(tmpdir(), `oneclaw-memory-workspace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await mkdir(homeDir, { recursive: true })
    await mkdir(workspace, { recursive: true })
    process.env.ONECLAW_HOME = homeDir

    try {
      const registry = createFrontendCommandRegistry()
      const addLookup = registry.lookup("/memory add project Architecture Notes :: Record important design decisions")
      const searchLookup = registry.lookup("/memory search design")
      const listLookup = registry.lookup("/memory list project")
      const showLookup = registry.lookup("/memory show project architecture-notes")
      const indexLookup = registry.lookup("/memory index project")
      const removeLookup = registry.lookup("/memory remove project architecture-notes")
      const context = {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: workspace,
      } as never

      const addResult = await addLookup?.command.handler(addLookup.args, context)
      const entryPath = join(workspace, ".oneclaw", "memory", "architecture-notes.md")
      const entryBody = await readFile(entryPath, "utf8")
      const searchResult = await searchLookup?.command.handler(searchLookup.args, context)
      const listResult = await listLookup?.command.handler(listLookup.args, context)
      const showResult = await showLookup?.command.handler(showLookup.args, context)
      const indexResult = await indexLookup?.command.handler(indexLookup.args, context)
      const removeResult = await removeLookup?.command.handler(removeLookup.args, context)
      const listAfterRemove = await listLookup?.command.handler(listLookup.args, context)

      expect(addResult?.message).toContain("Added project memory entry architecture-notes")
      expect(entryBody).toContain("Record important design decisions")
      expect(searchResult?.message).toContain("Architecture Notes")
      expect(listResult?.message).toContain("architecture-notes")
      expect(showResult?.message).toContain("Architecture Notes")
      expect(indexResult?.message).toContain("[Architecture Notes](memory/architecture-notes.md)")
      expect(removeResult?.message).toContain("Removed project memory entry architecture-notes")
      expect(listAfterRemove?.message?.includes("architecture-notes")).toBe(false)
    } finally {
      if (originalHome === undefined) {
        delete process.env.ONECLAW_HOME
      } else {
        process.env.ONECLAW_HOME = originalHome
      }
    }
  })

  test("doctor command aggregates health, auth, git, plugin, and skill state", async () => {
    const root = join(tmpdir(), `oneclaw-doctor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await mkdir(root, { recursive: true })
    spawnSync("git", ["init"], { cwd: root, stdio: "ignore" })

    const registry = createFrontendCommandRegistry()
    const lookedUp = registry.lookup("/doctor")
    const result = await lookedUp?.command.handler(lookedUp.args, {
      client: createFakeClient(),
      sessionId: "session_current",
      cwd: root,
    } as never)

    expect(result?.message).toContain("\"health\"")
    expect(result?.message).toContain("\"git\"")
    expect(result?.message).toContain("\"plugins\"")
    expect(result?.message).toContain("\"skills\"")
  })

  test("doctor bundle writes a local diagnostic artifact", async () => {
    const originalHome = process.env.ONECLAW_HOME
    const homeDir = join(tmpdir(), `oneclaw-doctor-home-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const root = join(tmpdir(), `oneclaw-doctor-workspace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await mkdir(homeDir, { recursive: true })
    await mkdir(root, { recursive: true })
    process.env.ONECLAW_HOME = homeDir

    try {
      const registry = createFrontendCommandRegistry()
      const lookedUp = registry.lookup("/doctor bundle")

      const result = await lookedUp?.command.handler(lookedUp.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: root,
      } as never)

      const parsed = JSON.parse(result?.message ?? "{}") as { path?: string }
      expect(parsed.path).toContain("diagnostics")
      expect(existsSync(parsed.path ?? "")).toBe(true)
      expect(await readFile(parsed.path ?? "", "utf8")).toContain("session_current")
    } finally {
      if (originalHome === undefined) {
        delete process.env.ONECLAW_HOME
      } else {
        process.env.ONECLAW_HOME = originalHome
      }
    }
  })

  test("hooks command initializes, validates, mutates, and reloads hook files", async () => {
    const originalHome = process.env.ONECLAW_HOME
    const homeDir = join(tmpdir(), `oneclaw-hooks-home-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const workspace = join(tmpdir(), `oneclaw-hooks-workspace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await mkdir(homeDir, { recursive: true })
    await mkdir(workspace, { recursive: true })
    process.env.ONECLAW_HOME = homeDir

    try {
      const registry = createFrontendCommandRegistry()
      const context = {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: workspace,
      } as never
      const initLookup = registry.lookup("/hooks init")
      const addLookup = registry.lookup("/hooks add command before_model mark-before echo before")
      const validateLookup = registry.lookup("/hooks validate")
      const filesLookup = registry.lookup("/hooks files")
      const removeLookup = registry.lookup("/hooks remove mark-before")

      const initResult = await initLookup?.command.handler(initLookup.args, context)
      const addResult = await addLookup?.command.handler(addLookup.args, context)
      const validateResult = await validateLookup?.command.handler(validateLookup.args, context)
      const filesResult = await filesLookup?.command.handler(filesLookup.args, context)
      const removeResult = await removeLookup?.command.handler(removeLookup.args, context)
      const filesPayload = JSON.parse(filesResult?.message ?? "{}") as {
        files?: Array<{ path?: string }>
      }

      const hookPath = join(workspace, ".oneclaw", "hooks.json")
      expect(initResult?.message).toContain(hookPath)
      expect(addResult?.message).toContain("mark-before")
      expect(validateResult?.message).toContain('"valid": true')
      expect((filesPayload.files ?? []).some(file => file.path === hookPath)).toBe(true)
      expect(removeResult?.message).toContain("Removed hook mark-before")
      expect((await readFile(hookPath, "utf8")).includes("mark-before")).toBe(false)
    } finally {
      if (originalHome === undefined) {
        delete process.env.ONECLAW_HOME
      } else {
        process.env.ONECLAW_HOME = originalHome
      }
    }
  })

  test("keybindings command persists configured bindings", async () => {
    const registry = createFrontendCommandRegistry()
    const setLookup = registry.lookup("/keybindings set palette ctrl+k")
    const resetLookup = registry.lookup("/keybindings reset")
    const patches: Record<string, unknown>[] = []

    const context = {
      client: createFakeClient({
        updateConfigPatch: async (patch: Record<string, unknown>) => {
          patches.push(patch)
          return {
            path: "/tmp/oneclaw.config.json",
            state: { keybindings: (patch.output as { keybindings?: unknown }).keybindings },
          }
        },
      }),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never

    const setResult = await setLookup?.command.handler(setLookup.args, context)
    const resetResult = await resetLookup?.command.handler(resetLookup.args, context)

    expect(setResult?.message).toContain("palette")
    expect(resetResult?.message).toContain("Reset keybindings")
    expect(JSON.stringify(patches[0])).toContain("ctrl+k")
    expect(JSON.stringify(patches[1])).toContain("enter")
  })

  test("bridge status/auth commands expose config and fetched bridge state", async () => {
    const originalHome = process.env.ONECLAW_HOME
    const originalFetch = globalThis.fetch
    const homeDir = join(tmpdir(), `oneclaw-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await mkdir(homeDir, { recursive: true })
    await writeFile(join(homeDir, "oneclaw.config.json"), JSON.stringify({
      bridge: {
        host: "127.0.0.1",
        port: 4520,
        authTokens: [
          { token: "secret-token", scopes: ["read", "write"], label: "test-token" },
        ],
      },
    }, null, 2))

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ ok: true, provider: "codex-subscription" }))
      }
      if (url.endsWith("/state")) {
        return new Response(JSON.stringify({ provider: "codex-subscription", activeProfile: "codex-subscription" }))
      }
      throw new Error(`unexpected url: ${url}`)
    }) as typeof fetch
    process.env.ONECLAW_HOME = homeDir

    try {
      const registry = createFrontendCommandRegistry()
      const statusLookup = registry.lookup("/bridge status")
      const authLookup = registry.lookup("/bridge auth")

      const statusResult = await statusLookup?.command.handler(statusLookup.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: "/tmp/workspace",
      } as never)
      const authResult = await authLookup?.command.handler(authLookup.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: "/tmp/workspace",
      } as never)

      expect(statusResult?.message).toContain("\"health\"")
      expect(statusResult?.message).toContain("\"state\"")
      expect(authResult?.message).toContain("\"authEnabled\": true")
      expect(authResult?.message).toContain("test-token")
    } finally {
      globalThis.fetch = originalFetch
      if (originalHome === undefined) {
        delete process.env.ONECLAW_HOME
      } else {
        process.env.ONECLAW_HOME = originalHome
      }
    }
  })

  test("bridge task, task-management, team, and artifacts commands call bridge HTTP endpoints", async () => {
    const originalHome = process.env.ONECLAW_HOME
    const originalFetch = globalThis.fetch
    const homeDir = join(tmpdir(), `oneclaw-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await mkdir(homeDir, { recursive: true })
    await writeFile(join(homeDir, "oneclaw.config.json"), JSON.stringify({
      bridge: {
        host: "127.0.0.1",
        port: 4520,
      },
    }, null, 2))

    const seen: Array<{ url: string; method: string; body: string | null }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      const method = init?.method ?? "GET"
      const body = typeof init?.body === "string" ? init.body : null
      seen.push({ url, method, body })
      if (url.endsWith("/bridge/sessions?team=qa-team")) {
        return new Response(JSON.stringify([{ sessionId: "session_agent", team: "qa-team" }]))
      }
      if (url.endsWith("/tasks/launch")) {
        return new Response(JSON.stringify({ goal: "ship release", tasks: [{ id: "task_1" }] }))
      }
      if (url.endsWith("/tasks?status=completed&team=qa-team")) {
        return new Response(JSON.stringify([{ id: "task_1", status: "completed", metadata: { team: "qa-team" } }]))
      }
      if (url.endsWith("/tasks")) {
        return new Response(JSON.stringify([{ id: "task_1", status: "completed" }]))
      }
      if (url.endsWith("/tasks/task_1")) {
        return new Response(JSON.stringify({ id: "task_1", status: "completed" }))
      }
      if (url.endsWith("/tasks/task_1/session")) {
        return new Response(JSON.stringify({ sessionId: "session_agent", team: "qa-team" }))
      }
      if (url.endsWith("/tasks/task_1/output")) {
        return new Response("[done] end_turn")
      }
      if (url.endsWith("/teams")) {
        if (method === "POST") {
          return new Response(JSON.stringify({ name: "qa-team", agents: [], messages: [] }))
        }
        return new Response(JSON.stringify([{ name: "qa-team" }]))
      }
      if (url.endsWith("/teams/qa-team/tasks")) {
        return new Response(JSON.stringify([{ id: "task_1", metadata: { team: "qa-team" } }]))
      }
      if (url.endsWith("/teams/qa-team/sessions")) {
        return new Response(JSON.stringify([{ sessionId: "session_agent", team: "qa-team" }]))
      }
      if (url.endsWith("/teams/qa-team")) {
        return new Response(JSON.stringify({ name: "qa-team", agents: ["session_agent"], messages: [] }))
      }
      if (url.endsWith("/teams/qa-team/agents")) {
        return new Response(JSON.stringify({ name: "qa-team", agents: ["session_agent"], messages: [] }))
      }
      if (url.endsWith("/teams/qa-team/messages")) {
        return new Response(JSON.stringify({ name: "qa-team", agents: ["session_agent"], messages: ["ship it"] }))
      }
      if (url.endsWith("/teams/qa-team/goal")) {
        return new Response(JSON.stringify({ name: "qa-team", goal: "ship release", status: "idle" }))
      }
      if (url.endsWith("/teams/qa-team/roles")) {
        return new Response(JSON.stringify({ name: "qa-team", roles: { session_agent: "reviewer" } }))
      }
      if (url.endsWith("/teams/qa-team/worktrees")) {
        return new Response(JSON.stringify({ name: "qa-team", worktrees: { session_agent: "/tmp/worktree" } }))
      }
      if (url.endsWith("/teams/qa-team/review")) {
        return new Response(JSON.stringify({ name: "qa-team", review: { status: "approved", note: "ok" } }))
      }
      if (url.endsWith("/teams/qa-team/merge")) {
        return new Response(JSON.stringify({ name: "qa-team", merge: { status: "ready", note: "ok" } }))
      }
      if (url.endsWith("/teams/qa-team/run")) {
        return new Response(JSON.stringify({ team: "qa-team", goal: "ship release", tasks: [{ id: "task_2" }] }))
      }
      if (url.endsWith("/artifacts")) {
        return new Response(JSON.stringify([{ id: "artifact_1" }]))
      }
      throw new Error(`unexpected url: ${url}`)
    }) as typeof fetch
    process.env.ONECLAW_HOME = homeDir

    try {
      const registry = createFrontendCommandRegistry()
      const taskLookup = registry.lookup("/bridge task ship release")
      const tasksLookup = registry.lookup("/bridge tasks")
      const filteredSessionsLookup = registry.lookup("/bridge sessions qa-team")
      const filteredTasksLookup = registry.lookup("/bridge tasks completed team qa-team")
      const taskShowLookup = registry.lookup("/bridge task show task_1")
      const taskTailLookup = registry.lookup("/bridge task tail task_1")
      const teamCreateLookup = registry.lookup("/bridge team create qa-team Release squad")
      const teamGoalLookup = registry.lookup("/bridge team goal qa-team ship release")
      const teamRoleLookup = registry.lookup("/bridge team role qa-team session_agent reviewer")
      const teamWorktreeLookup = registry.lookup("/bridge team worktree qa-team session_agent /tmp/worktree")
      const teamReviewLookup = registry.lookup("/bridge team review qa-team approved ok")
      const teamMergeLookup = registry.lookup("/bridge team merge qa-team ready ok")
      const teamRunLookup = registry.lookup("/bridge team run qa-team ship release")
      const teamTasksLookup = registry.lookup("/bridge team tasks qa-team")
      const teamSessionsLookup = registry.lookup("/bridge team sessions qa-team")
      const teamAddLookup = registry.lookup("/bridge team add qa-team session_agent")
      const teamMessageLookup = registry.lookup("/bridge team message qa-team ship it")
      const teamsLookup = registry.lookup("/bridge teams")
      const artifactsLookup = registry.lookup("/bridge artifacts")

      const taskResult = await taskLookup?.command.handler(taskLookup.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: "/tmp/workspace",
      } as never)
      const tasksResult = await tasksLookup?.command.handler(tasksLookup.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: "/tmp/workspace",
      } as never)
      const filteredSessionsResult = await filteredSessionsLookup?.command.handler(filteredSessionsLookup.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: "/tmp/workspace",
      } as never)
      const filteredTasksResult = await filteredTasksLookup?.command.handler(filteredTasksLookup.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: "/tmp/workspace",
      } as never)
      const taskShowResult = await taskShowLookup?.command.handler(taskShowLookup.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: "/tmp/workspace",
      } as never)
      const taskTailResult = await taskTailLookup?.command.handler(taskTailLookup.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: "/tmp/workspace",
      } as never)
      const teamCreateResult = await teamCreateLookup?.command.handler(teamCreateLookup.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: "/tmp/workspace",
      } as never)
      const teamGoalResult = await teamGoalLookup?.command.handler(teamGoalLookup.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: "/tmp/workspace",
      } as never)
      const teamRoleResult = await teamRoleLookup?.command.handler(teamRoleLookup.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: "/tmp/workspace",
      } as never)
      const teamWorktreeResult = await teamWorktreeLookup?.command.handler(teamWorktreeLookup.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: "/tmp/workspace",
      } as never)
      const teamReviewResult = await teamReviewLookup?.command.handler(teamReviewLookup.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: "/tmp/workspace",
      } as never)
      const teamMergeResult = await teamMergeLookup?.command.handler(teamMergeLookup.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: "/tmp/workspace",
      } as never)
      const teamRunResult = await teamRunLookup?.command.handler(teamRunLookup.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: "/tmp/workspace",
      } as never)
      const teamTasksResult = await teamTasksLookup?.command.handler(teamTasksLookup.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: "/tmp/workspace",
      } as never)
      const teamSessionsResult = await teamSessionsLookup?.command.handler(teamSessionsLookup.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: "/tmp/workspace",
      } as never)
      const teamAddResult = await teamAddLookup?.command.handler(teamAddLookup.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: "/tmp/workspace",
      } as never)
      const teamMessageResult = await teamMessageLookup?.command.handler(teamMessageLookup.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: "/tmp/workspace",
      } as never)
      const teamsResult = await teamsLookup?.command.handler(teamsLookup.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: "/tmp/workspace",
      } as never)
      const artifactsResult = await artifactsLookup?.command.handler(artifactsLookup.args, {
        client: createFakeClient(),
        sessionId: "session_current",
        cwd: "/tmp/workspace",
      } as never)

      expect(taskResult?.message).toContain("ship release")
      expect(tasksResult?.message).toContain("task_1")
      expect(filteredSessionsResult?.message).toContain("qa-team")
      expect(filteredTasksResult?.message).toContain("qa-team")
      expect(taskShowResult?.message).toContain("task_1")
      expect(taskShowResult?.message).toContain("session_agent")
      expect(taskTailResult?.message).toContain("[done] end_turn")
      expect(teamCreateResult?.message).toContain("qa-team")
      expect(teamGoalResult?.message).toContain("ship release")
      expect(teamRoleResult?.message).toContain("reviewer")
      expect(teamWorktreeResult?.message).toContain("/tmp/worktree")
      expect(teamReviewResult?.message).toContain("approved")
      expect(teamMergeResult?.message).toContain("ready")
      expect(teamRunResult?.message).toContain("task_2")
      expect(teamTasksResult?.message).toContain("task_1")
      expect(teamSessionsResult?.message).toContain("session_agent")
      expect(teamAddResult?.message).toContain("session_agent")
      expect(teamMessageResult?.message).toContain("ship it")
      expect(teamsResult?.message).toContain("qa-team")
      expect(artifactsResult?.message).toContain("artifact_1")
      expect(seen.some(item => item.url.endsWith("/tasks/launch") && item.method === "POST" && item.body?.includes("ship release"))).toBe(true)
      expect(seen.some(item => item.url.endsWith("/tasks") && item.method === "GET")).toBe(true)
      expect(seen.some(item => item.url.endsWith("/bridge/sessions?team=qa-team") && item.method === "GET")).toBe(true)
      expect(seen.some(item => item.url.endsWith("/tasks?status=completed&team=qa-team") && item.method === "GET")).toBe(true)
      expect(seen.some(item => item.url.endsWith("/teams") && item.method === "POST" && item.body?.includes("qa-team"))).toBe(true)
      expect(seen.some(item => item.url.endsWith("/teams/qa-team/goal") && item.method === "POST" && item.body?.includes("ship release"))).toBe(true)
      expect(seen.some(item => item.url.endsWith("/teams/qa-team/roles") && item.method === "POST" && item.body?.includes("reviewer"))).toBe(true)
      expect(seen.some(item => item.url.endsWith("/teams/qa-team/worktrees") && item.method === "POST" && item.body?.includes("/tmp/worktree"))).toBe(true)
      expect(seen.some(item => item.url.endsWith("/teams/qa-team/review") && item.method === "POST" && item.body?.includes("approved"))).toBe(true)
      expect(seen.some(item => item.url.endsWith("/teams/qa-team/merge") && item.method === "POST" && item.body?.includes("ready"))).toBe(true)
      expect(seen.some(item => item.url.endsWith("/teams/qa-team/run") && item.method === "POST" && item.body?.includes("ship release"))).toBe(true)
      expect(seen.some(item => item.url.endsWith("/artifacts") && item.method === "GET")).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      if (originalHome === undefined) {
        delete process.env.ONECLAW_HOME
      } else {
        process.env.ONECLAW_HOME = originalHome
      }
    }
  })

  test("branch and diff commands inspect the local git repo", async () => {
    const root = join(tmpdir(), `oneclaw-git-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, "file.txt"), "hello\n")
    spawnSync("git", ["init"], { cwd: root, stdio: "ignore" })
    spawnSync("git", ["config", "user.email", "test@example.com"], { cwd: root, stdio: "ignore" })
    spawnSync("git", ["config", "user.name", "Test User"], { cwd: root, stdio: "ignore" })
    spawnSync("git", ["add", "file.txt"], { cwd: root, stdio: "ignore" })
    spawnSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" })
    await writeFile(join(root, "file.txt"), "hello\nworld\n")

    const registry = createFrontendCommandRegistry()
    const branchLookup = registry.lookup("/branch")
    const diffLookup = registry.lookup("/diff names")

    const branchResult = await branchLookup?.command.handler(branchLookup.args, {
      client: createFakeClient(),
      sessionId: "session_current",
      cwd: root,
    } as never)
    const diffResult = await diffLookup?.command.handler(diffLookup.args, {
      client: createFakeClient(),
      sessionId: "session_current",
      cwd: root,
    } as never)

    expect(branchResult?.message).toContain("branch:")
    expect(diffResult?.message).toContain("file.txt")
  })

  test("files command returns a workspace tree", async () => {
    const root = join(tmpdir(), `oneclaw-files-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await mkdir(join(root, "src"), { recursive: true })
    await writeFile(join(root, "src", "index.ts"), "export {}\n")

    const registry = createFrontendCommandRegistry()
    const lookedUp = registry.lookup("/files 1")
    const result = await lookedUp?.command.handler(lookedUp.args, {
      client: createFakeClient(),
      sessionId: "session_current",
      cwd: root,
    } as never)

    expect(result?.message).toContain("src")
    expect(result?.message).toContain("src/index.ts")
  })

  test("symbols, fetch, web search, and todo commands use kernel-backed management RPCs", async () => {
    const registry = createFrontendCommandRegistry()
    const symbolsLookup = registry.lookup("/symbols OneClaw --path src --limit 5")
    const fetchLookup = registry.lookup("/fetch https://example.test/page 1200")
    const searchLookup = registry.lookup("/search-web oneclaw harness --limit 1")
    const todoListLookup = registry.lookup("/todo")
    const todoAddLookup = registry.lookup("/todo add write docs")
    const todoDoneLookup = registry.lookup("/todo done todo-1")
    const todoClearLookup = registry.lookup("/todo clear")
    const updates: Array<Array<Record<string, unknown>>> = []

    const context = {
      client: createFakeClient({
        todoUpdate: async (_sessionId: string, items: Array<Record<string, unknown>>) => {
          updates.push(items)
          return {
            sessionId: "session_current",
            count: items.length,
            byStatus: {},
            items,
          }
        },
      }),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never

    const symbolsResult = await symbolsLookup?.command.handler(symbolsLookup.args, context)
    const fetchResult = await fetchLookup?.command.handler(fetchLookup.args, context)
    const searchResult = await searchLookup?.command.handler(searchLookup.args, context)
    const listResult = await todoListLookup?.command.handler(todoListLookup.args, context)
    const addResult = await todoAddLookup?.command.handler(todoAddLookup.args, context)
    const doneResult = await todoDoneLookup?.command.handler(todoDoneLookup.args, context)
    const clearResult = await todoClearLookup?.command.handler(todoClearLookup.args, context)

    expect(symbolsResult?.message).toContain("OneClawRuntime")
    expect(symbolsResult?.message).toContain("src/runtime.ts")
    expect(fetchResult?.message).toContain("https://example.test/page")
    expect(fetchResult?.message).toContain("fetched")
    expect(searchResult?.message).toContain("oneclaw harness")
    expect(searchResult?.message).toContain("https://example.test/result")
    expect(listResult?.message).toContain("existing task")
    expect(addResult?.message).toContain("write docs")
    expect(doneResult?.message).toContain("done")
    expect(clearResult?.message).toContain("\"count\": 0")
    expect(updates.length).toBe(3)
  })

  test("plan command runs a planning prompt in the current session", async () => {
    const registry = createFrontendCommandRegistry()
    const lookedUp = registry.lookup("/plan ship a release")
    const prompts: string[] = []

    const result = await lookedUp?.command.handler(lookedUp.args, {
      client: createFakeClient({
        runPrompt: async (prompt: string) => {
          prompts.push(prompt)
          return {
            sessionId: "session_current",
            text: "plan result",
            iterations: 1,
            stopReason: "end_turn",
          }
        },
      }),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    expect(prompts[0]).toContain("Create a concise engineering plan")
    expect(prompts[0]).toContain("ship a release")
    expect(result?.message).toBe("plan result")
  })

  test("review command runs a review-style prompt", async () => {
    const registry = createFrontendCommandRegistry()
    const lookedUp = registry.lookup("/review src")
    const prompts: string[] = []

    const result = await lookedUp?.command.handler(lookedUp.args, {
      client: createFakeClient({
        runPrompt: async (prompt: string) => {
          prompts.push(prompt)
          return {
            sessionId: "session_current",
            text: "review result",
            iterations: 1,
            stopReason: "end_turn",
          }
        },
      }),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    expect(prompts[0]).toContain("Review the current workspace target: src")
    expect(prompts[0]).toContain("findings first")
    expect(result?.message).toBe("review result")
  })

  test("agents command runs delegate-style subtasks in isolated sessions", async () => {
    const registry = createFrontendCommandRegistry()
    const lookedUp = registry.lookup("/agents run fix flaky tests")
    const created: Array<Record<string, unknown> | undefined> = []
    const prompts: string[] = []

    const result = await lookedUp?.command.handler(lookedUp.args, {
      client: createFakeClient({
        createSession: async (_cwd: string, metadata?: Record<string, unknown>) => {
          created.push(metadata)
          return {
            id: `session_${created.length}`,
            cwd: "/tmp/workspace",
          }
        },
        runPromptTracked: (prompt: string) => {
          prompts.push(prompt)
          return {
            requestId: `req_${prompts.length}`,
            promise: Promise.resolve({
              sessionId: `session_${prompts.length}`,
              text: `done: ${prompt}`,
              iterations: 1,
              stopReason: "end_turn",
            }),
          }
        },
      }),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    expect(created.length).toBe(3)
    expect(created.every(item => item?.via === "delegate-subtask")).toBe(true)
    expect(prompts.length).toBe(3)
    expect(result?.message).toContain("\"goal\": \"fix flaky tests\"")
    expect(result?.message).toContain("\"tasks\"")
  })

  test("tasks command runs managed local subtasks and exposes task records", async () => {
    const registry = createFrontendCommandRegistry()
    const runLookup = registry.lookup("/tasks run triage issues")

    const runResult = await runLookup?.command.handler(runLookup.args, {
      client: createFakeClient({
        createSession: async (_cwd: string, metadata?: Record<string, unknown>) => ({
          id: `session_${String(metadata?.prompt ?? "task").replace(/\s+/g, "_")}`,
          cwd: "/tmp/workspace",
        }),
        runPromptTracked: (prompt: string, options?: { onEvent?: (event: Record<string, unknown>) => void | Promise<void> }) => {
          void options?.onEvent?.({ type: "tool_started" })
          return {
            requestId: `req_${prompt.replace(/\s+/g, "_")}`,
            promise: Promise.resolve({
              sessionId: `session_${prompt.replace(/\s+/g, "_")}`,
              text: `done: ${prompt}`,
              iterations: 1,
              stopReason: "end_turn",
            }),
          }
        },
      }),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    expect(runResult?.message).toContain("\"goal\": \"triage issues\"")
    const parsed = JSON.parse(runResult?.message ?? "{}") as { tasks?: Array<{ id: string }> }
    const taskId = parsed.tasks?.[0]?.id
    expect(taskId).toBeTruthy()

    const listLookup = registry.lookup("/tasks")
    const listResult = await listLookup?.command.handler(listLookup.args, {
      client: createFakeClient(),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    const showLookup = registry.lookup(`/tasks show ${taskId}`)
    const showResult = await showLookup?.command.handler(showLookup?.args ?? "", {
      client: createFakeClient(),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    const tailLookup = registry.lookup(`/tasks tail ${taskId}`)
    const tailResult = await tailLookup?.command.handler(tailLookup?.args ?? "", {
      client: createFakeClient(),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    const statusLookup = registry.lookup("/tasks status completed")
    const statusResult = await statusLookup?.command.handler(statusLookup?.args ?? "", {
      client: createFakeClient(),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    expect(listResult?.message).toContain("\"local\"")
    expect(listResult?.message).toContain("triage issues")
    expect(showResult?.message).toContain("\"output\"")
    expect(tailResult?.message).toContain("[done] end_turn")
    expect(statusResult?.message).toContain("triage issues")
  })

  test("agents show/use/tasks expose management views", async () => {
    const registry = createFrontendCommandRegistry()
    const selected: string[] = []

    const showLookup = registry.lookup("/agents show session_agent")
    const showResult = await showLookup?.command.handler(showLookup.args, {
      client: createFakeClient({
        sessionExportBundle: async (sessionId: string) => ({
          sessionId,
          markdown: "# agent session",
        }),
      }),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    const useLookup = registry.lookup("/agents use session_agent")
    const useResult = await useLookup?.command.handler(useLookup.args, {
      client: createFakeClient({
        sessionGet: async (sessionId: string) => ({
          id: sessionId,
          cwd: "/tmp/workspace",
          createdAt: "2026-04-07T00:00:00Z",
          updatedAt: "2026-04-07T00:00:00Z",
          messages: [],
        }),
      }),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
      setSessionId: (sessionId: string) => {
        selected.push(sessionId)
      },
    } as never)

    const tasksLookup = registry.lookup("/agents tasks")
    const tasksResult = await tasksLookup?.command.handler(tasksLookup.args, {
      client: createFakeClient(),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    expect(showResult?.message).toContain("agent session")
    expect(selected).toEqual(["session_agent"])
    expect(useResult?.message).toContain("Active session set to session_agent")
    expect(tasksResult?.message).toContain("[")
  })

  test("agents team commands manage lightweight agent teams", async () => {
    const registry = createFrontendCommandRegistry()
    const context = {
      client: createFakeClient(),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never

    const createLookup = registry.lookup("/agents team create qa-team Regression squad")
    const addLookup = registry.lookup("/agents team add qa-team session_agent")
    const messageLookup = registry.lookup("/agents team message qa-team review the flaky suite")
    const listLookup = registry.lookup("/agents team list")

    const createResult = await createLookup?.command.handler(createLookup.args, context)
    const addResult = await addLookup?.command.handler(addLookup.args, context)
    const messageResult = await messageLookup?.command.handler(messageLookup.args, context)
    const listResult = await listLookup?.command.handler(listLookup.args, context)

    expect(createResult?.message).toContain("qa-team")
    expect(addResult?.message).toContain("session_agent")
    expect(messageResult?.message).toContain("review the flaky suite")
    expect(listResult?.message).toContain("qa-team")
  })

  test("stats command aggregates state, usage, session, skill, and plugin views", async () => {
    const registry = createFrontendCommandRegistry()
    const lookedUp = registry.lookup("/stats")

    const result = await lookedUp?.command.handler(lookedUp.args, {
      client: createFakeClient(),
      sessionId: "session_current",
      cwd: "/tmp/workspace",
    } as never)

    expect(result?.message).toContain("\"state\"")
    expect(result?.message).toContain("\"usage\"")
    expect(result?.message).toContain("\"sessions\"")
    expect(result?.message).toContain("\"skills\"")
    expect(result?.message).toContain("\"plugins\"")
  })
})
