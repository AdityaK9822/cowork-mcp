import { LIMITS, assertWritable } from "../policy/limits.js"
import { ToolFailure } from "../errors.js"
import { authorize, runTooled, type ToolContext } from "./context.js"
import { atomicWrite, withBom } from "../core/atomic.js"
import { fileDiff } from "../core/diff.js"
import fs from "node:fs/promises"
import path from "node:path"

export const writeDescription =
  "Writes a file to the local filesystem, overwriting if one exists.\n\nMissing parent directories are created automatically.\n\nUse this tool to create new files or overwrite existing files. For partial changes, use the edit tool instead."

export interface WriteInput {
  path: string
  content: string
}

export interface WriteOutcome {
  output: string
  diff?: ReturnType<typeof fileDiff>
  bytes: number
  workspace: string
}

export async function writeTool(ctx: ToolContext, input: WriteInput) {
  return runTooled(ctx, "write", { path: input.path, content: "<content>" }, async (): Promise<WriteOutcome> => {
    const size = assertWritable(input.content)
    const target = await authorize(ctx, input.path)
    const previous = await fs.readFile(target.real).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
    if (previous && previous.includes(0)) throw new ToolFailure(`Refusing to overwrite a binary file: ${input.path}`)
    // Parent directories for new files: created only inside the already-sandboxed target.
    await fs.mkdir(path.dirname(target.real), { recursive: true })
    const snapshot = await ctx.snapshots.save(target.workspace.real, target.relative, previous)
    const bytes = withBom(previous, input.content)
    await atomicWrite(target.real, bytes)
    const diff = fileDiff(target.relative, previous ? previous.toString("utf8") : "", input.content, previous ? "modified" : "added")
    void snapshot
    return {
      output: `${previous ? "Wrote" : "Created"} file: ${target.relative} (${size} bytes)`,
      diff,
      bytes: size,
      workspace: target.workspace.name,
    }
  })
}

export const MAX_WRITE_BYTES = LIMITS.MAX_WRITE_BYTES
