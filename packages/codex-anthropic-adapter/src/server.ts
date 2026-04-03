import { randomUUID } from 'crypto'
import { getCodexLoginStatus } from '../../../services/codex/auth.js'
import {
  getCodexModelProviderId,
  getCodexOpenAIBaseUrl,
} from '../../../utils/model/providers.js'
import { getAdapterApiKey, getAdapterBaseUrl, getAdapterHost, getAdapterPort, getCodexAppServerUrl } from './config.js'
import { CodexAppServerClient } from './codexAppServerClient.js'
import { getAdapterSession } from './sessionManager.js'

type AnthropicError = {
  type: string
  error: {
    type: string
    message: string
  }
}

type AdapterResult = {
  stopReason: 'end_turn' | 'tool_use'
  content: Array<
    | {
        type: 'text'
        text: string
      }
    | {
        type: 'tool_use'
        id: string
        name: string
        input: unknown
      }
  >
  usage: {
    inputTokens: number
    outputTokens: number
  }
  model: string
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  })
}

function errorResponse(
  message: string,
  status = 500,
  type = 'api_error',
): Response {
  const body: AnthropicError = {
    type: 'error',
    error: {
      type,
      message,
    },
  }
  return json(body, status)
}

function buildAnthropicUsage(result: AdapterResult): Record<string, unknown> {
  return buildAnthropicUsageFromUsage(result.usage)
}

function buildAnthropicUsageFromUsage(usage: {
  inputTokens: number
  outputTokens: number
}): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: usage.outputTokens,
    server_tool_use: {
      web_search_requests: 0,
      web_fetch_requests: 0,
    },
    service_tier: 'standard',
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    inference_geo: '',
    iterations: [],
    speed: 'standard',
  }
}

function encodeSSEEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

function encodeSSEComment(comment: string): string {
  return `: ${comment}\n\n`
}

function buildStreamEventSequence(
  messageId: string,
  result: AdapterResult,
): string {
  const usage = buildAnthropicUsage(result)
  const chunks: string[] = []

  chunks.push(
    encodeSSEEvent('message_start', {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model: result.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          ...usage,
          output_tokens: 0,
        },
        container: null,
        context_management: null,
      },
    }),
  )

  const contentBlocks = result.content.length > 0
    ? result.content
    : [{ type: 'text' as const, text: '' }]

  contentBlocks.forEach((block, index) => {
    if (block.type === 'text') {
      chunks.push(
        encodeSSEEvent('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'text',
            text: '',
            citations: null,
          },
        }),
      )

      chunks.push(
        encodeSSEEvent('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: {
            type: 'text_delta',
            text: block.text,
          },
        }),
      )
    } else {
      chunks.push(
        encodeSSEEvent('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: {},
          },
        }),
      )

      chunks.push(
        encodeSSEEvent('content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: {
            type: 'input_json_delta',
            partial_json: JSON.stringify(block.input ?? {}),
          },
        }),
      )
    }

    chunks.push(
      encodeSSEEvent('content_block_stop', {
        type: 'content_block_stop',
        index,
      }),
    )
  })

  chunks.push(
    encodeSSEEvent('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: result.stopReason,
        stop_sequence: null,
        container: null,
      },
      usage,
      context_management: null,
    }),
  )

  chunks.push(
    encodeSSEEvent('message_stop', {
      type: 'message_stop',
    }),
  )

  return chunks.join('')
}

function streamResponse(req: Request, sessionKey: string): Response {
  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const messageId = `msg_${randomUUID()}`
      const session = getAdapterSession(sessionKey)
      const body = (await req.json()) as {
        model?: string
      }
      const model = body.model || 'gpt-5.4'
      let closed = false
      let usage = {
        inputTokens: 0,
        outputTokens: 0,
      }
      let textBlockIndex: number | null = null
      let nextContentIndex = 0
      let toolBlockSent = false
      const heartbeat = setInterval(() => {
        safeWriteRaw(encodeSSEComment('keep-alive'))
      }, 5_000)

      const safeWriteRaw = (chunk: string) => {
        if (closed) {
          return false
        }
        try {
          controller.enqueue(encoder.encode(chunk))
          return true
        } catch {
          closed = true
          return false
        }
      }

      const write = (event: string, data: unknown) => {
        return safeWriteRaw(encodeSSEEvent(event, data))
      }

      const safeClose = () => {
        if (closed) {
          return
        }
        closed = true
        try {
          controller.close()
        } catch {}
      }

      const ensureTextBlockStarted = () => {
        if (textBlockIndex !== null) {
          return
        }
        textBlockIndex = nextContentIndex++
        write('content_block_start', {
          type: 'content_block_start',
          index: textBlockIndex,
          content_block: {
            type: 'text',
            text: '',
            citations: null,
          },
        })
      }

      const stopTextBlock = () => {
        if (textBlockIndex === null) {
          return
        }
        write('content_block_stop', {
          type: 'content_block_stop',
          index: textBlockIndex,
        })
        textBlockIndex = null
      }

      write('message_start', {
        type: 'message_start',
        message: {
          id: messageId,
          type: 'message',
          role: 'assistant',
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            ...buildAnthropicUsageFromUsage(usage),
            output_tokens: 0,
          },
          container: null,
          context_management: null,
        },
      })

      try {
        const result = await session.handleStream(body, {
          onTextDelta(delta) {
            if (!delta) {
              return
            }
            ensureTextBlockStarted()
            write('content_block_delta', {
              type: 'content_block_delta',
              index: textBlockIndex,
              delta: {
                type: 'text_delta',
                text: delta,
              },
            })
          },
          onUsage(nextUsage) {
            usage = nextUsage
          },
          onToolCall(toolCall) {
            toolBlockSent = true
            stopTextBlock()
            const index = nextContentIndex++
            write('content_block_start', {
              type: 'content_block_start',
              index,
              content_block: {
                type: 'tool_use',
                id: toolCall.anthropicToolUseId,
                name: toolCall.tool,
                input: {},
              },
            })
            write('content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: {
                type: 'input_json_delta',
                partial_json: JSON.stringify(toolCall.arguments ?? {}),
              },
            })
            write('content_block_stop', {
              type: 'content_block_stop',
              index,
            })
          },
        })

        usage = result.usage

        if (!toolBlockSent && textBlockIndex === null) {
          ensureTextBlockStarted()
        }
        stopTextBlock()

        write('message_delta', {
          type: 'message_delta',
          delta: {
            stop_reason: result.stopReason,
            stop_sequence: null,
            container: null,
          },
          usage: buildAnthropicUsageFromUsage(usage),
          context_management: null,
        })
        write('message_stop', {
          type: 'message_stop',
        })
      } catch (error) {
        write('error', {
          type: 'error',
          error: {
            type: 'api_error',
            message: error instanceof Error ? error.message : String(error),
          },
        })
      } finally {
        clearInterval(heartbeat)
        safeClose()
      }
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}

async function handleHealth(): Promise<Response> {
  const auth = await getCodexLoginStatus()
  const client = new CodexAppServerClient(getCodexAppServerUrl())
  const appServer = await client.probe()

  return json({
    ok: appServer.ok,
    adapterBaseUrl: getAdapterBaseUrl(),
    adapterApiKey: getAdapterApiKey(),
    codexAppServerUrl: getCodexAppServerUrl(),
    codexModelProvider: getCodexModelProviderId(),
    codexOpenAIBaseUrl: getCodexOpenAIBaseUrl(),
    codexAuth: {
      loggedIn: auth.loggedIn,
      authMode: auth.authMode,
      email: auth.email,
      plan: auth.plan,
      planSource: auth.planSource,
      subscriptionLastChecked: auth.subscriptionLastChecked,
      organizationTitle: auth.organizationTitle,
      lastRefresh: auth.lastRefresh,
      usageFetchedAt: auth.usageFetchedAt,
    },
    appServer,
  })
}

async function handleMessages(req: Request): Promise<Response> {
  const headerKey = req.headers.get('x-api-key')
  if (headerKey && headerKey !== getAdapterApiKey()) {
    return errorResponse('Invalid adapter API key', 401, 'authentication_error')
  }

  const body = (await req.clone().json()) as {
    model?: string
    stream?: boolean
  }

  const sessionKey =
    req.headers.get('x-claude-code-session-id') ||
    req.headers.get('x-claude-remote-session-id') ||
    req.headers.get('x-client-request-id') ||
    'anonymous'

  try {
    const session = getAdapterSession(sessionKey)

    if (body.stream) {
      return streamResponse(req, sessionKey)
    }

    const result = await session.handle(body)
    const messageId = `msg_${randomUUID()}`

    return json({
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: result.model,
      content: result.content,
      stop_reason: result.stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: result.usage.inputTokens,
        output_tokens: result.usage.outputTokens,
      },
    })
  } catch (error) {
    return errorResponse(
      error instanceof Error ? error.message : String(error),
      500,
      'api_error',
    )
  }
}

const server = Bun.serve({
  hostname: getAdapterHost(),
  port: getAdapterPort(),
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url)

    if (url.pathname === '/health') {
      return handleHealth()
    }

    if (url.pathname === '/v1/messages' && req.method === 'POST') {
      return handleMessages(req)
    }

    return json(
      {
        ok: true,
        name: 'codex-anthropic-adapter',
        health: `${getAdapterBaseUrl()}/health`,
      },
      200,
    )
  },
})

// biome-ignore lint/suspicious/noConsole: adapter bootstrap log
console.log(
  `[codex-adapter] listening on http://${server.hostname}:${server.port} -> ${getCodexAppServerUrl()}`,
)
