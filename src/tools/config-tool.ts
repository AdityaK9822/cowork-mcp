// workspace_request_config — the ONLY way the model may ask for sandbox
// changes. Non-mutating by contract: it stages a request file and launches the
// GUI helper for the HUMAN to complete. The server process never parses the
// window's payload; the helper writes config.json itself and the change lands
// at the next server restart. There is deliberately no companion tool that
// writes configuration: the model can invite the user, never edit the
// sandbox.

import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { randomUUID } from "node:crypto"
import { ToolFailure } from "../errors.js"
import type { ToolContext } from "./context.js"
import { runTooled } from "./context.js"
export const REQUEST_TIMEOUT_MS = 10 * 60 * 1000

export const requestConfigDescription = `Open a configuration window on the user's screen so THEY can connect a new workspace (drag-drop a folder or pick one) and adjust that workspace's permissions. Use this ONLY when the user explicitly asks to connect, add, or configure a workspace. This tool never changes anything by itself: it only raises a window that the user completes. Never claim a workspace is connected unless workspace_status shows it AFTER the server restarts. The reason string is shown to the user inside the window as coming from you.`

export const requestConfigInput = {
  reason: z
    .string()
    .min(1)
    .max(300)
    .describe("Why this window is being opened, e.g. 'You asked me to add the ~/notes folder'. Shown to the user."),
}

interface PendingRequest {
  id: string
  reason: string
  requestedAt: string
  timeoutAt: string
  serverPid: number
  configPath: string
}

/** Launch candidates in priority order: the config-window helper, then the picker CLI. */
function helperCandidates(ctx: ToolContext): Array<{ kind: "gui" | "picker"; command: string; args: string[] }> {
  const candidates: Array<{ kind: "gui" | "picker"; command: string; args: string[] }> = []
  if (ctx.helpers?.gui && ctx.helpers?.guiDir)
    candidates.push({ kind: "gui", command: ctx.helpers.gui, args: [ctx.helpers.guiDir] })
  if (ctx.helpers?.picker)
    candidates.push({ kind: "picker", command: process.execPath, args: [ctx.helpers.picker] })
  return candidates
}

/** Liveness probe mirroring the helper's lockfile eviction: a dead PID's lock is stale. */
async function lockIsLive(lockPath: string): Promise<boolean> {
  const raw = await fs.readFile(lockPath, "utf8").catch(() => null)
  if (raw === null) return false
  const pid = Number.parseInt(raw.trim(), 10)
  if (!Number.isFinite(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === "EPERM" // Process exists but is owned by another user — treat as live.
  }
}

export async function requestConfigTool(ctx: ToolContext, input: { reason: string }) {
  return runTooled(ctx, "workspace_request_config", { reason: "<reason>" }, async () => {
    if (!ctx.config) throw new ToolFailure("No config handle available; cannot stage a configuration request.")
    if (process.env.COWORK_NO_GUI === "1")
      return {
        launched: false,
        config: "manual",
        alternative: `GUI disabled. Ask the user to edit ${ctx.config.path} directly and restart Claude Desktop.`,
      }

    const pendingDir = path.join(path.dirname(ctx.config.path), "pending")
    const lockPath = path.join(pendingDir, "gui.lock")
    if (await lockIsLive(lockPath))
      throw new ToolFailure(
        "A configuration window is already open. Wait for the user to finish with it before asking again.",
      )

    const candidates = helperCandidates(ctx)
    if (candidates.length === 0)
      return {
        launched: false,
        config: "manual",
        alternative: `No configuration helper is bundled. Ask the user to edit ${ctx.config.path} directly and restart Claude Desktop.`,
      }

    const now = Date.now()
    const request: PendingRequest = {
      id: randomUUID(),
      reason: input.reason,
      requestedAt: new Date(now).toISOString(),
      timeoutAt: new Date(now + REQUEST_TIMEOUT_MS).toISOString(),
      serverPid: process.pid,
      configPath: ctx.config.path,
    }
    await fs.mkdir(pendingDir, { recursive: true })
    const requestFile = path.join(pendingDir, `request-${request.id}.json`)
    await fs.writeFile(requestFile, JSON.stringify(request, null, 2), "utf8")
    await fs.writeFile(lockPath, String(process.pid), "utf8").catch(() => {})

    const { kind, command, args: prefix } = candidates[0]!
    const child = spawn(command, [...prefix, "--request", requestFile, "--lock", lockPath], {
      detached: true,
      stdio: "ignore",
      env: process.env,
    })
    child.unref()

    return {
      launched: true,
      helper: kind === "gui" ? "configuration window" : "native folder picker",
      note:
        kind === "picker"
          ? "The picker can only connect a folder with default permissions; permission editing needs the configuration window."
          : "The user sees your reason in the window. Changes apply after this server restarts — verify with workspace_status afterwards.",
      alternative: `The user can also edit ${ctx.config.path} directly.`,
    }
  })
}
