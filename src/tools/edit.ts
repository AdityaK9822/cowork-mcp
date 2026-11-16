import { assertWritable } from "../policy/limits.js"
import { ToolFailure } from "../errors.js"
import { authorize, runTooled, type ToolContext } from "./context.js"
import { atomicWrite, withBom } from "../core/atomic.js"
import { computeEdit, editInputChecks } from "../core/exact-match.js"
import { fileDiff } from "../core/diff.js"
import { notFoundMessage } from "../core/fuzzy.js"
import fs from "node:fs/promises"

export const editDescription =
  "Edit the contents of a file by finding and replacing exact text. When editing text from Read output, preserve the exact indentation (tabs or spaces) and omit the line-number prefix, such as `1: `. Never include the prefix in oldString or newString. Write line breaks as \\n; the file's existing CRLF or LF line endings are matched and preserved. To change line endings themselves, make oldString and newString differ only in \\r; that edit applies to the exact bytes. If there is no exact match, the edit retries while ignoring typographic quote, dash, and space variants, then trailing whitespace on each line. The edit fails if oldString is not found. By default, oldString must identify a UNIQUE location. Multiple matches FAIL unless replaceAll is true. Add more surrounding context to disambiguate, or set replaceAll to true to replace every occurrence. Use replaceAll when the change should apply to every occurrence, such as renaming a variable."

export interface EditInput {
  path: string
  oldString: string
  newString: string
  replaceAll?: boolean
}

export interface EditOutcome {
  output: string
  diff: ReturnType<typeof fileDiff>
  bytes: number
  workspace: string
}

export async function editTool(ctx: ToolContext, input: EditInput) {
  return runTooled(ctx, "edit", { ...input, oldString: "<old>", newString: "<new>" }, async (): Promise<EditOutcome> => {
    const gate = editInputChecks(input)
    if (gate) throw new ToolFailure(gate)
    const target = await authorize(ctx, input.path)
    const previous = await fs.readFile(target.real).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") throw new ToolFailure(await notFoundMessage(input.path, target.real))
      throw error
    })
    if (previous.includes(0)) throw new ToolFailure(`Cannot edit a binary file: ${input.path}`)
    let before = previous.toString("utf8")
    let outcome
    try {
      outcome = computeEdit(before, input, target.relative)
    } catch (error) {
      // Retry through the BOM: a stored BOM makes position-0 byte comparisons shift.
      if (before.charCodeAt(0) === 0xfeff) {
        before = before.slice(1)
        outcome = computeEdit(before, input, target.relative)
      } else {
        throw error
      }
    }
    assertWritable(outcome.replaced)
    await ctx.snapshots.save(target.workspace.real, target.relative, previous)
    const bytes = withBom(previous, outcome.replaced)
    await atomicWrite(target.real, bytes)
    const diff = fileDiff(target.relative, before, outcome.replaced)
    return {
      output: `Edited ${target.relative} (${outcome.replacements} replacement${outcome.replacements === 1 ? "" : "s"})`,
      diff,
      bytes: bytes.byteLength,
      workspace: target.workspace.name,
    }
  })
}
