import { join } from "node:path"
import type { OneClawConfig } from "../types.mts"
import { appendText, ensureDir, readTextIfExists, writeText } from "../utils.mts"

export class FileMemoryStore {
  private readonly memoryPath: string

  constructor(
    private readonly config: OneClawConfig,
    private readonly sessionId: string,
  ) {
    this.memoryPath = join(this.config.sessionDir, this.sessionId, "memory.md")
  }

  async init(): Promise<void> {
    await ensureDir(join(this.config.sessionDir, this.sessionId))
  }

  async read(): Promise<string> {
    return (await readTextIfExists(this.memoryPath)) ?? ""
  }

  async append(note: string): Promise<void> {
    await this.init()
    const line = note.endsWith("\n") ? note : `${note}\n`
    await appendText(this.memoryPath, line)
  }

  async replace(note: string): Promise<void> {
    await this.init()
    await writeText(this.memoryPath, note)
  }
}
