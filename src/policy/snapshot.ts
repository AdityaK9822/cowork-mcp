// Pre-mutation undo snapshots. Before every Tier B write, the previous bytes
// land under <dataHome>/snapshots/<wsHash>/<pathHash>/<NNN> with a sidecar
// meta.json. The path never holds the sensitive name directly — names live in
// meta. Last N per file, global byte budget evicts oldest-first.

import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { LIMITS } from "./limits.js"

export interface SnapshotRecord {
  /** Where the snapshot bytes live. */
  file: string
  /** Workspace-relative path that was snapshotted. */
  relative: string
  meta: { relative: string; ts: number; bytes: number; revision: number }
}

export class Snapshots {
  constructor(private readonly root: string, private readonly keep = LIMITS.SNAPSHOT_KEEP) {}

  private dirs(workspaceReal: string, relative: string) {
    const wsHash = createHash("sha256").update(workspaceReal).digest("hex").slice(0, 12)
    const pathHash = createHash("sha256").update(relative).digest("hex").slice(0, 12)
    return path.join(this.root, wsHash, pathHash)
  }

  /** Copy the current bytes (when the file exists) before a mutation. */
  async save(workspaceReal: string, relative: string, current: Buffer | undefined): Promise<SnapshotRecord | undefined> {
    if (!current) return undefined
    const dir = this.dirs(workspaceReal, relative)
    try {
      await fs.mkdir(dir, { recursive: true })
      const existing = (await fs.readdir(dir)).filter((name) => /^\d{6}$/.test(name)).sort()
      const revision = (existing.length > 0 ? Number(existing.at(-1)) : 0) + 1
      const slot = String(revision).padStart(6, "0")
      const file = path.join(dir, slot)
      await fs.writeFile(file, current)
      const meta = { relative, ts: Date.now(), bytes: current.byteLength, revision }
      await fs.writeFile(`${file}.json`, JSON.stringify(meta))
      await this.prune(dir, existing)
      await this.evictGlobal()
      return { file, relative, meta }
    } catch {
      // A snapshot failure must not block the mutation: the audit journal notes the risk instead.
      return undefined
    }
  }

  private async prune(dir: string, existing: string[]): Promise<void> {
    const stale = existing.slice(0, Math.max(0, existing.length - (this.keep - 1)))
    for (const slot of stale) {
      await fs.rm(path.join(dir, slot), { force: true }).catch(() => {})
      await fs.rm(`${path.join(dir, slot)}.json`, { force: true }).catch(() => {})
    }
  }

  private async evictGlobal(): Promise<void> {
    const workspaces = await fs.readdir(this.root).catch(() => [])
    let total = 0
    const records: Array<{ file: string; bytes: number; ts: number }> = []
    for (const ws of workspaces) {
      const paths = await fs.readdir(path.join(this.root, ws)).catch(() => [])
      for (const hash of paths) {
        const dir = path.join(this.root, ws, hash)
        const slots = await fs.readdir(dir).catch(() => [])
        for (const slot of slots.filter((name) => /^\d{6}$/.test(name))) {
          const file = path.join(dir, slot)
          const stat = await fs.stat(file).catch(() => undefined)
          if (!stat) continue
          total += stat.size
          records.push({ file, bytes: stat.size, ts: stat.mtimeMs })
        }
      }
    }
    if (total <= LIMITS.SNAPSHOT_TOTAL_BYTES) return
    const oldest = records.sort((a, b) => a.ts - b.ts)
    for (const record of oldest) {
      if (total <= LIMITS.SNAPSHOT_TOTAL_BYTES) break
      await fs.rm(record.file, { force: true }).catch(() => {})
      await fs.rm(`${record.file}.json`, { force: true }).catch(() => {})
      total -= record.bytes
    }
  }

  /** Inventory for workspace_status: per-workspace file counts and bytes. */
  async inventory(): Promise<Array<{ workspace: string; files: number; bytes: number; oldest?: number }>> {
    const result: Array<{ workspace: string; files: number; bytes: number; oldest?: number }> = []
    const workspaces = await fs.readdir(this.root).catch(() => [])
    for (const ws of workspaces) {
      const hashes = await fs.readdir(path.join(this.root, ws)).catch(() => [])
      let files = 0
      let bytes = 0
      let oldest: number | undefined
      for (const hash of hashes) {
        const dir = path.join(this.root, ws, hash)
        const metas = await fs.readdir(dir).catch(() => [])
        for (const meta of metas.filter((name) => name.endsWith(".json"))) {
          try {
            const parsed = JSON.parse(await fs.readFile(path.join(dir, meta), "utf8")) as { ts: number; bytes: number }
            files++
            bytes += parsed.bytes
            oldest = oldest === undefined ? parsed.ts : Math.min(oldest, parsed.ts)
          } catch {}
        }
      }
      result.push({ workspace: ws, files, bytes, ...(oldest === undefined ? {} : { oldest }) })
    }
    return result
  }
}
