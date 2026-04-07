import { tmpdir } from "node:os"
import { join } from "node:path"
import { HookExecutor } from "../src/hooks/executor.mts"
import { MemoryManager } from "../src/memory/manager.mts"
import { PluginRegistry } from "../src/plugins/registry.mts"
import { PromptAssembler } from "../src/prompts/assembler.mts"
import { QueryEngine } from "../src/runtime/query-engine.mts"
import { QueryLoop } from "../src/runtime/query-loop.mts"
import { PermissionPolicy } from "../src/runtime/permission-policy.mts"
import { ToolDispatcher } from "../src/runtime/tool-dispatcher.mts"
import { createSessionBackend } from "../src/session/backend.mts"
import { SkillRegistry } from "../src/skills/registry.mts"
import { AppStateStore } from "../src/state/store.mts"
import { TaskManager } from "../src/tasks/task-manager.mts"
import type {
  Logger,
  OneClawConfig,
  ProviderAdapter,
  ToolImplementation,
} from "../src/types.mts"
import { UsageTracker } from "../src/usage/tracker.mts"

export function createTestConfig(overrides: Partial<OneClawConfig> = {}): OneClawConfig {
  const root = join(tmpdir(), `oneclaw-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  return {
    homeDir: root,
    sessionDir: join(root, "sessions"),
    activeProfile: "internal-test",
    providerProfiles: {
      "internal-test": {
        label: "Internal Test Provider",
        kind: "internal-test",
        model: "internal-test",
      },
    },
    provider: {
      kind: "internal-test",
      model: "internal-test",
      maxTokens: 1000,
    },
    permissions: {
      mode: "allow",
      writableRoots: [process.cwd()],
      commandAllowlist: [],
      deniedCommands: [],
      pathRules: [],
    },
    mcpServers: [],
    skillDirs: [],
    pluginDirs: [],
    hooks: {
      files: [],
    },
    memory: {
      enabled: true,
      includeSession: true,
      includeProject: true,
      includeGlobal: true,
      projectDirName: ".oneclaw",
      projectFileName: "memory.md",
      globalFile: join(root, "memory", "global.md"),
    },
    sessionBackend: {
      kind: "file",
    },
    sandbox: {
      enabled: false,
      args: [],
      failIfUnavailable: false,
    },
    budget: {},
    output: {
      style: "text",
      theme: "neutral",
      keybindings: {
        submit: "enter",
        exit: "ctrl+c",
      },
    },
    runtime: {
      fastMode: false,
      effort: "medium",
      vimMode: false,
      voiceMode: false,
      voiceKeyterms: [],
    },
    worktree: {
      enabled: false,
      baseDir: join(root, "worktrees"),
      cleanup: true,
    },
    bridge: {
      host: "127.0.0.1",
      port: 0,
    },
    context: {
      maxChars: 5000,
      keepMessages: 4,
    },
    systemPrompt: "test",
    ...overrides,
  }
}

export function createTestState(config: OneClawConfig): AppStateStore {
  return new AppStateStore({
    provider: config.provider.kind,
    activeProfile: config.activeProfile,
    model: config.provider.model,
    permissionMode: config.permissions.mode,
    cwd: process.cwd(),
    theme: config.output.theme,
    outputStyle: config.output.style,
    keybindings: { ...config.output.keybindings },
    mcpConnected: 0,
    mcpFailed: 0,
    activeSessions: 0,
    bridgeSessions: 0,
    taskCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    estimatedCostUsd: 0,
  })
}

export function createTestHookExecutor(config: OneClawConfig, logger: Logger = console): HookExecutor {
  return new HookExecutor(config, logger, [])
}

export function createTestQueryLoop(
  config: OneClawConfig,
  provider: ProviderAdapter,
  tools: ToolImplementation[],
  logger: Logger = console,
): QueryLoop {
  const skills = new SkillRegistry()
  const plugins = new PluginRegistry()
  const memory = new MemoryManager(config)
  const prompts = new PromptAssembler(config, memory, skills, plugins)
  const state = createTestState(config)
  const hookExecutor = createTestHookExecutor(config, logger)
  const dispatcher = new ToolDispatcher(
    tools,
    new PermissionPolicy(config.permissions),
    [],
    hookExecutor,
    logger,
  )
  const usage = new UsageTracker(config, logger)
  return new QueryLoop(
    config,
    provider,
    dispatcher,
    prompts,
    usage,
    state,
    hookExecutor,
    [],
    logger,
  )
}

export function createTestSessionEngine(
  config: OneClawConfig,
  queryEngine: QueryEngine,
  logger: Logger = console,
): import("../src/runtime/session-engine.mts").SessionEngine {
  const tasks = new TaskManager()
  return new (require("../src/runtime/session-engine.mts").SessionEngine)(
    config,
    queryEngine,
    tasks,
    logger,
    createSessionBackend(config),
    createTestHookExecutor(config, logger),
    createTestState(config),
  )
}
