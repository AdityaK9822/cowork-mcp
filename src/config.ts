// Workspace configuration, resolved once at startup. config.json is the single
// persistent store; argv (--workspace) and COWORK_WORKSPACES are ADDITIVE,
// session-scoped grants on top of it (they are never written back). DXT
// directory-pickers arrive as COWORK_SEED_WORKSPACES and are migrated into the
// file once, when the file has no workspaces yet. Denylist extensions and
// exact-allow grants come from the file (global) and per-workspace entries.
// The model can never change any of this at runtime — restarting the MCP
// server is the only way to change the sandbox, by design.

import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import { realPathLexical, resolvePath, windowsPath, DEFAULT_GRANT, TOOL_NAMES, type Workspace, type ToolName, type ToolToggles } from "./policy/roots.js"
import { readConfig, writeConfig, type FileConfig, type ConfigWorkspaceEntry, type WorkspaceEntry } from "./policy/config-file.js"
import type { DenylistSpec } from "./policy/denylist.js"

export interface Config {
  workspaces: Workspace[]
  dataHome: string
  homedir: string
  deny: DenylistSpec
  skipped: string[]
  /** Absolute config.json path; used for pending-change detection. */
  configPath: string
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

function parseArgvWorkspaces(argv: readonly string[]): string[] {
  const found: string[] = []
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg === "--workspace") found.push(argv[++index] ?? "")
    else if (arg.startsWith("--workspace=")) found.push(arg.slice("--workspace=".length))
  }
  return found
}

/**
 * Validate one configured tool toggle. `read` cannot be disabled (a workspace
 * with read off would be inert); it is coerced back with a warning.
 */
function sanitizeTools(tools: ToolToggles | undefined, warn: (message: string) => void): ToolToggles {
  if (!tools) return {}
  const clean: ToolToggles = {}
  for (const [key, value] of Object.entries(tools)) {
    if (!TOOL_NAMES.includes(key as ToolName)) {
      warn(`cowork-mcp: ignoring unknown tool toggle '${key}' in workspace config`)
      continue
    }
    if (typeof value !== "boolean") {
      warn(`cowork-mcp: ignoring non-boolean tool toggle '${key}' in workspace config`)
      continue
    }
    if (key === "read" && value === false) {
      warn("cowork-mcp: 'read' cannot be disabled for a workspace; keeping it enabled")
      continue
    }
    if (value === false) clean[key as ToolName] = false
  }
  return clean
}

/** Glob characters are only legal in deny.relative, never in deny.allow. */
const hasGlobMagic = (value: string) => /[*?[\]!{}]/.test(value)

/**
 * Turn one config entry (legacy string or v2 object) into a candidate
 * Workspace with a grant. Returns `undefined` after a warning when the entry
 * is unusable; the server continues with the remaining workspaces.
 */
async function materialize(
  entry: ConfigWorkspaceEntry,
  homedir: string,
  warn: (message: string) => void,
): Promise<Workspace | undefined> {
  const asObject: WorkspaceEntry = typeof entry === "object" && entry !== null ? entry : { path: entry }
  if (typeof asObject.path !== "string" || asObject.path.trim() === "") {
    warn("cowork-mcp: skipping workspace entry with empty path")
    return undefined
  }
  const grant = { ...DEFAULT_GRANT }
  if (asObject.readOnly !== undefined) {
    if (typeof asObject.readOnly !== "boolean") {
      warn(`cowork-mcp: skipping workspace ${asObject.path}: 'readOnly' must be a boolean`)
      return undefined
    }
    grant.readOnly = asObject.readOnly
  }
  grant.tools = sanitizeTools(asObject.tools, warn)
  const denyRelative = (asObject.deny?.relative ?? []).filter(
    (pattern) => typeof pattern === "string" && pattern !== "",
  )
  const denyAllow: string[] = []
  for (const allow of asObject.deny?.allow ?? []) {
    if (typeof allow !== "string" || allow === "") continue
    if (hasGlobMagic(allow)) {
      warn(`cowork-mcp: allow entries must be exact paths without glob characters: ${allow}`)
      continue
    }
    denyAllow.push(allow.replaceAll("\\", "/"))
  }
  grant.denyRelative = denyRelative
  grant.denyAllow = denyAllow

  const root = resolvePath("/", asObject.path, homedir)
  let real: string
  try {
    const stat = await fs.stat(root)
    if (!stat.isDirectory()) throw new Error("not a directory")
    real = await realPathLexical(root)
  } catch (error) {
    warn(`cowork-mcp: skipping workspace ${asObject.path}: ${(error as Error).message}`)
    return undefined
  }
  return { name: path.basename(real), root, real, grant }
}
/** Load and validate config. Missing or invalid workspace entries are skipped with a stderr warning. */
export async function loadConfig(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void = () => {},
): Promise<Config> {
  const homedir = os.homedir()
  const dataHome = env.COWORK_HOME ? path.resolve(windowsPath(env.COWORK_HOME)) : path.join(homedir, ".cowork-mcp")
  const configPath = path.join(dataHome, "config.json")

  const { config: fileConfig } = await readConfig(configPath)
  const fileEntries = [...(fileConfig.workspaces ?? [])]

  // One-time DXT migration: Desktop's directory pickers arrive as
  // COWORK_SEED_<n> env vars (no separator characters, no platform splits).
  // When the file has no workspaces yet, persist the seeds so config.json
  // becomes the single store the config window later edits.
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8]
    .map((slot) => env[`COWORK_SEED_${slot}`])
    .filter((value): value is string => typeof value === "string" && value.trim() !== "")
  if (seeds.length > 0 && fileEntries.length === 0) {
    const migrated: FileConfig = { ...fileConfig, workspaces: seeds }
    await writeConfig(configPath, migrated)
      .then(() => warn(`cowork-mcp: migrated ${seeds.length} picker workspace(s) into ${configPath}`))
      .catch((error: Error) => warn(`cowork-mcp: could not persist picker workspaces: ${error.message}`))
    fileEntries.push(...seeds)
  }

  // argv and env are additive session-scoped grants, never persisted.
  const argvList = parseArgvWorkspaces(argv)
  const envList = env.COWORK_WORKSPACES ? envSplit(env.COWORK_WORKSPACES) : []
  const requested = [...fileEntries, ...argvList, ...envList]

  const resolved: Workspace[] = []
  const skipped: string[] = []
  for (const entry of requested) {
    if (typeof entry !== "string" && (typeof entry !== "object" || entry === null)) {
      skipped.push(String(entry))
      continue
    }
    const workspace = await materialize(entry, homedir, warn)
    if (!workspace) {
      skipped.push(typeof entry === "string" ? entry : entry.path)
      continue
    }
    resolved.push(workspace)
  }  // The file's deny sections remain the only source of global deny extensions.
  const deny = {
    relative: fileConfig.deny?.relative ?? [],
    absolute: fileConfig.deny?.absolute ?? [],
    allow: fileConfig.deny?.allow ?? [],
  }

  return {
    workspaces: uniqueByReal(resolved),
    dataHome,
    homedir,
    skipped,
    deny,
    configPath,
  }
}
