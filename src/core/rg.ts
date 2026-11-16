// Adapted from opencode (MIT) — packages/core/src/ripgrep.ts (args, NDJSON
// parsing, exit-code/error mapping) — minus any downloading: cowork-mcp uses
// the system rg from PATH (or $COWORK_RG) and otherwise falls back to a
// bounded pure-LS walk + regex scan. Zero network access, always.

import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import readline from "node:readline"
import { existsSync } from "node:fs"
import picomatch from "picomatch"
import { head } from "./text-boundary.js"
import { LIMITS } from "../policy/limits.js"

const MAX_LINE_CHARS = LIMITS.MAX_LINE_LENGTH
const ERROR_BYTES = 8 * 1024

export interface Match {
  path: string
  line: number
  text: string
}

export class SearchError extends Error {}
export class InvalidGlobError extends SearchError {}
export class InvalidPatternError extends SearchError {}

const normalizePath = (value: string) =>
  value
    .replace(/^(?:\.[\\/])+/u, "")
    .replace(/^[\\/]+/u, "")
    .replaceAll("\\", "/")

const isInvalidPattern = (stderr: string) =>
  stderr.includes("regex parse error") || stderr.includes("error parsing regex")

/** Locate rg: $COWORK_RG first, then every PATH directory. Cached per process. */
export async function resolveRg(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  if (env.COWORK_RG) {
    if (existsSync(env.COWORK_RG)) return env.COWORK_RG
    throw new SearchError(`COWORK_RG is set but does not exist: ${env.COWORK_RG}`)
  }
  const name = process.platform === "win32" ? "rg.exe" : "rg"
  for (const dir of (env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
    if (!dir) continue
    const candidate = path.join(dir, name)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
  }
  return undefined
}

interface RunResult<T> {
  rows: T[]
  truncated: boolean
  exitCode: number | null
  stderr: string
  sigterm: boolean
}

async function run<T>(options: {
  rg: string
  cwd: string
  args: string[]
  limit: number
  pattern?: string
  parse: (line: string) => T | undefined
}): Promise<RunResult<T>> {
  return await new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(options.rg, options.args, { cwd: options.cwd, stdio: ["ignore", "pipe", "pipe"] })
    } catch (error) {
      reject(error)
      return
    }
    const rows: T[] = []
    let truncated = false
    let stderr = ""
    const rl = readline.createInterface({ input: child.stdout! })
    rl.on("line", (line) => {
      if (line.length === 0) return
      const row = options.parse(line)
      if (row === undefined) return
      if (rows.length >= options.limit) {
        truncated = true
        child.kill("SIGTERM")
        rl.close()
        return
      }
      rows.push(row)
    })
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < ERROR_BYTES) stderr += chunk.toString("utf8")
    })
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" || error.code === "EACCES") reject(error)
      else reject(new SearchError(`ripgrep execution failed: ${error.message}`))
    })
    child.on("close", (code, signal) => resolve({ rows, truncated, exitCode: code, stderr, sigterm: signal === "SIGTERM" }))
  })
}

const wasTruncated = (result: RunResult<unknown>) => result.truncated || result.sigterm

export interface GrepInput {
  cwd: string
  pattern: string
  file?: string
  include?: string
  literal?: boolean
  caseSensitive?: boolean
  limit: number
  hidden?: boolean
}

export interface GrepResult {
  matches: Match[]
  truncated: boolean
  engine: "rg" | "js"
}

export async function grep(input: GrepInput, rgPath?: string): Promise<GrepResult> {
  const rg = rgPath ?? (await resolveRg())
  if (rg) return await grepRg(rg, input)
  return await grepJs(input)
}

async function grepRg(rg: string, input: GrepInput): Promise<GrepResult> {
  const args = [
    "--no-config",
    "--json",
    "--no-messages",
    "--max-filesize=10M",
    ...(input.hidden ? ["--hidden"] : []),
    ...(input.literal ? ["--fixed-strings"] : []),
    ...(input.caseSensitive === false ? ["--ignore-case"] : []),
    ...(input.include ? [`--glob=${input.include}`] : []),
    "--glob=!**/.git/**",
    "--",
    input.pattern,
    input.file ?? ".",
  ]
  const parse = (line: string): Match | undefined => {
    let json: unknown
    try {
      json = JSON.parse(line)
    } catch {
      throw new SearchError("Invalid ripgrep JSON output")
    }
    const data = (json as { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number } })?.data
    if ((json as { type?: string })?.type !== "match" || !data?.path?.text || !data?.lines?.text || data.line_number === undefined)
      return undefined
    const text = data.lines.text
    return {
      path: normalizePath(data.path.text),
      line: data.line_number,
      text: text.length > MAX_LINE_CHARS ? head(text, MAX_LINE_CHARS) + "..." : text,
    }
  }
  const result = await run<Match>({ rg, cwd: input.cwd, args, limit: input.limit, parse, pattern: input.pattern }).then(
    (resolved) => resolved,
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    },
  )
  if (result === undefined) return await grepJs(input)
  // Early-exit truncation is checked before exit codes: the SIGTERM we sent
  // surfaces as a null exit code, which is success-with-truncation.
  if (wasTruncated(result)) return { matches: result.rows, truncated: true, engine: "rg" }
  if (result.exitCode === 2) {
    const prefix = /^(?:rg: )?error parsing glob /.exec(result.stderr)
    if (prefix) throw new InvalidGlobError(result.stderr.slice(prefix[0].length).trimEnd())
    if (isInvalidPattern(result.stderr)) throw new InvalidPatternError(result.stderr.trim())
    throw new SearchError(result.stderr.trim() || "ripgrep failed with code 2")
  }
  if (result.exitCode !== 0 && result.exitCode !== 1)
    throw new SearchError(result.stderr.trim() || `ripgrep failed with code ${result.exitCode}`)
  return { matches: result.rows, truncated: false, engine: "rg" }
}

interface WalkEntry {
  relative: string
  absolute: string
}

// The fallback never scans more than these; it is an availability bridge, not a full engine.
const FALLBACK_FILES = 2_000
const FALLBACK_BYTES = 4 * 1024 * 1024

async function walk(
  cwd: string,
  options: { hidden?: boolean; maxEntries?: number },
): Promise<{ entries: WalkEntry[]; truncated: boolean }> {
  const entries: WalkEntry[] = []
  const skipHidden = !options.hidden
  let truncated = false
  const visited = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (entries.length >= (options.maxEntries ?? FALLBACK_FILES) || depth > 24) {
      truncated = true
      return
    }
    let items
    try {
      items = await fs.promises.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const item of items) {
      if (skipHidden && item.name.startsWith(".")) continue
      const childRel = rel ? `${rel}/${item.name}` : item.name
      const childAbs = path.join(dir, item.name)
      if (item.isDirectory()) {
        if (item.name === ".git") continue
        await visited(childAbs, childRel, depth + 1)
        if (truncated) return
      } else if (item.isFile()) {
        entries.push({ relative: childRel, absolute: childAbs })
        if (entries.length >= (options.maxEntries ?? FALLBACK_FILES)) {
          truncated = true
          return
        }
      }
    }
  }
  await visited(cwd, "", 0)
  return { entries, truncated }
}

const escapeLiteral = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

async function grepJs(input: GrepInput): Promise<GrepResult> {
  const { entries, truncated: walkTruncated } = await walk(input.cwd, { hidden: true })
  const pattern = input.literal ? escapeLiteral(input.pattern) : input.pattern
  let regex: RegExp
  try {
    regex = new RegExp(pattern, input.caseSensitive === false ? "iu" : "u")
  } catch {
    throw new InvalidPatternError(`Invalid regex pattern: ${pattern}`)
  }
  const include = input.include ? picomatch(input.include, { dot: true }) : undefined
  const targets = entries.filter((entry) => {
    if (entry.relative === ".git") return false
    if (include && !(include(entry.relative) || include(path.basename(entry.relative)))) return false
    if (input.file && entry.relative !== input.file && path.basename(entry.relative) !== input.file) return false
    return true
  })
  const matches: Match[] = []
  let bytes = 0
  let truncated = walkTruncated
  for (const target of targets) {
    if (matches.length > input.limit || bytes > FALLBACK_BYTES) {
      truncated = true
      break
    }
    let text: string
    try {
      const buffer = await fs.promises.readFile(target.absolute)
      bytes += buffer.byteLength
      if (buffer.includes(0)) continue
      text = buffer.toString("utf8")
    } catch {
      continue
    }
    const lines = text.split("\n")
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!
      if (regex.test(line)) {
        matches.push({ path: target.relative, line: index + 1, text: line.length > MAX_LINE_CHARS ? head(line, MAX_LINE_CHARS) + "..." : line })
        if (matches.length > input.limit) {
          truncated = true
          matches.pop()
          break
        }
      }
    }
  }
  return { matches, truncated, engine: "js" }
}

export interface GlobInput {
  cwd: string
  pattern: string
  limit: number
  hidden?: boolean
}

export interface GlobResult {
  files: string[]
  truncated: boolean
  engine: "rg" | "js"
}

export async function globSearch(input: GlobInput, rgPath?: string): Promise<GlobResult> {
  const rg = rgPath ?? (await resolveRg())
  if (rg) {
    const args = [
      "--no-config",
      "--files",
      ...(input.hidden ? ["--hidden"] : []),
      `--glob=${input.pattern}`,
      // Positive globs override rg's hidden-file filter; exclude before applying the result limit.
      ...(input.hidden ? [] : ["--glob=!**/.*"]),
      "--glob=!**/.git/**",
      ".",
    ]
    const result = await run<string>({ rg, cwd: input.cwd, args, limit: input.limit, parse: normalizePath }).catch(
      async (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? undefined : Promise.reject(error)),
    )
    if (result)
      return { files: result.rows.sort(), truncated: wasTruncated(result), engine: "rg" }
  }
  const { entries, truncated } = await walk(input.cwd, { hidden: input.hidden, maxEntries: 20_000 })
  const matcher = picomatch(input.pattern === "*" ? "**/*" : input.pattern, { dot: !!input.hidden })
  const files = entries.filter((entry) => matcher(entry.relative)).map((entry) => entry.relative)
  const overLimit = files.length > input.limit
  return {
    files: files.sort().slice(0, input.limit),
    truncated: truncated || overLimit,
    engine: "js",
  }
}
