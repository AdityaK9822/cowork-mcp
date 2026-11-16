// Adapted from opencode (MIT) — packages/core/src/tool/read-filesystem.ts (constants),
// packages/core/src/filesystem.ts (DEFAULT_SEARCH_LIMIT).

/**
 * Hard output/side-effect ceilings. Every tool reads these; none is user-widening.
 * Values match opencode's model-facing caps so paged outputs behave identically.
 */
export const LIMITS = {
  MAX_READ_LINES: 2_000,
  MAX_READ_BYTES: 50 * 1024,
  MAX_LINE_LENGTH: 2_000,
  TAIL_LINES: 100,
  FIRST_CHUNK: 256 * 1024,
  MAX_MEDIA_INGEST_BYTES: 20 * 1024 * 1024,
  MAX_WRITE_BYTES: 10 * 1024 * 1024,
  DEFAULT_SEARCH_LIMIT: 100,
  MAX_SEARCH_LIMIT: 1_000,
  /** Undo snapshots kept per file; older revisions rotate out. */
  SNAPSHOT_KEEP: 20,
  /** Global byte budget for all snapshots combined. */
  SNAPSHOT_TOTAL_BYTES: 100 * 1024 * 1024,
  /** Audit journal rotation threshold. */
  AUDIT_MAX_BYTES: 5 * 1024 * 1024,
} as const

export const containsNul = (bytes: Uint8Array) => bytes.includes(0)

/** Reject writes that carry binary payloads: content is JSON text and should never include NUL. */
export function assertWritable(content: string) {
  const bytes = Buffer.byteLength(content)
  if (bytes > LIMITS.MAX_WRITE_BYTES)
    throw new ToolError(`Content exceeds the ${LIMITS.MAX_WRITE_BYTES / (1024 * 1024)} MB write limit`)
  if (content.includes("\u0000")) throw new ToolError("Content contains a NUL byte and looks binary; refusing to write")
  return bytes
}

import { ToolFailure } from "../errors.js"
/** Alias so callers can stay dependency-light; keep one exception shape policies throw. */
export const ToolError = ToolFailure
