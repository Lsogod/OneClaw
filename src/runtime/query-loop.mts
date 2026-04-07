import { FileMemoryStore } from "../memory/store.mts"
import { HookExecutor } from "../hooks/executor.mts"
import { PromptAssembler } from "../prompts/assembler.mts"
import { AppStateStore } from "../state/store.mts"
import type {
  Logger,
  OneClawConfig,
  ProviderAdapter,
  RuntimeHook,
  SessionRecord,
  SessionRunResult,
  ToolExecution,
} from "../types.mts"
import { UsageTracker } from "../usage/tracker.mts"
import { summarizeCompaction, toPlainText } from "../utils.mts"
import { TaskManager } from "../tasks/task-manager.mts"
import { ToolDispatcher } from "./tool-dispatcher.mts"

type QueryLoopOptions = {
  skillNames?: string[]
  emit?: (event: {
    type: string
    [key: string]: unknown
  }) => void
}

export class QueryLoop {
  constructor(
    private readonly config: OneClawConfig,
    private readonly provider: ProviderAdapter,
    private readonly dispatcher: ToolDispatcher,
    private readonly prompts: PromptAssembler,
    private readonly usage: UsageTracker,
    private readonly state: AppStateStore,
    private readonly hookExecutor: HookExecutor,
    private readonly hooks: RuntimeHook[],
    private readonly logger: Logger,
  ) {}

  private async compactIfNeeded(
    session: SessionRecord,
    memory: FileMemoryStore,
  ): Promise<void> {
    const totalChars = session.messages.reduce(
      (sum, message) => sum + toPlainText(message.content).length,
      0,
    )
    if (totalChars <= this.config.context.maxChars) {
      return
    }

    const kept = session.messages.slice(-this.config.context.keepMessages)
    const compacted = session.messages.slice(0, -this.config.context.keepMessages)
    if (compacted.length === 0) {
      return
    }

    await memory.append(
      `## Compaction ${new Date().toISOString()}\n${summarizeCompaction(compacted)}\n`,
    )
    session.messages = kept
  }

  async run(
    session: SessionRecord,
    prompt: string,
    memory: FileMemoryStore,
    tasks: TaskManager,
    options: QueryLoopOptions = {},
  ): Promise<SessionRunResult> {
    options.emit?.({
      type: "user_prompt",
      sessionId: session.id,
      prompt,
    })
    session.messages.push({
      role: "user",
      content: [{ type: "text", text: prompt }],
      createdAt: new Date().toISOString(),
    })

    let iterations = 0
    let finalText = ""
    let finalStopReason: SessionRunResult["stopReason"] = "end_turn"
    let finalUsage: SessionRunResult["usage"] = undefined

    while (iterations < 10) {
      iterations += 1
      options.emit?.({
        type: "iteration_started",
        sessionId: session.id,
        iteration: iterations,
      })
      await this.compactIfNeeded(session, memory)
      const systemPrompt = await this.prompts.build(session, prompt, options)

      await this.usage.assertBudget()
      await this.hookExecutor.execute("before_model", {
        event: "before_model",
        sessionId: session.id,
        prompt,
        iteration: iterations,
      }, session.cwd)
      for (const hook of this.hooks) {
        await hook.beforeModelCall?.({
          sessionId: session.id,
          messages: session.messages,
          prompt,
        })
      }
      options.emit?.({
        type: "model_request",
        sessionId: session.id,
        iteration: iterations,
      })

      const response = await this.provider.generateTurn({
        systemPrompt,
        messages: session.messages,
        tools: this.dispatcher.listToolSpecs(),
        model: this.config.provider.model,
        maxTokens: this.config.provider.maxTokens,
      })

      this.usage.addUsage(this.config.provider.model, response.usage)
      const usage = this.usage.summary()
      this.state.patch({
        totalInputTokens: usage.inputTokens,
        totalOutputTokens: usage.outputTokens,
        estimatedCostUsd: usage.estimatedCostUsd,
      })

      for (const hook of this.hooks) {
        await hook.afterModelCall?.({
          sessionId: session.id,
          output: response,
        })
      }
      await this.hookExecutor.execute("after_model", {
        event: "after_model",
        sessionId: session.id,
        stopReason: response.stopReason,
      }, session.cwd)

      finalStopReason = response.stopReason
      finalUsage = response.usage
      finalText = response.content
        .filter(block => block.type === "text")
        .map(block => block.text)
        .join("\n")
      options.emit?.({
        type: "model_response",
        sessionId: session.id,
        stopReason: response.stopReason,
        text: finalText,
      })

      session.messages.push({
        role: "assistant",
        content: response.content,
        createdAt: new Date().toISOString(),
      })

      const toolCalls = response.content.filter(
        block => block.type === "tool_call",
      )
      if (toolCalls.length === 0) {
        return {
          sessionId: session.id,
          text: finalText,
          iterations,
          stopReason: finalStopReason,
          usage: finalUsage,
        }
      }

      const toolResults: ToolExecution[] = []
      for (const toolCall of toolCalls) {
        options.emit?.({
          type: "tool_started",
          sessionId: session.id,
          toolName: toolCall.name,
        })
        toolResults.push(await this.dispatcher.execute(toolCall, {
          cwd: session.cwd,
          config: this.config,
          sessionId: session.id,
          logger: this.logger,
          memory,
          tasks,
        }))
        options.emit?.({
          type: "tool_finished",
          sessionId: session.id,
          toolName: toolCall.name,
          ok: toolResults.at(-1)?.ok ?? false,
        })
      }

      session.messages.push({
        role: "user",
        content: toolCalls.map((toolCall, index) => ({
          type: "tool_result" as const,
          toolCallId: toolCall.id,
          name: toolCall.name,
          result: toolResults[index].output,
          isError: !toolResults[index].ok,
        })),
        createdAt: new Date().toISOString(),
      })
    }

    throw new Error("Query loop exceeded the maximum number of iterations.")
  }
}
