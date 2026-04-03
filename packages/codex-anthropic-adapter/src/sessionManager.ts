import { createHash, randomUUID } from 'crypto'
import { CodexAppServerClient } from './codexAppServerClient.js'
import { getCodexAppServerUrl } from './config.js'
import { getCodexModelProviderId } from '../../../utils/model/providers.js'

type AnthropicTextBlock = {
  type: 'text'
  text: string
}

type AnthropicToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

type AnthropicToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<{ type?: string; text?: string }>
  is_error?: boolean
}

type AnthropicMessageContent =
  | string
  | Array<
      | AnthropicTextBlock
      | AnthropicToolUseBlock
      | AnthropicToolResultBlock
      | {
          type?: string
          text?: string
          [key: string]: unknown
        }
    >

type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: AnthropicMessageContent
}

type AnthropicRequestBody = {
  model?: string
  system?:
    | string
    | Array<{
        type?: string
        text?: string
      }>
  messages?: AnthropicMessage[]
  stream?: boolean
}

type AdapterUsage = {
  inputTokens: number
  outputTokens: number
}

type PendingToolCall = {
  requestId: string
  callId: string
  anthropicToolUseId: string
  tool: string
  arguments: unknown
  threadId: string
  turnId: string
}

type TurnBoundary =
  | {
      kind: 'completed'
      assistantText: string
      usage: AdapterUsage
    }
  | {
      kind: 'tool_use'
      assistantText: string
      usage: AdapterUsage
      toolCall: PendingToolCall
    }

type TurnStreamHandlers = {
  onTextDelta?: (delta: string) => void
  onUsage?: (usage: AdapterUsage) => void
  onToolCall?: (toolCall: PendingToolCall) => void
}

function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeSystemPrompt(
  system: AnthropicRequestBody['system'],
): string | undefined {
  if (!system) {
    return undefined
  }
  if (typeof system === 'string') {
    return system.trim() || undefined
  }
  const parts = system
    .map(block => block.text?.trim())
    .filter((value): value is string => !!value)
  return parts.length > 0 ? parts.join('\n\n') : undefined
}

function extractTextFromContent(content: AnthropicMessageContent): string {
  if (typeof content === 'string') {
    return content
  }
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('\n')
}

function extractLatestUserText(messages: AnthropicMessage[] = []): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user') {
      continue
    }
    const text = extractTextFromContent(message.content).trim()
    if (text) {
      return text
    }
  }
  return ''
}

function findToolResultBlock(
  messages: AnthropicMessage[] = [],
  toolUseId: string,
): AnthropicToolResultBlock | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message?.role !== 'user' || !Array.isArray(message.content)) {
      continue
    }
    for (const block of message.content) {
      if (
        block?.type === 'tool_result' &&
        block.tool_use_id === toolUseId
      ) {
        return block as AnthropicToolResultBlock
      }
    }
  }
  return undefined
}

function toolResultToContentItems(
  block: AnthropicToolResultBlock,
): Array<{ type: 'inputText'; text: string }> {
  if (typeof block.content === 'string') {
    return [{ type: 'inputText', text: block.content }]
  }

  const text = block.content
    .map(item => item?.text?.trim())
    .filter((value): value is string => !!value)
    .join('\n')

  return [{ type: 'inputText', text }]
}

function mapAnthropicModelToCodex(model?: string): string {
  const normalized = (model ?? '').replace(/\[1m\]/gi, '').toLowerCase()
  if (normalized.startsWith('gpt-')) {
    return normalized
  }
  if (normalized.includes('haiku')) {
    return process.env.CLAUDE_CODE_CODEX_HAIKU_MODEL || 'gpt-5.4-mini'
  }
  if (normalized.includes('sonnet')) {
    return process.env.CLAUDE_CODE_CODEX_SONNET_MODEL || 'gpt-5.3-codex'
  }
  if (normalized.includes('opus')) {
    return process.env.CLAUDE_CODE_CODEX_OPUS_MODEL || 'gpt-5.4'
  }
  return process.env.CLAUDE_CODE_CODEX_DEFAULT_MODEL || 'gpt-5.4'
}

function usageFromNotification(params: unknown): AdapterUsage | undefined {
  const notification = params as {
    tokenUsage?: {
      last?: {
        inputTokens?: number
        outputTokens?: number
      }
    }
  }

  const inputTokens = notification?.tokenUsage?.last?.inputTokens
  const outputTokens = notification?.tokenUsage?.last?.outputTokens
  if (
    typeof inputTokens === 'number' &&
    typeof outputTokens === 'number'
  ) {
    return { inputTokens, outputTokens }
  }
  return undefined
}

async function startThread(params: {
  client: CodexAppServerClient
  model: string
  systemPrompt?: string
}): Promise<string> {
  const result = (await params.client.request('thread/start', {
    cwd: process.cwd(),
    approvalPolicy: 'never',
    sandbox: 'danger-full-access',
    model: params.model,
    modelProvider: getCodexModelProviderId(),
    serviceName: 'claude-code-codex-adapter',
    baseInstructions: params.systemPrompt ?? null,
    developerInstructions: params.systemPrompt ?? null,
    experimentalRawEvents: false,
    persistExtendedHistory: true,
  })) as {
    thread: {
      id: string
    }
  }
  return result.thread.id
}

class CodexSession {
  private readonly client = new CodexAppServerClient(getCodexAppServerUrl())
  private threadId: string | null = null
  private systemPromptHash: string | null = null
  private pendingToolCall: PendingToolCall | null = null
  private serial: Promise<unknown> = Promise.resolve()

  async handle(body: AnthropicRequestBody): Promise<{
    stopReason: 'end_turn' | 'tool_use'
    content: Array<AnthropicTextBlock | AnthropicToolUseBlock>
    usage: AdapterUsage
    model: string
  }> {
    return this.runExclusive(async () => {
      await this.client.ensureInitialized()

      if (this.pendingToolCall) {
        return this.resumeFromToolResult(body)
      }

      return this.startUserTurn(body)
    })
  }

  async handleStream(
    body: AnthropicRequestBody,
    handlers: TurnStreamHandlers,
  ): Promise<{
    stopReason: 'end_turn' | 'tool_use'
    content: Array<AnthropicTextBlock | AnthropicToolUseBlock>
    usage: AdapterUsage
    model: string
  }> {
    return this.runExclusive(async () => {
      await this.client.ensureInitialized()

      if (this.pendingToolCall) {
        return this.resumeFromToolResult(body, handlers)
      }

      return this.startUserTurn(body, handlers)
    })
  }

  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.serial.then(fn, fn)
    this.serial = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private async ensureThread(body: AnthropicRequestBody): Promise<string> {
    const systemPrompt = normalizeSystemPrompt(body.system)
    const nextHash = systemPrompt ? hashValue(systemPrompt) : null
    const model = mapAnthropicModelToCodex(body.model)

    if (!this.threadId || this.systemPromptHash !== nextHash) {
      this.threadId = await startThread({
        client: this.client,
        model,
        systemPrompt,
      })
      this.systemPromptHash = nextHash
      this.pendingToolCall = null
    }

    return this.threadId
  }

  private async startUserTurn(
    body: AnthropicRequestBody,
    handlers: TurnStreamHandlers = {},
  ): Promise<{
    stopReason: 'end_turn' | 'tool_use'
    content: Array<AnthropicTextBlock | AnthropicToolUseBlock>
    usage: AdapterUsage
    model: string
  }> {
    const threadId = await this.ensureThread(body)
    const userText = extractLatestUserText(body.messages)
    if (!userText) {
      throw new Error(
        'Codex adapter expected the latest Anthropic user message to contain text.',
      )
    }

    const boundary = await this.consumeTurnBoundary({
      threadId,
      handlers,
      begin: async () =>
        (await this.client.request('turn/start', {
          threadId,
          input: [{ type: 'text', text: userText }],
          model: mapAnthropicModelToCodex(body.model),
          effort: 'medium',
        })) as { turn: { id: string } },
    })

    return {
      stopReason: boundary.kind === 'tool_use' ? 'tool_use' : 'end_turn',
      content:
        boundary.kind === 'tool_use'
          ? [
              ...(boundary.assistantText
                ? [{ type: 'text', text: boundary.assistantText } as const]
                : []),
              {
                type: 'tool_use',
                id: boundary.toolCall.anthropicToolUseId,
                name: boundary.toolCall.tool,
                input: boundary.toolCall.arguments,
              } as const,
            ]
          : [{ type: 'text', text: boundary.assistantText } as const],
      usage: boundary.usage,
      model: body.model || mapAnthropicModelToCodex(body.model),
    }
  }

  private async resumeFromToolResult(
    body: AnthropicRequestBody,
    handlers: TurnStreamHandlers = {},
  ): Promise<{
    stopReason: 'end_turn' | 'tool_use'
    content: Array<AnthropicTextBlock | AnthropicToolUseBlock>
    usage: AdapterUsage
    model: string
  }> {
    const pending = this.pendingToolCall
    if (!pending) {
      throw new Error('No pending Codex tool call to resume.')
    }

    const toolResult = findToolResultBlock(
      body.messages,
      pending.anthropicToolUseId,
    )
    if (!toolResult) {
      throw new Error(
        `Missing tool_result for pending tool_use ${pending.anthropicToolUseId}.`,
      )
    }

    const boundary = await this.consumeTurnBoundary({
      threadId: pending.threadId,
      turnId: pending.turnId,
      handlers,
      begin: async () => {
        await this.client.respond(pending.requestId, {
          success: !toolResult.is_error,
          contentItems: toolResultToContentItems(toolResult),
        })
        return { turn: { id: pending.turnId } }
      },
    })

    this.pendingToolCall = null

    return {
      stopReason: boundary.kind === 'tool_use' ? 'tool_use' : 'end_turn',
      content:
        boundary.kind === 'tool_use'
          ? [
              ...(boundary.assistantText
                ? [{ type: 'text', text: boundary.assistantText } as const]
                : []),
              {
                type: 'tool_use',
                id: boundary.toolCall.anthropicToolUseId,
                name: boundary.toolCall.tool,
                input: boundary.toolCall.arguments,
              } as const,
            ]
          : [{ type: 'text', text: boundary.assistantText } as const],
      usage: boundary.usage,
      model: body.model || mapAnthropicModelToCodex(body.model),
    }
  }

  private async consumeTurnBoundary(params: {
    threadId: string
    turnId?: string
    handlers?: TurnStreamHandlers
    begin: () => Promise<{ turn: { id: string } }>
  }): Promise<TurnBoundary> {
    return await new Promise<TurnBoundary>((resolve, reject) => {
      let turnId = params.turnId ?? ''
      let assistantText = ''
      let usage: AdapterUsage = { inputTokens: 0, outputTokens: 0 }
      let settled = false

      const cleanup = () => {
        unsubscribeNotification()
        unsubscribeRequest()
      }

      const finish = (value: TurnBoundary) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        resolve(value)
      }

      const fail = (error: unknown) => {
        if (settled) {
          return
        }
        settled = true
        cleanup()
        reject(error)
      }

      const unsubscribeNotification = this.client.onNotification(message => {
        const notificationParams = message.params as
          | {
              threadId?: string
              turnId?: string
              turn?: { id?: string }
              delta?: string
            }
          | undefined

        if (
          notificationParams?.threadId &&
          notificationParams.threadId !== params.threadId
        ) {
          return
        }

        if (!turnId && notificationParams?.turnId) {
          turnId = notificationParams.turnId
        }
        if (!turnId && notificationParams?.turn?.id) {
          turnId = notificationParams.turn.id
        }

        if (
          turnId &&
          notificationParams?.turnId &&
          notificationParams.turnId !== turnId
        ) {
          return
        }

        switch (message.method) {
          case 'item/agentMessage/delta':
            {
              const delta = String(notificationParams?.delta ?? '')
              assistantText += delta
              params.handlers?.onTextDelta?.(delta)
            }
            break
          case 'thread/tokenUsage/updated': {
            const nextUsage = usageFromNotification(message.params)
            if (nextUsage) {
              usage = nextUsage
              params.handlers?.onUsage?.(nextUsage)
            }
            break
          }
          case 'turn/completed':
            finish({
              kind: 'completed',
              assistantText: assistantText.trim(),
              usage,
            })
            break
          case 'error': {
            const errorParams = message.params as {
              error?: { message?: string }
            }
            fail(
              new Error(
                errorParams?.error?.message ||
                  'Codex app-server reported an error.',
              ),
            )
            break
          }
        }
      })

      const unsubscribeRequest = this.client.onServerRequest(message => {
        const requestParams = message.params as
          | {
              threadId?: string
              turnId?: string
              callId?: string
              tool?: string
              arguments?: unknown
            }
          | undefined

        if (
          requestParams?.threadId &&
          requestParams.threadId !== params.threadId
        ) {
          return
        }

        if (!turnId && requestParams?.turnId) {
          turnId = requestParams.turnId
        }

        if (turnId && requestParams?.turnId && requestParams.turnId !== turnId) {
          return
        }

        if (message.method === 'item/tool/requestUserInput') {
          void this.client.respond(message.id, { answers: {} })
          return
        }

        if (message.method !== 'item/tool/call') {
          return
        }

        if (!requestParams?.callId || !requestParams.tool || !turnId) {
          fail(new Error('Received malformed Codex dynamic tool call request.'))
          return
        }

        const anthropicToolUseId = `codex_tool_${requestParams.callId}`
        const pendingToolCall: PendingToolCall = {
          requestId: message.id,
          callId: requestParams.callId,
          anthropicToolUseId,
          tool: requestParams.tool,
          arguments: requestParams.arguments,
          threadId: params.threadId,
          turnId,
        }
        this.pendingToolCall = pendingToolCall
        params.handlers?.onToolCall?.(pendingToolCall)
        finish({
          kind: 'tool_use',
          assistantText: assistantText.trim(),
          usage,
          toolCall: pendingToolCall,
        })
      })

      void params
        .begin()
        .then(result => {
          if (!turnId) {
            turnId = result.turn.id
          }
        })
        .catch(fail)
    })
  }
}

const sessions = new Map<string, CodexSession>()

function getOrCreateSession(sessionKey: string): CodexSession {
  const existing = sessions.get(sessionKey)
  if (existing) {
    return existing
  }
  const session = new CodexSession()
  sessions.set(sessionKey, session)
  return session
}

export function getAdapterSession(sessionKey: string): {
  handle: CodexSession['handle']
  handleStream: CodexSession['handleStream']
} {
  const session = getOrCreateSession(sessionKey)
  return {
    handle: session.handle.bind(session),
    handleStream: session.handleStream.bind(session),
  }
}
