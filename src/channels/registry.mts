import { mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { OneClawConfig } from "../types.mts"
import { randomId, readJsonIfExists, slugify, writeJson } from "../utils.mts"

export type ChannelKind =
  | "webhook"
  | "slack"
  | "discord"
  | "telegram"
  | "feishu"
  | "dingtalk"
  | "email"
  | "matrix"
  | "whatsapp"
  | "qq"
  | "mochat"

export type ChannelRecord = {
  name: string
  kind: ChannelKind
  enabled: boolean
  label?: string
  secretEnv?: string
  webhookPath?: string
  createdAt: string
  updatedAt: string
  metadata?: Record<string, unknown>
}

export type ChannelMessageRecord = {
  id: string
  channel: string
  direction: "inbound" | "outbound"
  text: string
  threadId?: string
  sender?: string
  status: "received" | "sent" | "acknowledged"
  createdAt: string
  metadata?: Record<string, unknown>
}

type ChannelStore = {
  channels?: ChannelRecord[]
  messages?: ChannelMessageRecord[]
}

const VALID_CHANNEL_KINDS = new Set<ChannelKind>([
  "webhook",
  "slack",
  "discord",
  "telegram",
  "feishu",
  "dingtalk",
  "email",
  "matrix",
  "whatsapp",
  "qq",
  "mochat",
])

function storePath(config: OneClawConfig): string {
  return join(config.homeDir, "channels", "channels.json")
}

async function readStore(config: OneClawConfig): Promise<Required<ChannelStore>> {
  const path = storePath(config)
  const store = await readJsonIfExists<ChannelStore>(path)
  return {
    channels: (store?.channels ?? [])
      .filter(channel => typeof channel?.name === "string" && VALID_CHANNEL_KINDS.has(channel.kind))
      .sort((left, right) => left.name.localeCompare(right.name)),
    messages: (store?.messages ?? [])
      .filter(message => typeof message?.id === "string" && typeof message?.channel === "string")
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  }
}

async function writeStore(config: OneClawConfig, store: Required<ChannelStore>): Promise<string> {
  const path = storePath(config)
  await mkdir(dirname(path), { recursive: true })
  await writeJson(path, {
    channels: store.channels.sort((left, right) => left.name.localeCompare(right.name)),
    messages: store.messages.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
  })
  return path
}

export function assertChannelKind(kind: string): asserts kind is ChannelKind {
  if (!VALID_CHANNEL_KINDS.has(kind as ChannelKind)) {
    throw new Error(`Unsupported channel kind: ${kind}. Use ${[...VALID_CHANNEL_KINDS].join(", ")}`)
  }
}

export async function listChannels(config: OneClawConfig, query = "") {
  const store = await readStore(config)
  const normalized = query.trim().toLowerCase()
  const channels = normalized
    ? store.channels.filter(channel => [
        channel.name,
        channel.kind,
        channel.label ?? "",
        channel.webhookPath ?? "",
      ].join("\n").toLowerCase().includes(normalized))
    : store.channels
  return {
    path: storePath(config),
    count: channels.length,
    channels,
  }
}

export async function upsertChannel(
  config: OneClawConfig,
  payload: {
    name: string
    kind: ChannelKind
    label?: string
    secretEnv?: string
    enabled?: boolean
    webhookPath?: string
    metadata?: Record<string, unknown>
  },
) {
  assertChannelKind(payload.kind)
  const name = slugify(payload.name)
  if (!name) {
    throw new Error("Channel name is required.")
  }
  const store = await readStore(config)
  const previous = store.channels.find(channel => channel.name === name)
  const now = new Date().toISOString()
  const channel: ChannelRecord = {
    name,
    kind: payload.kind,
    enabled: payload.enabled ?? previous?.enabled ?? true,
    label: payload.label ?? previous?.label,
    secretEnv: payload.secretEnv ?? previous?.secretEnv,
    webhookPath: payload.webhookPath ?? previous?.webhookPath ?? `/channels/${name}/messages`,
    metadata: payload.metadata ?? previous?.metadata,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  }
  const path = await writeStore(config, {
    channels: [
      ...store.channels.filter(item => item.name !== name),
      channel,
    ],
    messages: store.messages,
  })
  return {
    path,
    replaced: Boolean(previous),
    channel,
  }
}

export async function removeChannel(config: OneClawConfig, name: string) {
  const channelName = slugify(name)
  const store = await readStore(config)
  const remaining = store.channels.filter(channel => channel.name !== channelName)
  const path = await writeStore(config, {
    channels: remaining,
    messages: store.messages,
  })
  return {
    path,
    name: channelName,
    removed: remaining.length !== store.channels.length,
  }
}

export async function recordChannelMessage(
  config: OneClawConfig,
  payload: {
    channel: string
    direction?: "inbound" | "outbound"
    text: string
    threadId?: string
    sender?: string
    status?: "received" | "sent" | "acknowledged"
    metadata?: Record<string, unknown>
  },
) {
  const channel = slugify(payload.channel)
  if (!channel) {
    throw new Error("Channel is required.")
  }
  const text = payload.text.trim()
  if (!text) {
    throw new Error("Channel message text is required.")
  }
  const store = await readStore(config)
  const message: ChannelMessageRecord = {
    id: randomId("channel"),
    channel,
    direction: payload.direction ?? "inbound",
    text,
    threadId: payload.threadId,
    sender: payload.sender,
    status: payload.status ?? (payload.direction === "outbound" ? "sent" : "received"),
    createdAt: new Date().toISOString(),
    metadata: payload.metadata,
  }
  const path = await writeStore(config, {
    channels: store.channels,
    messages: [message, ...store.messages].slice(0, 1000),
  })
  return {
    path,
    message,
  }
}

export async function listChannelMessages(config: OneClawConfig, query = "") {
  const store = await readStore(config)
  const normalized = query.trim().toLowerCase()
  const messages = normalized
    ? store.messages.filter(message => [
        message.id,
        message.channel,
        message.text,
        message.sender ?? "",
        message.threadId ?? "",
      ].join("\n").toLowerCase().includes(normalized))
    : store.messages
  return {
    path: storePath(config),
    count: messages.length,
    messages,
  }
}

export async function acknowledgeChannelMessage(config: OneClawConfig, id: string) {
  const store = await readStore(config)
  let updated: ChannelMessageRecord | null = null
  const messages = store.messages.map(message => {
    if (message.id !== id) {
      return message
    }
    updated = {
      ...message,
      status: "acknowledged",
    }
    return updated
  })
  const path = await writeStore(config, {
    channels: store.channels,
    messages,
  })
  return {
    path,
    id,
    acknowledged: Boolean(updated),
    message: updated,
  }
}
