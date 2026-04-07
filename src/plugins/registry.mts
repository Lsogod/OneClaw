import { readdir } from "node:fs/promises"
import { basename, join, resolve, sep } from "node:path"
import { pathToFileURL } from "node:url"
import type { HookDefinition, PluginDefinition } from "../types.mts"
import {
  collectFilesByExtension,
  readTextIfExists,
  safeJsonParse,
} from "../utils.mts"

type PluginManifest = {
  name: string
  main?: string
  hooksFile?: string
  skillsDir?: string
  systemPromptPatches?: string[]
}

export class PluginRegistry {
  readonly plugins: PluginDefinition[] = []
  private readonly hookDefinitions: HookDefinition[] = []
  private readonly loadedModulePaths = new Set<string>()
  private readonly loadedPluginNames = new Set<string>()
  private readonly loadedHookKeys = new Set<string>()

  private hookKey(definition: HookDefinition): string {
    return JSON.stringify({
      name: definition.name,
      event: definition.event,
      type: definition.type,
      command: definition.command,
      url: definition.url,
      method: definition.method,
      matcher: definition.matcher,
    })
  }

  private registerHookDefinitions(definitions: HookDefinition[]): void {
    for (const definition of definitions) {
      const key = this.hookKey(definition)
      if (this.loadedHookKeys.has(key)) {
        continue
      }
      this.loadedHookKeys.add(key)
      this.hookDefinitions.push(definition)
    }
  }

  private registerPlugin(plugin: PluginDefinition | undefined): void {
    if (!plugin?.name || this.loadedPluginNames.has(plugin.name)) {
      return
    }
    this.loadedPluginNames.add(plugin.name)
    this.plugins.push(plugin)
    this.registerHookDefinitions(plugin.hookDefinitions ?? [])
  }

  private async importPluginModule(pathname: string): Promise<PluginDefinition | undefined> {
    const resolvedPath = resolve(pathname)
    if (this.loadedModulePaths.has(resolvedPath)) {
      return undefined
    }
    this.loadedModulePaths.add(resolvedPath)
    const module = await import(pathToFileURL(resolvedPath).href)
    return (module.default ?? module.plugin) as PluginDefinition | undefined
  }

  private async loadLooseModules(
    pluginDirs: string[],
    ignoredRoots: Set<string>,
  ): Promise<void> {
    const files = await collectFilesByExtension(pluginDirs, [".mjs", ".js", ".mts"], 2)
    for (const file of files) {
      const resolvedFile = resolve(file)
      const ignored = [...ignoredRoots].some(root =>
        resolvedFile === root || resolvedFile.startsWith(`${root}${sep}`),
      )
      if (ignored) {
        continue
      }
      this.registerPlugin(await this.importPluginModule(resolvedFile))
    }
  }

  async load(pluginDirs: string[]): Promise<void> {
    const manifestRoots = new Set<string>()
    for (const root of pluginDirs) {
      const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue
        }
        const pluginRoot = join(root, entry.name)
        const resolvedManifestPath = await (async () => {
          for (const candidate of [
            join(pluginRoot, "plugin.json"),
            join(pluginRoot, ".oneclaw-plugin", "plugin.json"),
            join(pluginRoot, ".claude-plugin", "plugin.json"),
          ]) {
            const raw = await readTextIfExists(candidate)
            if (raw) {
              return { path: candidate, raw }
            }
          }
          return null
        })()
        if (!resolvedManifestPath) {
          continue
        }
        manifestRoots.add(resolve(pluginRoot))

        const manifest = safeJsonParse<PluginManifest>(resolvedManifestPath.raw, {
          name: entry.name,
        })
        const plugin: PluginDefinition = {
          name: manifest.name || basename(pluginRoot),
          systemPromptPatches: [...(manifest.systemPromptPatches ?? [])],
        }

        if (manifest.main) {
          const exported = await this.importPluginModule(join(pluginRoot, manifest.main))
          if (exported) {
            plugin.tools = exported.tools
            plugin.hooks = exported.hooks
            plugin.hookDefinitions = exported.hookDefinitions
            plugin.systemPromptPatches = [
              ...(plugin.systemPromptPatches ?? []),
              ...(exported.systemPromptPatches ?? []),
            ]
          }
        }

        if (manifest.hooksFile) {
          const hookRaw = await readTextIfExists(join(pluginRoot, manifest.hooksFile))
          if (hookRaw) {
            const parsed = safeJsonParse<HookDefinition[] | { hooks?: HookDefinition[] }>(hookRaw, [])
            const definitions = Array.isArray(parsed)
              ? parsed
              : (parsed.hooks ?? [])
            plugin.hookDefinitions = [
              ...(plugin.hookDefinitions ?? []),
              ...definitions,
            ]
          }
        }

        if (manifest.skillsDir) {
          const markdownFiles = await collectFilesByExtension([join(pluginRoot, manifest.skillsDir)], [".md"], 2)
          for (const file of markdownFiles) {
            const raw = await readTextIfExists(file)
            if (raw?.trim()) {
              plugin.systemPromptPatches = [
                ...(plugin.systemPromptPatches ?? []),
                raw.trim(),
              ]
            }
          }
        }

        this.registerPlugin(plugin)
      }
    }
    await this.loadLooseModules(pluginDirs, manifestRoots)
  }

  getTools() {
    return this.plugins.flatMap(plugin => plugin.tools ?? [])
  }

  getHooks() {
    return this.plugins.flatMap(plugin => (plugin.hooks ? [plugin.hooks] : []))
  }

  getHookDefinitions(): HookDefinition[] {
    return [...this.hookDefinitions]
  }

  getSystemPromptPatches(): string[] {
    return this.plugins.flatMap(plugin => plugin.systemPromptPatches ?? [])
  }
}
