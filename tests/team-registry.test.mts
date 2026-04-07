import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { TeamRegistry } from "../src/agents/team-registry.mts"
import { createTestConfig } from "./test-support.mts"

describe("TeamRegistry", () => {
  test("persists and reloads team state", () => {
    const config = createTestConfig()
    const storagePath = join(config.homeDir, "bridge", "teams.json")
    const first = new TeamRegistry(storagePath)
    first.create("qa-team", "QA coverage", { goal: "review release" })
    first.addAgent("qa-team", "session_1")
    first.setRole("qa-team", "session_1", "reviewer")
    first.setWorktree("qa-team", "session_1", "/tmp/worktrees/session_1")
    first.addTask("qa-team", "task_1")
    first.setReview("qa-team", "approved", "looks good")
    first.setMerge("qa-team", "ready", "ready to merge")
    first.setStatus("qa-team", "running")
    first.sendMessage("qa-team", "review ready")

    const second = new TeamRegistry(storagePath)
    const team = second.get("qa-team")

    expect(team?.description).toBe("QA coverage")
    expect(team?.goal).toBe("review release")
    expect(team?.status).toBe("running")
    expect(team?.agents).toEqual(["session_1"])
    expect(team?.roles).toEqual({ session_1: "reviewer" })
    expect(team?.worktrees).toEqual({ session_1: "/tmp/worktrees/session_1" })
    expect(team?.review?.status).toBe("approved")
    expect(team?.merge?.status).toBe("ready")
    expect(team?.tasks).toEqual(["task_1"])
    expect(team?.messages).toEqual(["review ready"])
  })

  test("notifies subscribers with updated team snapshots", () => {
    const registry = new TeamRegistry()
    const snapshots: string[] = []
    const unsubscribe = registry.subscribe(teams => {
      snapshots.push(teams.map(team => team.name).join(","))
    })

    registry.create("ops-team", "Ops")
    registry.addAgent("ops-team", "session_2")
    unsubscribe()

    expect(snapshots[0]).toBe("")
    expect(snapshots[snapshots.length - 1]).toBe("ops-team")
  })
})
