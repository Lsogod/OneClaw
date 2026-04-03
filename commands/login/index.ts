import type { Command } from '../../commands.js'
import { hasAnthropicApiKeyAuth } from '../../utils/auth.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import {
  getAPIProviderDisplayName,
  isCodexProvider,
} from '../../utils/model/providers.js'

export default () =>
  ({
    type: 'local-jsx',
    name: 'login',
    description: isCodexProvider()
      ? `Sign in with your ${getAPIProviderDisplayName()} account`
      : hasAnthropicApiKeyAuth()
        ? 'Switch Anthropic accounts'
        : 'Sign in with your Anthropic account',
    isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGIN_COMMAND),
    load: () => import('./login.js'),
  }) satisfies Command
