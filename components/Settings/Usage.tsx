import * as React from 'react'
import { useCallback, useEffect, useState } from 'react'
import { extraUsage as extraUsageCommand } from 'src/commands/extra-usage/index.js'
import { formatCost } from 'src/cost-tracker.js'
import {
  type CodexNormalizedUsage,
  type CodexUsageWindow,
  getCodexAuthSnapshot,
  refreshCodexUsageCache,
} from 'src/services/codex/auth.js'
import { getSubscriptionType } from 'src/utils/auth.js'
import { getAPIProvider } from 'src/utils/model/providers.js'
import { useTerminalSize } from '../../hooks/useTerminalSize.js'
import { Box, Text } from '../../ink.js'
import { useKeybinding } from '../../keybindings/useKeybinding.js'
import {
  type ExtraUsage,
  fetchUtilization,
  type RateLimit,
  type Utilization,
} from '../../services/api/usage.js'
import { formatResetText } from '../../utils/format.js'
import { logError } from '../../utils/log.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { ConfigurableShortcutHint } from '../ConfigurableShortcutHint.js'
import { Byline } from '../design-system/Byline.js'
import {
  isEligibleForOverageCreditGrant,
  OverageCreditUpsell,
} from '../LogoV2/OverageCreditUpsell.js'

type LimitBarProps = {
  title: string
  limit: RateLimit
  maxWidth: number
  showTimeInReset?: boolean
  extraSubtext?: string
}

const BAR_BLOCKS = [' ', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'] as const
const EMPTY_BAR_CHAR = '─'

function buildVisibleBar(ratio: number, width: number): {
  filled: string
  empty: string
} {
  const normalizedRatio = Math.min(1, Math.max(0, ratio))
  const whole = Math.floor(normalizedRatio * width)
  const filledSegments = [BAR_BLOCKS[BAR_BLOCKS.length - 1].repeat(whole)]

  if (whole < width) {
    const remainder = normalizedRatio * width - whole
    const middle = Math.floor(remainder * BAR_BLOCKS.length)
    const middleBlock = BAR_BLOCKS[middle]
    if (middleBlock.trim()) {
      filledSegments.push(middleBlock)
    }
  }

  const filled = filledSegments.join('')
  const emptyWidth = Math.max(0, width - filled.length)

  return {
    filled,
    empty: EMPTY_BAR_CHAR.repeat(emptyWidth),
  }
}

function LimitBar({
  title,
  limit,
  maxWidth,
  showTimeInReset = true,
  extraSubtext,
}: LimitBarProps): React.ReactNode {
  const { utilization, resets_at } = limit
  if (utilization === null) {
    return null
  }

  const usedText = `${Math.floor(utilization)}% used`

  let subtext: string | undefined
  if (resets_at) {
    subtext = `Resets ${formatResetText(resets_at, true, showTimeInReset)}`
  }

  if (extraSubtext) {
    subtext = subtext ? `${extraSubtext} · ${subtext}` : extraSubtext
  }

  const maxBarWidth = 50
  const usedLabelSpace = usedText.length + 1
  const barWidth = Math.max(
    10,
    Math.min(maxBarWidth, maxWidth - usedLabelSpace),
  )
  const { filled, empty } = buildVisibleBar(utilization / 100, barWidth)
  const content = `${filled}${empty} ${usedText}`

  return (
    <Text>
      <Text bold>{title}</Text>
      {'\n'}
      {content}
      {subtext ? `\n${subtext}` : ''}
    </Text>
  )
}

function buildCodexWindowBars(
  usage: CodexNormalizedUsage | null | undefined,
): Array<{
  title: string
  limit: RateLimit
}> {
  const entries: Array<{
    title: string
    limit: RateLimit
  }> = []

  const pushWindow = (window: CodexUsageWindow | null | undefined) => {
    if (!window || window.usedPercent === null) {
      return
    }

    entries.push({
      title: window.label,
      limit: {
        utilization: window.usedPercent,
        resets_at: window.resetAt,
      },
    })
  }

  pushWindow(
    usage?.primary
      ? {
          ...usage.primary,
          label: 'Current session',
        }
      : null,
  )
  pushWindow(
    usage?.secondary
      ? {
          ...usage.secondary,
          label: 'Current week (all models)',
        }
      : null,
  )
  pushWindow(
    usage?.codeReview
      ? {
          ...usage.codeReview,
          label: 'Code review',
        }
      : null,
  )

  for (const additional of usage?.additionalLimits ?? []) {
    pushWindow(additional.primary)
    pushWindow(additional.secondary)
  }

  return entries
}

function renderFooter(): React.ReactNode {
  return (
    <Text dimColor>
      <ConfigurableShortcutHint
        action="confirm:no"
        context="Settings"
        fallback="Esc"
        description="cancel"
      />
    </Text>
  )
}

function renderLoadingState(): React.ReactNode {
  return (
    <Box flexDirection="column" gap={1}>
      <Text dimColor>Loading usage data…</Text>
      {renderFooter()}
    </Box>
  )
}

export function Usage(): React.ReactNode {
  const apiProvider = getAPIProvider()
  const [utilization, setUtilization] = useState<Utilization | null>(null)
  const [codexSnapshot, setCodexSnapshot] = useState(() =>
    apiProvider === 'codex' ? getCodexAuthSnapshot() : null,
  )
  const [error, setError] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const { columns } = useTerminalSize()

  const availableWidth = columns - 2
  const maxWidth = Math.min(availableWidth, 80)

  const loadUtilization = useCallback(async () => {
    setIsLoading(true)
    setError(null)

    try {
      if (apiProvider === 'codex') {
        await refreshCodexUsageCache()
        setCodexSnapshot(getCodexAuthSnapshot())
        setUtilization({})
        return
      }

      const data = await fetchUtilization()
      setUtilization(data)
    } catch (err) {
      logError(err as Error)
      const axiosError = err as {
        response?: {
          data?: unknown
        }
      }
      const responseBody = axiosError.response?.data
        ? jsonStringify(axiosError.response.data)
        : undefined

      setError(
        responseBody
          ? `Failed to load usage data: ${responseBody}`
          : 'Failed to load usage data',
      )
    } finally {
      setIsLoading(false)
    }
  }, [apiProvider])

  useEffect(() => {
    void loadUtilization()
  }, [loadUtilization])

  useKeybinding(
    'settings:retry',
    () => {
      void loadUtilization()
    },
    { context: 'Settings', isActive: !!error && !isLoading },
  )

  if (error) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color="error">Error: {error}</Text>
        <Text dimColor>
          <Byline>
            <ConfigurableShortcutHint
              action="settings:retry"
              context="Settings"
              fallback="r"
              description="retry"
            />
            <ConfigurableShortcutHint
              action="confirm:no"
              context="Settings"
              fallback="Esc"
              description="cancel"
            />
          </Byline>
        </Text>
      </Box>
    )
  }

  if (apiProvider === 'codex') {
    if (isLoading && !codexSnapshot) {
      return renderLoadingState()
    }

    const snapshot = codexSnapshot ?? getCodexAuthSnapshot()
    const liveUsageBars = buildCodexWindowBars(snapshot.usage)

    return (
      <Box flexDirection="column" gap={1} width="100%">
        {!snapshot.loggedIn && (
          <Text dimColor>Not logged in. Run one auth login.</Text>
        )}

        {snapshot.loggedIn && liveUsageBars.length > 0 && (
          <>
            {liveUsageBars.map(({ title, limit }) => (
              <LimitBar
                key={`${title}-${limit.resets_at ?? 'no-reset'}`}
                title={title}
                limit={limit}
                maxWidth={maxWidth}
              />
            ))}
          </>
        )}

        {snapshot.loggedIn &&
          snapshot.authMode === 'chatgpt' &&
          liveUsageBars.length === 0 && (
            <Text dimColor>
              Live quota metadata was fetched, but this account did not return
              any renderable rate-limit windows.
            </Text>
          )}

        {renderFooter()}
      </Box>
    )
  }

  if (!utilization) {
    return renderLoadingState()
  }

  const subscriptionType = getSubscriptionType()
  const showSonnetBar =
    subscriptionType === 'max' ||
    subscriptionType === 'team' ||
    subscriptionType === null

  const limits = [
    {
      title: 'Current session',
      limit: utilization.five_hour,
    },
    {
      title: 'Current week (all models)',
      limit: utilization.seven_day,
    },
    ...(showSonnetBar
      ? [
          {
            title: 'Current week (Sonnet only)',
            limit: utilization.seven_day_sonnet,
          },
        ]
      : []),
  ]

  return (
    <Box flexDirection="column" gap={1} width="100%">
      {limits.some(({ limit }) => limit) || (
        <Text dimColor>/usage is only available for subscription plans.</Text>
      )}

      {limits.map(
        ({ title, limit }) =>
          limit && (
            <LimitBar
              key={title}
              title={title}
              limit={limit}
              maxWidth={maxWidth}
            />
          ),
      )}

      {utilization.extra_usage && (
        <ExtraUsageSection
          extraUsage={utilization.extra_usage}
          maxWidth={maxWidth}
        />
      )}

      {isEligibleForOverageCreditGrant() && (
        <OverageCreditUpsell maxWidth={maxWidth} />
      )}

      {renderFooter()}
    </Box>
  )
}

type ExtraUsageSectionProps = {
  extraUsage: ExtraUsage
  maxWidth: number
}

const EXTRA_USAGE_SECTION_TITLE = 'Extra usage'

function ExtraUsageSection({
  extraUsage,
  maxWidth,
}: ExtraUsageSectionProps): React.ReactNode {
  const subscriptionType = getSubscriptionType()
  const isProOrMax =
    subscriptionType === 'pro' || subscriptionType === 'max'

  if (!isProOrMax) {
    return false
  }

  if (!extraUsage.is_enabled) {
    if (extraUsageCommand.isEnabled()) {
      return (
        <Box flexDirection="column">
          <Text bold>{EXTRA_USAGE_SECTION_TITLE}</Text>
          <Text dimColor>Extra usage not enabled · /extra-usage to enable</Text>
        </Box>
      )
    }

    return null
  }

  if (extraUsage.monthly_limit === null) {
    return (
      <Box flexDirection="column">
        <Text bold>{EXTRA_USAGE_SECTION_TITLE}</Text>
        <Text dimColor>Unlimited</Text>
      </Box>
    )
  }

  if (
    typeof extraUsage.used_credits !== 'number' ||
    typeof extraUsage.utilization !== 'number'
  ) {
    return null
  }

  const formattedUsedCredits = formatCost(extraUsage.used_credits / 100, 2)
  const formattedMonthlyLimit = formatCost(extraUsage.monthly_limit / 100, 2)
  const now = new Date()
  const oneMonthReset = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    1,
  )

  return (
    <LimitBar
      title={EXTRA_USAGE_SECTION_TITLE}
      limit={{
        utilization: extraUsage.utilization,
        resets_at: oneMonthReset.toISOString(),
      }}
      showTimeInReset={false}
      extraSubtext={`${formattedUsedCredits} / ${formattedMonthlyLimit} spent`}
      maxWidth={maxWidth}
    />
  )
}
