import type { Command } from '../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { getAPIProviderDisplayName } from '../../utils/model/providers.js'

export default {
  type: 'local-jsx',
  name: 'logout',
  description: `Sign out from your ${getAPIProviderDisplayName()} account`,
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_LOGOUT_COMMAND),
  load: () => import('./logout.js'),
} satisfies Command
