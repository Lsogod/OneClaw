#!/usr/bin/env node
import { chmod, lstat, mkdir, readFile, symlink, unlink, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir, platform } from "node:os"

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, "..")
const nodeLauncher = resolve(projectRoot, "bin", "one.mjs")
const unixLauncher = resolve(projectRoot, "bin", "one")
const isWindows = platform() === "win32"
const defaultTarget = isWindows
  ? resolve(process.env.LOCALAPPDATA ?? homedir(), "Programs", "OneClaw", "one.cmd")
  : resolve(homedir(), ".local", "bin", "one")
const target = resolve(process.env.ONECLAW_INSTALL_BIN ?? defaultTarget)
const targetDir = dirname(target)

await mkdir(targetDir, { recursive: true })
await chmod(nodeLauncher, 0o755).catch(() => undefined)
await chmod(unixLauncher, 0o755).catch(() => undefined)

const existingStat = await lstat(target).catch(error => {
  if (error && error.code === "ENOENT") {
    return undefined
  }
  throw error
})

if (existingStat) {
  const stat = existingStat
  if (isWindows && !stat.isSymbolicLink()) {
    const existing = await readFile(target, "utf-8").catch(() => "")
    if (!existing.includes("OneClaw installer shim")) {
      const backup = `${target}.bak`
      await writeFile(backup, `OneClaw installer refused to overwrite non-shim target: ${target}\n`)
      throw new Error(`Refusing to overwrite non-shim target: ${target}. Remove it or set ONECLAW_INSTALL_BIN.`)
    }
  } else if (!stat.isSymbolicLink()) {
    const backup = `${target}.bak`
    await writeFile(backup, `OneClaw installer refused to overwrite non-symlink target: ${target}\n`)
    throw new Error(`Refusing to overwrite non-symlink target: ${target}. Remove it or set ONECLAW_INSTALL_BIN.`)
  }
  await unlink(target)
}

if (isWindows) {
  const script = [
    "@echo off",
    "rem OneClaw installer shim",
    "setlocal",
    `node "${nodeLauncher}" %*`,
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n")
  await writeFile(target, script, "utf-8")
} else {
  await symlink(nodeLauncher, target)
}

process.stdout.write(JSON.stringify({
  ok: true,
  launcher: isWindows ? nodeLauncher : nodeLauncher,
  target,
  platform: platform(),
}, null, 2) + "\n")
