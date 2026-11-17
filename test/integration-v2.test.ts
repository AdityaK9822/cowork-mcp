/**
 * v2 integration: config.json as the single store — per-workspace grants over
 * real stdio, the workspace_request_config flow (GUI disabled), and pending-
 * change detection in workspace_status. Run from the package directory after
 * `npm run build`.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const CWD = path.dirname(import.meta.dir)
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-it2-home-"))
const READONLY = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-it2-ro-"))
const NORMAL = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-it2-rw-"))
await fs.mkdir(HOME, { recursive: true })

const configPath = path.join(HOME, "config.json")
await fs.writeFile(
  configPath,
  JSON.stringify(
    {
      workspaces: [
        { path: READONLY, readOnly: true },
        { path: NORMAL, deny: { relative: ["vault/**"] } },
      ],
    },
    null,
    2,
  ),
  "utf8",
)
await fs.writeFile(path.join(READONLY, "doc.txt"), "immutable\n")
await fs.writeFile(path.join(NORMAL, ".env"), "SECRET=1\n")
await fs.writeFile(path.join(NORMAL, "app.py"), "print('hello')\n")

let child: ChildProcess | undefined
let buffer = ""
const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
let nextId = 1

function send(method: string, params?: unknown): Promise<any> {
  const id = nextId++
  child!.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }) + "\n")
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

child = spawn("node", [path.join(CWD, "dist", "index.cjs")], {
  env: { ...process.env, COWORK_HOME: HOME, COWORK_NO_GUI: "1" },
  stdio: ["pipe", "pipe", "pipe"],
})
child.stdout!.on("data", (chunk: Buffer) => {
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
child.stderr!.on("data", (chunk: Buffer) => process.stderr.write(`[server] ${chunk}`))

const call = async (name: string, args: Record<string, unknown>) => {
  const response = await send("tools/call", { name, arguments: args })
  const text = response.result?.content?.map((block: any) => block.text ?? "").join("\n") ?? ""
  return { response, text, isError: Boolean(response.result?.isError ?? response.error) }
}

const init = async () => {
  await send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "cowork-it2", version: "0" },
  })
  await send("notifications/initialized", {})
}

const readAudit = async () =>
  (await fs.readFile(path.join(HOME, "audit.jsonl"), "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))

describe("cowork-mcp v2 end-to-end", () => {
  afterAll(async () => {
    child?.kill()
    for (const dir of [HOME, READONLY, NORMAL]) await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
  })

  test("boots from config.json objects and lists the config tool", async () => {
    await init()
    const list = await send("tools/list", {})
    const names = list.result.tools.map((tool: any) => tool.name)
    expect(names).toContain("workspace_request_config")
  })

  test("read-only workspace denies write, allows read", async () => {
    await init()
    const denied = await call("write", { path: path.join(READONLY, "new.txt"), content: "x" })
    expect(denied.isError).toBe(true)
    expect(denied.text).toContain("write")
    expect(denied.text).toMatch(/not enabled|read-only/i)
    const ok = await call("read", { path: path.join(READONLY, "doc.txt") })
    expect(ok.text).toContain("immutable")
  })

  test("per-workspace deny rules block targeted reads and filter root-level search", async () => {
    await init()
    const targeted = await call("read", { path: path.join(NORMAL, "vault", "private.txt") })
    expect(targeted.isError).toBe(true)
    const deniedEntry = (await readAudit()).at(-1)
    expect(deniedEntry.result).toBe("denied")

    // Root-level grep sees the workspace but never the .env floor content…
    const wide = await call("grep", { pattern: "SECRET|print" })
    expect(wide.text).toContain("print('hello')")
    expect(wide.text).not.toContain("SECRET=1")
  })

  test("workspace_request_config refuses to spawn when the GUI is disabled and points at manual config", async () => {
    await init()
    const { text, isError } = await call("workspace_request_config", { reason: "test: add a folder" })
    expect(isError).toBe(false)
    expect(text).toContain('"launched": false')
    expect(text).toContain("config.json")
  })

  test("workspace_status reports pending config changes after an external edit", async () => {
    await init()
    const before = await call("workspace_status", {})
    expect(before.text).toContain('"configChangePending": false')
    await fs.writeFile(
      configPath,
      JSON.stringify({ workspaces: [{ path: READONLY, readOnly: true }, { path: NORMAL }] }, null, 2),
      "utf8",
    )
    const after = await call("workspace_status", {})
    expect(after.text).toContain('"configChangePending": true')
    expect(after.text).toContain('"readOnly": true')
  })
})
