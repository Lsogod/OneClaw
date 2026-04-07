import type { HookDefinition, HookEventName } from "../types.mts"
import { readTextIfExists, safeJsonParse } from "../utils.mts"

function normalizeDefinitions(raw: unknown, sourcePath: string): HookDefinition[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((item): item is HookDefinition =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as HookDefinition).name === "string" &&
        typeof (item as HookDefinition).event === "string" &&
        typeof (item as HookDefinition).type === "string",
      )
      .map(item => ({
        timeoutMs: 5_000,
        blockOnFailure: false,
        ...item,
      }))
  }

  if (
    typeof raw === "object" &&
    raw !== null &&
    Array.isArray((raw as { hooks?: unknown[] }).hooks)
  ) {
    return normalizeDefinitions((raw as { hooks: unknown[] }).hooks, sourcePath)
  }

  if (typeof raw === "object" && raw !== null) {
    const definitions: HookDefinition[] = []
    for (const [eventName, entries] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(entries)) {
        continue
      }
      for (const entry of entries) {
        if (typeof entry !== "object" || entry === null) {
          continue
        }
        definitions.push({
          timeoutMs: 5_000,
          blockOnFailure: false,
          ...(entry as HookDefinition),
          event: ((entry as HookDefinition).event ?? eventName) as HookEventName,
          name: (entry as HookDefinition).name ?? `${eventName}:${sourcePath}`,
        })
      }
    }
    return definitions
  }

  return []
}

export class HookRegistry {
  private readonly definitions: HookDefinition[] = []

  async load(paths: string[]): Promise<void> {
    for (const path of paths) {
      const raw = await readTextIfExists(path)
      if (!raw) {
        continue
      }
      const parsed = safeJsonParse<unknown>(raw, null)
      this.definitions.push(...normalizeDefinitions(parsed, path))
    }
  }

  register(definitions: HookDefinition[]): void {
    this.definitions.push(...definitions)
  }

  list(): HookDefinition[] {
    return [...this.definitions]
  }

  get(event: HookEventName): HookDefinition[] {
    return this.definitions.filter(definition => definition.event === event)
  }
}
