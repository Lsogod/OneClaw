export type AppState = {
  provider: string
  activeProfile: string
  model: string
  permissionMode: string
  cwd: string
  theme: string
  outputStyle: string
  keybindings: Record<string, string>
  mcpConnected: number
  mcpFailed: number
  activeSessions: number
  bridgeSessions: number
  taskCount: number
  totalInputTokens: number
  totalOutputTokens: number
  estimatedCostUsd: number
}

type Subscriber = (state: AppState) => void

export class AppStateStore {
  private readonly subscribers = new Set<Subscriber>()

  constructor(private state: AppState) {}

  get(): AppState {
    return {
      ...this.state,
      keybindings: { ...this.state.keybindings },
    }
  }

  patch(update: Partial<AppState>): void {
    this.state = {
      ...this.state,
      ...update,
      keybindings: update.keybindings
        ? { ...update.keybindings }
        : this.state.keybindings,
    }
    this.emit()
  }

  update(updater: (state: AppState) => AppState): void {
    this.state = updater(this.get())
    this.emit()
  }

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber)
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  private emit(): void {
    const snapshot = this.get()
    for (const subscriber of this.subscribers) {
      subscriber(snapshot)
    }
  }
}
