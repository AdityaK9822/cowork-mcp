// Shared per-call context: resolves paths through the sandbox, applies the
// denylist, and journals every call. Tools never touch policy directly.

import type { Roots, Target } from "../policy/roots.js"
import type { Denylist } from "../policy/denylist.js"
import type { Audit, AuditResult } from "../policy/audit.js"
import type { Snapshots } from "../policy/snapshot.js"
import { ToolFailure } from "../errors.js"

export interface ToolContext {
  roots: Roots
  denylist: Denylist
  audit: Audit
  snapshots: Snapshots
}

export interface Authorized extends Target {
  decision: ReturnType<Denylist["check"]>
}

/** Resolve + denylist in one step; throws ToolFailure on either gate. */
export async function authorize(ctx: ToolContext, input: string): Promise<Authorized> {
  const target = await ctx.roots.resolve(input)
  const decision = ctx.denylist.check(target.real, target.relative)
  if (!decision.allowed) throw new ToolFailure(`Blocked: ${decision.rule}`)
  return { ...target, decision }
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
