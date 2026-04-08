import type {
  Logger,
  RuntimeHook,
  ToolCallBlock,
  ToolExecution,
  ToolExecutionContext,
  ToolImplementation,
  ToolSpec,
} from "../types.mts"
import { HookExecutor } from "../hooks/executor.mts"
import { PermissionPolicy } from "./permission-policy.mts"

export class ToolDispatcher {
  private readonly tools = new Map<string, ToolImplementation>()

  constructor(
    tools: ToolImplementation[],
    private readonly permissions: PermissionPolicy,
    private readonly hooks: RuntimeHook[],
    private readonly hookExecutor: HookExecutor,
    private readonly logger: Logger,
  ) {
    for (const tool of tools) {
      this.tools.set(tool.spec.name, tool)
    }
  }

  listToolSpecs(): ToolSpec[] {
    return [...this.tools.values()].map(tool => tool.spec)
  }

  async execute(toolCall: ToolCallBlock, context: ToolExecutionContext): Promise<ToolExecution> {
    const tool = this.tools.get(toolCall.name)
    if (!tool) {
      return {
        ok: false,
        output: `Unknown tool: ${toolCall.name}`,
      }
    }

    const decision = await this.permissions.decide(tool.spec, toolCall.input, context.cwd)
    if (!decision.allowed) {
      return {
        ok: false,
        output: `Permission denied for ${tool.spec.name}: ${decision.reason}`,
      }
    }

    for (const hook of this.hooks) {
      await hook.beforeTool?.({
        sessionId: context.sessionId,
        toolCall,
      })
    }
    await this.hookExecutor.execute("before_tool", {
      event: "before_tool",
      sessionId: context.sessionId,
      toolName: tool.spec.name,
      input: toolCall.input,
    }, context.cwd)

    this.logger.debug?.(`[tool] ${tool.spec.name}`)
    const result = await tool.execute(toolCall.input, context)

    for (const hook of this.hooks) {
      try {
        await hook.afterTool?.({
          sessionId: context.sessionId,
          toolCall,
          result,
        })
      } catch (error) {
        this.logger.debug?.(`[hook] afterTool error: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    try {
      await this.hookExecutor.execute("after_tool", {
        event: "after_tool",
        sessionId: context.sessionId,
        toolName: tool.spec.name,
        ok: result.ok,
        output: result.output,
      }, context.cwd)
    } catch (error) {
      this.logger.debug?.(`[hook] after_tool executor error: ${error instanceof Error ? error.message : String(error)}`)
    }

    return result
  }
}
