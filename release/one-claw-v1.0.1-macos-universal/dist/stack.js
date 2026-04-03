// @bun
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = import.meta.require;
var __using = (stack, value, async) => {
  if (value != null) {
    if (typeof value !== "object" && typeof value !== "function")
      throw TypeError('Object expected to be assigned to "using" declaration');
    let dispose;
    if (async)
      dispose = value[Symbol.asyncDispose];
    if (dispose === undefined)
      dispose = value[Symbol.dispose];
    if (typeof dispose !== "function")
      throw TypeError("Object not disposable");
    stack.push([async, dispose, value]);
  } else if (async) {
    stack.push([async]);
  }
  return value;
};
var __callDispose = (stack, error, hasError) => {
  let fail = (e) => error = hasError ? new SuppressedError(e, error, "An error was suppressed during disposal") : (hasError = true, e), next = (it) => {
    while (it = stack.pop()) {
      try {
        var result = it[1] && it[1].call(it[2]);
        if (it[0])
          return Promise.resolve(result).then(next, (e) => (fail(e), next()));
      } catch (e) {
        fail(e);
      }
    }
    if (hasError)
      throw error;
  };
  return next();
};

// packages/codex-anthropic-adapter/src/config.ts
function getAdapterHost() {
  return process.env.CODEX_ADAPTER_HOST || "127.0.0.1";
}
function getAdapterPort() {
  const raw = process.env.CODEX_ADAPTER_PORT || "4317";
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 4317;
}
function getAdapterBaseUrl() {
  return `http://${getAdapterHost()}:${getAdapterPort()}`;
}
function getCodexAppServerUrl() {
  return process.env.CODEX_APP_SERVER_URL || "ws://127.0.0.1:4318";
}
function getAdapterApiKey() {
  return process.env.CODEX_ADAPTER_API_KEY || "codex-local";
}

// packages/codex-anthropic-adapter/src/stack.ts
import { dirname, join } from "path";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
function getBunBinary() {
  return Bun.which("bun") || process.execPath;
}
function getAdapterEntry() {
  const here = dirname(fileURLToPath(import.meta.url));
  const built = join(here, "server.js");
  if (existsSync(built)) {
    return built;
  }
  return join(here, "server.ts");
}
function spawnManagedProcess(label, cmd) {
  const proc = Bun.spawn(cmd, {
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit"
  });
  proc.exited.then((code) => {
    if (code !== 0) {
      console.error(`[codex-stack] ${label} exited with code ${code}`);
    }
  });
  return proc;
}
async function main() {
  const appServer = spawnManagedProcess("codex app-server", [
    "codex",
    "app-server",
    "--listen",
    getCodexAppServerUrl()
  ]);
  const adapter = spawnManagedProcess("codex adapter", [
    getBunBinary(),
    getAdapterEntry()
  ]);
  const shutdown = () => {
    appServer.kill();
    adapter.kill();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await Promise.race([appServer.exited, adapter.exited]);
  shutdown();
}
await main();
