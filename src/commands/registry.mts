import type { OneClawRuntime } from "../runtime/assembler.mts"
import { saveUserConfigPatch } from "../config.mts"
import { listProviderProfiles } from "../providers/profiles.mts"
import { collectProviderAuthStatuses } from "../providers/auth.mts"
import type { MemoryScope } from "../types.mts"

export type CommandResult = {
  message?: string
  shouldExit?: boolean
}

export type CommandContext = {
  runtime: OneClawRuntime
  sessionId: string
  cwd: string
}

type CommandHandler = (args: string, context: CommandContext) => Promise<CommandResult>

type SlashCommand = {
  name: string
  description: string
  handler: CommandHandler
}

export class CommandRegistry {
  private readonly commands = new Map<string, SlashCommand>()

  register(command: SlashCommand): void {
    this.commands.set(command.name, command)
  }

  lookup(input: string): { command: SlashCommand; args: string } | null {
    if (!input.startsWith("/")) {
      return null
    }
    const [name, ...rest] = input.slice(1).split(" ")
    const command = this.commands.get(name)
    if (!command) {
      return null
    }
    return {
      command,
      args: rest.join(" ").trim(),
    }
  }

  helpText(): string {
    return [...this.commands.values()]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(command => `/${command.name.padEnd(12)} ${command.description}`)
      .join("\n")
  }
}

async function renderMemory(
  context: CommandContext,
  scope: MemoryScope,
): Promise<string> {
  const memory = await context.runtime.memory.readScope(scope, {
    cwd: context.cwd,
    sessionId: context.sessionId,
  })
  return memory || `(${scope} memory is empty)`
}

export function createDefaultCommandRegistry(): CommandRegistry {
  const registry = new CommandRegistry()

  registry.register({
    name: "help",
    description: "Show available slash commands",
    handler: async () => ({
      message: registry.helpText(),
    }),
  })

  registry.register({
    name: "exit",
    description: "Exit interactive mode",
    handler: async () => ({
      shouldExit: true,
    }),
  })

  registry.register({
    name: "tasks",
    description: "List current task records",
    handler: async (_args, context) => ({
      message: JSON.stringify(context.runtime.tasks.list(), null, 2),
    }),
  })

  registry.register({
    name: "sessions",
    description: "List known session snapshots",
    handler: async (_args, context) => ({
      message: JSON.stringify(await context.runtime.sessions.listSnapshots(), null, 2),
    }),
  })

  registry.register({
    name: "providers",
    description: "Show provider profiles and auth status",
    handler: async (_args, context) => {
      const statuses = await collectProviderAuthStatuses()
      const payload = listProviderProfiles(context.runtime.config).map(item => ({
        name: item.name,
        active: item.active,
        kind: item.profile.kind,
        model: item.profile.model,
        configured: statuses.find(status => status.kind === item.profile.kind)?.configured ?? false,
      }))
      return {
        message: JSON.stringify(payload, null, 2),
      }
    },
  })

  registry.register({
    name: "profile",
    description: "List or persist the active provider profile",
    handler: async (args, context) => {
      if (!args || args === "list") {
        return {
          message: JSON.stringify(listProviderProfiles(context.runtime.config), null, 2),
        }
      }
      const [subcommand, value] = args.split(/\s+/, 2)
      if (subcommand !== "use" || !value) {
        return {
          message: "Usage: /profile list | /profile use <name>",
        }
      }
      const path = await saveUserConfigPatch({
        activeProfile: value,
      }, context.cwd)
      return {
        message: `Persisted active profile ${value} to ${path}. Restart runtime to apply.`,
      }
    },
  })

  registry.register({
    name: "mcp",
    description: "Show MCP statuses and resources",
    handler: async (_args, context) => ({
      message: JSON.stringify({
        statuses: context.runtime.mcp.listStatuses(),
        resources: context.runtime.mcp.listResources(),
      }, null, 2),
    }),
  })

  registry.register({
    name: "state",
    description: "Show current runtime state snapshot",
    handler: async (_args, context) => ({
      message: JSON.stringify(context.runtime.state.get(), null, 2),
    }),
  })

  registry.register({
    name: "usage",
    description: "Show cumulative usage and budget summary",
    handler: async (_args, context) => ({
      message: JSON.stringify(context.runtime.usage.summary(), null, 2),
    }),
  })

  registry.register({
    name: "memory",
    description: "Inspect session/project/global memory",
    handler: async (args, context) => {
      const scope = (args || "session") as MemoryScope
      if (!["session", "project", "global"].includes(scope)) {
        return {
          message: "Usage: /memory [session|project|global]",
        }
      }
      return {
        message: await renderMemory(context, scope),
      }
    },
  })

  registry.register({
    name: "hooks",
    description: "List loaded hook definitions",
    handler: async (_args, context) => ({
      message: JSON.stringify(context.runtime.hooks.list(), null, 2),
    }),
  })

  return registry
}
