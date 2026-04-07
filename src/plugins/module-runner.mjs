import { mkdir, readFile, appendFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const HOOK_ALIASES = {
  session_start: ["session_start", "sessionStart"],
  before_model: ["before_model", "beforeModel", "beforeModelCall"],
  after_model: ["after_model", "afterModel", "afterModelCall"],
  before_tool: ["before_tool", "beforeTool", "beforeToolCall"],
  after_tool: ["after_tool", "afterTool", "afterToolCall"],
  session_end: ["session_end", "sessionEnd"],
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString("utf8")
}

function createLogger(prefix) {
  const write = level => message => {
    process.stderr.write(`[plugin:${prefix}:${level}] ${String(message)}\n`)
  }
  return {
    info: write("info"),
    warn: write("warn"),
    error: write("error"),
    debug: write("debug"),
  }
}

async function loadPlugin(modulePath) {
  const imported = await import(pathToFileURL(resolve(modulePath)).href)
  return imported.default ?? imported.plugin ?? imported
}

function serializeTool(tool) {
  if (!tool?.spec?.name) {
    return null
  }
  return {
    name: tool.spec.name,
    description: tool.spec.description ?? tool.spec.name,
    readOnly: Boolean(tool.spec.readOnly),
    inputSchema: tool.spec.inputSchema ?? { type: "object", properties: {} },
  }
}

function resolveHookHandler(plugin, eventName) {
  const candidates = HOOK_ALIASES[eventName] ?? [eventName]
  const hooks = plugin?.hooks && typeof plugin.hooks === "object" ? plugin.hooks : null
  for (const candidate of candidates) {
    const direct = plugin?.[candidate]
    if (typeof direct === "function") {
      return direct
    }
    const nested = hooks?.[candidate]
    if (typeof nested === "function") {
      return nested
    }
  }
  return null
}

function listModuleHooks(plugin) {
  return Object.keys(HOOK_ALIASES).filter(eventName =>
    typeof resolveHookHandler(plugin, eventName) === "function",
  )
}

function normalizeHookResult(result) {
  if (result == null) {
    return {
      ok: true,
      blocked: false,
      message: "",
      metadata: {},
    }
  }
  if (typeof result === "string") {
    return {
      ok: true,
      blocked: false,
      message: result,
      metadata: {},
    }
  }
  return {
    ok: result?.ok !== false && result?.blocked !== true,
    blocked: Boolean(result?.blocked),
    message: String(result?.message ?? result?.output ?? ""),
    metadata: result?.metadata ?? {},
  }
}

function createRuntimeContext(name, payload) {
  const memoryPath = payload.memoryPath
  return {
    cwd: payload.cwd,
    sessionId: payload.sessionId,
    config: payload.config,
    event: payload.event,
    logger: createLogger(name),
    memory: {
      read: async () => {
        if (!memoryPath) {
          return ""
        }
        try {
          return await readFile(memoryPath, "utf8")
        } catch {
          return ""
        }
      },
      append: async note => {
        if (!memoryPath) {
          return
        }
        await mkdir(dirname(memoryPath), { recursive: true })
        await appendFile(memoryPath, String(note).endsWith("\n") ? String(note) : `${String(note)}\n`)
      },
    },
    tasks: {
      list: () => Array.isArray(payload.tasks) ? payload.tasks : [],
    },
  }
}

async function inspectModule(modulePath) {
  const plugin = await loadPlugin(modulePath)
  return {
    name: plugin?.name ?? "plugin",
    systemPromptPatches: Array.isArray(plugin?.systemPromptPatches) ? plugin.systemPromptPatches : [],
    hookDefinitions: Array.isArray(plugin?.hookDefinitions) ? plugin.hookDefinitions : [],
    moduleHookEvents: listModuleHooks(plugin),
    tools: Array.isArray(plugin?.tools)
      ? plugin.tools.map(serializeTool).filter(Boolean)
      : [],
  }
}

async function executeTool(modulePath, exportedToolName, payload) {
  const plugin = await loadPlugin(modulePath)
  const tools = Array.isArray(plugin?.tools) ? plugin.tools : []
  const tool = tools.find(candidate => candidate?.spec?.name === exportedToolName)
  if (!tool) {
    throw new Error(`Plugin tool not found: ${exportedToolName}`)
  }
  const context = createRuntimeContext(exportedToolName, payload)

  const result = await tool.execute(payload.input ?? {}, context)
  return {
    ok: Boolean(result?.ok),
    output: String(result?.output ?? ""),
    metadata: result?.metadata ?? {},
  }
}

async function executeHook(modulePath, eventName, payload) {
  const plugin = await loadPlugin(modulePath)
  const hook = resolveHookHandler(plugin, eventName)
  if (!hook) {
    throw new Error(`Plugin hook not found: ${eventName}`)
  }
  const context = createRuntimeContext(eventName, {
    ...payload,
    event: eventName,
  })
  const inputPayload = payload.payload ?? {}
  const result = hook.length >= 2
    ? await hook(inputPayload, context)
    : await hook({
      event: eventName,
      payload: inputPayload,
      context,
    })
  return normalizeHookResult(result)
}

async function main() {
  const [mode, modulePath, name] = process.argv.slice(2)
  if (!mode || !modulePath) {
    throw new Error("Usage: module-runner.mjs <inspect|execute|hook> <modulePath> [toolName|eventName]")
  }

  if (mode === "inspect") {
    process.stdout.write(`${JSON.stringify(await inspectModule(modulePath))}\n`)
    return
  }

  if (mode === "execute") {
    if (!name) {
      throw new Error("Usage: module-runner.mjs execute <modulePath> <toolName>")
    }
    const raw = await readStdin()
    const payload = raw.trim() ? JSON.parse(raw) : {}
    process.stdout.write(`${JSON.stringify(await executeTool(modulePath, name, payload))}\n`)
    return
  }

  if (mode === "hook") {
    if (!name) {
      throw new Error("Usage: module-runner.mjs hook <modulePath> <eventName>")
    }
    const raw = await readStdin()
    const payload = raw.trim() ? JSON.parse(raw) : {}
    process.stdout.write(`${JSON.stringify(await executeHook(modulePath, name, payload))}\n`)
    return
  }

  throw new Error(`Unknown mode: ${mode}`)
}

await main()
