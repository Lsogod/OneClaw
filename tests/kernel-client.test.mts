import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { KernelClient } from "../src/frontend/kernel-client.mts"

describe("KernelClient approvals", () => {
  test("forwards approval requests to the frontend and resumes the kernel run", async () => {
    const originalHome = process.env.ONECLAW_HOME
    const originalProvider = process.env.ONECLAW_PROVIDER
    const root = join(tmpdir(), `oneclaw-kernel-client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await mkdir(root, { recursive: true })

    process.env.ONECLAW_HOME = root
    process.env.ONECLAW_PROVIDER = "internal-test"
    const client = new KernelClient(root)

    try {
      const result = await client.runPrompt("run shell pwd", {
        cwd: root,
        onApprovalRequest: async request => {
          expect(request.toolName).toBe("run_shell")
          return true
        },
      })

      expect(result.text).toContain("Tool results received")
      expect(result.text).toContain(root)
    } finally {
      await client.close()
      if (originalHome === undefined) {
        delete process.env.ONECLAW_HOME
      } else {
        process.env.ONECLAW_HOME = originalHome
      }
      if (originalProvider === undefined) {
        delete process.env.ONECLAW_PROVIDER
      } else {
        process.env.ONECLAW_PROVIDER = originalProvider
      }
    }
  })

  test("can cancel a tracked request before a long-running shell tool finishes", async () => {
    const originalHome = process.env.ONECLAW_HOME
    const originalProvider = process.env.ONECLAW_PROVIDER
    const root = join(tmpdir(), `oneclaw-kernel-client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const homeDir = join(root, "home")
    await mkdir(homeDir, { recursive: true })
    await writeFile(join(homeDir, "oneclaw.config.json"), JSON.stringify({
      permissions: {
        mode: "allow",
        writableRoots: [root],
      },
    }, null, 2))

    process.env.ONECLAW_HOME = homeDir
    process.env.ONECLAW_PROVIDER = "internal-test"
    const client = new KernelClient(root)

    try {
      const tracked = client.runPromptTracked('run shell python3 -c "import time; time.sleep(5)"', {
        cwd: root,
      })
      await new Promise(resolve => setTimeout(resolve, 200))
      const cancelled = await client.cancelRequest(tracked.requestId)
      expect(cancelled.accepted).toBe(true)
      try {
        await tracked.promise
        expect("resolved").toBe("rejected")
      } catch (error) {
        expect(String(error)).toContain("cancel")
      }
    } finally {
      await client.close()
      if (originalHome === undefined) {
        delete process.env.ONECLAW_HOME
      } else {
        process.env.ONECLAW_HOME = originalHome
      }
      if (originalProvider === undefined) {
        delete process.env.ONECLAW_PROVIDER
      } else {
        process.env.ONECLAW_PROVIDER = originalProvider
      }
    }
  })

  test("closes cleanly without surfacing a kernel exit error", async () => {
    const originalHome = process.env.ONECLAW_HOME
    const originalProvider = process.env.ONECLAW_PROVIDER
    const root = join(tmpdir(), `oneclaw-kernel-client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    await mkdir(root, { recursive: true })

    process.env.ONECLAW_HOME = root
    process.env.ONECLAW_PROVIDER = "internal-test"
    const client = new KernelClient(root)

    try {
      await client.createSession(root)
      await client.close()
      expect("closed").toBe("closed")
    } finally {
      if (originalHome === undefined) {
        delete process.env.ONECLAW_HOME
      } else {
        process.env.ONECLAW_HOME = originalHome
      }
      if (originalProvider === undefined) {
        delete process.env.ONECLAW_PROVIDER
      } else {
        process.env.ONECLAW_PROVIDER = originalProvider
      }
    }
  })

  test("exposes status, context, config, plugin, skill, task, and config patch RPCs", async () => {
    const originalHome = process.env.ONECLAW_HOME
    const originalProvider = process.env.ONECLAW_PROVIDER
    const root = join(tmpdir(), `oneclaw-kernel-client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const homeDir = join(root, "home")
    await mkdir(homeDir, { recursive: true })

    process.env.ONECLAW_HOME = homeDir
    process.env.ONECLAW_PROVIDER = "internal-test"
    const client = new KernelClient(root)

    try {
      const session = await client.createSession(root, { via: "test" })
      const status = await client.status(session.id)
      const context = await client.context(session.id)
      const config = await client.config("permissions")
      const hooks = await client.hooks()
      const plugins = await client.plugins()
      const skills = await client.skills()
      const tasks = await client.tasks()
      const memory = await client.memory(session.id)
      const patched = await client.updateConfigPatch({
        output: { theme: "contrast" },
        permissions: { mode: "allow" },
      })
      const reloaded = await client.reload()
      const cleared = await client.clearSession(session.id, true)

      expect(status.session).toBeTruthy()
      expect((status.session as { id?: string }).id).toBe(session.id)
      expect(context.session).toBeTruthy()
      expect((context.session as { id?: string }).id).toBe(session.id)
      expect((config as { section?: string }).section).toBe("permissions")
      expect(Array.isArray((hooks as { hooks?: unknown[] }).hooks)).toBe(true)
      expect(Array.isArray((plugins as { plugins?: unknown[] }).plugins)).toBe(true)
      expect(Array.isArray((skills as { skills?: unknown[] }).skills)).toBe(true)
      expect(Array.isArray((tasks as { tasks?: unknown[] }).tasks)).toBe(true)
      expect((memory as { session?: { path?: string } }).session?.path).toContain(session.id)
      expect((patched.state as { theme?: string }).theme).toBe("contrast")
      expect((patched.state as { permissionMode?: string }).permissionMode).toBe("allow")
      expect((reloaded as { provider?: string }).provider).toBeTruthy()
      expect(cleared.clearedMemory).toBe(true)
    } finally {
      await client.close()
      if (originalHome === undefined) {
        delete process.env.ONECLAW_HOME
      } else {
        process.env.ONECLAW_HOME = originalHome
      }
      if (originalProvider === undefined) {
        delete process.env.ONECLAW_PROVIDER
      } else {
        process.env.ONECLAW_PROVIDER = originalProvider
      }
    }
  })
})
