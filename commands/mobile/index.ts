import type { Command } from '../../commands.js'

const mobile = {
  type: 'local-jsx',
  name: 'mobile',
  aliases: ['ios', 'android'],
  description: 'Show QR code for the supported mobile client',
  load: () => import('./mobile.js'),
} satisfies Command

export default mobile
