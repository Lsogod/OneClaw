#!/usr/bin/env node
import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, "..")
const cli = resolve(root, "src", "cli.mts")
const bun = process.env.ONECLAW_BUN ?? "bun"
const pathSeparator = process.platform === "win32" ? ";" : ":"
const pathPrefix = `${resolve(homedir(), ".bun", "bin")}${pathSeparator}`
const child = spawn(bun, [cli, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdio: "inherit",
  shell: process.platform === "win32",
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
