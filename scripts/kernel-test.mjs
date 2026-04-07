#!/usr/bin/env node
import { spawn } from "node:child_process"
import { dirname, resolve } from "node:path"
import { delimiter } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(here, "..")
const kernelRoot = resolve(projectRoot, "kernel")
const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3")
const existingPythonPath = process.env.PYTHONPATH
const pythonPath = existingPythonPath
  ? `${kernelRoot}${delimiter}${existingPythonPath}`
  : kernelRoot

const child = spawn(python, ["-m", "unittest", "discover", "-s", "kernel/tests"], {
  cwd: projectRoot,
  stdio: "inherit",
  shell: process.platform === "win32",
  env: {
    ...process.env,
    PYTHONPATH: pythonPath,
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
  process.stderr.write(`Failed to run Python kernel tests: ${error.message}\n`)
  process.exit(1)
})
