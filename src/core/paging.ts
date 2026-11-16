// Adapted from opencode (MIT) — packages/core/src/tool/read-filesystem.ts.
// The Environment/Effect layers are replaced by direct node:fs on one open
// FileHandle; all paging arithmetic is ported verbatim (cap table, checkpoint
// streaming, tail reads, BOM handling, NUL detection, line clamping).

import path from "node:path"
import { pathToFileURL } from "node:url"
import fs from "node:fs/promises"
import { LIMITS } from "../policy/limits.js"
import { MEDIA_MIMES, detectMedia, mimeType } from "./mime.js"
import { head } from "./text-boundary.js"

export const MAX_READ_LINES = LIMITS.MAX_READ_LINES
export const MAX_READ_BYTES = LIMITS.MAX_READ_BYTES
export const MAX_MEDIA_INGEST_BYTES = LIMITS.MAX_MEDIA_INGEST_BYTES
const FIRST_CHUNK = LIMITS.FIRST_CHUNK
const TAIL_LINES = LIMITS.TAIL_LINES
const MAX_LINE_LENGTH = LIMITS.MAX_LINE_LENGTH
// Enough UTF-8 bytes for the clamped prefix, including a BOM and a partial code point at the end.
const LINE_BYTES = 4 * (MAX_LINE_LENGTH + 1)
const MAX_LINE_SUFFIX = `... (line truncated to ${MAX_LINE_LENGTH} chars)`

export class BinaryFileError extends Error {
  constructor(public resource: string) {
    super(`Cannot read binary file: ${resource}`)
  }
}
export class MediaIngestLimitError extends Error {
  constructor(public resource: string, public maximumBytes: number) {
    super(`Media exceeds ${maximumBytes} byte ingestion limit: ${resource}`)
  }
}
export class PathKindError extends Error {
  constructor(public resource: string, public expected: "a file" | "a file or directory") {
    super(`Path is not ${expected}: ${resource}`)
  }
}
export class DirectoryOffsetError extends Error {
  constructor(public resource: string) {
    super(`A negative offset only works for files, and ${resource} is a directory`)
  }
}
export class NotFoundError extends Error {
  constructor(public resource: string) {
    super(`File not found: ${resource}`)
  }
}

export interface PageInput {
  /** 1-based line/entry offset; negative offsets read the file's tail. */
  offset?: number
  limit?: number
}

export interface FileContent {
  type: "file"
  uri: string
  name: string
  content: string
  encoding: "utf8" | "base64"
  mime: string
}

export interface TextPage {
  type: "text-page"
  content: string
  lineCount: number
  mime: string
  offset: number
  truncated: boolean
  next?: number
}

export interface ListEntry {
  path: string
  type: "file" | "directory" | "symlink"
}

export interface ListPage {
  type: "list-page"
  entries: ListEntry[]
  truncated: boolean
  next?: number
}

export type Page = FileContent | TextPage | ListPage

/**
 * Read one page of a file, or a page of a directory listing. Small clean text
 * files return whole-file content; anything larger streams through
 * checkpoints so a random line window costsreads only the chunks that hold it.
 */
export async function readPage(input: string, resource: string, page: PageInput = {}): Promise<Page> {
  // stat decides file-vs-directory up front: opening a directory may succeed
  // and only fail with EISDIR at first read, and stat follows symlinks.
  const info = await fs.stat(input).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new NotFoundError(resource)
    throw error
  })
  if (info.isDirectory()) {
    if (page.offset !== undefined && page.offset < 0) throw new DirectoryOffsetError(resource)
    return listPage(input, resource, page)
  }
  const handle = await fs.open(input, "r")
  try {
    return await readWithHandle(handle, input, resource, page, info)
  } finally {
    await handle.close()
  }
}

async function readWithHandle(
  handle: fs.FileHandle,
  input: string,
  resource: string,
  page: PageInput,
  info: { size: number },
): Promise<Page> {
  const range = async (offset: number, length: number): Promise<Uint8Array> => {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    return buffer.subarray(0, bytesRead)
  }
  const first = { bytes: await range(0, FIRST_CHUNK), info }

  const media = detectMedia(first.bytes)
  if (media && MEDIA_MIMES.has(media)) {
    if (first.info.size > MAX_MEDIA_INGEST_BYTES)
      throw new MediaIngestLimitError(resource, MAX_MEDIA_INGEST_BYTES)
    const whole = await readWhole(handle, resource)
    return {
      type: "file",
      uri: pathToFileURL(input).href,
      name: path.basename(input),
      content: Buffer.from(whole).toString("base64"),
      encoding: "base64",
      mime: media,
    }
  }

  const paged = first.info.size > MAX_READ_BYTES || page.offset !== undefined || page.limit !== undefined
  if (!paged) {
    if (first.bytes.includes(0)) throw new BinaryFileError(resource)
    const lines = new TextDecoder().decode(first.bytes).split("\n")
    // A final separator ends the last physical line; keep it in whole-file content.
    const count = lines.at(-1) === "" ? lines.length - 1 : lines.length
    if (count <= MAX_READ_LINES) {
      const content = lines.map(clampLine).join("\n")
      if (Buffer.byteLength(content) <= MAX_READ_BYTES)
        return {
          type: "file",
          uri: pathToFileURL(input).href,
          name: path.basename(input),
          content,
          encoding: "utf8",
          mime: mimeType(input),
        }
    }
  }

  return await textPage(range, first, page, resource, mimeType(input))
}

async function readWhole(handle: fs.FileHandle, resource: string): Promise<Uint8Array> {
  const buffer = Buffer.alloc((await handle.stat()).size)
  let filled = 0
  while (filled < buffer.length) {
    const { bytesRead } = await handle.read(buffer, filled, buffer.length - filled, filled)
    if (bytesRead === 0) break
    filled += bytesRead
  }
  void resource
  return buffer.subarray(0, filled)
}

async function listPage(input: string, resource: string, page: PageInput): Promise<ListPage> {
  let items
  try {
    items = await fs.readdir(input, { withFileTypes: true })
  } catch {
    throw new PathKindError(resource, "a file or directory")
  }
  const entries = items.flatMap((item): { name: string; type: "directory" | "file" | "symlink" }[] =>
    item.isDirectory() ? [{ name: item.name, type: "directory" }]
    : item.isFile() ? [{ name: item.name, type: "file" }]
    : item.isSymbolicLink() ? [{ name: item.name, type: "symlink" }]
    : [],
  )
  const offset = page.offset || 1
  const limit = Math.min(page.limit || MAX_READ_LINES, MAX_READ_LINES)
  const visible = entries
    .map((item) => ({ path: item.name + (item.type === "directory" ? path.sep : ""), type: item.type }))
    .sort((a, b) =>
      a.type === "directory"
        ? b.type === "directory"
          ? a.path.localeCompare(b.path)
          : -1
        : b.type === "directory"
          ? 1
          : a.path.localeCompare(b.path),
    )
  const selected = visible.slice(offset - 1, offset - 1 + limit)
  const truncated = offset - 1 + selected.length < visible.length
  return { type: "list-page", entries: selected, truncated, ...(truncated ? { next: offset + selected.length } : {}) }
}

// The first line ending in a chunk may have started many chunks earlier.
type Checkpoint = { byte: number; length: number; firstLine: number; start: number; lastLine: number }

type RangeReader = (offset: number, length: number) => Promise<Uint8Array>

async function textPage(range: RangeReader, first: { bytes: Uint8Array; info: { size: number } }, page: PageInput, resource: string, mime = ""): Promise<TextPage> {
  const requested = page.offset || 1
  const limit = Math.min(page.limit || MAX_READ_LINES, MAX_READ_LINES)
  const checkpoints: Checkpoint[] = []
  const entries: string[] = []
  let size = 0
  let from = requested
  let tail = false
  let consumed = 0
  let next: number | undefined
  let firstNul = Infinity
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true })

  const reread = async (offset: number, length: number): Promise<Uint8Array> => {
    const bytes = await range(offset, length)
    if (bytes.length === length) return bytes
    const result = new Uint8Array(length)
    result.set(bytes)
    let filled = bytes.length
    while (filled < length) {
      const more = await range(offset + filled, length - filled)
      if (more.length === 0) break
      result.set(more, filled)
      filled += more.length
    }
    return result.subarray(0, filled)
  }

  // Select complete lines in this chunk. Only a split line's displayable prefix ever needs a separate read.
  const collect = async (point: Checkpoint, chunk: Uint8Array) => {
    let start = point.start
    let local = Math.max(0, start - point.byte)
    for (let line = point.firstLine; line < from && local < chunk.length; local++) {
      if (chunk[local] !== 10) continue
      line++
      start = point.byte + local + 1
    }
    for (let line = Math.max(point.firstLine, from); line <= point.lastLine; line++) {
      if (!tail && (entries.length >= limit || size >= MAX_READ_BYTES)) {
        next = line
        return
      }
      const lf = chunk.indexOf(10, local)
      const end = point.byte + (lf < 0 ? chunk.length : lf)
      const length = Math.min(LINE_BYTES, end - start)
      const bytes =
        start >= point.byte
          ? chunk.subarray(start - point.byte, start - point.byte + length)
          : start + length <= first.bytes.length
            ? first.bytes.subarray(start, start + length)
            : await reread(start, length)
      let text = decoder.decode(bytes)
      // Single-chunk pages decode from byte zero. Streamed pages decode from the selected line,
      // except a past-end tail, whose embedded BOM remains content.
      if (
        text.startsWith("\uFEFF") &&
        (start === 0 || (!tail && line === from && first.bytes.length < first.info.size))
      )
        text = text.slice(1)
      text = clampLine(text.endsWith("\r") ? text.slice(0, -1) : text)
      const cost = Buffer.byteLength(text) + (entries.length > 0 ? 1 : 0)
      if (!tail && size + cost > MAX_READ_BYTES) {
        next = line
        return
      }
      entries.push(text)
      size += cost
      consumed = end + Number(lf >= 0)
      local = lf + 1
      start = end + 1
    }
  }

  let byte = 0
  let total = 0
  let start = 0
  let chunk = first.bytes
  let lastByte = 0
  while (chunk.length > 0) {
    lastByte = byte
    if (firstNul === Infinity) {
      const nul = chunk.indexOf(0)
      if (nul >= 0) firstNul = byte + nul
    }
    let count = 0
    for (let i = 0; i < chunk.length; i++) count += Number(chunk[i] === 10)
    if (count > 0) {
      const point = { byte, length: chunk.length, firstLine: total + 1, start, lastLine: total + count }
      checkpoints.push(point)
      total += count
      if (requested > 0 && total >= requested) await collect(point, chunk)
      start = byte + chunk.lastIndexOf(10) + 1
    }
    byte += chunk.length
    // Any byte after a full page starts another line, even if that line has no newline for megabytes.
    if (next === undefined && (entries.length >= limit || size >= MAX_READ_BYTES) && consumed < byte)
      next = requested + entries.length
    if (next !== undefined || byte >= first.info.size) break
    const more = await range(byte, FIRST_CHUNK)
    if (more.length === 0) break
    chunk = more
  }

  // EOF ends an unterminated line. A trailing newline already ended the last one.
  if (next === undefined && start < byte) {
    total++
    const point = { byte: lastByte, length: chunk.length, firstLine: total, start, lastLine: total }
    checkpoints.push(point)
    if (requested > 0 && total >= requested) await collect(point, chunk)
  }
  if (requested < 0 || requested > total) {
    tail = requested > total
    from = Math.max(1, total + 1 + (tail ? -Math.min(page.limit || TAIL_LINES, TAIL_LINES) : requested))
    // Each checkpoint covers disjoint line numbers. Seek to the chunk ending the first selected line;
    // chunks in the middle of a long line have no checkpoint and are never reread.
    for (const point of checkpoints) {
      if (point.lastLine < from) continue
      const bytes =
        point.byte === 0 ? first.bytes : point.byte === lastByte ? chunk : await reread(point.byte, point.length)
      await collect(point, bytes)
      if (next !== undefined) break
    }
    if (tail) {
      while (size > MAX_READ_BYTES) {
        size -= Buffer.byteLength(entries.shift() ?? "") + 1
        from++
      }
      consumed = byte
    }
  }

  if (firstNul < consumed) throw new BinaryFileError(resource)
  return {
    type: "text-page",
    content: entries.join("\n"),
    lineCount: entries.length,
    mime,
    offset: from,
    truncated: next !== undefined,
    ...(next === undefined ? {} : { next }),
  }
}

const clampLine = (line: string) => {
  if (line.length <= MAX_LINE_LENGTH) return line
  const boundary = head(line, MAX_LINE_LENGTH)
  return boundary + MAX_LINE_SUFFIX
}
