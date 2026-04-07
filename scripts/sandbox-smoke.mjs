#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, "..")
const launcher = resolve(projectRoot, "bin", "one.mjs")
const root = await mkdtemp(join(tmpdir(), "oneclaw-sandbox-smoke-"))
const home = join(root, "home")
const workspace = join(root, "workspace")
const marker = join(root, "sandbox-wrapper.log")
const wrapper = join(root, "sandbox-wrapper.mjs")

try {
  await writeFile(wrapper, `
import { appendFileSync } from "node:fs"
import { spawnSync } from "node:child_process"
appendFileSync(${JSON.stringify(marker)}, "sandbox-wrapper\\n")
const [command, ...args] = process.argv.slice(2)
const result = spawnSync(command, args, { stdio: "inherit", shell: false })
if (result.error) {
  console.error(result.error.message)
  process.exit(1)
}
process.exit(result.status ?? 0)
`.trim() + "\n", "utf8")

  await mkdir(home, { recursive: true })
  await mkdir(workspace, { recursive: true })
  await writeFile(join(home, "oneclaw.config.json"), JSON.stringify({
    permissions: {
      mode: "allow",
      writableRoots: [workspace],
    },
    sandbox: {
      enabled: true,
      command: process.execPath,
      args: [wrapper],
      failIfUnavailable: true,
    },
  }, null, 2), "utf8")

  const result = spawnSync(process.execPath, [
    launcher,
    "-p",
    "run shell echo sandbox-e2e",
    "--output-format",
    "json",
  ], {
    cwd: workspace,
    encoding: "utf8",
    env: {
      ...process.env,
      ONECLAW_HOME: home,
      ONECLAW_PROVIDER: "internal-test",
    },
  })

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout)
    process.exit(result.status ?? 1)
  }
  const markerText = await readFile(marker, "utf8").catch(() => "")
  if (!markerText.includes("sandbox-wrapper")) {
    process.stderr.write("Sandbox wrapper was not invoked.\n")
    process.exit(1)
  }
  const parsed = JSON.parse(result.stdout)
  if (!String(parsed.text ?? "").includes("sandbox-e2e")) {
    process.stderr.write(`Expected sandbox command output, got: ${result.stdout}\n`)
    process.exit(1)
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    strategy: "command",
    marker,
  }, null, 2) + "\n")
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => undefined)
}
