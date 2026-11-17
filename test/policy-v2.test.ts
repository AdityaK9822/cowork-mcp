/**
 * v2 policy tests: per-workspace grants (readOnly, tool toggles, deny globs),
 * the config single-store loader, additive argv/env, DXT seed migration, the
 * config pending-change handle, and the picker's validation rules.
 */
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadConfig } from "../src/config.ts"
import { loadDenylist } from "../src/policy/denylist.ts"
import { Roots } from "../src/policy/roots.ts"
import { openConfigFile, readConfig, writeConfig, upsertWorkspaceEntry } from "../src/policy/config-file.ts"
import { addWorkspace } from "../src/config-picker.ts"
import { authorize, searchResultBlocked, type ToolContext } from "../src/tools/context.ts"
import { Audit } from "../src/policy/audit.ts"
import { Snapshots } from "../src/policy/snapshot.ts"

const tmp = async () => await fs.mkdtemp(path.join(os.tmpdir(), "cowork-v2-"))
const warn = () => {
  const messages: string[] = []
  return { messages, fn: (message: string) => messages.push(message) }
}

async function buildCtx(configBody: object | undefined, argv: string[] = [], env: Record<string, string> = {}): Promise<ToolContext> {
  const home = await tmp()
  if (configBody !== undefined) await writeConfig(path.join(home, "config.json"), configBody as never)
  const config = await loadConfig(argv, { ...env, COWORK_HOME: home }, warn().fn)
  return {
    roots: new Roots(config.workspaces),
    denylist: loadDenylist(config.dataHome, config.homedir, config.deny),
    audit: new Audit(path.join(config.dataHome, "audit.jsonl")),
    snapshots: new Snapshots(path.join(config.dataHome, "snapshots")),
    config: await openConfigFile(config.configPath),
  }
}

describe("loadConfig: v2 object entries", () => {
  test("legacy string entries still parse with default grants", async () => {
    const dir = await tmp()
    const ctx = await buildCtx({ workspaces: [dir] })
    expect(ctx.roots.workspacesGrantedView()).toHaveLength(1)
    const [ws] = ctx.roots.workspacesGrantedView()
    expect(ws!.readOnly).toBe(false)
    expect(ws!.tools.write).toBe(true)
    expect(ws!.deny.relative).toEqual([])
  })

  test("object entries carry readOnly, toggles, and deny rules", async () => {
    const dir = await tmp()
    await fs.writeFile(path.join(dir, "secret.key"), "----")
    const ctx = await buildCtx({
      workspaces: [
        {
          path: dir,
          readOnly: true,
          tools: { write: false, edit: false, list: false },
          deny: { relative: ["notes/private/**"], allow: ["notes/private/PUBLIC.md"] },
        },
      ],
    })
    const [ws] = ctx.roots.workspacesGrantedView()
    expect(ws!.readOnly).toBe(true)
    expect(ws!.tools.read).toBe(true)
    expect(ws!.tools.list).toBe(false)
    expect(ws!.deny.relative).toEqual(["notes/private/**"])
    expect(ws!.deny.allow).toEqual(["notes/private/PUBLIC.md"])
  })

  test("'read' cannot be disabled; unknown toggles warn but are dropped", async () => {
    const warn = { messages: [] as string[], fn: (m: string) => warn.messages.push(m) }
    const home = await tmp()
    const dir = await tmp()
    await writeConfig(path.join(home, "config.json"), { workspaces: [{ path: dir, tools: { read: false, write: false, nosuch: false } }] })
    const config = await loadConfig([], { COWORK_HOME: home }, warn.fn)
    expect(config.workspaces).toHaveLength(1)
    expect(config.workspaces[0]!.grant.tools.read).toBeUndefined()
    expect(config.workspaces[0]!.grant.tools.write).toBe(false)
    expect(warn.messages.join("\n")).toContain("'read' cannot be disabled")
    expect(warn.messages.join("\n")).toContain("unknown tool toggle 'nosuch'")
  })

  test("glob characters in per-workspace 'allow' are rejected with a warning, not an error", async () => {
    const warn = { messages: [] as string[], fn: (m: string) => warn.messages.push(m) }
    const home = await tmp()
    const dir = await tmp()
    await writeConfig(path.join(home, "config.json"), { workspaces: [{ path: dir, deny: { allow: ["secrets/*.md"] } }] })
    const config = await loadConfig([], { COWORK_HOME: home }, warn.fn)
    expect(config.workspaces).toHaveLength(1)
    expect(config.workspaces[0]!.grant.denyAllow).toEqual([])
    expect(warn.messages.join("\n")).toContain("exact paths without glob characters")
  })

  test("argv and env are additive to the file store and dedupe by realpath", async () => {
    const dir = await tmp()
    const other = await tmp()
    const ctx = await buildCtx({ workspaces: [dir] }, ["--workspace", other, "--workspace", dir], { COWORK_WORKSPACES: other })
    // dir appears in file + argv + env; other twice: dedupe keeps both dirs, once each.
    // macOS symlinks tmp dirs (/var → /private/var), so compare resolved roots.
    const real = (p: string) => fs.realpath(p)
    const expected = [(await real(dir)), (await real(other))].sort()
    expect(ctx.roots.workspacesGrantedView().map((ws) => ws.real).sort()).toEqual(expected)
  })

  test("DXT seeds migrate into the file exactly once", async () => {
    const home = await tmp()
    const dir = await tmp()
    const first = await loadConfig([], { COWORK_HOME: home, COWORK_SEED_1: dir }, warn().fn)
    expect(first.workspaces).toHaveLength(1)
    const { config } = await readConfig(path.join(home, "config.json"))
    expect(config.workspaces).toEqual([dir])
    // Second boot with the same seeds: file already populated, no change.
    const second = await loadConfig([], { COWORK_HOME: home, COWORK_SEED_1: dir }, warn().fn)
    expect(second.workspaces).toHaveLength(1)
  })
})

describe("per-workspace enforcement", () => {
  test("readOnly blocks write and edit, but not read", async () => {
    const dir = await tmp()
    await fs.writeFile(path.join(dir, "doc.txt"), "hello")
    const ctx = await buildCtx({ workspaces: [{ path: dir, readOnly: true }] })
    await expect(authorize(ctx, "write", "doc.txt")).rejects.toThrow(/read-only|not enabled/)
    await expect(authorize(ctx, "edit", "doc.txt")).rejects.toThrow()
    const target = await authorize(ctx, "read", "doc.txt")
    expect(target.workspace.grant.readOnly).toBe(true)
  })

  test("a disabled tool denies that tool only", async () => {
    const dir = await tmp()
    await fs.writeFile(path.join(dir, "a.txt"), "hi")
    const ctx = await buildCtx({ workspaces: [{ path: dir, tools: { grep: false } }] })
    await expect(authorize(ctx, "grep", "a.txt")).rejects.toThrow(/tool 'grep' is not enabled/)
    const target = await authorize(ctx, "read", "a.txt")
    expect(target.relative).toBe("a.txt")
  })

  test("per-workspace deny globs block, exact allow exceptions rescue, global floor stays", async () => {
    const dir = await tmp()
    await fs.writeFile(path.join(dir, ".env.local"), "K=v")
    const ctx = await buildCtx({
      workspaces: [{ path: dir, deny: { relative: ["vault/**"], allow: ["vault/PUBLIC.md", ".env.local"] } }],
    })
    await expect(authorize(ctx, "read", "vault/private.txt")).rejects.toThrow(/workspace rule \(vault\/\*\*\)/)
    await expect(authorize(ctx, "read", "vault/PUBLIC.md")).resolves.toBeTruthy()
    // The per-workspace allow CANNOT excuse the global floor (.env*).
    await expect(authorize(ctx, "read", ".env.local")).rejects.toThrow(/protected file pattern/)
  })

  test("searchResultBlocked filters the global floor in workspace-wide search", () => {
    const global = { relative: [".env*"], allow: [] }
    const ws = { relative: ["tmp/**"], allow: ["tmp/ok.txt"] }
    expect(searchResultBlocked(global, ws, ".env.local")).toBe(true)
    expect(searchResultBlocked(global, ws, "tmp/private.txt")).toBe(true)
    expect(searchResultBlocked(global, ws, "tmp/ok.txt")).toBe(false)
    expect(searchResultBlocked(global, ws, "src/main.ts")).toBe(false)
  })
})

describe("config file handle", () => {
  test("pendingChange flips when the file changes after boot", async () => {
    const home = await tmp()
    const dir = await tmp()
    await writeConfig(path.join(home, "config.json"), { workspaces: [dir] })
    const handle = await openConfigFile(path.join(home, "config.json"))
    expect(await handle!.pendingChange()).toBe(false)
    await writeConfig(path.join(home, "config.json"), { workspaces: [dir], deny: { relative: ["x/**"] } })
    expect(await handle!.pendingChange()).toBe(true)
  })

  test("a file that appears after boot counts as pending", async () => {
    const home = await tmp()
    const missing = path.join(home, "config.json")
    const handle = await openConfigFile(missing)
    expect(handle!.bootHash).not.toBe("absent")
    await writeConfig(missing, { workspaces: [] })
    expect(await handle!.pendingChange()).toBe(true)
  })

  test("upsertWorkspaceEntry replaces by path and keeps other sections", async () => {
    const config = { deny: { relative: ["a/**"] }, workspaces: [{ path: "/x", readOnly: true }] }
    const next = upsertWorkspaceEntry(config as never, { path: "/x", readOnly: false }, (p) => path.resolve(p))
    expect(next.workspaces).toEqual([{ path: "/x" }])
    expect(next.deny).toEqual({ relative: ["a/**"] })
  })
})

describe("picker validation (addWorkspace)", () => {
  test("connects a valid directory with defaults and refuses the data home", async () => {
    const home = await tmp()
    const dir = await tmp()
    const outcome = await addWorkspace({ configPath: path.join(home, "config.json"), dataHome: home, homedir: home, selected: dir, existingRoots: [] })
    expect(outcome.status).toBe("connected")
    const { config } = await readConfig(path.join(home, "config.json"))
    expect(config.workspaces).toHaveLength(1)

    const wholeHome = await addWorkspace({ configPath: path.join(home, "config.json"), dataHome: home, homedir: home, selected: home, existingRoots: [] })
    expect(wholeHome.status).toBe("invalid")
  })

  test("rejects a folder inside an existing workspace without touching config", async () => {
    const home = await tmp()
    const dir = await tmp()
    const nested = await fs.mkdtemp(path.join(dir, "nested-"))
    const outcome = await addWorkspace({
      configPath: path.join(home, "config.json"),
      dataHome: home,
      homedir: home,
      selected: nested,
      existingRoots: [dir],
    })
    expect(outcome.status).toBe("invalid")
    expect(outcome.reason).toMatch(/already inside a connected workspace/)
    const { config } = await readConfig(path.join(home, "config.json"))
    expect(config.workspaces ?? []).toHaveLength(0)
  })

  test("re-connecting the same folder reports 'already connected' and preserves grants", async () => {
    const home = await tmp()
    const dir = await tmp()
    await writeConfig(path.join(home, "config.json"), { workspaces: [{ path: dir, readOnly: true }] })
    const outcome = await addWorkspace({
      configPath: path.join(home, "config.json"),
      dataHome: home,
      homedir: home,
      selected: dir,
      existingRoots: [dir],
    })
    expect(outcome.status).toBe("connected")
    expect(outcome.reason).toMatch(/unchanged/)
    const { config } = await readConfig(path.join(home, "config.json"))
    expect(config.workspaces).toEqual([{ path: dir, readOnly: true }])
  })
})
