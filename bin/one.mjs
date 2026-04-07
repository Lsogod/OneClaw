#!/usr/bin/env node
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..")
const cli = resolve(root, "src", "cli.mts")
const pathSeparator = process.platform === "win32" ? ";" : ":"
const bunBinDir = resolve(homedir(), ".bun", "bin")
const pathPrefix = `${bunBinDir}${pathSeparator}`

function resolveBunExecutable() {
  if (process.env.ONECLAW_BUN) {
    return process.env.ONECLAW_BUN
  }
  if (process.platform === "win32") {
    const bunExe = resolve(bunBinDir, "bun.exe")
    if (existsSync(bunExe)) {
      return bunExe
    }
    return "bun.exe"
  }
  return "bun"
}

const bun = resolveBunExecutable()
const child = spawn(bun, [cli, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: "inherit",
  shell: false,
  env: {
    ...process.env,
    PATH: `${pathPrefix}${process.env.PATH ?? ""}`,
  },
})

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})

child.on("error", error => {
  process.stderr.write(`Failed to launch OneClaw: ${error.message}\n`)
  process.exit(1)
})
