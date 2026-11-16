import { ToolFailure } from "../errors.js"
import { NotFoundError, readPage, type PageInput } from "../core/paging.js"
import { formatRead, notFoundMessage } from "../core/fuzzy.js"
import { MEDIA_MIMES, type MediaMime } from "../core/mime.js"
import { authorize, journal, runTooled, type ToolContext } from "./context.js"
import type { Target } from "../policy/roots.js"

export const readDescription =
  "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. A negative offset reads the file's last lines. Prefer one larger read over many small slices, and use grep to find specific content in large files."

export interface ReadInput {
  path: string
  offset?: number
  limit?: number
}

export interface ReadOutcome {
  text?: string
  media?: { mime: MediaMime; base64: string }
  bytes?: number
  workspace?: string
}

export async function readTool(ctx: ToolContext, input: ReadInput) {
  return runTooled(ctx, "read", { ...input }, async (): Promise<ReadOutcome> => {
    const target = await authorize(ctx, input.path)
    try {
      return await readTarget(ctx, target, input)
    } catch (error) {
      if (error instanceof NotFoundError) throw new ToolFailure(await notFoundMessage(input.path, target.real))
      throw error
    }
  })
}

export async function readTarget(ctx: ToolContext, target: Target, input: ReadInput): Promise<ReadOutcome> {
  const page: PageInput = {
    ...(input.offset === undefined ? {} : { offset: input.offset }),
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  }
  const result = await readPage(target.real, target.relative, page)
  if (result.type === "file" && result.encoding === "base64") {
    const mime = result.mime as MediaMime
    if (MEDIA_MIMES.has(mime))
      return { media: { mime, base64: result.content }, bytes: 0, workspace: target.workspace.name }
  }
  if (result.type === "file") return { text: formatRead(target.relative, input.offset, result), bytes: result.content.length, workspace: target.workspace.name }
  return { text: formatRead(target.relative, input.offset, result), workspace: target.workspace.name }
}

export { journal }
