// Shared per-call context: resolves paths through the sandbox, applies the
// global denylist, the per-workspace tool toggles and deny globs, and journals
// every call. Tools never touch policy directly.

import type { Roots, Target, ToolName } from "../policy/roots.js"
import type { Denylist } from "../policy/denylist.js"
import type { Audit, AuditResult } from "../policy/audit.js"
import type { Snapshots } from "../policy/snapshot.js"
import type { ConfigFileHandle } from "../policy/config-file.js"
import { ToolFailure } from "../errors.js"
import picomatch from "picomatch"

export interface ToolContext {
  roots: Roots
  denylist: Denylist
  audit: Audit
  snapshots: Snapshots
  /** Handle on config.json: path + sha256 as booted; detects pending changes not yet applied. */
  config?: ConfigFileHandle
  /** Paths of the config-window / picker helpers, when built. Both share the contract `<gui> <guiDir> …args`. */
  helpers?: { gui?: string; guiDir?: string; picker?: string }
}

export interface Authorized extends Target {
  decision: ReturnType<Denylist["check"]>
}

/**
 * Resolve + global denylist + per-workspace tool toggle + per-workspace deny
 * globs in one step. Throws ToolFailure on any gate. Mutation denials on a
 * read-only workspace and disabled-tool denials carry the "Blocked:" prefix so
 * runTooled classifies them as `denied` in the audit journal.
 */
export async function authorize(ctx: ToolContext, tool: ToolName, input: string): Promise<Authorized> {
  const target = await ctx.roots.resolve(input)
  const { workspace } = target
  if (!ctx.roots.toolEnabledFor(workspace, tool))
    throw new ToolFailure(
      `Blocked: tool '${tool}' is not enabled for workspace '${workspace.name}'. The user controls this in the workspace configuration.`,
    )
  const decision = ctx.denylist.check(target.real, target.relative)
  if (!decision.allowed) throw new ToolFailure(`Blocked: ${decision.rule}`)
  const workspaceRule = workspaceDeny(workspace, target.relative)
  if (workspaceRule) throw new ToolFailure(`Blocked: workspace rule (${workspaceRule})`)
  return { ...target, decision }
}

/**
 * Per-workspace deny globs: matched like the global relative set (matchBase for
 * slash-less patterns, basename fallback), with exact-path allow exceptions.
 * The global floor has ALREADY been checked in Denylist.check and cannot be
 * excused by these per-workspace allows.
 */
function workspaceDeny(workspace: Target["workspace"], relative: string): string | undefined {
  const rel = relative.replaceAll("\\", "/")
  if (workspace.grant.denyAllow.includes(rel)) return undefined
  for (const pattern of workspace.grant.denyRelative) {
    if (matchesRelative(pattern, rel)) return pattern
  }
  return undefined
}

/** One relative deny pattern against one workspace-relative path (shared with root-level search filtering). */
export function matchesRelative(pattern: string, rel: string): boolean {
  const options = { dot: true, matchBase: !pattern.includes("/") }
  return (
    picomatch.isMatch(rel, pattern, options) ||
    picomatch.isMatch(rel.split("/").pop() ?? "", pattern, { dot: true })
  )
}

/**
 * Whether a workspace-relative result of a root-level search is blocked by the
 * global denylist's relative rules plus this workspace's own globs. Exact-path
 * allows (global and per-workspace) excuse a path ONLY from relative rules —
 * the global absolute floor (data home, ~/.ssh) is irrelevant here because
 * search results are workspace-relative by construction.
 */
export function searchResultBlocked(
  global: { relative: string[]; allow: string[] },
  workspace: { relative: string[]; allow: string[] },
  relative: string,
): boolean {
  const rel = relative.replaceAll("\\", "/")
  if (global.allow.includes(rel) || workspace.allow.includes(rel)) return false
  for (const pattern of [...global.relative, ...workspace.relative]) {
    if (matchesRelative(pattern, rel)) return true
  }
  return false
}

/** Journal one call; never throws. */
export async function journal(
  ctx: ToolContext,
  tool: string,
  args: Record<string, unknown>,
  result: AuditResult,
  extra?: { workspace?: string; reason?: string; bytes?: number },
): Promise<void> {
  await ctx.audit.append({ ts: new Date().toISOString(), tool, args, result, ...extra })
}

/** Run a tool body with guaranteed journaling, converting throws into ToolFailure text results. */
export async function runTooled<A>(
  ctx: ToolContext,
  tool: string,
  args: Record<string, unknown>,
  body: () => Promise<A>,
): Promise<A> {
  try {
    const value = await body()
    await journal(ctx, tool, args, "ok", extraOf(value))
    return value
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const denied = message.startsWith("Blocked:") || message.includes("outside the allowed workspaces")
    await journal(ctx, tool, args, denied ? "denied" : "error", { reason: message })
    throw error
  }
}

type WithBytes = { bytes?: number; workspace?: string }
const extraOf = (value: unknown): { bytes?: number; workspace?: string } => {
  if (value && typeof value === "object") {
    const source = value as WithBytes
    return { ...(source.bytes === undefined ? {} : { bytes: source.bytes }), ...(source.workspace === undefined ? {} : { workspace: source.workspace }) }
  }
  return {}
}
