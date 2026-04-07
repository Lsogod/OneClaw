#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, "..")
const installScript = resolve(projectRoot, "scripts", "install.mjs")
const packageJson = await import(resolve(projectRoot, "package.json"), { with: { type: "json" } })
const target = join(
  tmpdir(),
  `oneclaw-install-smoke-${process.pid}${process.platform === "win32" ? ".cmd" : ""}`,
)

await rm(target, { force: true }).catch(() => undefined)

const install = spawnSync(process.execPath, [installScript], {
  cwd: projectRoot,
  encoding: "utf-8",
  env: {
    ...process.env,
    ONECLAW_INSTALL_BIN: target,
  },
})

if (install.status !== 0) {
  process.stderr.write(install.stderr || install.stdout)
  process.exit(install.status ?? 1)
}

const launched = spawnSync(target, ["--version"], {
  cwd: projectRoot,
  encoding: "utf-8",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    ONECLAW_PROVIDER: "internal-test",
  },
})

await rm(target, { force: true }).catch(() => undefined)

if (launched.status !== 0) {
  process.stderr.write(launched.stderr || launched.stdout)
  process.exit(launched.status ?? 1)
}

if (launched.stdout.trim() !== packageJson.default.version) {
  process.stderr.write(`Expected ${packageJson.default.version}, got ${launched.stdout.trim()}\n`)
  process.exit(1)
}

process.stdout.write(JSON.stringify({
  ok: true,
  target,
  version: launched.stdout.trim(),
}, null, 2) + "\n")
