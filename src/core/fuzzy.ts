// Adapted from opencode (MIT) — packages/core/src/tool/plugin/read.ts
// (similar/canonical/stem/editDistance, numbered read output) plus the
// file-not-found suggestion flow that names the nearest existing parent.

import fs from "node:fs/promises"
import path from "node:path"
import { head } from "./text-boundary.js"
import type { Page } from "./paging.js"

/** NFC-normalize and fold look-alike spaces and quotes so near-misses match. */
export const canonical = (name: string) =>
  name
    .normalize("NFC")
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/[\u2018\u2019]/g, "'")

export const stem = (name: string) => {
  const dot = name.lastIndexOf(".")
  const stripped = dot > 0 ? name.slice(0, dot) : name
  return stripped || name
}

export const editDistance = (a: string, b: string) => {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    for (let j = 1; j <= b.length; j++)
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    previous = current
  }
  return previous[b.length]!
}

/**
 * Ranks a folder's entries against a missing name: same name ignoring case,
 * then same stem with another extension, then one containing the other, then
 * a typo in the stem.
 */
export const similar = (names: readonly string[], requested: string) => {
  const name = requested.toLowerCase()
  const wanted = stem(name)
  const typos = wanted.length < 3 ? 0 : wanted.length < 5 ? 1 : 2
  const tier = (candidate: string) => {
    if (candidate === name) return 1
    // Names that only differ in look-alike characters are what exact recovery handles or deliberately skips.
    if (canonical(candidate) === canonical(name)) return
    const found = stem(candidate)
    if (found === wanted) return 2
    if (
      Math.min(found.length, wanted.length) >= 3 &&
      (candidate.includes(name) || name.includes(candidate) || found.includes(wanted) || wanted.includes(found))
    )
      return 3
    // Folders can be huge, so skip the distance when the lengths alone rule out a typo.
    if (typos > 0 && Math.abs(found.length - wanted.length) <= typos && editDistance(found, wanted) <= typos) return 4
  }
  return names
    .filter((entry) => entry !== requested)
    .flatMap((entry) => {
      const rank = tier(entry.toLowerCase())
      return rank === undefined ? [] : [{ entry, rank, distance: editDistance(entry.toLowerCase(), name) }]
    })
    .sort((a, b) => a.rank - b.rank || a.distance - b.distance || a.entry.localeCompare(b.entry))
    .slice(0, 3)
    .map((match) => match.entry)
}

const didYouMean = (suggestions: string[]) =>
  suggestions.length === 0 ? [] : [`Did you mean one of these?\n${suggestions.slice(0, 3).join("\n")}`]

/**
 * Model-facing miss message for a path that resolved inside a workspace but
 * does not exist: names the nearest existing parent when the parent folder is
 * gone, and offers ranked suggestions from the listing.
 */
export async function notFoundMessage(input: string, absolute: string): Promise<string> {
  const folder = path.dirname(absolute)
  const child = path.basename(absolute)
  let listing: string[] = []
  try {
    const entries = await fs.readdir(folder, { withFileTypes: true })
    listing = entries.map((entry) => entry.name)
  } catch {
    // The nearest existing parent search: walk up until a directory lists.
    let walk = path.dirname(folder)
    while (walk !== path.dirname(walk)) {
      try {
        const entries = await fs.readdir(walk, { withFileTypes: true })
        const present = entries.find((entry) => entry.isDirectory() && path.join(walk, entry.name) === folder)
        if (!present) {
          return [
            `File not found: ${input}`,
            `The folder ${folder} does not exist. The nearest folder that does is ${walk}.`,
          ].join("\n\n")
        }
      } catch {
        break
      }
      walk = path.dirname(walk)
    }
    return `File not found: ${input}`
  }
  const suggestions = similar(listing, child).map((entry) => path.join(path.dirname(input), entry))
  return [`File not found: ${input}`, ...didYouMean(suggestions)].join("\n\n")
}

/**
 * Numbered model-facing text for read results, faithful to opencode's
 * toModelContent for text pages and directory listings. Media pages are
 * rendered by the tool layer (MCP content blocks) and never reach this.
 */
export function formatRead(displayPath: string, offset: number | undefined, output: Page): string {
  if (output.type === "list-page") {
    const start = offset || 1
    const content = [
      output.entries.length === 0
        ? `Read directory ${displayPath}, 0 entries`
        : `Read directory ${displayPath}, entries ${start}-${start + output.entries.length - 1}`,
    ]
    output.entries.forEach((entry) => content.push(entry.path))
    if (output.truncated && output.next !== undefined)
      content.push(`[Output truncated. Continue reading with offset: ${output.next}]`)
    return content.join("\n")
  }

  const start = output.type === "text-page" ? output.offset : 1
  // Pages already join selected lines; a trailing newline represents a selected blank line.
  const text = output.type === "file" ? output.content.replace(/\n$/, "") : output.content
  const empty = output.type === "text-page" ? output.lineCount === 0 : output.content === ""
  const lines = empty ? [] : text.split("\n")
  // A page that starts before the requested offset is the file's tail, returned for an offset past the end.
  const total = start + lines.length - 1
  const pastEnd = output.type === "text-page" && offset !== undefined && start < offset
  const content = [
    (lines.length === 0 ? `Read file ${displayPath}, 0 lines` : `Read file ${displayPath}, lines ${start}-${total}`) +
      (pastEnd ? ` (offset ${offset} is past the end; the file has ${total} ${total === 1 ? "line" : "lines"})` : ""),
  ]
  lines.forEach((line, index) => content.push(`${start + index}: ${line}`))
  if (output.type === "text-page" && output.truncated && output.next !== undefined)
    content.push(`[Output truncated. Continue reading with offset: ${output.next}]`)
  return content.join("\n")
}

export { head }
