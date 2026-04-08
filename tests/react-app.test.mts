import { describe, expect, test } from "bun:test"
import type { SessionRecord } from "../src/types.mts"
import {
  buildArtifactPanelEntries,
  buildArtifactPanelLines,
  buildBridgeActionOptions,
  buildBridgePanelEntries,
  buildBridgeSummaryLines,
  buildBridgePanelLines,
  buildInfoPanelLines,
  buildMcpActionOptions,
  buildMcpPanelEntries,
  buildMcpPanelLines,
  extractSseFrames,
  resolveUiPresentation,
  resolveStatusBarStats,
} from "../src/tui/react-app.tsx"

describe("TUI view model", () => {
  test("status bar reads token totals from kernel usage() payload", () => {
    const stats = resolveStatusBarStats({
      provider: "codex-subscription",
      activeProfile: "codex-subscription",
      model: "gpt-5.4",
    }, {
      inputTokens: 1234,
      outputTokens: 56,
      estimatedCostUsd: 0.0049,
    })

    expect(stats.provider).toBe("codex-subscription")
    expect(stats.profile).toBe("codex-subscription")
    expect(stats.model).toBe("gpt-5.4")
    expect(stats.tokensIn).toBe(1234)
    expect(stats.tokensOut).toBe(56)
    expect(Math.round(stats.estimatedCostUsd * 10_000)).toBe(49)
  })

  test("status bar falls back to runtime state totals when usage summary is absent", () => {
    const stats = resolveStatusBarStats({
      provider: "codex-subscription",
      activeProfile: "codex-subscription",
      model: "gpt-5.4",
      totalInputTokens: 88,
      totalOutputTokens: 9,
    }, {})

    expect(stats.tokensIn).toBe(88)
    expect(stats.tokensOut).toBe(9)
  })

  test("context lines do not inject fake empty text when inspector content is blank", () => {
    const session: SessionRecord = {
      id: "session_92a8abcd",
      cwd: "/Users/mac/Documents/OneClaw",
      createdAt: "2026-04-07T04:40:32Z",
      updatedAt: "2026-04-07T04:40:32Z",
      messages: [],
    }

    expect(buildInfoPanelLines(session, "")).toEqual([
      "session session_92a8... · OneClaw",
    ])
  })

  test("command output takes precedence over session summary in the info panel", () => {
    const session: SessionRecord = {
      id: "session_92a8abcd",
      cwd: "/Users/mac/Documents/OneClaw",
      createdAt: "2026-04-07T04:40:32Z",
      updatedAt: "2026-04-07T04:40:32Z",
      messages: [],
    }

    expect(buildInfoPanelLines(session, "/help\n/providers\n/profile")).toEqual([
      "/help",
      "/providers",
      "/profile",
    ])
  })

  test("bridge summary lines describe live bridge tasks, teams, and sessions", () => {
    expect(buildBridgeSummaryLines({
      reachable: true,
      sessions: [
        { sessionId: "session_1", status: "running", team: "qa-team" },
        { sessionId: "session_2", status: "completed" },
      ],
      tasks: [
        { id: "task_1", status: "running", metadata: { team: "qa-team" } },
        { id: "task_2", status: "completed" },
      ],
      teams: [
        { name: "qa-team", status: "running", agents: ["session_1"], tasks: ["task_1"] },
      ],
    })).toEqual([
      "bridge 2 sessions · 2 tasks · 1 teams",
      "running 1 sessions · 1 tasks · 1 teams",
      "teams qa-team:running",
    ])
  })

  test("bridge summary lines report offline control plane", () => {
    expect(buildBridgeSummaryLines({
      reachable: false,
      sessions: [],
      tasks: [],
      teams: [],
      error: "connect ECONNREFUSED",
    })).toEqual([
      "bridge offline · connect ECONNREFUSED",
    ])
  })

  test("bridge panel lines render team, task, and session views", () => {
    const snapshot = {
      reachable: true,
      sessions: [
        { sessionId: "session_abcdef123456", status: "running", team: "qa-team" },
      ],
      tasks: [
        { id: "task_1", status: "running", metadata: { team: "qa-team" } },
      ],
      teams: [
        { name: "qa-team", status: "running", goal: "fix flaky tests", agents: ["session_abcdef123456"], tasks: ["task_1"], plan: ["inspect", "patch"], roles: { session_abcdef123456: "reviewer" }, review: { status: "pending" }, merge: { status: "ready" }, messages: ["done"] },
      ],
    }

    expect(buildBridgePanelLines(snapshot, "tasks")).toEqual([
      "task_1 · running · qa-team",
    ])
    expect(buildBridgePanelLines(snapshot, "teams")).toEqual([
      "qa-team · running · 1 agents · 1 tasks · 2 plan · 1 roles · review:pending · merge:ready · 1 msgs · fix flaky tests",
    ])
    expect(buildBridgePanelLines(snapshot, "sessions", "session_abcdef123456")).toEqual([
      "session_abcd... · running · qa-team *",
    ])
  })

  test("bridge panel entries keep inspectable values for tasks, teams, and sessions", () => {
    const snapshot = {
      reachable: true,
      sessions: [
        { sessionId: "session_abcdef123456", status: "running", team: "qa-team" },
      ],
      tasks: [
        { id: "task_1", status: "running", metadata: { team: "qa-team" } },
      ],
      teams: [
        { name: "qa-team", status: "running", goal: "fix flaky tests", agents: ["session_abcdef123456"], tasks: ["task_1"], plan: ["inspect"], roles: {}, messages: [] },
      ],
    }

    expect(buildBridgePanelEntries(snapshot, "tasks")).toEqual([
      { value: "task_1", label: "task_1 · running · qa-team" },
    ])
    expect(buildBridgePanelEntries(snapshot, "teams")).toEqual([
      { value: "qa-team", label: "qa-team · running · 1 agents · 1 tasks · 1 plan · 0 roles · 0 msgs · fix flaky tests" },
    ])
    expect(buildBridgePanelEntries(snapshot, "sessions", "session_abcdef123456")).toEqual([
      { value: "session_abcdef123456", label: "session_abcd... · running · qa-team *" },
    ])
  })

  test("bridge action options expose contextual control-plane actions", () => {
    expect(buildBridgeActionOptions("overview", null).map(option => option.value)).toEqual([
      "refresh-bridge",
    ])
    expect(buildBridgeActionOptions("tasks", { value: "task_1", label: "task_1" }).map(option => option.value)).toEqual([
      "inspect-task",
      "show-task-session",
      "cancel-task",
    ])
    expect(buildBridgeActionOptions("teams", { value: "qa-team", label: "qa-team" }).map(option => option.value)).toEqual([
      "inspect-team",
      "focus-team-tasks",
      "focus-team-sessions",
      "set-team-goal",
      "run-team-goal",
      "message-team",
    ])
    expect(buildBridgeActionOptions("sessions", { value: "session_1", label: "session_1" }).map(option => option.value)).toEqual([
      "inspect-session",
      "use-session",
      "interrupt-session",
      "export-session",
    ])
  })

  test("extracts complete SSE frames and preserves the trailing partial frame", () => {
    expect(extractSseFrames([
      "event: sessions",
      "data: [{\"sessionId\":\"session_1\"}]",
      "",
      "event: tasks",
      "data: [{\"id\":\"task_1\"}]",
      "",
      "event: teams",
      "data: [{\"name\":\"qa-team\"}]",
    ].join("\n"))).toEqual({
      frames: [
        {
          event: "sessions",
          data: "[{\"sessionId\":\"session_1\"}]",
        },
        {
          event: "tasks",
          data: "[{\"id\":\"task_1\"}]",
        },
      ],
      rest: "event: teams\ndata: [{\"name\":\"qa-team\"}]",
    })
  })

  test("mcp panel lines render overview, tool, and resource browser states", () => {
    const snapshot = {
      statuses: [{ name: "fs", state: "connected" }],
      tools: [{ qualifiedName: "mcp__fs__read", readOnly: true, description: "Read files" }],
      resources: [{ server: "fs", uri: "file://README.md" }],
      resourceTemplates: [{ server: "fs", uriTemplate: "file://{path}" }],
    }

    expect(buildMcpPanelLines(snapshot, "overview").join("\n")).toContain("servers 1")
    expect(buildMcpPanelLines(snapshot, "tools").join("\n")).toContain("mcp__fs__read")
    expect(buildMcpPanelLines(snapshot, "resources").join("\n")).toContain("file://README.md")
    expect(buildMcpPanelLines(snapshot, "resources").join("\n")).toContain("template")
    expect(buildMcpPanelEntries(snapshot, "resources")).toEqual([
      { kind: "resource", server: "fs", uri: "file://README.md", value: "file://README.md", label: "fs · file://README.md" },
      { kind: "template", server: "fs", uriTemplate: "file://{path}", value: "file://{path}", label: "fs · template · file://{path}" },
    ])
    expect(buildMcpActionOptions("resources", { kind: "template", server: "fs", value: "file://{path}", label: "fs" }).map(option => option.value)).toEqual([
      "inspect-mcp",
      "read-mcp-template",
    ])
    expect(buildMcpActionOptions("statuses", { kind: "status", server: "fs", value: "fs", label: "fs" }).map(option => option.value)).toEqual([
      "inspect-mcp",
      "reconnect-mcp",
    ])
  })

  test("artifact panel lines expose local tool result artifacts", () => {
    const snapshot = {
      reachable: true,
      count: 2,
      artifacts: [
        {
          id: "artifact_abcdef123456",
          kind: "tool-result" as const,
          name: "fetch-result",
          source: "web_fetch",
          contentType: "application/json",
          path: "/tmp/artifact.json",
          relativePath: ".oneclaw/artifacts/artifact.json",
          bytes: 128,
          createdAt: "2026-04-08T00:00:00Z",
          metadata: {},
        },
        {
          id: "artifact_review",
          kind: "swarm-summary" as const,
          name: "swarm review",
          contentType: "text/markdown",
          path: "/tmp/swarm.md",
          relativePath: ".oneclaw/artifacts/swarm.md",
          bytes: 64,
          createdAt: "2026-04-08T00:00:01Z",
          metadata: {},
        },
      ],
    }

    expect(buildArtifactPanelLines(snapshot, "overview").join("\n")).toContain("tool-result:1")
    expect(buildArtifactPanelLines(snapshot, "all")).toEqual([
      "artifact_abc... · tool-result · web_fetch · 128b",
      "artifact_rev... · swarm-summary · swarm review · 64b",
    ])
    expect(buildArtifactPanelEntries(snapshot)).toEqual([
      { value: "artifact_abcdef123456", label: "artifact_abc... · tool-result · web_fetch · 128b" },
      { value: "artifact_review", label: "artifact_rev... · swarm-summary · swarm review · 64b" },
    ])
  })

  test("TUI presentation consumes runtime theme and keybinding state with fallbacks", () => {
    expect(resolveUiPresentation({
      provider: "codex-subscription",
      activeProfile: "codex-subscription",
      theme: "contrast",
      keybindings: {
        submit: "ctrl+j",
        palette: "ctrl+k",
        sessions: "ctrl+o",
        profile: "ctrl+t",
        mcp: "ctrl+m",
        bridge: "ctrl+b",
      },
    })).toEqual({
      primaryColor: "white",
      mutedColor: "cyan",
      submitKey: "ctrl+j",
      paletteKey: "ctrl+k",
      sessionKey: "ctrl+o",
      profileKey: "ctrl+t",
      mcpKey: "ctrl+m",
      bridgeKey: "ctrl+b",
    })
    expect(resolveUiPresentation({ provider: "codex-subscription", activeProfile: "codex-subscription" }).submitKey).toBe("enter")
  })
})
