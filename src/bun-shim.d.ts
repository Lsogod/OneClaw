declare const Bun: {
  serve(options: {
    hostname?: string
    port?: number
    fetch(request: Request): Response | Promise<Response>
  }): {
    hostname: string
    port: number
    stop(): void
  }
  spawn(cmd: string[], options?: {
    stdout?: "pipe" | "inherit"
    stderr?: "pipe" | "inherit" | "ignore"
  }): {
    stdout?: ReadableStream<Uint8Array>
    exited: Promise<number>
  }
  sleep(ms: number): Promise<void>
}

interface ImportMeta {
  main?: boolean
}

declare module "bun:test" {
  export const describe: (name: string, callback: () => void) => void
  export const test: (name: string, callback: () => void | Promise<void>) => void
  export const expect: (value: unknown) => {
    toBe(expected: unknown): void
    toEqual(expected: unknown): void
    toBeTruthy(): void
    toContain(expected: unknown): void
  }
}
