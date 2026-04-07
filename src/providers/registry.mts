import type { PublicProviderKind } from "../types.mts"

export type ProviderDescriptor = {
  kind: PublicProviderKind
  label: string
  authKind: "api_key" | "subscription" | "oauth_device" | "none"
  defaultBaseUrl?: string
  description: string
}

export const PROVIDERS: ProviderDescriptor[] = [
  {
    kind: "anthropic-compatible",
    label: "Anthropic-Compatible API",
    authKind: "api_key",
    defaultBaseUrl: "https://api.anthropic.com",
    description: "Anthropic-compatible Messages API for Claude and compatible gateways.",
  },
  {
    kind: "claude-subscription",
    label: "Claude Subscription",
    authKind: "subscription",
    defaultBaseUrl: "https://api.anthropic.com",
    description: "Reuse local ~/.claude/.credentials.json with Claude OAuth headers.",
  },
  {
    kind: "openai-compatible",
    label: "OpenAI-Compatible API",
    authKind: "api_key",
    defaultBaseUrl: "https://api.openai.com/v1",
    description: "OpenAI-compatible Chat Completions for OpenAI, OpenRouter, Kimi, GLM, MiniMax and gateways.",
  },
  {
    kind: "codex-subscription",
    label: "Codex Subscription",
    authKind: "subscription",
    defaultBaseUrl: "https://chatgpt.com/backend-api",
    description: "Reuse local ~/.codex/auth.json against chatgpt.com Codex Responses.",
  },
  {
    kind: "github-copilot",
    label: "GitHub Copilot",
    authKind: "oauth_device",
    defaultBaseUrl: "https://api.githubcopilot.com",
    description: "GitHub Copilot OAuth device flow and OpenAI-compatible chat endpoint.",
  },
]

export function getProviderDescriptor(kind: PublicProviderKind): ProviderDescriptor {
  return PROVIDERS.find(provider => provider.kind === kind)
    ?? PROVIDERS.find(provider => provider.kind === "codex-subscription")
    ?? PROVIDERS[0]!
}
