// config.json policy handle: hashing, atomic writes, and additive mutation of
// the workspace list. Used by the server (pending-change detection), the
// picker fallback CLI, and — mirrored, not imported — the Electron helper's
// main process. The LOAD path (validation, defaults, dedupe) lives in
// config.ts and remains the single parser of record at boot.

import fs from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import type { ToolToggles, WorkspaceGrant } from "./roots.js"

/** An entry as it appears in config.json: legacy string or v2 object form. */
export type ConfigWorkspaceEntry = string | WorkspaceEntry

export interface WorkspaceEntry {
  path: string
  readOnly?: boolean
  tools?: ToolToggles
  deny?: { relative?: string[]; allow?: string[] }
}

export interface FileConfig {
  workspaces?: ConfigWorkspaceEntry[]
  deny?: { relative?: string[]; absolute?: string[]; allow?: string[] }
}

export interface ConfigFileHandle {
  path: string
  /** sha256 of the file contents exactly as the server booted (`sha256("")` when no file existed). */
  bootHash: string
  /** Recompute the current file hash; null when the file no longer exists. */
  currentHash(): Promise<string | null>
  /** True when config.json changed since boot — a GUI/picker edit waiting for restart. */
  pendingChange(): Promise<boolean>
}

export async function openConfigFile(configPath: string | undefined): Promise<ConfigFileHandle | undefined> {
  if (!configPath) return undefined
  const bootRaw = await fs.readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? null : Promise.reject(error),
  )
  const bootHash = bootRaw === null ? ABSENT : sha256(bootRaw)
  const currentHash = async (): Promise<string | null> => {
    const raw = await fs.readFile(configPath, "utf8").catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? null : Promise.reject(error),
    )
    return raw === null ? null : sha256(raw)
  }
  const pendingChange = async (): Promise<boolean> => {
    // A file that did not exist at boot and still does not exist is unchanged; one that appeared is a change.
    return (await currentHash()) !== bootHash
  }
  return { path: configPath, bootHash, currentHash, pendingChange }
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")
const ABSENT = sha256("") // sentinel for "no file existed at boot" — still a valid sha256 hex string

/** Read + JSON-parse config.json, tolerating a missing or invalid file. */
export async function readConfig(configPath: string): Promise<{ config: FileConfig; raw: string | null }> {
  const raw = await fs.readFile(configPath, "utf8").catch(() => null)
  if (raw === null) return { config: {}, raw: null }
  try {
    return { config: JSON.parse(raw) as FileConfig, raw }
  } catch {
    return { config: {}, raw }
  }
}

/**
 * Atomically write config.json: temp file (O_EXCL, same dir) then rename.
 * Mirrors core/atomic.ts without importing it so the module stays
 * dependency-free for CLI use.
 */
export async function writeConfig(configPath: string, config: FileConfig): Promise<void> {
  const body = `${JSON.stringify(config, null, 2)}\n`
  const directory = path.dirname(configPath)
  await fs.mkdir(directory, { recursive: true })
  const temp = path.join(directory, `.${path.basename(configPath)}.${randomUUID()}.tmp`)
  const handle = await fs.open(temp, "wx", 0o600)
  try {
    await handle.writeFile(body, "utf8")
  } finally {
    await handle.close()
  }
  await fs.rename(temp, configPath)
}

/**
 * Add or replace one workspace entry by realpath'd path. The caller decides
 * validation policy; this only guarantees a single entry per path and leaves
 * other config sections untouched.
 */
export function upsertWorkspaceEntry(config: FileConfig, entry: WorkspaceEntry, realOf: (p: string) => string): FileConfig {
  const list = [...(config.workspaces ?? [])]
  const incoming = realOf(entry.path)
  const kept = list.filter((existing) => {
    const path = typeof existing === "string" ? existing : existing.path
    return realOf(path) !== incoming
  })
  const normalized: WorkspaceEntry = {
    path: entry.path,
    ...(entry.readOnly ? { readOnly: true } : {}),
    ...(entry.tools ? { tools: entry.tools } : {}),
    ...(entry.deny ? { deny: entry.deny } : {}),
  }
  return { ...config, workspaces: [...kept, normalized] }
}

export type { WorkspaceGrant }
