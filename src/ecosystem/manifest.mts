import type { KernelClient } from "../frontend/kernel-client.mts"

export type EcosystemManifestOptions = {
  client: KernelClient
  commandNames: string[]
  cwd: string
  verbose?: boolean
}

export async function buildEcosystemManifest(options: EcosystemManifestOptions): Promise<Record<string, unknown>> {
  const [tools, plugins, skills, mcp, hooks, instructions] = await Promise.all([
    options.client.tools({ summaryOnly: !options.verbose }),
    options.client.plugins({ verbose: options.verbose }),
    options.client.skills({ includeBody: false }),
    options.client.mcp({ verbose: options.verbose }),
    options.client.hooks(),
    options.client.instructions({ includeContent: false, cwd: options.cwd }),
  ])
  return {
    version: 1,
    cwd: options.cwd,
    commands: {
      count: options.commandNames.length,
      names: [...options.commandNames].sort(),
    },
    tools,
    plugins,
    skills,
    mcp,
    hooks,
    instructions,
  }
}
