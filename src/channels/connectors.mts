import { createHmac, timingSafeEqual } from "node:crypto"
import type { OneClawConfig } from "../types.mts"
import { limitText, slugify } from "../utils.mts"
import {
  getChannel,
  getChannelMessage,
  updateChannelMessage,
  type ChannelRecord,
} from "./registry.mts"

export type ChannelDeliveryRequest = {
  endpoint: string
  endpointRedacted: string
  headers: Record<string, string>
  body: Record<string, unknown>
}

function metadataString(channel: ChannelRecord, key: string): string | undefined {
  const value = channel.metadata?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function redactEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint)
    if (url.username || url.password) {
      url.username = url.username ? "***" : ""
      url.password = url.password ? "***" : ""
    }
    if (/bot[^/]+/i.test(url.pathname)) {
      url.pathname = url.pathname.replace(/bot[^/]+/i, "bot***")
    }
    return url.toString()
  } catch {
    return endpoint.replace(/[A-Za-z0-9_-]{24,}/g, "***")
  }
}

function secretValue(channel: ChannelRecord): string | undefined {
  return channel.secretEnv ? process.env[channel.secretEnv] : undefined
}

function endpointForChannel(channel: ChannelRecord): string {
  const direct = metadataString(channel, "deliveryUrl") ?? metadataString(channel, "webhookUrl")
  if (direct) {
    return direct
  }
  const secret = secretValue(channel)
  if (secret?.startsWith("http://") || secret?.startsWith("https://")) {
    return secret
  }
  if (channel.kind === "telegram") {
    const token = secret
    const chatId = metadataString(channel, "chatId")
    if (token && chatId) {
      return `https://api.telegram.org/bot${token}/sendMessage`
    }
  }
  throw new Error(`Channel ${channel.name} has no delivery endpoint. Configure metadata.deliveryUrl or secretEnv.`)
}

export function buildChannelDeliveryRequest(channel: ChannelRecord, text: string): ChannelDeliveryRequest {
  const endpoint = endpointForChannel(channel)
  const headers = {
    "content-type": "application/json",
  }
  const body = (() => {
    if (channel.kind === "discord") {
      return { content: text }
    }
    if (channel.kind === "telegram") {
      return {
        chat_id: metadataString(channel, "chatId"),
        text,
      }
    }
    if (channel.kind === "feishu") {
      return {
        msg_type: "text",
        content: { text },
      }
    }
    if (channel.kind === "dingtalk") {
      return {
        msgtype: "text",
        text: { content: text },
      }
    }
    return { text }
  })()
  return {
    endpoint,
    endpointRedacted: redactEndpoint(endpoint),
    headers,
    body,
  }
}

export async function deliverChannelMessage(config: OneClawConfig, messageId: string) {
  const message = await getChannelMessage(config, messageId)
  if (!message) {
    return {
      delivered: false,
      messageId,
      error: `Channel message not found: ${messageId}`,
    }
  }
  if (message.direction !== "outbound") {
    return {
      delivered: false,
      messageId,
      error: `Channel message is ${message.direction}; only outbound messages can be delivered.`,
    }
  }
  const channel = await getChannel(config, message.channel)
  if (!channel) {
    return {
      delivered: false,
      messageId,
      error: `Channel not found: ${message.channel}`,
    }
  }
  if (!channel.enabled) {
    return {
      delivered: false,
      messageId,
      channel: channel.name,
      error: `Channel ${channel.name} is disabled.`,
    }
  }
  const request = buildChannelDeliveryRequest(channel, message.text)
  try {
    const response = await fetch(request.endpoint, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(request.body),
    })
    const responseText = await response.text().catch(() => "")
    const status = response.ok ? "sent" : "failed"
    const updated = await updateChannelMessage(config, message.id, {
      status,
      metadata: {
        deliveredAt: new Date().toISOString(),
        deliveryStatus: response.status,
        deliveryOk: response.ok,
        deliveryEndpoint: request.endpointRedacted,
        deliveryResponse: limitText(responseText, 1000),
      },
    })
    return {
      delivered: response.ok,
      channel: channel.name,
      messageId: message.id,
      endpoint: request.endpointRedacted,
      responseStatus: response.status,
      responseText: limitText(responseText, 1000),
      message: updated.message,
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const updated = await updateChannelMessage(config, message.id, {
      status: "failed",
      metadata: {
        deliveredAt: new Date().toISOString(),
        deliveryOk: false,
        deliveryEndpoint: request.endpointRedacted,
        deliveryError: detail,
      },
    })
    return {
      delivered: false,
      channel: channel.name,
      messageId: message.id,
      endpoint: request.endpointRedacted,
      error: detail,
      message: updated.message,
    }
  }
}

export async function verifyChannelSignature(
  config: OneClawConfig,
  channelName: string,
  signature: string,
  payload: string,
) {
  const channel = await getChannel(config, slugify(channelName))
  if (!channel) {
    return {
      verified: false,
      channel: slugify(channelName),
      reason: "channel-not-found",
    }
  }
  const secret = secretValue(channel)
  if (!secret) {
    return {
      verified: false,
      channel: channel.name,
      reason: "missing-secret-env",
      secretEnv: channel.secretEnv,
    }
  }
  const digest = createHmac("sha256", secret).update(payload).digest("hex")
  const expected = signature.replace(/^sha256=/i, "").trim()
  const expectedBuffer = Buffer.from(expected, "hex")
  const actualBuffer = Buffer.from(digest, "hex")
  const verified = expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer)
  return {
    verified,
    channel: channel.name,
    algorithm: "hmac-sha256",
    signature: verified ? "matched" : "mismatch",
  }
}
