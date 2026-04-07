import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { PermissionPolicy } from "../src/runtime/permission-policy.mts"

describe("PermissionPolicy", () => {
  test("allows read-only tools in deny mode", async () => {
    const policy = new PermissionPolicy({
      mode: "deny",
      writableRoots: [process.cwd()],
      commandAllowlist: [],
      deniedCommands: [],
      pathRules: [],
    })

    const decision = await policy.decide(
      {
        name: "read_file",
        description: "",
        inputSchema: {},
        readOnly: true,
      },
      { path: "./README.md" },
      process.cwd(),
    )

    expect(decision.allowed).toBe(true)
  })

  test("denies mutating tools in deny mode", async () => {
    const policy = new PermissionPolicy({
      mode: "deny",
      writableRoots: [process.cwd()],
      commandAllowlist: [],
      deniedCommands: [],
      pathRules: [],
    })

    const decision = await policy.decide(
      {
        name: "write_file",
        description: "",
        inputSchema: {},
        readOnly: false,
      },
      { path: "./README.md", content: "x" },
      process.cwd(),
    )

    expect(decision.allowed).toBe(false)
  })

  test("denies implicit cwd access outside writable roots", async () => {
    const policy = new PermissionPolicy({
      mode: "allow",
      writableRoots: [process.cwd()],
      commandAllowlist: [],
      deniedCommands: [],
      pathRules: [],
    })

    const decision = await policy.decide(
      {
        name: "list_files",
        description: "",
        inputSchema: {},
        readOnly: true,
      },
      {},
      tmpdir(),
    )

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain("outside writable roots")
  })
})
