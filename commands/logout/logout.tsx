import * as React from 'react'
import { clearTrustedDeviceTokenCache } from '../../bridge/trustedDevice.js'
import { Text } from '../../ink.js'
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js'
import { getGroveNoticeConfig, getGroveSettings } from '../../services/api/grove.js'
import { logoutFromCodexCli } from '../../services/codex/auth.js'
import { clearPolicyLimitsCache } from '../../services/policyLimits/index.js'
import { clearRemoteManagedSettingsCache } from '../../services/remoteManagedSettings/index.js'
import { getClaudeAIOAuthTokens, removeApiKey } from '../../utils/auth.js'
import { clearBetasCaches } from '../../utils/betas.js'
import { saveGlobalConfig } from '../../utils/config.js'
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js'
import { getAPIProviderDisplayName, isCodexProvider } from '../../utils/model/providers.js'
import { getSecureStorage } from '../../utils/secureStorage/index.js'
import { clearToolSchemaCache } from '../../utils/toolSchemaCache.js'
import { resetUserCache } from '../../utils/user.js'

async function clearPersistedAuthState(clearOnboarding = false): Promise<void> {
  await clearAuthRelatedCaches()

  saveGlobalConfig(current => {
    const updated = { ...current }

    if (clearOnboarding) {
      updated.hasCompletedOnboarding = false
      updated.subscriptionNoticeCount = 0
      updated.hasAvailableSubscription = false

      if (updated.customApiKeyResponses?.approved) {
        updated.customApiKeyResponses = {
          ...updated.customApiKeyResponses,
          approved: [],
        }
      }
    }

    updated.oauthAccount = undefined
    return updated
  })
}

export async function performLogout({
  clearOnboarding = false,
}: {
  clearOnboarding?: boolean
} = {}): Promise<void> {
  const { flushTelemetry } = await import(
    '../../utils/telemetry/instrumentation.js'
  )

  await flushTelemetry()
  await removeApiKey()

  // Wipe secure storage data when clearing Anthropic-style auth state.
  getSecureStorage().delete()
  await clearPersistedAuthState(clearOnboarding)
}

export async function performCodexLogout({
  clearOnboarding = false,
}: {
  clearOnboarding?: boolean
} = {}): Promise<void> {
  const { flushTelemetry } = await import(
    '../../utils/telemetry/instrumentation.js'
  )

  await flushTelemetry()
  await logoutFromCodexCli()
  await clearPersistedAuthState(clearOnboarding)
}

// Clear memoized state that depends on the active auth session.
export async function clearAuthRelatedCaches(): Promise<void> {
  getClaudeAIOAuthTokens.cache?.clear?.()
  clearTrustedDeviceTokenCache()
  clearBetasCaches()
  clearToolSchemaCache()

  resetUserCache()
  refreshGrowthBookAfterAuthChange()

  getGroveNoticeConfig.cache?.clear?.()
  getGroveSettings.cache?.clear?.()

  await clearRemoteManagedSettingsCache()
  await clearPolicyLimitsCache()
}

export async function call(): Promise<React.ReactNode> {
  if (isCodexProvider()) {
    await performCodexLogout({ clearOnboarding: true })
  } else {
    await performLogout({ clearOnboarding: true })
  }

  const message = (
    <Text>
      Successfully logged out from your {getAPIProviderDisplayName()} account.
    </Text>
  )

  setTimeout(() => {
    gracefulShutdownSync(0, 'logout')
  }, 200)

  return message
}
