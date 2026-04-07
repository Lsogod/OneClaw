import type { OneClawConfig, ProviderProfile } from "../types.mts"
import { getProviderDescriptor } from "./registry.mts"

export const BUILTIN_PROVIDER_PROFILES: Record<string, ProviderProfile> = {
  "anthropic-compatible": {
    label: "Anthropic-Compatible API",
    kind: "anthropic-compatible",
    model: "claude-sonnet-4-6",
    baseUrl: getProviderDescriptor("anthropic-compatible").defaultBaseUrl,
    description: "Anthropic-style Messages API for Claude and compatible gateways.",
  },
  "claude-subscription": {
    label: "Claude Subscription",
    kind: "claude-subscription",
    model: "claude-sonnet-4-6",
    baseUrl: getProviderDescriptor("claude-subscription").defaultBaseUrl,
    description: "Reuse local Claude CLI subscription credentials.",
  },
  "openai-compatible": {
    label: "OpenAI-Compatible API",
    kind: "openai-compatible",
    model: "gpt-5.4",
    baseUrl: getProviderDescriptor("openai-compatible").defaultBaseUrl,
    description: "OpenAI-compatible Chat Completions profile.",
  },
  "codex-subscription": {
    label: "Codex Subscription",
    kind: "codex-subscription",
    model: "gpt-5.4",
    baseUrl: getProviderDescriptor("codex-subscription").defaultBaseUrl,
    description: "Reuse local Codex subscription auth.json.",
  },
  "github-copilot": {
    label: "GitHub Copilot",
    kind: "github-copilot",
    model: "gpt-5.4",
    baseUrl: getProviderDescriptor("github-copilot").defaultBaseUrl,
    description: "GitHub Copilot OAuth device-flow profile.",
  },
}

export const INTERNAL_PROVIDER_PROFILES: Record<string, ProviderProfile> = {
  "internal-test": {
    label: "Internal Test Provider",
    kind: "internal-test",
    model: "internal-test",
    description: "Hidden deterministic provider reserved for automated tests.",
  },
}

export function listProviderProfiles(config: OneClawConfig): Array<{
  name: string
  profile: ProviderProfile
  active: boolean
}> {
  return Object.entries({
    ...BUILTIN_PROVIDER_PROFILES,
    ...config.providerProfiles,
  })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, profile]) => ({
      name,
      profile,
      active: name === config.activeProfile,
    }))
}

export function resolveActiveProviderProfile(
  config: OneClawConfig,
): { name: string; profile: ProviderProfile } {
  const mergedProfiles = {
    ...INTERNAL_PROVIDER_PROFILES,
    ...BUILTIN_PROVIDER_PROFILES,
    ...config.providerProfiles,
  }
  const active = mergedProfiles[config.activeProfile]
    ?? mergedProfiles["codex-subscription"]
    ?? INTERNAL_PROVIDER_PROFILES["internal-test"]
  const activeName = mergedProfiles[config.activeProfile]
    ? config.activeProfile
    : active.kind
  return {
    name: activeName,
    profile: active,
  }
}
