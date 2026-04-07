import { MemoryManager } from "../memory/manager.mts"
import { TaskManager } from "../tasks/task-manager.mts"
import type { SessionRecord, SessionRunResult } from "../types.mts"
import { QueryLoop } from "./query-loop.mts"

export type QueryEvent =
  | { type: "user_prompt"; sessionId: string; prompt: string }
  | { type: "iteration_started"; sessionId: string; iteration: number }
  | { type: "model_request"; sessionId: string; iteration: number }
  | { type: "model_response"; sessionId: string; stopReason: string; text: string }
  | { type: "tool_started"; sessionId: string; toolName: string }
  | { type: "tool_finished"; sessionId: string; toolName: string; ok: boolean }
  | { type: "completed"; sessionId: string; result: SessionRunResult }

type EventStream<T> = {
  push(value: T): void
  finish(): void
  fail(error: unknown): void
  iterable: AsyncIterable<T>
}

function createEventStream<T>(): EventStream<T> {
  const queue: T[] = []
  const waiters: Array<{
    resolve: (value: IteratorResult<T>) => void
    reject: (reason?: unknown) => void
  }> = []
  let done = false
  let failure: unknown

  const flush = (): void => {
    while (queue.length > 0 && waiters.length > 0) {
      const waiter = waiters.shift()!
      waiter.resolve({
        done: false,
        value: queue.shift()!,
      })
    }
    if (failure !== undefined) {
      while (waiters.length > 0) {
        waiters.shift()!.reject(failure)
      }
      return
    }
    if (done) {
      while (waiters.length > 0) {
        waiters.shift()!.resolve({
          done: true,
          value: undefined,
        })
      }
    }
  }

  return {
    push(value) {
      queue.push(value)
      flush()
    },
    finish() {
      done = true
      flush()
    },
    fail(error) {
      failure = error
      flush()
    },
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (queue.length > 0) {
              return Promise.resolve({
                done: false,
                value: queue.shift()!,
              })
            }
            if (failure !== undefined) {
              return Promise.reject(failure)
            }
            if (done) {
              return Promise.resolve({
                done: true,
                value: undefined,
              })
            }
            return new Promise<IteratorResult<T>>((resolve, reject) => {
              waiters.push({ resolve, reject })
            })
          },
        }
      },
    },
  }
}

export class QueryEngine {
  constructor(
    private readonly loop: QueryLoop,
    private readonly memory: MemoryManager,
    private readonly tasks: TaskManager,
  ) {}

  stream(
    session: SessionRecord,
    prompt: string,
    options: {
      skillNames?: string[]
      onEvent?: (event: QueryEvent) => void
    } = {},
  ): {
    events: AsyncIterable<QueryEvent>
    result: Promise<SessionRunResult>
  } {
    const stream = createEventStream<QueryEvent>()
    const result = this.loop.run(
      session,
      prompt,
      this.memory.getSessionStore(session.id),
      this.tasks,
      {
        skillNames: options.skillNames,
        emit: event => {
          const typedEvent = event as QueryEvent
          stream.push(typedEvent)
          options.onEvent?.(typedEvent)
        },
      },
    ).then(result => {
      const completed: QueryEvent = {
        type: "completed",
        sessionId: session.id,
        result,
      }
      stream.push(completed)
      options.onEvent?.(completed)
      stream.finish()
      return result
    }).catch(error => {
      stream.fail(error)
      throw error
    })

    return {
      events: stream.iterable,
      result,
    }
  }

  async run(
    session: SessionRecord,
    prompt: string,
    options: {
      skillNames?: string[]
      onEvent?: (event: QueryEvent) => void
    } = {},
  ): Promise<{ result: SessionRunResult; events: QueryEvent[] }> {
    const events: QueryEvent[] = []
    const execution = this.stream(session, prompt, {
      ...options,
      onEvent: event => {
        events.push(event)
        options.onEvent?.(event)
      },
    })
    const result = await execution.result
    for await (const _event of execution.events) {
      // Consume the async stream so callers can choose between buffered and streaming APIs.
    }
    return {
      result,
      events,
    }
  }
}
