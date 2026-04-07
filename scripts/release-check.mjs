#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, "..")
const packageJson = await import(pathToFileURL(resolve(projectRoot, "package.json")).href, { with: { type: "json" } })
const version = packageJson.default.version
const binPath = resolve(projectRoot, packageJson.default.bin.one)
const installScript = resolve(projectRoot, "scripts", "install.mjs")

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

assert(typeof version === "string" && version.length > 0, "package version is required")
assert(existsSync(binPath), `bin target is missing: ${binPath}`)
assert(existsSync(installScript), `install script is missing: ${installScript}`)

if (process.platform !== "win32") {
  assert((statSync(binPath).mode & 0o111) !== 0, `bin target is not executable: ${binPath}`)
}

const launched = spawnSync(process.execPath, [binPath, "--version"], {
  cwd: projectRoot,
  encoding: "utf-8",
  env: {
    ...process.env,
    ONECLAW_PROVIDER: "internal-test",
  },
})

assert(launched.status === 0, `launcher failed: ${launched.stderr || launched.stdout}`)
assert(launched.stdout.trim() === version, `launcher version ${launched.stdout.trim()} does not match package version ${version}`)

process.stdout.write(JSON.stringify({
  ok: true,
  version,
  bin: binPath,
  installScript,
}, null, 2) + "\n")
