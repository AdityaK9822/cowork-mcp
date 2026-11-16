// Adapted from opencode (MIT) — packages/core/src/file-access.ts (resolvePath),
// packages/util/src/fs-util.ts (windowsPath), and the FSUtil.contains semantics
// verified by packages/core/test/filesystem/filesystem.test.ts.

import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
import { ToolFailure } from "../errors.js"

/** Normalize MSYS/Cygwin/WSL-style drive paths on Windows; a no-op elsewhere. */
export function windowsPath(p: string): string {
  if (process.platform !== "win32") return p
  return p
    .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
    .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
}

/** Expand a leading ~ and resolve lexically against `directory`. */
export function resolvePath(directory: string, input: string, home = os.homedir()): string {
  const normalized = windowsPath(input)
  return path.resolve(
    directory,
    normalized === "~"
      ? home
      : normalized.startsWith("~/") || (process.platform === "win32" && normalized.startsWith("~\\"))
        ? path.join(home, normalized.slice(2))
        : normalized,
  )
}

/**
 * True when `target` equals `root` or lies inside it. Prefix checks must be
 * segment-exact, so `/a/b` does not contain `/a/bad`.
 */
export function contains(root: string, target: string): boolean {
  if (root === target) return true
  const rel = path.relative(root, target)
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

/**
 * Realpath of the longest existing ancestor with the missing tail joined
 * lexically. Lets writes address files that do not exist yet while still
 * resolving every symlink that is actually on disk.
 */
export async function realPathLexical(target: string): Promise<string> {
  try {
    return await fs.realpath(target)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error
  }
  const parent = path.dirname(target)
  // The filesystem root always exists, so recursion terminates before parent === target.
  return path.join(await realPathLexical(parent), path.basename(target))
}

/** True for Windows absolute forms: drive-letter paths and UNC shares. */
export const isWinAbsolute = (value: string) => /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value)

export interface Workspace {
  /** User-visible label. */
  name: string
  /** Normalized absolute root as configured. */
  root: string
  /** Realpath of the root; containment is decided against this. */
  real: string
}

export interface Target {
  workspace: Workspace
  /** Lexical absolute path (symlinks not yet applied). */
  absolute: string
  /** Realpath with any non-existing tail joined lexically. */
  real: string
  /** Workspace-relative path, forward slashes, computed lexically. */
  relative: string
}

/**
 * The authoritative sandbox. Every tool resolves its paths only through this
 * class; a target is usable only when its FULLY RESOLVED realpath lies inside
 * one workspace's real root. Containment is decided on the realpath alone:
 * lexical prefixes can be symlinked aliases of the root (e.g. /tmp on macOS),
 * and the resolved-real check is the security-critical direction (escapes).
 */
export class Roots {
  constructor(private readonly workspaces: readonly Workspace[]) {}

  /** Read-only view for tools and status output. */
  workspacesSafeView() {
    return this.workspaces.map((ws) => ({ name: ws.name, root: ws.root, real: ws.real }));
  }

  /**
   * Resolve a tool-supplied path to a verified target, or fail. Relative
   * inputs resolve against each workspace root; absolute and ~ inputs resolve
   * against the system. When overlapping workspaces both contain the target,
   * an existing target wins over a would-be path; ties prefer the most
   * specific (longest-root) grant. Symlink escapes never pass: the realpath
   * of every existing component is resolved and re-checked.
   */
  async resolve(input: string, home = os.homedir()): Promise<Target> {
    const trimmed = input.trim()
    if (trimmed === "") throw new ToolFailure("Path must not be empty")
    const candidates: Array<{ ws: Workspace; absolute: string; real: string; exists: boolean }> = []
    for (const ws of this.workspaces) {
      const absolute = resolvePath(ws.real, trimmed, home)
      const real = await realPathLexical(absolute)
      if (!contains(ws.real, real)) continue
      let exists = true
      try {
        await fs.stat(absolute)
      } catch {
        exists = false
      }
      candidates.push({ ws, absolute, real, exists })
    }
    if (candidates.length === 0) throw new ToolFailure(`Path is outside the allowed workspaces: ${trimmed}`)
    candidates.sort((a, b) => Number(b.exists) - Number(a.exists) || b.ws.real.length - a.ws.real.length)
    const best = candidates[0]!
    const relative = path.relative(best.ws.real, best.real).replaceAll("\\", "/") || "."
    return { workspace: best.ws, absolute: best.absolute, real: best.real, relative }
  }
}
