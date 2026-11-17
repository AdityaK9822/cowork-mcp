import { LIMITS } from "../policy/limits.js"
import type { ToolContext } from "./context.js"
import { runTooled } from "./context.js"
import { VERSION } from "../version.js"

export const workspaceStatusDescription =
  "Report the server's configuration: the workspace allowlist with each workspace's permissions (read-only, enabled tools, deny rules), the active protected-path denylist, whether configuration changes are pending a restart, the snapshot inventory, and limits. Call this before assuming what is readable or writable, and after any configuration attempt to see what the user actually granted."

export async function workspaceStatus(ctx: ToolContext) {
  return runTooled(ctx, "workspace_status", {}, async () => {
    const inventory = await ctx.snapshots.inventory()
    const pendingChange = ctx.config ? await ctx.config.pendingChange().catch(() => undefined) : undefined
    return {
      version: VERSION,
      workspaces: ctx.roots.workspacesGrantedView(),
      denylist: ctx.denylist.summary(),
      configChangePending: pendingChange === undefined ? "unknown" : pendingChange,
      configPath: ctx.config?.path,
      snapshots: inventory,
      limits: LIMITS,
      bytes: undefined,
    }
  })
}
