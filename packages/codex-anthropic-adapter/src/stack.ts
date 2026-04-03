import { getCodexAppServerUrl } from './config.js'
import { dirname, join } from 'path'
import { existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { getCodexAppServerConfigOverrides } from '../../../utils/model/providers.js'

function getBunBinary(): string {
  return Bun.which('bun') || process.execPath
}

function getAdapterEntry(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const built = join(here, 'server.js')
  if (existsSync(built)) {
    return built
  }

  return join(here, 'server.ts')
}

function spawnManagedProcess(label: string, cmd: string[]): Bun.Subprocess {
  const proc = Bun.spawn(cmd, {
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'inherit',
  })

  proc.exited.then(code => {
    if (code !== 0) {
      // biome-ignore lint/suspicious/noConsole: stack launcher needs direct process output
      console.error(`[codex-stack] ${label} exited with code ${code}`)
    }
  })

  return proc
}

async function main(): Promise<void> {
  const appServerArgs = [
    'codex',
    'app-server',
    '--listen',
    getCodexAppServerUrl(),
  ]
  for (const override of getCodexAppServerConfigOverrides()) {
    appServerArgs.push('-c', override)
  }

  const appServer = spawnManagedProcess('codex app-server', appServerArgs)

  const adapter = spawnManagedProcess('codex adapter', [
    getBunBinary(),
    getAdapterEntry(),
  ])

  const shutdown = () => {
    appServer.kill()
    adapter.kill()
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  await Promise.race([appServer.exited, adapter.exited])
  shutdown()
}

await main()
