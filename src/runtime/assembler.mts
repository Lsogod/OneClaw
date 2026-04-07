import { createDefaultCommandRegistry, type CommandRegistry } from "../commands/registry.mts"
import { BridgeSessionManager } from "../bridge/manager.mts"
import { loadConfig } from "../config.mts"
import { HookExecutor } from "../hooks/executor.mts"
import { HookRegistry } from "../hooks/registry.mts"
import { McpRegistry } from "../mcp/registry.mts"
import { MemoryManager } from "../memory/manager.mts"
import { formatOutput } from "../output/registry.mts"
import { PluginRegistry } from "../plugins/registry.mts"
import { createProvider } from "../providers/index.mts"
import { SkillRegistry } from "../skills/registry.mts"
import { createSessionBackend } from "../session/backend.mts"
import { AppStateStore } from "../state/store.mts"
import { TaskManager } from "../tasks/task-manager.mts"
import { createBuiltinTools } from "../tools/builtin.mts"
import type { Logger, OneClawConfig } from "../types.mts"
import { createConsoleLogger } from "../utils.mts"
import { UsageTracker } from "../usage/tracker.mts"
import { WorktreeManager } from "../worktree/manager.mts"
import { Coordinator } from "../coordinator/coordinator.mts"
import { PromptAssembler } from "../prompts/assembler.mts"
import { PermissionPolicy, type ApprovalHandler } from "./permission-policy.mts"
import { QueryEngine } from "./query-engine.mts"
import { QueryLoop } from "./query-loop.mts"
import { SessionEngine } from "./session-engine.mts"
import { ToolDispatcher } from "./tool-dispatcher.mts"

export type OneClawRuntime = {
  config: OneClawConfig
  logger: Logger
  provider: ReturnType<typeof createProvider>
  skills: SkillRegistry
  plugins: PluginRegistry
  mcp: McpRegistry
  memory: MemoryManager
  hooks: HookExecutor
  tasks: TaskManager
  coordinator: Coordinator
  bridge: BridgeSessionManager
  state: AppStateStore
  usage: UsageTracker
  worktrees: WorktreeManager
  commands: CommandRegistry
  sessions: SessionEngine
  dispatcher: ToolDispatcher
  formatOutput: typeof formatOutput
  shutdown(): Promise<void>
}

type CreateRuntimeOptions = {
  cwd?: string
  config?: OneClawConfig
  logger?: Logger
  verbose?: boolean
  approvalHandler?: ApprovalHandler
}

export async function createRuntime(
  options: CreateRuntimeOptions = {},
): Promise<OneClawRuntime> {
  const cwd = options.cwd ?? process.cwd()
  const config = options.config ?? await loadConfig(cwd)
  const logger = options.logger ?? createConsoleLogger(Boolean(options.verbose))

  const skills = new SkillRegistry()
  await skills.load(config.skillDirs)

  const plugins = new PluginRegistry()
  await plugins.load(config.pluginDirs)

  const mcp = new McpRegistry(logger, { config })
  await mcp.connect(config.mcpServers)

  const provider = createProvider(config)
  const tasks = new TaskManager()
  const bridge = new BridgeSessionManager()
  const usage = new UsageTracker(config, logger)
  const memory = new MemoryManager(config)
  const worktrees = new WorktreeManager(config, logger)
  const hookRegistry = new HookRegistry()
  await hookRegistry.load(config.hooks.files)
  hookRegistry.register(plugins.getHookDefinitions())
  const hooks = plugins.getHooks()
  const hookExecutor = new HookExecutor(config, logger, hookRegistry.list())
  const state = new AppStateStore({
    provider: provider.name,
    activeProfile: config.activeProfile,
    model: config.provider.model,
    permissionMode: config.permissions.mode,
    cwd,
    theme: config.output.theme,
    outputStyle: config.output.style,
    keybindings: { ...config.output.keybindings },
    mcpConnected: mcp.listStatuses().filter(status => status.state === "connected").length,
    mcpFailed: mcp.listStatuses().filter(status => status.state === "failed").length,
    activeSessions: 0,
    bridgeSessions: 0,
    taskCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    estimatedCostUsd: 0,
  })
  const stopBridgeSync = bridge.subscribe(sessions => {
    state.patch({
      bridgeSessions: sessions.length,
    })
  })
  const sessionBackend = createSessionBackend(config)
  const permissions = new PermissionPolicy(config.permissions, options.approvalHandler)
  const tools = [
    ...createBuiltinTools(config),
    ...mcp.createManagementTools(),
    ...plugins.getTools(),
    ...(await mcp.toTools()),
  ]
  const dispatcher = new ToolDispatcher(tools, permissions, hooks, hookExecutor, logger)
  const prompts = new PromptAssembler(config, memory, skills, plugins)
  const queryLoop = new QueryLoop(
    config,
    provider,
    dispatcher,
    prompts,
    usage,
    state,
    hookExecutor,
    hooks,
    logger,
  )
  const queryEngine = new QueryEngine(queryLoop, memory, tasks)
  const sessions = new SessionEngine(
    config,
    queryEngine,
    tasks,
    logger,
    sessionBackend,
    hookExecutor,
    state,
  )
  const coordinator = new Coordinator(tasks)
  const commands = createDefaultCommandRegistry()

  return {
    config,
    logger,
    provider,
    skills,
    plugins,
    mcp,
    memory,
    hooks: hookExecutor,
    tasks,
    coordinator,
    bridge,
    state,
    usage,
    worktrees,
    commands,
    sessions,
    dispatcher,
    formatOutput,
    shutdown: async () => {
      await sessions.shutdown()
      stopBridgeSync()
      await mcp.close()
    },
  }
}
