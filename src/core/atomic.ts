// Atomic write: temporary file in the destination directory (O_EXCL so a
// symlink-swap race cannot redirect it), fsync, then rename over the target.
// The parent directory is re-verified after creating the temp file: if the
// directory was swapped for a symlink during the write, the temp file is
// removed instead of renamed.

import fs from "node:fs/promises"
import path from "node:path"
import { realPathLexical } from "../policy/roots.js"

export interface AtomicWriteResult {
  existed: boolean
  bytes: number
}

/** Preserve a leading UTF-8 BOM from the previous content, opencode-style. */
export function withBom(previous: Buffer | undefined, content: string): Buffer {
  const bom = previous && previous[0] === 0xef && previous[1] === 0xbb && previous[2] === 0xbf
  const body = Buffer.from(content, "utf8")
  if (!bom) return body
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body])
}

export async function atomicWrite(absolute: string, bytes: Buffer): Promise<AtomicWriteResult> {
  const directory = path.dirname(absolute)
  const existed = await fs
    .stat(absolute)
    .then((stat) => stat.isFile())
    .catch(() => false)
  const tmp = path.join(directory, `.cowork-tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  const handle = await fs.open(tmp, "wx", 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    // Re-verify the destination parent still resolves to the same place.
    const expected = await realPathLexical(directory)
    const actual = await fs.realpath(directory)
    if (expected !== actual) throw new Error("directory changed during write; refusing to rename into it")
    await fs.rename(tmp, absolute)
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {})
    throw error
  }
  return { existed, bytes: bytes.byteLength }
}
