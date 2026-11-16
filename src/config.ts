// Workspace configuration, resolved once at startup. Precedence for the
// workspace list: argv → COWORK_WORKSPACES (env) → config file. Denylist
// extensions and exact-allow grants only come from the config file. The model
// can never change any of this at runtime — restarting the MCP server is the
// only way to change the sandbox, by design.

import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import { realPathLexical, resolvePath, windowsPath, type Workspace } from "./policy/roots.js"
import type { DenylistSpec } from "./policy/denylist.js"

export interface Config {
  workspaces: Workspace[]
  dataHome: string
  homedir: string
  deny: DenylistSpec
  skipped: string[]
}

interface FileConfig {
  workspaces?: string[]
  deny?: { relative?: string[]; absolute?: string[]; allow?: string[] }
}

function parseArgvWorkspaces(argv: readonly string[]): string[] {
  const found: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === "--workspace") found.push(argv[++index] ?? "")
    else if (arg.startsWith("--workspace=")) found.push(arg.slice("--workspace=".length))
  }
  return found
}

const envSplit = (value: string) => value.split(process.platform === "win32" ? ";" : ":")

const uniqueByReal = (list: Workspace[]): Workspace[] => {
  const seen = new Set<string>()
  const names = new Set<string>()
  const result: Workspace[] = []
  for (const ws of list) {
    if (seen.has(ws.real)) continue
    seen.add(ws.real)
    let name = ws.name
    let suffix = 2
    while (names.has(name)) name = `${ws.name} ${suffix++}`
    names.add(name)
    result.push({ ...ws, name })
  }
  return result
}

/** Load and validate config. Missing or invalid workspace entries are skipped with a stderr warning. */
export async function loadConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void = () => {},
): Promise<Config> {
  const homedir = os.homedir()
  const dataHome = env.COWORK_HOME ? path.resolve(windowsPath(env.COWORK_HOME)) : path.join(homedir, ".cowork-mcp")

  const argvList = parseArgvWorkspaces(argv)
  const envList = env.COWORK_WORKSPACES ? envSplit(env.COWORK_WORKSPACES) : []
  let requested = argvList
  let fileConfig: FileConfig = {}
  if (requested.length === 0 && envList.length === 0) {
    const file = path.join(dataHome, "config.json")
    try {
      fileConfig = JSON.parse(await fs.readFile(file, "utf8")) as FileConfig
      requested = fileConfig.workspaces ?? []
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT")
        warn(`cowork-mcp: unreadable config ${file}: ${(error as Error).message}`)
    }
  } else {
    // Keep deny/allow still configurable from the file even when argv/env picks workspaces.
    try {
      fileConfig = JSON.parse(await fs.readFile(path.join(dataHome, "config.json"), "utf8")) as FileConfig
    } catch {}
  }

  const resolved: Workspace[] = []
  const skipped: string[] = []
  for (const entry of requested) {
    if (typeof entry !== "string" || entry.trim() === "") continue
    const root = resolvePath("/", entry, homedir)
    let real: string
    try {
      const stat = await fs.stat(root)
      if (!stat.isDirectory()) throw new Error("not a directory")
      real = await realPathLexical(root)
    } catch (error) {
      warn(`cowork-mcp: skipping workspace ${entry}: ${(error as Error).message}`)
      skipped.push(entry)
      continue
    }
    resolved.push({ name: path.basename(real), root, real })
  }

  return {
    workspaces: uniqueByReal(resolved),
    dataHome,
    homedir,
    skipped,
    deny: {
      relative: fileConfig.deny?.relative ?? [],
      absolute: fileConfig.deny?.absolute ?? [],
      allow: fileConfig.deny?.allow ?? [],
    },
  }
}
