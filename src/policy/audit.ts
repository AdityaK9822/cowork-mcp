// Append-only JSONL audit journal. Every tool call is recorded — allowed,
// denied, or errored — because denials are the security story. Secret-looking
// argument values are redacted; long values are truncated to a digest.

import fs from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import { LIMITS } from "./limits.js"

export type AuditResult = "ok" | "denied" | "error"

export interface AuditEntry {
  ts: string
  tool: string
  workspace?: string
  args: Record<string, unknown>
  result: AuditResult
  reason?: string
  bytes?: number
}

const SECRET_PATTERN = /(api[_-]?key|token|secret|password|passwd|authorization|Bearer |BEGIN .*PRIVATE KEY)/i

/** Redact secret-looking strings and truncate huge ones, keeping a digest of the full value. */
export function redact(value: unknown): unknown {
  if (typeof value === "string") {
    const safeguard = SECRET_PATTERN.test(value)
    if (value.length > 200 || safeguard) {
      const digest = createHash("sha256").update(value).digest("hex").slice(0, 16)
      return safeguard ? `<redacted:${digest}>` : `<truncated:${digest}> ${value.slice(0, 120)}…`
    }
    return value
  }
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, redact(item)]))
  }
  return value
}

export class Audit {
  constructor(private readonly file: string) {}

  async append(entry: AuditEntry): Promise<void> {
    const line = `${JSON.stringify({ ...entry, args: redact(entry.args) })}\n`
    try {
      await this.rotate()
      await fs.appendFile(this.file, line, "utf8")
    } catch {
      // The journal never breaks tool execution; disk-optional by design.
    }
  }

  private async rotate(): Promise<void> {
    const stat = await fs.stat(this.file).catch(() => undefined)
    if (!stat || stat.size < LIMITS.AUDIT_MAX_BYTES) return
    const stamped = this.file.replace(/\.jsonl$/, `.${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`)
    await fs.rename(this.file, stamped).catch(() => {})
    const dir = path.dirname(this.file)
    const all = await fs.readdir(dir).catch(() => [])
    const rotated = all.filter((name) => name.startsWith("audit.") && name.endsWith(".jsonl")).sort()
    for (const old of rotated.slice(0, Math.max(0, rotated.length - 4)))
      await fs.rm(path.join(dir, old), { force: true }).catch(() => {})
  }
}
