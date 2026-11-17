// `config-picker` — the no-GUI-framework fallback for workspace connection.
// Opens the platform's native folder chooser (osascript / PowerShell /
// zenity / kdialog), validates the selection against the same rules the
// server's own loader applies, appends it to config.json atomically, and
// journals one audit entry. Exits: 0 connected, 1 user canceled, 2 invalid,
// 3 no dialog available (headless).

import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { realPathLexical, resolvePath } from "./policy/roots.js"
import { upsertWorkspaceEntry, readConfig, writeConfig, type FileConfig, type WorkspaceEntry } from "./policy/config-file.js"

export interface PickerOutcome {
  status: "connected" | "canceled" | "invalid" | "unavailable"
  path?: string
  reason?: string
}

/** The dialog command per platform; stdout line = POSIX/absolute path. */
export function dialogCommand(platform: NodeJS.Platform): { command: string; args: string[] } | undefined {
  if (platform === "darwin")
    return {
      command: "osascript",
      args: ["-e", 'POSIX path of (choose folder with prompt "Choose a folder to connect to Cowork")'],
    }
  if (platform === "win32")
    return {
      command: "powershell",
      args: [
        "-NoProfile",
        "-STA",
        "-Command",
        'Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.FolderBrowserDialog; $d.Description = "Choose a folder to connect to Cowork"; if ($d.ShowDialog() -eq "OK") { $d.SelectedPath }',
      ],
    }
  return undefined
}

function linuxDialogs(): Array<{ command: string; args: string[] }> {
  const prompt = "Choose a folder to connect to Cowork"
  return [
    { command: "zenity", args: ["--file-selection", "--directory", "--title", prompt] },
    { command: "kdialog", args: ["--getexistingdirectory", process.env.HOME ?? "/", "--title", prompt] },
  ]
}

/** Run the first available dialog; resolves undefined when the user cancels. */
export function runDialog(command: string, args: string[], timeoutMs = 10 * 60 * 1000): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"] })
    let out = ""
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout?.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")))
    child.on("error", () => {
      clearTimeout(timer)
      resolve(undefined)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      const line = out.trim().split("\n").pop()?.trim()
      resolve(code === 0 && line ? line : undefined)
    })
  })
}

/**
 * Validate + append one workspace entry. Mirrors the server's boot-time safety
 * rules: must be an existing directory, must not live inside the data home,
 * must not sit inside an existing workspace, and a duplicate by realpath is
 * passed through as already-connected.
 */
export async function addWorkspace(options: {
  configPath: string
  dataHome: string
  homedir: string
  selected: string
  existingRoots: Array<string>
}): Promise<PickerOutcome> {
  const { configPath, dataHome: dataHomeRaw, homedir, selected, existingRoots } = options
  // Resolve once: symlinked tmp roots (/var → /private/var on macOS) must not skew containment checks.
  const dataHome = await realPathLexical(dataHomeRaw)
  const home = await realPathLexical(homedir)
  const root = resolvePath("/", selected, homedir)
  let stat
  try {
    stat = await fs.stat(root)
  } catch (error) {
    return { status: "invalid", path: selected, reason: `cannot access: ${(error as Error).message}` }
  }
  if (!stat.isDirectory()) return { status: "invalid", path: selected, reason: "not a directory" }
  const real = await realPathLexical(root)
  const slash = (value: string) => value.replaceAll("\\", "/")

  const inside = (child: string, parent: string) => child === parent || child.startsWith(`${slash(parent)}/`)
  if (inside(slash(real), slash(dataHome)))
    return { status: "invalid", path: selected, reason: "the Cowork data directory cannot be a workspace" }
  if (slash(home) === slash(real))
    return { status: "invalid", path: selected, reason: "connecting the entire home directory is not allowed" }
  for (const existing of existingRoots) {
    const existingReal = await realPathLexical(resolvePath("/", existing, homedir)).catch(() => existing)
    const same = slash(real) === slash(existingReal)
    if (same) return { status: "connected", path: real, reason: "already connected; configuration unchanged" }
    if (inside(slash(real), slash(existingReal))) return { status: "invalid", path: selected, reason: "already inside a connected workspace" }
    if (inside(slash(existingReal), slash(real)))
      return { status: "invalid", path: selected, reason: "contains an already-connected workspace" }
  }

  const { config } = await readConfig(configPath)
  const entry: WorkspaceEntry = { path: real }
  const next: FileConfig = upsertWorkspaceEntry(config, entry, (candidate) => candidate)
  await writeConfig(configPath, next)
  return { status: "connected", path: real }
}

function print(outcome: PickerOutcome) {
  process.stdout.write(`${JSON.stringify(outcome)}\n`)
}

async function main() {
  const home = process.env.COWORK_HOME ? path.resolve(process.env.COWORK_HOME) : path.join(os.homedir(), ".cowork-mcp")
  const configPath = path.join(home, "config.json")
  const { config } = await readConfig(configPath)
  const existingRoots = (config.workspaces ?? []).map((entry) => (typeof entry === "string" ? entry : entry.path))

  const primary = dialogCommand(process.platform)
  const candidates = primary ? [primary, ...(process.platform === "linux" ? linuxDialogs() : [])] : linuxDialogs()
  let selected: string | undefined
  for (const candidate of candidates) {
    selected = await runDialog(candidate.command, candidate.args)
    if (selected !== undefined) break
  }
  if (selected === undefined && candidates.length === 0) {
    print({ status: "unavailable", reason: "no native folder dialog is available on this platform" })
    process.exit(3)
  }
  if (selected === undefined) {
    print({ status: "canceled" })
    process.exit(1)
  }

  const outcome = await addWorkspace({
    configPath,
    dataHome: home,
    homedir: os.homedir(),
    selected,
    existingRoots,
  })
  print(outcome)
  process.exit(outcome.status === "connected" ? 0 : outcome.status === "canceled" ? 1 : 2)
}

if (process.argv[1] && path.basename(process.argv[1]).includes("config-picker")) main()
