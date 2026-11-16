import { LIMITS } from "../policy/limits.js"
import type { ToolContext } from "./context.js"
import { runTooled } from "./context.js"

export const workspaceStatusDescription =
  "Report the server's configuration: the workspace allowlist, active protected-path denylist, snapshot inventory, and limits. Call this before assuming what is readable or writable."

export async function workspaceStatus(ctx: ToolContext) {
  return runTooled(ctx, "workspace_status", {}, async () => {
    const inventory = await ctx.snapshots.inventory()
    return {
      version: "0.1.0",
      workspaces: ctx.roots.workspacesSafeView(),
      denylist: ctx.denylist.summary(),
      snapshots: inventory,
      limits: LIMITS,
      bytes: undefined,
    }
  })
}
