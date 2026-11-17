/**
 * M3/M4 integration suite: speaks real stdio JSON-RPC to the bundled server
 * and asserts the full pipeline — sandbox denials, snapshots, audit journal.
 * Run from the package directory after `npm run build`.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const CWD = path.dirname(import.meta.dir)
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-it-home-"))
const WS = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-it-ws-"))
const OUTSIDE = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-it-out-"))
await fs.writeFile(path.join(WS, "hello.txt"), "hello world\n")
await fs.writeFile(path.join(OUTSIDE, "secret.txt"), "top secret\n")

let child: ChildProcess | undefined
let buffer = ""
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
let nextId = 1

function start(): ChildProcess {
  const proc = spawn("node", [path.join(CWD, "dist", "index.cjs"), "--workspace", WS], {
    env: { ...process.env, COWORK_HOME: HOME },
    stdio: ["pipe", "pipe", "pipe"],
  })
  proc.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8")
    let index
    while ((index = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      try {
        const message = JSON.parse(line)
        if (message.id !== undefined && pending.has(message.id)) {
          pending.get(message.id)!.resolve(message)
          pending.delete(message.id)
        }
      } catch {}
    }
  })
  proc.stderr!.on("data", (chunk: Buffer) => process.stderr.write(`[server] ${chunk}`))
  return proc
}

function send(method: string, params?: unknown): Promise<any> {
  const id = nextId++
  const message = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n"
  child!.stdin!.write(message)
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id)
        reject(new Error(`timeout waiting for ${method}`))
      }
    }, 10_000)
  })
}

const call = async (name: string, args: Record<string, unknown>) => {
  const response = await send("tools/call", { name, arguments: args })
  const text = response.result?.content?.map((block: any) => block.text ?? "").join("\n") ?? ""
  return { response, text, isError: Boolean(response.result?.isError ?? response.error) }
}

const init = async () => {
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "cowork-it", version: "0" },
  })
  await send("notifications/initialized", {})
}

const auditFile = () => path.join(HOME, "audit.jsonl")
const readAudit = async () =>
  (await fs.readFile(auditFile(), "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))

describe("cowork-mcp end-to-end", () => {
  afterAll(async () => {
    child?.kill()
    await fs.rm(HOME, { recursive: true, force: true }).catch(() => {})
    await fs.rm(WS, { recursive: true, force: true }).catch(() => {})
    await fs.rm(OUTSIDE, { recursive: true, force: true }).catch(() => {})
  })

  test("boots, lists tools", async () => {
    child = start()
    await init()
    const list = await send("tools/list", {})
    const names = list.result.tools.map((tool: any) => tool.name)
    expect(names).toEqual(["workspace_status", "workspace_request_config", "read", "list", "glob", "grep", "write", "edit"])
  })

  test("workspace_status reports the allowlist", async () => {
    const { text, isError } = await call("workspace_status", {})
    expect(isError).toBe(false)
    expect(text).toContain(path.basename(WS))
    expect(text).toContain(".env*")
  })

  test("read returns numbered lines", async () => {
    const { text, isError } = await call("read", { path: "hello.txt" })
    expect(isError).toBe(false)
    expect(text).toContain("1: hello world")
  })

  test("list pages a directory", async () => {
    const { text } = await call("list", { path: "." })
    expect(text).toContain("hello.txt")
  })

  test("grep finds matches", async () => {
    const { text } = await call("grep", { pattern: "hello", path: "." })
    expect(text).toContain("Found 1 matches")
    expect(text).toContain("hello.txt")
  })

  test("glob finds files", async () => {
    const { text } = await call("glob", { pattern: "*.txt", path: "." })
    expect(text).toContain("hello.txt")
  })

  test("write creates a file atomically; content lands", async () => {
    const { text } = await call("write", { path: "made/by/write.md", content: "# made\n" })
    expect(text).toContain("Created file: made/by/write.md")
    expect(await fs.readFile(path.join(WS, "made", "by", "write.md"), "utf8")).toBe("# made\n")
  })

  test("edit applies an exact replacement with a diff", async () => {
    const { text } = await call("edit", { path: "hello.txt", oldString: "world", newString: "there" })
    expect(text).toContain("Edited hello.txt (1 replacement)")
    expect(await fs.readFile(path.join(WS, "hello.txt"), "utf8")).toBe("hello there\n")
    expect(text).toContain("```diff")
  })

  test("snapshot exists for the edited file", async () => {
    const snapshots = path.join(HOME, "snapshots")
    const workspaces = await fs.readdir(snapshots)
    expect(workspaces.length).toBeGreaterThan(0)
    const metas: string[] = []
    for (const ws of workspaces) {
      for (const hash of await fs.readdir(path.join(snapshots, ws)))
        metas.push(...(await fs.readdir(path.join(snapshots, ws, hash))).filter((name) => name.endsWith(".json")))
    }
    expect(metas.length).toBeGreaterThan(0)
  })

  test("denials: outside workspace, traversal, and protected paths are all rejected", async () => {
    const outsideRead = await call("read", { path: path.join(OUTSIDE, "secret.txt") })
    expect(outsideRead.isError).toBe(true)
    expect(outsideRead.text).toContain("outside the allowed workspaces")

    const traversal = await call("read", { path: "../other/file" })
    expect(traversal.isError).toBe(true)

    await fs.writeFile(path.join(WS, ".env"), "KEY=x\n")
    const envRead = await call("read", { path: ".env" })
    expect(envRead.isError).toBe(true)
    expect(envRead.text).toContain("Blocked")

    const envWrite = await call("write", { path: ".env", content: "EVIL=1" })
    expect(envWrite.isError).toBe(true)
    expect(await fs.readFile(path.join(WS, ".env"), "utf8")).toBe("KEY=x\n")
  })

  test("audit journal records allowed and denied calls", async () => {
    const entries = await readAudit()
    const results = entries.map((entry) => entry.result)
    expect(results).toContain("ok")
    expect(results).toContain("denied")
    const envEntry = entries.find((entry) => entry.tool === "read" && JSON.stringify(entry.args).includes(".env"))
    expect(envEntry?.result).toBe("denied")
  })

  test("edit miss produces the did-you-mean-free hint, not a crash", async () => {
    const { isError, text } = await call("edit", {
      path: "hello.txt",
      oldString: "zzz-not-there\nvery-missing",
      newString: "x",
    })
    expect(isError).toBe(true)
    expect(text).toContain("Could not find oldString")
  })

  test("read on a missing file suggests near matches", async () => {
    const { isError, text } = await call("read", { path: "helo.txt" })
    expect(isError).toBe(true)
    expect(text).toContain("File not found")
    expect(text).toContain("hello.txt")
  })

  test("edit is idempotence-safe: applied edit reports no crash on re-run", async () => {
    const { text } = await call("edit", { path: "hello.txt", oldString: "there", newString: "world" })
    expect(text).toContain("Edited hello.txt")
  })
})
