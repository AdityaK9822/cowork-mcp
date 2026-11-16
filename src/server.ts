// MCP stdio server wiring. Tools are declared with zod schemas and opencode's
// proven descriptions; every handler runs through the shared ToolContext.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import type { ToolContext } from "./tools/context.js"
import { workspaceStatus, workspaceStatusDescription } from "./tools/workspace-status.js"
import { readTool, readDescription } from "./tools/read.js"
import { grepTool, grepDescription, globTool, globDescription, listTool, listDescription } from "./tools/search.js"
import { writeTool, writeDescription } from "./tools/write.js"
import { editTool, editDescription } from "./tools/edit.js"
import { ToolFailure } from "./errors.js"
import { MEDIA_MIMES } from "./core/mime.js"

const failure = (error: unknown) => ({
  isError: true as const,
  content: [{ type: "text" as const, text: error instanceof ToolFailure || error instanceof Error ? error.message : String(error) }],
})

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] })

export function createServer(ctx: ToolContext) {
  const server = new McpServer({ name: "cowork-mcp", version: "0.1.0" })

  server.tool(
    "workspace_status",
    workspaceStatusDescription,
    {},
    async () => {
      try {
        const status = await workspaceStatus(ctx)
        const { bytes: _bytes, ...rest } = status
        return { content: [{ type: "text" as const, text: "```json\n" + JSON.stringify(rest, null, 2) + "\n```" }] }
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.tool(
    "read",
    readDescription,
    {
      path: z.string().describe("File or directory to read"),
      offset: z.number().int().optional().describe("The line or directory entry to start reading from (1-based; negative reads the file's tail)"),
      limit: z.number().int().optional().describe("The maximum number of lines or directory entries to read (defaults to and capped at 2000)"),
    },
    async (input) => {
      try {
        const outcome = await readTool(ctx, input)
        if (outcome.media) {
          return {
            content: [
              { type: "text" as const, text: "Image or document read successfully." },
              { type: "image" as const, mimeType: outcome.media.mime, data: outcome.media.base64 },
            ],
          }
        }
        return text(outcome.text ?? "")
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.tool(
    "list",
    listDescription,
    {
      path: z.string().optional().describe("Directory to list; defaults to each workspace root"),
      offset: z.number().int().optional().describe("1-based entry offset"),
      limit: z.number().int().optional().describe("Maximum entries to return"),
    },
    async (input) => {
      try {
        const outcome = await listTool(ctx, input)
        return text(outcome.text)
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.tool(
    "glob",
    globDescription,
    {
      pattern: z.string().min(1).describe("Glob pattern to match files against"),
      path: z.string().optional().describe("Directory to search; defaults to every workspace root"),
      limit: z.number().int().optional().describe("Maximum number of matching files to return (default 100, max 1000)"),
    },
    async (input) => {
      try {
        const outcome = await globTool(ctx, input)
        return text(outcome.text)
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.tool(
    "grep",
    grepDescription,
    {
      pattern: z.string().min(1).describe("Regular expression or literal text to match in file contents."),
      path: z.string().optional().describe("File or directory to search. Defaults to all workspace roots."),
      include: z.string().optional().describe('Glob pattern to filter files (for example, "*.js" or "*.{ts,tsx}")'),
      literal: z.boolean().optional().describe("Treat pattern as exact text instead of a regular expression (default: false)."),
      caseSensitive: z.boolean().optional().describe("Use case-sensitive matching (default: true)."),
      limit: z.number().int().optional().describe("Maximum number of matching lines to return (default: 100)"),
    },
    async (input) => {
      try {
        const outcome = await grepTool(ctx, input)
        return text(outcome.text)
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.tool(
    "write",
    writeDescription,
    {
      path: z.string().describe("Path to the file to write to"),
      content: z.string().describe("Content to write to the file"),
    },
    async (input) => {
      try {
        const outcome = await writeTool(ctx, input)
        return text(outcome.output)
      } catch (error) {
        return failure(error)
      }
    },
  )

  server.tool(
    "edit",
    editDescription,
    {
      path: z.string().describe("File to edit"),
      oldString: z.string().describe("Exact text to find and replace"),
      newString: z.string().describe("Text to replace oldString with (must differ from oldString)"),
      replaceAll: z.boolean().optional().describe("Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false."),
    },
    async (input) => {
      try {
        const outcome = await editTool(ctx, input)
        const stats = `+${outcome.diff.additions} -${outcome.diff.deletions}`
        return text(`${outcome.output}\n\n\`\`\`diff\n${outcome.diff.patch}\n\`\`\`\n(${stats})`)
      } catch (error) {
        return failure(error)
      }
    },
  )

  void MEDIA_MIMES
  return server
}

export async function serve(ctx: ToolContext) {
  const server = createServer(ctx)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
