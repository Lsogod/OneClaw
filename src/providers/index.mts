import Anthropic from "@anthropic-ai/sdk"
import type {
  ContentBlock,
  Message,
  OneClawConfig,
  ProviderAdapter,
  ProviderTurnInput,
  ProviderTurnOutput,
  ToolSpec,
  ToolCallBlock,
} from "../types.mts"
import {
  buildCodexHeaders,
  getClaudeAttributionHeader,
  getClaudeCodeSessionId,
  getClaudeOAuthBetas,
  getClaudeOAuthHeaders,
  getCopilotApiBase,
  loadClaudeCredential,
  loadCodexCredential,
  loadCopilotAuth,
} from "./auth.mts"
import { getProviderDescriptor } from "./registry.mts"
import { limitText } from "../utils.mts"

function anthropicToolSchema(tool: ToolSpec): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }
}

function convertToAnthropicMessages(messages: Message[]): Array<Record<string, unknown>> {
  return messages.map(message => {
    const content = message.content.map(block => {
      if (block.type === "text") {
        return { type: "text", text: block.text }
      }
      if (block.type === "tool_call") {
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input ?? {},
        }
      }
      return {
        type: "tool_result",
        tool_use_id: block.toolCallId,
        content: block.result,
        is_error: Boolean(block.isError),
      }
    })
    return {
      role: message.role,
      content,
    }
  })
}

function parseAnthropicContent(content: unknown[]): Array<ProviderTurnOutput["content"][number]> {
  const blocks: Array<ProviderTurnOutput["content"][number]> = []
  for (const item of content) {
    const block = item as Record<string, unknown>
    if (block.type === "text") {
      blocks.push({
        type: "text",
        text: String(block.text ?? ""),
      })
      continue
    }
    if (block.type === "tool_use") {
      blocks.push({
        type: "tool_call",
        id: String(block.id ?? ""),
        name: String(block.name ?? ""),
        input: block.input ?? {},
      })
    }
  }
  return blocks
}

function makeHeaders(
  apiKey?: string,
  extraHeaders?: Record<string, string>,
): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(apiKey ? { "x-api-key": apiKey } : {}),
    ...(extraHeaders ?? {}),
  }
}

function toOpenAIMessage(message: Message): Record<string, unknown>[] {
  if (message.role === "user") {
    const outgoing: Record<string, unknown>[] = []
    const userText = message.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("\n")
    if (userText) {
      outgoing.push({ role: "user", content: userText })
    }
    for (const block of message.content) {
      if (block.type !== "tool_result") continue
      outgoing.push({
        role: "tool",
        tool_call_id: block.toolCallId,
        content: block.result,
      })
    }
    return outgoing
  }

  const assistantText = message.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n")
  const toolCalls = message.content
    .filter(block => block.type === "tool_call")
    .map(block => ({
      id: block.id,
      type: "function",
      function: {
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      },
    }))

  return [{
    role: "assistant",
    content: assistantText || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }]
}

function convertMessagesToOpenAI(messages: Message[], systemPrompt: string): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []
  if (systemPrompt) {
    result.push({ role: "system", content: systemPrompt })
  }
  for (const message of messages) {
    result.push(...toOpenAIMessage(message))
  }
  return result
}

function parseOpenAIResponse(body: {
  choices?: Array<{
    message?: {
      content?: string | null
      tool_calls?: Array<{
        id: string
        type: "function"
        function: {
          name: string
          arguments: string
        }
      }>
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}): ProviderTurnOutput {
  const message = body.choices?.[0]?.message
  const content: Array<ProviderTurnOutput["content"][number]> = []
  if (message?.content) {
    content.push({
      type: "text",
      text: message.content,
    })
  }

  for (const toolCall of message?.tool_calls ?? []) {
    content.push({
      type: "tool_call",
      id: toolCall.id,
      name: toolCall.function.name,
      input: parseToolArguments(toolCall.function.arguments),
    })
  }

  return {
    content,
    stopReason: content.some(block => block.type === "tool_call") ? "tool_use" : "end_turn",
    usage: {
      inputTokens: body.usage?.prompt_tokens,
      outputTokens: body.usage?.completion_tokens,
    },
    raw: body,
  }
}

function parseToolArguments(rawArguments?: string): unknown {
  if (!rawArguments?.trim()) {
    return {}
  }
  try {
    return JSON.parse(rawArguments)
  } catch {
    return {}
  }
}

function convertMessagesToCodex(messages: Message[]): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = []
  for (const message of messages) {
    if (message.role === "user") {
      const text = message.content
        .filter(block => block.type === "text")
        .map(block => block.text)
        .join("\n")
      if (text.trim()) {
        result.push({
          role: "user",
          content: [{ type: "input_text", text }],
        })
      }
      for (const block of message.content) {
        if (block.type !== "tool_result") continue
        result.push({
          type: "function_call_output",
          call_id: block.toolCallId,
          output: block.result,
        })
      }
      continue
    }

    const assistantText = message.content
      .filter(block => block.type === "text")
      .map(block => block.text)
      .join("\n")
    if (assistantText) {
      result.push({
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: assistantText, annotations: [] }],
      })
    }
    for (const block of message.content) {
      if (block.type !== "tool_call") continue
      result.push({
        type: "function_call",
        id: `fc_${block.id.slice(0, 58)}`,
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input ?? {}),
      })
    }
  }
  return result
}

function convertToolsToCodex(tools: ToolSpec[]): Record<string, unknown>[] {
  return tools.map(tool => ({
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }))
}

function parseSseEvents(raw: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = []
  let dataLines: string[] = []

  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      if (dataLines.length > 0) {
        const payload = dataLines.join("\n").trim()
        dataLines = []
        if (payload && payload !== "[DONE]") {
          try {
            events.push(JSON.parse(payload) as Record<string, unknown>)
          } catch {}
        }
      }
      continue
    }

    if (line.startsWith(":")) {
      continue
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart())
    }
  }

  if (dataLines.length > 0) {
    const payload = dataLines.join("\n").trim()
    if (payload && payload !== "[DONE]") {
      try {
        events.push(JSON.parse(payload) as Record<string, unknown>)
      } catch {}
    }
  }

  return events
}

function parseCodexStopReason(
  completedResponse: Record<string, unknown> | null,
  hasToolCalls: boolean,
): ProviderTurnOutput["stopReason"] {
  const status = completedResponse?.status
  if (hasToolCalls && status === "completed") {
    return "tool_use"
  }
  if (status === "incomplete") {
    return "max_tokens"
  }
  return "end_turn"
}

class AnthropicCompatibleProvider implements ProviderAdapter {
  readonly name = "anthropic-compatible"

  constructor(
    private readonly config: OneClawConfig,
  ) {}

  async generateTurn(input: ProviderTurnInput): Promise<ProviderTurnOutput> {
    const apiKey = this.config.provider.apiKey
      ?? process.env.ONECLAW_API_KEY
      ?? process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      throw new Error("Anthropic-compatible provider requires ONECLAW_API_KEY or ANTHROPIC_API_KEY.")
    }

    const client = new Anthropic({
      apiKey,
      baseURL: this.config.provider.baseUrl || getProviderDescriptor("anthropic-compatible").defaultBaseUrl,
      maxRetries: 2,
    })

    const message = await client.messages.create({
      model: input.model,
      max_tokens: input.maxTokens,
      system: input.systemPrompt,
      messages: convertToAnthropicMessages(input.messages) as never,
      tools: input.tools.map(anthropicToolSchema) as never,
    })

    return {
      content: parseAnthropicContent(message.content as unknown[]),
      stopReason: (message.stop_reason as ProviderTurnOutput["stopReason"]) ?? "end_turn",
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
      raw: message,
    }
  }
}

class ClaudeSubscriptionProvider implements ProviderAdapter {
  readonly name = "claude-subscription"

  constructor(private readonly config: OneClawConfig) {}

  async generateTurn(input: ProviderTurnInput): Promise<ProviderTurnOutput> {
    const credential = await loadClaudeCredential(true)
    const headers = await getClaudeOAuthHeaders()
    const attribution = await getClaudeAttributionHeader()
    const client = new Anthropic({
      authToken: credential.accessToken,
      baseURL: this.config.provider.baseUrl || getProviderDescriptor("claude-subscription").defaultBaseUrl,
      defaultHeaders: headers,
      maxRetries: 2,
    })

    const message = await client.beta.messages.create({
      model: input.model,
      max_tokens: input.maxTokens,
      system: input.systemPrompt
        ? `${attribution}\n${input.systemPrompt}`
        : attribution,
      messages: convertToAnthropicMessages(input.messages) as never,
      tools: input.tools.map(anthropicToolSchema) as never,
      betas: getClaudeOAuthBetas() as never,
      metadata: {
        user_id: JSON.stringify({
          device_id: "oneclaw",
          session_id: getClaudeCodeSessionId(),
          account_uuid: "",
        }),
      } as never,
    })

    return {
      content: parseAnthropicContent(message.content as unknown[]),
      stopReason: (message.stop_reason as ProviderTurnOutput["stopReason"]) ?? "end_turn",
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
      },
      raw: message,
    }
  }
}

class OpenAICompatibleProvider implements ProviderAdapter {
  readonly name = "openai-compatible"

  constructor(
    private readonly config: OneClawConfig,
    private readonly extraHeaders?: Record<string, string>,
    private readonly endpointPath = "/chat/completions",
  ) {}

  async generateTurn(input: ProviderTurnInput): Promise<ProviderTurnOutput> {
    const apiKey = this.config.provider.apiKey
      ?? process.env.ONECLAW_API_KEY
      ?? process.env.OPENAI_API_KEY
    if (!apiKey) {
      throw new Error("OpenAI-compatible provider requires ONECLAW_API_KEY or OPENAI_API_KEY.")
    }
    const baseUrl = (this.config.provider.baseUrl || getProviderDescriptor("openai-compatible").defaultBaseUrl)!
      .replace(/\/$/, "")
    const endpoint = baseUrl.endsWith("/v1")
      ? `${baseUrl}${this.endpointPath.startsWith("/") ? this.endpointPath.replace(/^\/v1/, "") : this.endpointPath}`
      : `${baseUrl}${this.endpointPath.startsWith("/") ? "" : "/"}${this.endpointPath}`

    const response = await fetch(endpoint, {
      method: "POST",
      headers: makeHeaders(apiKey, this.extraHeaders),
      body: JSON.stringify({
        model: input.model,
        messages: convertMessagesToOpenAI(input.messages, input.systemPrompt),
        tools: input.tools.map(tool => ({
          type: "function",
          function: {
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          },
        })),
        tool_choice: "auto",
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Provider request failed (${response.status}): ${limitText(errorText, 1000)}`)
    }

    const body = await response.json() as {
      choices?: Array<{
        message?: {
          content?: string | null
          tool_calls?: Array<{
            id: string
            type: "function"
            function: {
              name: string
              arguments: string
            }
          }>
        }
      }>
      usage?: {
        prompt_tokens?: number
        completion_tokens?: number
      }
    }
    return parseOpenAIResponse(body)
  }
}

class CodexSubscriptionProvider implements ProviderAdapter {
  readonly name = "codex-subscription"

  constructor(private readonly config: OneClawConfig) {}

  async generateTurn(input: ProviderTurnInput): Promise<ProviderTurnOutput> {
    const credential = await loadCodexCredential()
    const baseUrl = (this.config.provider.baseUrl || getProviderDescriptor("codex-subscription").defaultBaseUrl)!
      .replace(/\/$/, "")
    const endpoint = baseUrl.endsWith("/codex/responses")
      ? baseUrl
      : baseUrl.endsWith("/codex")
        ? `${baseUrl}/responses`
        : `${baseUrl}/codex/responses`

    const response = await fetch(endpoint, {
      method: "POST",
      headers: await buildCodexHeaders(credential.accessToken),
      body: JSON.stringify({
        model: input.model,
        store: false,
        stream: true,
        instructions: input.systemPrompt || "You are OneClaw.",
        input: convertMessagesToCodex(input.messages),
        text: { verbosity: "medium" },
        include: ["reasoning.encrypted_content"],
        tool_choice: "auto",
        parallel_tool_calls: true,
        ...(input.tools.length > 0 ? { tools: convertToolsToCodex(input.tools) } : {}),
      }),
    })

    if (!response.ok) {
      throw new Error(`Codex request failed (${response.status}): ${await response.text()}`)
    }

    const rawStream = await response.text()
    const events = parseSseEvents(rawStream)
    const content: Array<ProviderTurnOutput["content"][number]> = []
    let streamedText = ""
    let completedResponse: Record<string, unknown> | null = null

    for (const event of events) {
      if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
        streamedText += event.delta
        continue
      }
      if (event.type === "response.output_item.done") {
        const item = event.item as Record<string, unknown> | undefined
        if (!item) {
          continue
        }
        if (item.type === "message") {
          const rawContent = Array.isArray(item.content) ? item.content : []
          const text = rawContent
            .filter(block => (block as Record<string, unknown>).type === "output_text")
            .map(block => String((block as Record<string, unknown>).text ?? ""))
            .join("")
          if (text) {
            content.push({ type: "text", text })
          }
          continue
        }
        if (item.type === "function_call") {
          let parsedArguments: unknown = {}
          if (typeof item.arguments === "string" && item.arguments) {
            try {
              parsedArguments = JSON.parse(item.arguments)
            } catch {
              parsedArguments = {}
            }
          }
          content.push({
            type: "tool_call",
            id: String(item.call_id ?? item.id ?? ""),
            name: String(item.name ?? ""),
            input: parsedArguments,
          })
        }
        continue
      }
      if (event.type === "response.completed" && event.response && typeof event.response === "object") {
        completedResponse = event.response as Record<string, unknown>
        continue
      }
      if (event.type === "response.failed") {
        throw new Error(`Codex response failed: ${JSON.stringify(event)}`)
      }
      if (event.type === "error") {
        throw new Error(`Codex error: ${JSON.stringify(event)}`)
      }
    }

    if (streamedText && !content.some(block => block.type === "text")) {
      content.unshift({
        type: "text",
        text: streamedText,
      })
    }

    const body = (completedResponse ?? {}) as {
      usage?: {
        input_tokens?: number
        output_tokens?: number
      }
    }

    return {
      content,
      stopReason: parseCodexStopReason(completedResponse, content.some(block => block.type === "tool_call")),
      usage: {
        inputTokens: body.usage?.input_tokens,
        outputTokens: body.usage?.output_tokens,
      },
      raw: body,
    }
  }
}

class GitHubCopilotProvider implements ProviderAdapter {
  readonly name = "github-copilot"

  constructor(private readonly config: OneClawConfig) {}

  async generateTurn(input: ProviderTurnInput): Promise<ProviderTurnOutput> {
    const auth = await loadCopilotAuth()
    if (!auth) {
      throw new Error("No GitHub Copilot token found. Run `oneclaw auth copilot-login` first.")
    }
    const provider = new OpenAICompatibleProvider(
      {
        ...this.config,
        provider: {
          ...this.config.provider,
          apiKey: auth.githubToken,
          baseUrl: this.config.provider.baseUrl || getCopilotApiBase(auth.enterpriseUrl),
        },
      },
      {
        "user-agent": "oneclaw/0.1.0",
        "openai-intent": "conversation-edits",
      },
      "/chat/completions",
    )
    return provider.generateTurn(input)
  }
}

class InternalTestProvider implements ProviderAdapter {
  readonly name = "internal-test"

  async generateTurn(input: ProviderTurnInput): Promise<ProviderTurnOutput> {
    const lastMessage = input.messages.at(-1)
    const toolResults = lastMessage?.content.filter(
      block => block.type === "tool_result",
    ) ?? []

    if (toolResults.length > 0) {
      return {
        content: [{
          type: "text",
          text: `Tool results received:\n${toolResults.map(block => `- ${block.name}: ${block.result}`).join("\n")}`,
        }],
        stopReason: "end_turn",
      }
    }

    const prompt = extractLastUserText(input.messages).toLowerCase()
    const tool = (name: string, payload: unknown): ToolCallBlock => ({
      type: "tool_call",
      id: `internal_${name}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      input: payload,
    })

    if (prompt.includes("list files")) {
      return {
        content: [tool("list_files", { path: ".", depth: 2 })],
        stopReason: "tool_use",
      }
    }
    if (prompt.includes("read file")) {
      const [, path = "README.md"] = prompt.match(/read file\s+(.+)$/) ?? []
      return {
        content: [tool("read_file", { path: path.trim() })],
        stopReason: "tool_use",
      }
    }
    if (prompt.includes("search")) {
      const [, pattern = "TODO"] = prompt.match(/search(?: for)?\s+(.+)$/) ?? []
      return {
        content: [tool("search_files", { pattern: pattern.trim(), path: "." })],
        stopReason: "tool_use",
      }
    }
    if (prompt.includes("run shell")) {
      const [, command = "pwd"] = prompt.match(/run shell\s+(.+)$/) ?? []
      return {
        content: [tool("run_shell", { command: command.trim() })],
        stopReason: "tool_use",
      }
    }

    return {
      content: [{
        type: "text",
        text: `Internal test provider response for: ${extractLastUserText(input.messages)}`,
      }],
      stopReason: "end_turn",
    }
  }
}

function extractLastUserText(messages: Message[]): string {
  const lastUser = [...messages].reverse().find(message => message.role === "user")
  if (!lastUser) {
    return ""
  }
  return lastUser.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("\n")
}

export function createProvider(config: OneClawConfig): ProviderAdapter {
  switch (config.provider.kind) {
    case "anthropic-compatible":
      return new AnthropicCompatibleProvider(config)
    case "claude-subscription":
      return new ClaudeSubscriptionProvider(config)
    case "openai-compatible":
      return new OpenAICompatibleProvider(config)
    case "codex-subscription":
      return new CodexSubscriptionProvider(config)
    case "github-copilot":
      return new GitHubCopilotProvider(config)
    case "internal-test":
      return new InternalTestProvider()
    default:
      throw new Error(`Unsupported provider kind: ${String(config.provider.kind)}`)
  }
}
