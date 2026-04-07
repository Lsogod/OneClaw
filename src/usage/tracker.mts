import type { Logger, OneClawConfig, ProviderTurnOutput } from "../types.mts"

export type UsageSummary = {
  inputTokens: number
  outputTokens: number
  estimatedCostUsd: number
  turns: number
}

type PricingHint = {
  inputUsdPer1k: number
  outputUsdPer1k: number
}

const PRICING_HINTS: Array<{ prefix: string; pricing: PricingHint }> = [
  { prefix: "gpt-5.4-mini", pricing: { inputUsdPer1k: 0.0002, outputUsdPer1k: 0.0008 } },
  { prefix: "gpt-5.4", pricing: { inputUsdPer1k: 0.0012, outputUsdPer1k: 0.0048 } },
  { prefix: "claude", pricing: { inputUsdPer1k: 0.001, outputUsdPer1k: 0.005 } },
  { prefix: "kimi", pricing: { inputUsdPer1k: 0.0008, outputUsdPer1k: 0.003 } },
]

function pricingForModel(model: string): PricingHint {
  const normalized = model.toLowerCase()
  return PRICING_HINTS.find(entry => normalized.startsWith(entry.prefix))?.pricing
    ?? { inputUsdPer1k: 0.0005, outputUsdPer1k: 0.002 }
}

export class UsageTracker {
  private summaryState: UsageSummary = {
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    turns: 0,
  }

  constructor(
    private readonly config: OneClawConfig,
    private readonly logger?: Logger,
  ) {}

  assertBudget(): void {
    const maxUsd = this.config.budget.maxUsd
    if (typeof maxUsd === "number" && this.summaryState.estimatedCostUsd >= maxUsd) {
      throw new Error(
        `Estimated usage budget exceeded: ${this.summaryState.estimatedCostUsd.toFixed(4)} USD >= ${maxUsd.toFixed(4)} USD`,
      )
    }
  }

  addUsage(model: string, usage?: ProviderTurnOutput["usage"]): UsageSummary {
    if (!usage) {
      this.summaryState.turns += 1
      return this.summary()
    }

    const inputTokens = usage.inputTokens ?? 0
    const outputTokens = usage.outputTokens ?? 0
    const pricing = pricingForModel(model)
    const estimatedCostUsd =
      (inputTokens / 1000) * pricing.inputUsdPer1k +
      (outputTokens / 1000) * pricing.outputUsdPer1k

    this.summaryState = {
      inputTokens: this.summaryState.inputTokens + inputTokens,
      outputTokens: this.summaryState.outputTokens + outputTokens,
      estimatedCostUsd: this.summaryState.estimatedCostUsd + estimatedCostUsd,
      turns: this.summaryState.turns + 1,
    }

    const warnUsd = this.config.budget.warnUsd
    if (
      typeof warnUsd === "number" &&
      this.summaryState.estimatedCostUsd >= warnUsd
    ) {
      this.logger?.warn(
        `[budget] estimated spend ${this.summaryState.estimatedCostUsd.toFixed(4)} USD reached warning threshold ${warnUsd.toFixed(4)} USD`,
      )
    }

    return this.summary()
  }

  summary(): UsageSummary {
    return { ...this.summaryState }
  }
}
