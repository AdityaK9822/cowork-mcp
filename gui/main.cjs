// cowork-gui — Electron MAIN process. Owns every privileged operation:
// reading/writing config.json, talking to the native dialogs, walking the
// tree for dry-run counts, and appending audit entries. The renderer is
// sandboxed (contextIsolation on, nodeIntegration off, no remote, no
// navigation) and talks only through the contextBridge API defined in
// preload.cjs.

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron")
const fs = require("node:fs/promises")
const fsSync = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const crypto = require("node:crypto")
const { spawn } = require("node:child_process")
const picomatch = require("picomatch")

const REQUEST_TIMEOUT_MS = 10 * 60 * 1000
const TOOL_NAMES = ["read", "list", "glob", "grep", "write", "edit"]
const DEFAULT_RELATIVE = [".env*", "*.pem", "*.key", "id_rsa*", "**/.git/**", ".git", ".npmrc"]

const slash = (value) => value.replaceAll("\\", "/")
const inside = (child, parent) => slash(child) === slash(parent) || slash(child).startsWith(`${slash(parent)}/`)

let request = null // { id, reason, configPath, dataHome, timeoutAt }
let lockPath = null
let win = null

// ---------- helpers mirrored from the server's policy layer (the server's
// loadConfig stays the parser of record at next boot; invalid entries written
// here are skipped-with-warning there, so a GUI bug can widen nothing) ----------

function normalizeEntry(entry) {
  const out = {
    path: entry.path,
    readOnly: entry.readOnly === true,
    tools: {},
    denyRelative: [],
    denyAllow: [],
  }
  if (entry.tools && typeof entry.tools === "object") {
    for (const [key, value] of Object.entries(entry.tools)) {
      if (!TOOL_NAMES.includes(key)) continue
      if (key === "read" && value === false) continue // read cannot be disabled
      if (value === false) out.tools[key] = false
    }
  }
  for (const pattern of Array.isArray(entry.denyRelative) ? entry.denyRelative : []) {
    if (typeof pattern === "string" && pattern !== "") out.denyRelative.push(pattern)
  }
  for (const allow of Array.isArray(entry.denyAllow) ? entry.denyAllow : []) {
    if (typeof allow === "string" && allow !== "" && !/[*?[\]!{}]/.test(allow)) out.denyAllow.push(slash(allow))
  }
  return out
}

/** `read` is forced on in normalizeEntry, so a workspace can never become inert. */
const entryProblems = () => []

function matchesRelative(pattern, rel) {
  const options = { dot: true, matchBase: !pattern.includes("/") }
  return picomatch.isMatch(rel, pattern, options) || picomatch.isMatch(rel.split("/").pop() ?? "", pattern, { dot: true })
}

async function realPathLexical(target) {
  try {
    return await fs.realpath(target)
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error
  }
  const parent = path.dirname(target)
  return path.join(await realPathLexical(parent), path.basename(target))
}

function atomicWriteSync(file, body) {
  const directory = path.dirname(file)
  fsSync.mkdirSync(directory, { recursive: true })
  const temp = path.join(directory, `.${path.basename(file)}.${crypto.randomUUID()}.tmp`)
  const handle = fsSync.openSync(temp, "wx", 0o600)
  try {
    fsSync.writeFileSync(handle, body, "utf8")
    fsSync.fsyncSync(handle)
  } finally {
    fsSync.closeSync(handle)
  }
  fsSync.renameSync(temp, file)
}

function auditAppend(auditFile, entry) {
  try {
    fsSync.mkdirSync(path.dirname(auditFile), { recursive: true })
    fsSync.appendFileSync(auditFile, `${JSON.stringify(entry)}\n`, "utf8")
  } catch {
    // The journal never breaks the window.
  }
}

/** Bounded walk for the dry-run preview: stops at 10k entries. */
function countMatches(root, patterns, allow) {
  let visited = 0
  let matched = 0
  const walk = (dir, relBase) => {
    if (visited >= 10000) return
    let entries
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (++visited >= 10000) return
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), rel)
      } else if (entry.isFile()) {
        if (allow.includes(rel)) continue
        for (const pattern of patterns) {
          if (matchesRelative(pattern, rel)) {
            matched++
            break
          }
        }
      }
    }
  }
  walk(root, "")
  return { matched, visited, bounded: visited >= 10000 }
}

async function auditTail(auditFile, lines = 10) {
  let raw
  try {
    raw = await fs.readFile(auditFile, "utf8")
  } catch {
    return []
  }
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-lines)
    .map((line) => {
      try {
        const entry = JSON.parse(line)
        return { ts: entry.ts, tool: entry.tool, workspace: entry.workspace, result: entry.result, reason: entry.reason }
      } catch {
        return { ts: "", tool: "unparsed", result: "error" }
      }
    })
}

// ---------- validation for candidate workspace paths ----------

async function candidateProblems(selectedPath, config) {
  const problems = []
  let real
  try {
    const stat = await fs.stat(selectedPath)
    if (!stat.isDirectory()) return ["not a directory"]
    real = await realPathLexical(selectedPath)
  } catch (error) {
    return [`cannot access: ${error.message}`]
  }
  const dataHome = request?.dataHome ?? path.join(os.homedir(), ".cowork-mcp")
  if (inside(real, dataHome)) problems.push("inside the Cowork data directory")
  if (slash(real) === slash(os.homedir())) problems.push("the entire home directory cannot be a workspace")
  for (const entry of config.workspaces ?? []) {
    const existing = typeof entry === "string" ? entry : entry.path
    try {
      const existingReal = await realPathLexical(existing)
      if (slash(real) === slash(existingReal)) return ["already connected"]
      if (inside(real, existingReal)) problems.push(`inside existing workspace ${existing}`)
      if (inside(existingReal, real)) problems.push(`contains existing workspace ${existing}`)
    } catch {
      // Skip entries that do not resolve; the server warns about them at boot too.
    }
  }
  return problems
}

// ---------- IPC surface (the renderer sees only these) ----------

function currentConfig() {
  const configPath = request?.configPath ?? path.join(os.homedir(), ".cowork-mcp", "config.json")
  let config = {}
  try {
    config = JSON.parse(fsSync.readFileSync(configPath, "utf8"))
  } catch {
    // Missing or invalid config behaves like an empty one; the server does the same.
  }
  return { configPath, config }
}

function registerIpc() {
  ipcMain.handle("cowork:getState", async () => {
    const { configPath, config } = currentConfig()
    const auditFile = path.join(request?.dataHome ?? path.join(os.homedir(), ".cowork-mcp"), "audit.jsonl")
    return {
      reason: request?.reason ?? "",
      configPath,
      dataHome: request?.dataHome ?? "",
      workspaces: await Promise.all(
        (config.workspaces ?? []).map(async (entry) => {
          const source = typeof entry === "string" ? { path: entry } : entry
          let real = source.path
          try {
            real = await realPathLexical(source.path)
          } catch {}
          const normalized = normalizeEntry({ path: source.path, readOnly: source.readOnly, tools: source.tools, denyRelative: source.deny?.relative ?? [], denyAllow: source.deny?.allow ?? [] })
          return { ...normalized, real, name: path.basename(real) }
        }),
      ),
      floor: { relative: DEFAULT_RELATIVE, note: "Protected for every workspace. Extend with deny rules; never removable." },
      audit: await auditTail(auditFile),
    }
  })

  ipcMain.handle("cowork:pickFolder", async () => {
    const result = await dialog.showOpenDialog(win, {
      title: "Choose a folder to connect",
      properties: ["openDirectory", "dontAddToRecentDirs"],
    })
    if (result.canceled || result.filePaths.length === 0) return undefined
    return result.filePaths[0]
  })

  ipcMain.handle("cowork:pathForDrag", async (_event, droppedPath) => {
    // The renderer sends the PATH string from webUtils.getPathForFile only.
    return typeof droppedPath === "string" ? droppedPath : undefined
  })

  ipcMain.handle("cowork:validate", async (_event, candidate) => {
    const { config } = currentConfig()
    const problems = await candidateProblems(candidate, config)
    return { problems, real: problems.length === 0 ? await realPathLexical(candidate) : undefined }
  })

  ipcMain.handle("cowork:dryRun", async (_event, payload) => {
    // payload: { root, denyRelative[] } — counts files the proposed globs would block.
    const { config } = currentConfig()
    const entry = (config.workspaces ?? []).find((e) => (typeof e === "string" ? e : e.path) === payload.root)
    const source = typeof entry === "string" ? { denyRelative: [] } : entry ?? {}
    const allow = [...(source.deny?.allow ?? []).map(slash)]
    return countMatches(payload.root, [...DEFAULT_RELATIVE, ...(payload.denyRelative ?? [])], allow)
  })

  ipcMain.handle("cowork:apply", async (_event, payload) => {
    // payload: { workspaces: [{ path, real, readOnly, tools, denyRelative, denyAllow }] }
    const { configPath } = currentConfig()
    const seen = new Set()
    const normalizedList = []
    for (const entry of payload.workspaces ?? []) {
      const problems = await candidateProblems(entry.path, { workspaces: normalizedList.map((e) => ({ path: e.path })) })
      if (problems.length > 0 && problems[0] !== "already connected") return { ok: false, error: `${entry.path}: ${problems.join("; ")}` }
      if (problems.length > 0) continue // already connected at its existing grant — leave untouched
      const key = entry.real ?? entry.path
      if (seen.has(key)) continue
      seen.add(key)
      normalizedList.push(normalizeEntry(entry))
    }
    const next = { workspaces: normalizedList.map((entry) => ({
      path: entry.path,
      ...(entry.readOnly ? { readOnly: true } : {}),
      ...(Object.keys(entry.tools).length > 0 ? { tools: entry.tools } : {}),
      ...(entry.denyRelative.length > 0 || entry.denyAllow.length > 0
        ? { deny: { ...(entry.denyRelative.length ? { relative: entry.denyRelative } : {}), ...(entry.denyAllow.length ? { allow: entry.denyAllow } : {}) } }
        : {}),
    })) }
    try {
      atomicWriteSync(configPath, `${JSON.stringify(next, null, 2)}\n`)
    } catch (error) {
      audit(configPath, next, "error", error.message)
      return { ok: false, error: `could not write config: ${error.message}` }
    }
    audit(configPath, next, "ok")
    return { ok: true, note: "Takes effect after Claude Desktop restarts this server." }
  })

  function audit(configPath, next, result, reason) {
    auditAppend(
      path.join(request?.dataHome ?? path.join(os.homedir(), ".cowork-mcp"), "audit.jsonl"),
      {
        ts: new Date().toISOString(),
        tool: "workspace_config_gui",
        args: { count: next.workspaces.length },
        result,
        ...(reason ? { reason } : {}),
        source: "gui",
      },
    )
  }

  ipcMain.handle("cowork:cancel", async () => {
    auditAppend(
      path.join(request?.dataHome ?? path.join(os.homedir(), ".cowork-mcp"), "audit.jsonl"),
      { ts: new Date().toISOString(), tool: "workspace_config_gui", args: {}, result: "ok", action: "cancelled", source: "gui" },
    )
    return true
  })
}

// ---------- window + lifecycle ----------

function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 720,
    title: "Cowork Workspace",
    show: false,
    resizable: true,
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
    },
  })
  win.setMenuBarVisibility(false)
  win.on("show", () => win.focus())
  win.webContents.on("will-navigate", (event) => event.preventDefault())
  win.webContents.on("will-attach-webview", (event) => event.preventDefault())
  win.once("ready-to-show", () => win.show())
  void win.loadFile(path.join(__dirname, "renderer", "index.html"))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    const index = process.argv.indexOf("--request")
    const requestFile = index !== -1 ? process.argv[index + 1] : undefined
    lockPath = process.argv.includes("--lock") ? process.argv[process.argv.indexOf("--lock") + 1] : undefined
    registerIpc()

    if (!requestFile || process.argv.includes("--dev")) {
      request = { reason: process.argv.includes("--dev") ? "Development preview — no live request." : "", configPath: path.join(os.homedir(), ".cowork-mcp", "config.json"), dataHome: path.join(os.homedir(), ".cowork-mcp") }
    } else {
      let parsed
      try {
        parsed = JSON.parse(fsSync.readFileSync(requestFile, "utf8"))
      } catch {
        console.error("cowork-gui: unreadable request file")
        app.exit(2)
        return
      }
      if (Date.parse(parsed.timeoutAt) < Date.now()) {
        console.error("cowork-gui: request is stale (older than 10 minutes)")
        app.exit(3)
        return
      }
      request = parsed
    }

    createWindow()
  })

  app.on("window-all-closed", () => {
    if (lockPath) fsSync.rmSync(lockPath, { force: true })
    app.quit()
  })

  process.on("SIGINT", () => app.quit())
  process.on("SIGTERM", () => app.quit())
}

void entryProblems
void shell
