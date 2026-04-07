import { describe, expect, test } from "bun:test"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { startBridgeServer } from "../src/bridge/server.mts"

const envKeys = [
  "ONECLAW_HOME",
  "ONECLAW_PROVIDER",
  "ONECLAW_BRIDGE_PORT",
  "ONECLAW_BRIDGE_TOKEN",
] as const

const envSnapshot = Object.fromEntries(envKeys.map(key => [key, process.env[key]])) as Record<string, string | undefined>

function restoreEnv(): void {
  for (const key of envKeys) {
    const value = envSnapshot[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

async function readFirstSseChunk(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) {
    return ""
  }
  const { value } = await reader.read()
  await reader.cancel().catch(() => undefined)
  return value ? new TextDecoder().decode(value) : ""
}

describe("bridge streaming", () => {
  test("streams kernel events over SSE and closes with a result event", async () => {
    const root = join(tmpdir(), `oneclaw-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const homeDir = join(root, "home")
    await mkdir(homeDir, { recursive: true })

    process.env.ONECLAW_HOME = homeDir
    process.env.ONECLAW_PROVIDER = "internal-test"
    process.env.ONECLAW_BRIDGE_PORT = "0"

    const server = await startBridgeServer()
    try {
      const baseUrl = `http://${server.hostname}:${server.port}`
      const createSessionResponse = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ cwd: process.cwd() }),
      })
      expect(createSessionResponse.ok).toBe(true)
      const createSessionJson = await createSessionResponse.json() as { sessionId: string }

      const listedSessionsResponse = await fetch(`${baseUrl}/sessions`)
      expect(listedSessionsResponse.ok).toBe(true)
      const listedSessions = await listedSessionsResponse.json() as Array<{ id: string }>
      expect(listedSessions.some(session => session.id === createSessionJson.sessionId)).toBe(true)

      const streamResponse = await fetch(`${baseUrl}/sessions/${createSessionJson.sessionId}/query/stream`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt: "list files" }),
      })

      expect(streamResponse.ok).toBe(true)
      expect(streamResponse.headers.get("content-type")).toContain("text/event-stream")
      const streamText = await streamResponse.text()
      expect(streamText).toContain("event: iteration_started")
      expect(streamText).toContain("event: provider_text_delta")
      expect(streamText).toContain("event: tool_started")
      expect(streamText).toContain("event: result")
      expect(streamText).toContain("event: done")

      const historyResponse = await fetch(`${baseUrl}/sessions/${createSessionJson.sessionId}/history`)
      expect(historyResponse.ok).toBe(true)
      const historyPayload = await historyResponse.json() as { messages: Array<{ role: string }> }
      expect(historyPayload.messages.length > 0).toBe(true)

      const historyExportResponse = await fetch(`${baseUrl}/sessions/${createSessionJson.sessionId}/history/export?format=markdown`)
      expect(historyExportResponse.ok).toBe(true)
      expect(historyExportResponse.headers.get("content-type")).toContain("text/markdown")
      const historyExportText = await historyExportResponse.text()
      expect(historyExportText).toContain("# Session History")
      expect(historyExportText.toLowerCase()).toContain("list files")

      const exportResponse = await fetch(`${baseUrl}/sessions/${createSessionJson.sessionId}/export?format=markdown`)
      expect(exportResponse.ok).toBe(true)
      expect(exportResponse.headers.get("content-type")).toContain("text/markdown")
      const exportText = await exportResponse.text()
      expect(exportText).toContain("# Session")
      expect(exportText.toLowerCase()).toContain("list files")

      const bundleResponse = await fetch(`${baseUrl}/sessions/${createSessionJson.sessionId}/export/bundle`)
      expect(bundleResponse.ok).toBe(true)
      const bundlePayload = await bundleResponse.json() as {
        sessionId: string
        markdown: string
        session: { id: string }
      }
      expect(bundlePayload.sessionId).toBe(createSessionJson.sessionId)
      expect(bundlePayload.session.id).toBe(createSessionJson.sessionId)
      expect(bundlePayload.markdown).toContain("# Session")

      const cancelResponse = await fetch(`${baseUrl}/sessions/${createSessionJson.sessionId}/cancel`, {
        method: "POST",
      })
      expect(cancelResponse.ok).toBe(true)
    } finally {
      server.stop()
      restoreEnv()
    }
  })

  test("can cancel a running streamed session query", async () => {
    const root = join(tmpdir(), `oneclaw-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
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
    process.env.ONECLAW_BRIDGE_PORT = "0"

    const server = await startBridgeServer()
    try {
      const baseUrl = `http://${server.hostname}:${server.port}`
      const createSessionResponse = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ cwd: root }),
      })
      const { sessionId } = await createSessionResponse.json() as { sessionId: string }

      const streamResponsePromise = fetch(`${baseUrl}/sessions/${sessionId}/query/stream`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          prompt: 'run shell python3 -c "import time; time.sleep(5)"',
        }),
      })

      await new Promise(resolve => setTimeout(resolve, 250))
      const activeRequestsResponse = await fetch(`${baseUrl}/bridge/requests`)
      expect(activeRequestsResponse.ok).toBe(true)
      const activeRequests = await activeRequestsResponse.json() as Array<{
        requestId: string
        sessionId: string
      }>
      const activeRequest = activeRequests.find(item => item.sessionId === sessionId)
      expect(activeRequest).toBeTruthy()

      const cancelResponse = await fetch(`${baseUrl}/bridge/requests/${activeRequest?.requestId}/interrupt`, {
        method: "POST",
      })
      expect(cancelResponse.ok).toBe(true)

      const streamResponse = await streamResponsePromise
      const streamText = await streamResponse.text()
      expect(streamText).toContain("event: error")
      expect(streamText.toLowerCase()).toContain("cancel")

      const bridgeSessionResponse = await fetch(`${baseUrl}/bridge/sessions/${sessionId}`)
      expect(bridgeSessionResponse.ok).toBe(true)
      const bridgeSession = await bridgeSessionResponse.json() as { status: string }
      expect(bridgeSession.status).toBe("interrupted")

      const bridgeRequestResponse = await fetch(`${baseUrl}/bridge/requests/${activeRequest?.requestId}/session`)
      expect(bridgeRequestResponse.ok).toBe(true)
      const bridgeRequestSession = await bridgeRequestResponse.json() as { sessionId: string }
      expect(bridgeRequestSession.sessionId).toBe(sessionId)
    } finally {
      server.stop()
      restoreEnv()
    }
  })

  test("requires bridge auth when a token is configured", async () => {
    const root = join(tmpdir(), `oneclaw-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const homeDir = join(root, "home")
    await mkdir(homeDir, { recursive: true })

    process.env.ONECLAW_HOME = homeDir
    process.env.ONECLAW_PROVIDER = "internal-test"
    process.env.ONECLAW_BRIDGE_PORT = "0"
    process.env.ONECLAW_BRIDGE_TOKEN = "secret-token"

    const server = await startBridgeServer()
    try {
      const baseUrl = `http://${server.hostname}:${server.port}`
      const healthResponse = await fetch(`${baseUrl}/health`)
      expect(healthResponse.ok).toBe(true)

      const deniedResponse = await fetch(`${baseUrl}/state`)
      expect(deniedResponse.status).toBe(401)

      const allowedResponse = await fetch(`${baseUrl}/state`, {
        headers: {
          authorization: "Bearer secret-token",
        },
      })
      expect(allowedResponse.ok).toBe(true)
    } finally {
      server.stop()
      restoreEnv()
    }
  })

  test("supports scoped auth tokens and artifact exports", async () => {
    const root = join(tmpdir(), `oneclaw-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
    const homeDir = join(root, "home")
    await mkdir(homeDir, { recursive: true })

    await writeFile(join(homeDir, "oneclaw.config.json"), JSON.stringify({
      permissions: {
        mode: "allow",
        writableRoots: [root],
      },
      bridge: {
        authTokens: [
          { token: "read-token", scopes: ["read"] },
          { token: "write-token", scopes: ["write"] },
          { token: "control-token", scopes: ["control"] },
        ],
      },
    }, null, 2))

    process.env.ONECLAW_HOME = homeDir
    process.env.ONECLAW_PROVIDER = "internal-test"
    process.env.ONECLAW_BRIDGE_PORT = "0"
    delete process.env.ONECLAW_BRIDGE_TOKEN

    const server = await startBridgeServer()
    try {
      const baseUrl = `http://${server.hostname}:${server.port}`

      const missingAuthResponse = await fetch(`${baseUrl}/state`)
      expect(missingAuthResponse.status).toBe(401)

      const readStateResponse = await fetch(`${baseUrl}/state`, {
        headers: {
          authorization: "Bearer read-token",
        },
      })
      expect(readStateResponse.ok).toBe(true)

      const deniedCreateResponse = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: {
          authorization: "Bearer read-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ cwd: root }),
      })
      expect(deniedCreateResponse.status).toBe(403)

      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: {
          authorization: "Bearer write-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ cwd: root }),
      })
      expect(createResponse.status).toBe(201)
      const { sessionId } = await createResponse.json() as { sessionId: string }

      const queryResponse = await fetch(`${baseUrl}/sessions/${sessionId}/query`, {
        method: "POST",
        headers: {
          authorization: "Bearer write-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt: "list files" }),
      })
      expect(queryResponse.ok).toBe(true)

      const artifactCreateResponse = await fetch(`${baseUrl}/sessions/${sessionId}/export/artifact`, {
        method: "POST",
        headers: {
          authorization: "Bearer write-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({ format: "markdown", name: "review-export" }),
      })
      expect(artifactCreateResponse.status).toBe(201)
      const artifact = await artifactCreateResponse.json() as {
        id: string
        sessionId: string
        filename: string
      }
      expect(artifact.sessionId).toBe(sessionId)
      expect(artifact.filename).toContain("review-export")

      const sessionArtifactsResponse = await fetch(`${baseUrl}/sessions/${sessionId}/artifacts`, {
        headers: {
          authorization: "Bearer read-token",
        },
      })
      expect(sessionArtifactsResponse.ok).toBe(true)
      const sessionArtifacts = await sessionArtifactsResponse.json() as Array<{ id: string }>
      expect(sessionArtifacts.some(item => item.id === artifact.id)).toBe(true)

      const artifactsResponse = await fetch(`${baseUrl}/artifacts`, {
        headers: {
          authorization: "Bearer read-token",
        },
      })
      expect(artifactsResponse.ok).toBe(true)
      const artifacts = await artifactsResponse.json() as Array<{ id: string }>
      expect(artifacts.some(item => item.id === artifact.id)).toBe(true)

      const artifactContentResponse = await fetch(`${baseUrl}/artifacts/${artifact.id}/content`, {
        headers: {
          authorization: "Bearer read-token",
        },
      })
      expect(artifactContentResponse.ok).toBe(true)
      const artifactContent = await artifactContentResponse.text()
      expect(artifactContent).toContain("# Session")

      const deniedInterruptResponse = await fetch(`${baseUrl}/sessions/${sessionId}/interrupt`, {
        method: "POST",
        headers: {
          authorization: "Bearer read-token",
        },
      })
      expect(deniedInterruptResponse.status).toBe(403)

      const controlInterruptResponse = await fetch(`${baseUrl}/sessions/${sessionId}/interrupt`, {
        method: "POST",
        headers: {
          authorization: "Bearer control-token",
        },
      })
      expect(controlInterruptResponse.ok).toBe(true)
    } finally {
      server.stop()
      restoreEnv()
    }
  })

  test("supports background bridge tasks and team control-plane endpoints", async () => {
    const root = join(tmpdir(), `oneclaw-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
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
    process.env.ONECLAW_BRIDGE_PORT = "0"

    const server = await startBridgeServer()
    try {
      const baseUrl = `http://${server.hostname}:${server.port}`

      const createTeamResponse = await fetch(`${baseUrl}/teams`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: "qa-team", description: "QA task force", goal: "list files" }),
      })
      expect(createTeamResponse.status).toBe(201)
      const createdTeam = await createTeamResponse.json() as { goal?: string; status?: string; plan?: string[] }
      expect(createdTeam.goal).toBe("list files")
      expect(createdTeam.status).toBe("idle")
      expect(createdTeam.plan).toEqual([])

      const launchResponse = await fetch(`${baseUrl}/tasks/launch`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ goal: "list files", cwd: root, team: "qa-team" }),
      })
      expect(launchResponse.status).toBe(202)
      const launched = await launchResponse.json() as {
        tasks: Array<{ id: string }>
      }
      const taskId = launched.tasks[0]?.id
      expect(taskId).toBeTruthy()

      await new Promise(resolve => setTimeout(resolve, 250))

      const tasksResponse = await fetch(`${baseUrl}/tasks`)
      expect(tasksResponse.ok).toBe(true)
      const tasks = await tasksResponse.json() as Array<{ id: string }>
      expect(tasks.some(task => task.id === taskId)).toBe(true)

      const filteredTasksResponse = await fetch(`${baseUrl}/tasks?team=qa-team`)
      expect(filteredTasksResponse.ok).toBe(true)
      const filteredTasks = await filteredTasksResponse.json() as Array<{ id: string }>
      expect(filteredTasks.some(task => task.id === taskId)).toBe(true)

      const taskResponse = await fetch(`${baseUrl}/tasks/${taskId}`)
      expect(taskResponse.ok).toBe(true)
      const task = await taskResponse.json() as { id: string; status: string }
      expect(task.id).toBe(taskId)

      const taskSessionResponse = await fetch(`${baseUrl}/tasks/${taskId}/session`)
      expect(taskSessionResponse.ok).toBe(true)
      const taskSession = await taskSessionResponse.json() as { sessionId?: string }
      expect(typeof taskSession.sessionId).toBe("string")

      const outputResponse = await fetch(`${baseUrl}/tasks/${taskId}/output`)
      expect(outputResponse.ok).toBe(true)
      const output = await outputResponse.text()
      expect(output).toContain("[done]")

      const teamResponse = await fetch(`${baseUrl}/teams/qa-team`)
      expect(teamResponse.ok).toBe(true)
      const team = await teamResponse.json() as {
        name: string
        goal?: string
        status?: string
        plan?: string[]
        agents: string[]
        tasks: Array<{ id: string }>
        sessions: Array<{ sessionId: string }>
      }
      expect(team.name).toBe("qa-team")
      expect(team.goal).toBe("list files")
      expect(team.status).toBe("completed")
      expect(team.plan).toEqual(["list files"])
      expect(team.agents.length > 0).toBe(true)
      expect(team.tasks.some(item => item.id === taskId)).toBe(true)
      expect(team.sessions.length > 0).toBe(true)
      const agentId = team.agents[0]
      expect(agentId).toBeTruthy()

      const roleResponse = await fetch(`${baseUrl}/teams/qa-team/roles`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentId, role: "reviewer" }),
      })
      expect(roleResponse.ok).toBe(true)
      const roleTeam = await roleResponse.json() as { roles: Record<string, string> }
      expect(roleTeam.roles[agentId]).toBe("reviewer")

      const worktreeResponse = await fetch(`${baseUrl}/teams/qa-team/worktrees`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ agentId, path: root }),
      })
      expect(worktreeResponse.ok).toBe(true)
      const worktreeTeam = await worktreeResponse.json() as { worktrees: Record<string, string> }
      expect(worktreeTeam.worktrees[agentId]).toBe(root)

      const reviewResponse = await fetch(`${baseUrl}/teams/qa-team/review`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "approved", note: "looks good" }),
      })
      expect(reviewResponse.ok).toBe(true)
      const reviewTeam = await reviewResponse.json() as { review?: { status?: string } }
      expect(reviewTeam.review?.status).toBe("approved")

      const mergeResponse = await fetch(`${baseUrl}/teams/qa-team/merge`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ status: "ready", note: "ready to merge" }),
      })
      expect(mergeResponse.ok).toBe(true)
      const mergeTeam = await mergeResponse.json() as { merge?: { status?: string } }
      expect(mergeTeam.merge?.status).toBe("ready")

      const teamGoalResponse = await fetch(`${baseUrl}/teams/qa-team/goal`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ goal: "review release" }),
      })
      expect(teamGoalResponse.ok).toBe(true)
      const updatedGoal = await teamGoalResponse.json() as { goal?: string }
      expect(updatedGoal.goal).toBe("review release")

      const teamPlanResponse = await fetch(`${baseUrl}/teams/qa-team/plan`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ plan: ["inspect", "patch", "verify"] }),
      })
      expect(teamPlanResponse.ok).toBe(true)
      const updatedPlan = await teamPlanResponse.json() as { plan?: string[] }
      expect(updatedPlan.plan).toEqual(["inspect", "patch", "verify"])

      const teamRunResponse = await fetch(`${baseUrl}/teams/qa-team/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ goal: "review release", cwd: root, subtasks: ["inspect release", "summarize release"] }),
      })
      expect(teamRunResponse.status).toBe(202)
      const launchedTeamRun = await teamRunResponse.json() as {
        tasks: Array<{ id: string }>
      }
      expect(launchedTeamRun.tasks.length > 0).toBe(true)
      expect(launchedTeamRun.tasks.length).toBe(2)

      const teamTasksResponse = await fetch(`${baseUrl}/teams/qa-team/tasks`)
      expect(teamTasksResponse.ok).toBe(true)
      const teamTasks = await teamTasksResponse.json() as Array<{ id: string }>
      expect(teamTasks.some(item => item.id === taskId)).toBe(true)

      const teamSessionsResponse = await fetch(`${baseUrl}/teams/qa-team/sessions`)
      expect(teamSessionsResponse.ok).toBe(true)
      const teamSessions = await teamSessionsResponse.json() as Array<{ sessionId: string }>
      expect(teamSessions.length > 0).toBe(true)

      const teamTaskStreamResponse = await fetch(`${baseUrl}/tasks/stream?team=qa-team`)
      expect(teamTaskStreamResponse.ok).toBe(true)
      const teamTaskStreamText = await readFirstSseChunk(teamTaskStreamResponse)
      expect(teamTaskStreamText).toContain("event: tasks")
      expect(teamTaskStreamText).toContain(taskId as string)

      const teamSessionStreamResponse = await fetch(`${baseUrl}/bridge/sessions/stream?team=qa-team`)
      expect(teamSessionStreamResponse.ok).toBe(true)
      const teamSessionStreamText = await readFirstSseChunk(teamSessionStreamResponse)
      expect(teamSessionStreamText).toContain("event: sessions")
      expect(teamSessionStreamText).toContain("qa-team")

      const teamStreamResponse = await fetch(`${baseUrl}/teams/qa-team/stream`)
      expect(teamStreamResponse.ok).toBe(true)
      const teamStreamText = await readFirstSseChunk(teamStreamResponse)
      expect(teamStreamText).toContain("event: team")
      expect(teamStreamText).toContain("qa-team")

      const messageResponse = await fetch(`${baseUrl}/teams/qa-team/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ message: "review complete" }),
      })
      expect(messageResponse.ok).toBe(true)
      const updatedTeam = await messageResponse.json() as { messages: string[] }
      expect(updatedTeam.messages).toContain("review complete")
    } finally {
      server.stop()
      restoreEnv()
    }
  })

  test("persists bridge sessions across server restarts", async () => {
    const root = join(tmpdir(), `oneclaw-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
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
    process.env.ONECLAW_BRIDGE_PORT = "0"

    const first = await startBridgeServer()
    let sessionId = ""
    try {
      const baseUrl = `http://${first.hostname}:${first.port}`
      const createResponse = await fetch(`${baseUrl}/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ cwd: root }),
      })
      expect(createResponse.status).toBe(201)
      sessionId = (await createResponse.json() as { sessionId: string }).sessionId

      const queryResponse = await fetch(`${baseUrl}/sessions/${sessionId}/query`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({ prompt: "list files" }),
      })
      expect(queryResponse.ok).toBe(true)
    } finally {
      first.stop()
    }

    const second = await startBridgeServer()
    try {
      const baseUrl = `http://${second.hostname}:${second.port}`
      const sessionsResponse = await fetch(`${baseUrl}/bridge/sessions`)
      expect(sessionsResponse.ok).toBe(true)
      const sessions = await sessionsResponse.json() as Array<{ sessionId: string; status: string }>
      const restored = sessions.find(session => session.sessionId === sessionId)
      expect(restored).toBeTruthy()
      expect(["completed", "failed", "cancelled", "interrupted", "idle"]).toContain(restored?.status as string)
    } finally {
      second.stop()
      restoreEnv()
    }
  })

  test("can cancel a background bridge task", async () => {
    const root = join(tmpdir(), `oneclaw-bridge-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
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
    process.env.ONECLAW_BRIDGE_PORT = "0"

    const server = await startBridgeServer()
    try {
      const baseUrl = `http://${server.hostname}:${server.port}`
      const launchResponse = await fetch(`${baseUrl}/tasks/launch`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          goal: 'run shell python3 -c "import time; time.sleep(5)"',
          cwd: root,
        }),
      })
      expect(launchResponse.status).toBe(202)
      const launched = await launchResponse.json() as {
        tasks: Array<{ id: string }>
      }
      const taskId = launched.tasks[0]?.id
      expect(taskId).toBeTruthy()

      await new Promise(resolve => setTimeout(resolve, 300))

      const cancelResponse = await fetch(`${baseUrl}/tasks/${taskId}/cancel`, {
        method: "POST",
      })
      expect(cancelResponse.ok).toBe(true)

      await new Promise(resolve => setTimeout(resolve, 250))

      const taskResponse = await fetch(`${baseUrl}/tasks/${taskId}`)
      expect(taskResponse.ok).toBe(true)
      const task = await taskResponse.json() as { status: string }
      expect(task.status).toBe("killed")
    } finally {
      server.stop()
      restoreEnv()
    }
  })
})
