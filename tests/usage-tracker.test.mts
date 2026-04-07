import { describe, expect, test } from "bun:test"
import { UsageTracker } from "../src/usage/tracker.mts"
import { createTestConfig } from "./test-support.mts"

describe("UsageTracker", () => {
  test("accumulates usage and estimated cost", () => {
    const tracker = new UsageTracker(createTestConfig({
      budget: {
        warnUsd: 0.000001,
      },
    }), console)
    tracker.addUsage("gpt-5.4", {
      inputTokens: 1000,
      outputTokens: 500,
    })
    const summary = tracker.summary()

    expect(summary.inputTokens).toBe(1000)
    expect(summary.outputTokens).toBe(500)
    expect(summary.estimatedCostUsd > 0).toBe(true)
  })

  test("throws when estimated budget is exhausted", () => {
    const tracker = new UsageTracker(createTestConfig({
      budget: {
        maxUsd: 0.000001,
      },
    }))
    tracker.addUsage("gpt-5.4", {
      inputTokens: 2000,
      outputTokens: 2000,
    })

    let error: Error | null = null
    try {
      tracker.assertBudget()
    } catch (caught) {
      error = caught as Error
    }
    expect(error?.message).toContain("Estimated usage budget exceeded")
  })
})
