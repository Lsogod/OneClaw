import { feature } from 'bun:bundle'
import * as React from 'react'
import { resetCostState } from '../../bootstrap/state.js'
import {
  clearTrustedDeviceToken,
  enrollTrustedDevice,
} from '../../bridge/trustedDevice.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { ConfigurableShortcutHint } from '../../components/ConfigurableShortcutHint.js'
import { ConsoleOAuthFlow } from '../../components/ConsoleOAuthFlow.js'
import { Dialog } from '../../components/design-system/Dialog.js'
import { useMainLoopModel } from '../../hooks/useMainLoopModel.js'
import { Text } from '../../ink.js'
import { refreshGrowthBookAfterAuthChange } from '../../services/analytics/growthbook.js'
import { loginWithCodexCliWithOptions } from '../../services/codex/auth.js'
import { refreshPolicyLimits } from '../../services/policyLimits/index.js'
import { refreshRemoteManagedSettings } from '../../services/remoteManagedSettings/index.js'
import type { LocalJSXCommandOnDone } from '../../types/command.js'
import { errorMessage } from '../../utils/errors.js'
import { logError } from '../../utils/log.js'
import { stripSignatureBlocks } from '../../utils/messages.js'
import {
  getCodexOpenAIApiKeyEnvVar,
  getCodexPreferredAuthMode,
  isCodexProvider,
} from '../../utils/model/providers.js'
import {
  checkAndDisableAutoModeIfNeeded,
  checkAndDisableBypassPermissionsIfNeeded,
  resetAutoModeGateCheck,
  resetBypassPermissionsCheck,
} from '../../utils/permissions/bypassPermissionsKillswitch.js'
import { resetUserCache } from '../../utils/user.js'

function finalizeLoginSuccess(context: LocalJSXCommandContext): void {
  context.onChangeAPIKey()

  // Signature-bearing blocks are bound to the previous auth state.
  context.setMessages(stripSignatureBlocks)

  resetCostState()
  void refreshRemoteManagedSettings()
  void refreshPolicyLimits()
  resetUserCache()
  refreshGrowthBookAfterAuthChange()
  clearTrustedDeviceToken()
  void enrollTrustedDevice()
  resetBypassPermissionsCheck()

  const appState = context.getAppState()
  void checkAndDisableBypassPermissionsIfNeeded(
    appState.toolPermissionContext,
    context.setAppState,
  )

  if (feature('TRANSCRIPT_CLASSIFIER')) {
    resetAutoModeGateCheck()
    void checkAndDisableAutoModeIfNeeded(
      appState.toolPermissionContext,
      context.setAppState,
      appState.fastMode,
    )
  }

  context.setAppState(prev => ({
    ...prev,
    authVersion: prev.authVersion + 1,
  }))
}

function isInterrupted(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false
  }

  const candidate = error as {
    isCanceled?: boolean
    signal?: string
  }

  return candidate.isCanceled === true || candidate.signal === 'SIGINT'
}

export async function call(
  onDone: LocalJSXCommandOnDone,
  context: LocalJSXCommandContext,
): Promise<React.ReactNode | null> {
  if (isCodexProvider()) {
    try {
      await loginWithCodexCliWithOptions({
        mode: getCodexPreferredAuthMode(),
        apiKeyEnvVar: getCodexOpenAIApiKeyEnvVar(),
      })
      finalizeLoginSuccess(context)
      onDone('Login successful')
    } catch (error) {
      if (isInterrupted(error)) {
        onDone('Login interrupted')
      } else {
        logError(error as Error)
        onDone(`Login failed: ${errorMessage(error)}`)
      }
    }

    return null
  }

  return (
    <Login
      onDone={success => {
        if (success) {
          finalizeLoginSuccess(context)
        }

        onDone(success ? 'Login successful' : 'Login interrupted')
      }}
    />
  )
}

export function Login(props: {
  onDone: (success: boolean, mainLoopModel: string) => void
  startingMessage?: string
}): React.ReactNode {
  const mainLoopModel = useMainLoopModel()

  return (
    <Dialog
      title="Login"
      onCancel={() => props.onDone(false, mainLoopModel)}
      color="permission"
      inputGuide={exitState =>
        exitState.pending ? (
          <Text>Press {exitState.keyName} again to exit</Text>
        ) : (
          <ConfigurableShortcutHint
            action="confirm:no"
            context="Confirmation"
            fallback="Esc"
            description="cancel"
          />
        )
      }
    >
      <ConsoleOAuthFlow
        onDone={() => props.onDone(true, mainLoopModel)}
        startingMessage={props.startingMessage}
      />
    </Dialog>
  )
}
