import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import type { Logger, McpServerConfig, OneClawConfig, ToolImplementation } from "../types.mts"
import { buildShellInvocation, defaultShell, joinShellCommand } from "../sandbox/adapter.mts"
import { limitText } from "../utils.mts"

export type McpConnectionStatus = {
  name: string
  state: "connected" | "degraded" | "failed"
  transport: string
  detail?: string
}

export type McpResourceRecord = {
  server: string
  uri: string
  name: string
  description: string
}

type McpClientRecord = {
  name: string
  client: {
    connect(transport: unknown): Promise<void>
    listTools(): Promise<{
      tools?: Array<{
        name: string
        description?: string
        annotations?: { readOnlyHint?: boolean }
        inputSchema?: Record<string, unknown>
      }>
    }>
    callTool(args: {
      name: string
      arguments: Record<string, unknown>
    }): Promise<Record<string, unknown>>
    listResources?(): Promise<{ resources?: Array<{
      uri?: string
      name?: string
      description?: string
    }> }>
    readResource?(args: { uri: string }): Promise<{
      contents?: Array<{
        text?: string
        blob?: string
      }>
    }>
  }
  transport: {
    close(): Promise<void>
  }
  resources: McpResourceRecord[]
  resourceStatus: "available" | "unavailable"
  resourceDetail?: string
}

type McpRegistryOptions = {
  config?: OneClawConfig
  createClient?: () => McpClientRecord["client"]
  createTransport?: (config: McpServerConfig) => McpClientRecord["transport"]
}

const MCP_TOOL_TIMEOUT_MS = 60_000

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`MCP tool call timed out after ${ms}ms: ${label}`)), ms)
    timeout.unref?.()
  })
  return Promise.race([
    promise,
    timeoutPromise,
  ]).finally(() => clearTimeout(timeout))
}

function renderMcpContent(result: Record<string, unknown>): string {
  const content = Array.isArray(result.content) ? result.content : []
  const rendered = content.map(item => {
    const block = item as Record<string, unknown>
    if (block.type === "text") return String(block.text ?? "")
    if (block.type === "resource") return JSON.stringify(block.resource ?? {}, null, 2)
    return JSON.stringify(block, null, 2)
  })
  return limitText(rendered.join("\n"), 12_000)
}

export class McpRegistry {
  private readonly clients = new Map<string, McpClientRecord>()
  private readonly statuses = new Map<string, McpConnectionStatus>()

  constructor(
    private readonly logger: Logger,
    private readonly options: McpRegistryOptions = {},
  ) {}

  private createTransport(config: McpServerConfig): McpClientRecord["transport"] {
    if (this.options.createTransport) {
      return this.options.createTransport(config)
    }
    if (this.options.config?.sandbox.enabled) {
      const invocation = buildShellInvocation(
        this.options.config,
        defaultShell(),
        joinShellCommand([config.command, ...(config.args ?? [])]),
      )
      return new StdioClientTransport({
        command: invocation.command,
        args: invocation.args,
        env: config.env,
        cwd: config.cwd,
      })
    }
    return new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
    })
  }

  private createClient(): McpClientRecord["client"] {
    if (this.options.createClient) {
      return this.options.createClient()
    }
    return new Client({
      name: "oneclaw",
      version: "0.1.0",
    })
  }

  private async safeListResources(
    client: McpClientRecord["client"],
  ): Promise<{
    resources: McpResourceRecord[]
    state: "connected" | "degraded"
    detail?: string
  }> {
    if (!client.listResources) {
      return {
        resources: [],
        state: "degraded",
        detail: "resources unavailable",
      }
    }
    try {
      const listedResources = await withTimeout(client.listResources(), MCP_TOOL_TIMEOUT_MS, "listResources")
      return {
        resources: (listedResources.resources ?? []).map(resource => ({
          server: "",
          uri: String(resource.uri ?? ""),
          name: String(resource.name ?? resource.uri ?? ""),
          description: String(resource.description ?? ""),
        })),
        state: "connected",
      }
    } catch (error) {
      return {
        resources: [],
        state: "degraded",
        detail: `resources unavailable: ${String(error)}`,
      }
    }
  }

  async connect(configs: McpServerConfig[]): Promise<void> {
    for (const config of configs) {
      if (config.transport !== "stdio") {
        this.logger.warn(`[mcp] unsupported transport for ${config.name}: ${config.transport}`)
        this.statuses.set(config.name, {
          name: config.name,
          state: "failed",
          transport: config.transport,
          detail: "unsupported transport",
        })
        continue
      }

      try {
        const transport = this.createTransport(config)
        const client = this.createClient()
        await client.connect(transport)
        const resourceProbe = await this.safeListResources(client)
        const resources = resourceProbe.resources.map(resource => ({
          ...resource,
          server: config.name,
        }))
        this.clients.set(config.name, {
          name: config.name,
          client,
          transport,
          resources,
          resourceStatus: resourceProbe.state === "connected" ? "available" : "unavailable",
          resourceDetail: resourceProbe.detail,
        })
        this.statuses.set(config.name, {
          name: config.name,
          state: resourceProbe.state,
          transport: config.transport,
          detail: resourceProbe.detail,
        })
        if (resourceProbe.state === "degraded") {
          this.logger.warn(`[mcp] connected ${config.name} without resources: ${resourceProbe.detail ?? "resources unavailable"}`)
        } else {
          this.logger.info(`[mcp] connected ${config.name}`)
        }
      } catch (error) {
        this.statuses.set(config.name, {
          name: config.name,
          state: "failed",
          transport: config.transport,
          detail: String(error),
        })
        this.logger.warn(`[mcp] failed to connect ${config.name}: ${String(error)}`)
      }
    }
  }

  async toTools(): Promise<ToolImplementation[]> {
    const tools: ToolImplementation[] = []
    for (const [serverName, record] of this.clients.entries()) {
      const listed = await withTimeout(record.client.listTools(), MCP_TOOL_TIMEOUT_MS, `${serverName}/listTools`)
      for (const tool of listed.tools ?? []) {
        tools.push({
          spec: {
            name: `mcp__${serverName}__${tool.name}`,
            description: `[MCP ${serverName}] ${tool.description ?? tool.name}`,
            readOnly: Boolean(tool.annotations?.readOnlyHint),
            source: "mcp",
            inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
          },
          execute: async input => {
            try {
              const result = await withTimeout(
                record.client.callTool({
                  name: tool.name,
                  arguments: (input as Record<string, unknown>) ?? {},
                }),
                MCP_TOOL_TIMEOUT_MS,
                `${serverName}/${tool.name}`,
              )
              const output = renderMcpContent(result as Record<string, unknown>)
              return {
                ok: !Boolean((result as Record<string, unknown>).isError),
                output,
                metadata: {
                  server: serverName,
                  structuredContent: (result as Record<string, unknown>).structuredContent,
                },
              }
            } catch (error) {
              return {
                ok: false,
                output: `MCP tool error: ${error instanceof Error ? error.message : String(error)}`,
              }
            }
          },
        })
      }
    }
    return tools
  }

  createManagementTools(): ToolImplementation[] {
    return [
      {
        spec: {
          name: "list_mcp_resources",
          description: "List connected MCP resources.",
          readOnly: true,
          source: "mcp",
          inputSchema: {
            type: "object",
            properties: {
              server: { type: "string" },
            },
          },
        },
        execute: async input => {
          const server = typeof (input as { server?: string })?.server === "string"
            ? (input as { server?: string }).server
            : undefined
          const resources = this.listResources()
            .filter(resource => !server || resource.server === server)
          return {
            ok: true,
            output: resources.length > 0
              ? JSON.stringify(resources, null, 2)
              : "(no MCP resources)",
          }
        },
      },
      {
        spec: {
          name: "read_mcp_resource",
          description: "Read a specific MCP resource by server and uri.",
          readOnly: true,
          source: "mcp",
          inputSchema: {
            type: "object",
            required: ["server", "uri"],
            properties: {
              server: { type: "string" },
              uri: { type: "string" },
            },
          },
        },
        execute: async input => {
          const values = input as { server?: string; uri?: string }
          if (!values.server || !values.uri) {
            return {
              ok: false,
              output: "Missing required fields: server, uri",
            }
          }
          try {
            const output = await this.readResource(values.server, values.uri)
            return {
              ok: true,
              output,
            }
          } catch (error) {
            return {
              ok: false,
              output: String(error),
            }
          }
        },
      },
    ]
  }

  listStatuses(): McpConnectionStatus[] {
    return [...this.statuses.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    )
  }

  listResources(): McpResourceRecord[] {
    return [...this.clients.values()]
      .flatMap(record => record.resources)
      .sort((left, right) => left.uri.localeCompare(right.uri))
  }

  async readResource(serverName: string, uri: string): Promise<string> {
    const record = this.clients.get(serverName)
    if (!record) {
      throw new Error(`Unknown MCP server: ${serverName}`)
    }
    if (!record.client.readResource) {
      throw new Error(`MCP server ${serverName} does not support resources`)
    }
    const result = await record.client.readResource({ uri })
    const content = (result.contents ?? [])
      .map(item => item.text ?? item.blob ?? "")
      .join("\n")
      .trim()
    return content || "(empty resource)"
  }

  async close(): Promise<void> {
    for (const record of this.clients.values()) {
      await record.transport.close()
    }
  }
}
