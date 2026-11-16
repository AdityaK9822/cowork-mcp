// Protected-path policy. The relative set matches workspace-relative paths
// (matchBase: slash-less patterns hit the basename at any depth); the absolute
// set matches realpath'd locations. The data directory and home credential
// stores are a hard floor that user configuration can extend but never remove.

import path from "node:path"
import picomatch from "picomatch"
import { ToolFailure } from "../errors.js"

export const DEFAULT_RELATIVE = [".env*", "*.pem", "*.key", "id_rsa*", "**/.git/**", ".git", ".npmrc"] as const

export function defaultAbsolute(dataHome: string, homedir: string): string[] {
  const slash = (value: string) => value.replaceAll("\\", "/")
  return [`${slash(dataHome)}/**`, `${slash(homedir)}/.aws/**`, `${slash(homedir)}/.ssh/**`]
}

export interface DenyDecision {
  allowed: boolean
  /** Which rule fired, for error and audit messages. */
  rule?: string
  /** True when the relative allowlist (exact user-granted paths) exempted the path. */
  granted?: boolean
}

export interface DenylistSpec {
  relative: string[]
  absolute: string[]
  /** Exact workspace-relative paths the user explicitly granted; no globs. */
  allow: string[]
}

const norm = (value: string) => value.replaceAll("\\", "/")

export class Denylist {
  constructor(private readonly spec: DenylistSpec) {}

  /** Absolute patterns always decide first — an explicit grant cannot unprotect them. */
  check(absolute: string, relative: string): DenyDecision {
    const abs = norm(absolute)
    for (const pattern of this.spec.absolute) {
      if (picomatch.isMatch(abs, pattern, { dot: true }))
        return { allowed: false, rule: `protected path (${pattern})` }
    }
    const rel = norm(relative)
    if (this.spec.allow.includes(rel)) return { allowed: true, granted: true }
    for (const pattern of this.spec.relative) {
      const options = { dot: true, matchBase: !pattern.includes("/") }
      if (picomatch.isMatch(rel, pattern, options) || picomatch.isMatch(path.posix.basename(rel), pattern, { dot: true }))
        return { allowed: false, rule: `protected file pattern (${pattern})` }
    }
    return { allowed: true }
  }

  summary() {
    return {
      relative: this.spec.relative,
      absolute: this.spec.absolute.map(norm),
      allow: this.spec.allow,
    }
  }
}

/** Compile config input, validating that allow entries are exact paths (no glob magic). */
export function loadDenylist(dataHome: string, homedir: string, overrides?: Partial<DenylistSpec>): Denylist {
  const spec: DenylistSpec = {
    relative: [...DEFAULT_RELATIVE, ...(overrides?.relative ?? [])],
    absolute: [...defaultAbsolute(dataHome, homedir), ...(overrides?.absolute ?? [])],
    allow: overrides?.allow ?? [],
  }
  for (const entry of spec.allow) {
    if (/[*?[\]!{}]/.test(entry))
      throw new ToolFailure(`Allowlist entries must be exact paths without glob characters: ${entry}`)
  }
  return new Denylist(spec)
}
