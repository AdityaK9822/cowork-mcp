import { LIMITS } from "../policy/limits.js"
import { InvalidGlobError, InvalidPatternError, globSearch, grep, type GrepResult } from "../core/rg.js"
import { ToolFailure } from "../errors.js"
import { authorize, runTooled, searchResultBlocked, type ToolContext } from "./context.js"

const fmtMatches = (result: GrepResult, displayRoot: string) => {
  const lines = result.matches.length === 0 ? ["No matches found"] : [`Found ${result.matches.length} matches`]
  let current = ""
  for (const match of result.matches) {
    if (current !== match.path) {
      if (current) lines.push("")
      current = match.path
      lines.push(`${current}:`)
    }
    lines.push(`  Line ${match.line}: ${match.text.replace(/\n$/, "")}`)
  }
  if (result.truncated)
    lines.push(
      "",
      `(Results are truncated: showing first ${result.matches.length} results. Consider using a more specific path or pattern.)`,
    )
  if (result.engine === "js")
    lines.push("", "(Searched with the built-in fallback engine; install ripgrep for full performance.)")
  void displayRoot
  return lines.join("\n")
}

export const grepDescription =
  "Search file contents using ripgrep's regular expression syntax or literal text matching. Use it to locate specific code, symbols, or text patterns, and narrow searches with path or include. Returns matching file paths, line numbers, and line previews."

export interface GrepInput {
  pattern: string
  path?: string
  include?: string
  literal?: boolean
  caseSensitive?: boolean
  limit?: number
}

export async function grepTool(ctx: ToolContext, input: GrepInput) {
  return runTooled(ctx, "grep", { ...input }, async () => {
    if (input.pattern === "") throw new ToolFailure("Pattern must not be empty")
    const limit = Math.min(input.limit ?? LIMITS.DEFAULT_SEARCH_LIMIT, LIMITS.MAX_SEARCH_LIMIT)
    try {
      if (input.path === undefined) {
        if (ctx.roots.allWorkspacesDisable("grep"))
          throw new ToolFailure("Blocked: tool 'grep' is not enabled for any workspace.")
        // Search every workspace root; results are prefixed by workspace name.
        const global = ctx.denylist.summary()
        const outputs: string[] = []
        let total = 0
        for (const ws of ctx.roots.workspacesGrantedView()) {
          if (!ws.tools.grep) continue
          const result = await grep({ cwd: ws.real, pattern: input.pattern, ...(input.include ? { include: input.include } : {}), ...(input.literal === undefined ? {} : { literal: input.literal }), ...(input.caseSensitive === undefined ? {} : { caseSensitive: input.caseSensitive }), limit })
          if (result.matches.length === 0) continue
          const matches = ws.deny.relative.length === 0 ? result.matches : result.matches.filter((match) => !searchResultBlocked(global, ws.deny, match.path))
          if (matches.length === 0) continue
          outputs.push(`# ${ws.name}\n${fmtMatches({ ...result, matches }, ws.name)}`)
          total += matches.length
        }
        return { text: total === 0 ? "No matches found" : outputs.join("\n\n"), workspace: undefined }
      }
      const target = await authorize(ctx, "grep", input.path)
      const isFile = await import("node:fs/promises").then((fs) =>
        fs.stat(target.real).then((stat) => stat.isFile()).catch(() => false),
      )
      const result = await grep({
        cwd: isFile ? target.workspace.real : target.real,
        pattern: input.pattern,
        ...(isFile ? { file: target.relative } : {}),
        ...(input.include ? { include: input.include } : {}),
        ...(input.literal === undefined ? {} : { literal: input.literal }),
        ...(input.caseSensitive === undefined ? {} : { caseSensitive: input.caseSensitive }),
        limit,
      })
      return {
        text: fmtMatches(result, target.workspace.name),
        workspace: target.workspace.name,
        bytes: result.matches.reduce((sum, match) => sum + match.text.length, 0),
      }
    } catch (error) {
      if (error instanceof InvalidGlobError) throw new ToolFailure(`Invalid glob in include ${error.message}`)
      if (error instanceof InvalidPatternError) throw new ToolFailure(`Invalid regex pattern: ${error.message}`)
      throw error
    }
  })
}

export const globDescription =
  "Search file paths using a glob pattern (examples: \"**/*.ts\", \"src/**/*.tsx\"). Results are sorted and capped."

export interface GlobInput {
  pattern: string
  path?: string
  limit?: number
}

export async function globTool(ctx: ToolContext, input: GlobInput) {
  return runTooled(ctx, "glob", { ...input }, async () => {
    if (input.pattern === "") throw new ToolFailure("Pattern must not be empty")
    const limit = Math.min(input.limit ?? LIMITS.DEFAULT_SEARCH_LIMIT, LIMITS.MAX_SEARCH_LIMIT)
    if (input.path === undefined) {
      if (ctx.roots.allWorkspacesDisable("glob"))
        throw new ToolFailure("Blocked: tool 'glob' is not enabled for any workspace.")
      const global = ctx.denylist.summary()
      const outputs: string[] = []
      let count = 0
      for (const ws of ctx.roots.workspacesGrantedView()) {
        if (!ws.tools.glob) continue
        const result = await globSearch({ cwd: ws.real, pattern: input.pattern, limit })
        if (result.files.length === 0) continue
        const files = ws.deny.relative.length === 0 ? result.files : result.files.filter((file) => !searchResultBlocked(global, ws.deny, file))
        if (files.length === 0) continue
        outputs.push(`# ${ws.name}\n${files.join("\n")}${result.truncated ? "\n[truncated]" : ""}`)
        count += files.length
      }
      return { text: count === 0 ? "No files match" : outputs.join("\n\n"), workspace: undefined }
    }
    const target = await authorize(ctx, "glob", input.path)
    const result = await globSearch({ cwd: target.real, pattern: input.pattern, limit })
    const text = result.files.length === 0 ? "No files match" : result.files.map((file) => `${target.relative === "." ? "" : `${target.relative}/`}${file}`).join("\n")
    return { text: text + (result.truncated ? "\n[truncated]" : ""), workspace: target.workspace.name }
  })
}

export const listDescription =
  "List directory entries one per line, directories first. Use offset and limit to page through large directories."

export interface ListInput {
  path?: string
  offset?: number
  limit?: number
}

export async function listTool(ctx: ToolContext, input: ListInput) {
  return runTooled(ctx, "list", { ...input }, async () => {
    const target = await authorize(ctx, "list", input.path ?? ".")
    const { readPage } = await import("../core/paging.js")
    const result = await readPage(target.real, target.relative, {
      ...(input.offset === undefined ? {} : { offset: input.offset }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    })
    if (result.type !== "list-page") throw new ToolFailure(`Path is not a directory: ${input.path ?? "."}`)
    const lines: string[] = result.entries.map((entry) => `${entry.path}${entry.type === "symlink" ? " (symlink)" : ""}`)
    if (result.truncated && result.next !== undefined) lines.push(`[Truncated. Continue with offset: ${result.next}]`)
    return {
      text: `Read directory ${target.relative}, entries ${input.offset || 1}-${(input.offset || 1) + result.entries.length - 1}\n${lines.join("\n")}`,
      workspace: target.workspace.name,
    }
  })
}
