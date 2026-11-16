// Adapted from opencode (MIT) — packages/core/src/tool/plugin/edit.ts.
// The matcher family is ported near-verbatim (pure functions): LF-view
// matching mapped back to source bytes, CRLF preservation via LCS line
// alignment, unicode-variant and trailing-whitespace fallback tiers, and the
// miss-hint that avoids a re-read round-trip.

interface Match {
  readonly start: number
  readonly end: number
}

export interface EditInput {
  oldString: string
  newString: string
  replaceAll?: boolean
}

export interface EditOutcome {
  /** Full file content after the edit. */
  replaced: string
  replacements: number
}

const crlf = "\r\n"

const normalizeForMatch = (value: string) =>
  value
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")

const findOccurrences = (content: string, search: string) => {
  const result: Match[] = []
  let offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) {
    result.push({ start: offset, end: offset + search.length })
    offset += search.length
  }
  return result
}

const findLineOccurrences = (content: string, search: string) => {
  const trailingNewline = search.endsWith("\n")
  const expected = search.split("\n")
  if (trailingNewline) expected.pop()
  const lines = [...content.matchAll(/[^\n]*(?:\n|$)/g)]
    .filter((match) => match[0] !== "")
    .map((match) => {
      const newline = match[0].endsWith("\n")
      const text = newline ? match[0].slice(0, -1) : match[0]
      return {
        start: match.index,
        end: match.index + match[0].length,
        text,
        contentEnd: match.index + text.length - (text.endsWith("\r") ? 1 : 0),
        newline,
      }
    })
  const candidates = lines.flatMap((line, index) => {
    const actual = lines.slice(index, index + expected.length)
    if (actual.length !== expected.length) return []
    if (
      !actual.every(
        (item, lineIndex) =>
          normalizeForMatch(item.text.trimEnd()) === normalizeForMatch(expected[lineIndex]!.trimEnd()),
      )
    )
      return []
    const last = actual.at(-1)!
    if (trailingNewline && !last.newline) return []
    return [{ start: line.start, end: trailingNewline ? last.end : last.contentEnd }]
  })
  return candidates.reduce<Match[]>((result, candidate) => {
    if (result.some((match) => match.end > candidate.start && match.start < candidate.end)) return result
    result.push(candidate)
    return result
  }, [])
}

/** The dominant line ending in text, or fallback when there is none. */
const lineEnding = (text: string, fallback: string) => {
  const crlfCount = text.split(crlf).length - 1
  const lfCount = text.split("\n").length - 1 - crlfCount
  if (crlfCount === lfCount) return fallback
  return crlfCount > lfCount ? crlf : "\n"
}

/**
 * Joins the replacement's lines with line endings taken from the matched source region. A replacement line that
 * keeps a region line (longest common subsequence, compared like the trailing-whitespace tier) reuses that line's
 * ending; a line that changes in place reuses the ending of the line it replaces; only lines beyond those take
 * `fallback`. Unchanged context inside a match therefore keeps its bytes even in a mixed-ending file.
 */
const withRegionEndings = (region: string, replacement: string, fallback: string) => {
  const before = region.split(/\r?\n/)
  const endings = [...region.matchAll(/\r?\n/g)].map((match) => match[0])
  const after = replacement.split("\n")
  const key = (line: string) => normalizeForMatch(line.trimEnd())
  const source = alignLines(before.map(key), after.map(key))
  return after.map((line, index) => (index === after.length - 1 ? line : line + (endings[source[index]!] ?? fallback))).join("")
}

/**
 * For each line of `after`, the index of the `before` line it keeps (longest common subsequence) or, between kept
 * lines, the line it takes the place of; undefined for lines with no counterpart.
 */
const alignLines = (before: string[], after: string[]) => {
  const width = after.length + 1
  const table = new Uint32Array((before.length + 1) * width)
  for (let i = before.length - 1; i >= 0; i--)
    for (let j = after.length - 1; j >= 0; j--)
      table[i * width + j] =
        before[i] === after[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
  const result: (number | undefined)[] = []
  const gap = { before: [] as number[], after: [] as number[] }
  const flush = () => {
    gap.after.forEach((j, k) => (result[j] = gap.before[k]))
    gap.before = []
    gap.after = []
  }
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      flush()
      result[j++] = i++
      continue
    }
    if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) gap.before.push(i++)
    else gap.after.push(j++)
  }
  while (i < before.length) gap.before.push(i++)
  while (j < after.length) gap.after.push(j++)
  flush()
  return result
}

/**
 * Matches against the LF view Read shows the model, then maps offsets back to the source, so CRLF and mixed line
 * endings neither block matches nor leak into untouched regions.
 */
const matchView = (source: string, oldString: string, newString: string) => {
  const view = source.replaceAll(crlf, "\n")
  const removed = [...source.matchAll(/\r\n/g)].map((match, index) => (match.index ?? 0) - index)
  const fileEnding = lineEnding(source, "\n")
  const search = oldString.replaceAll(crlf, "\n")
  const replacement = newString.replaceAll(crlf, "\n")
  const exact = findOccurrences(view, search)
  // These one-to-one mappings preserve offsets into the LF view.
  const unicode = exact.length > 0 ? [] : findOccurrences(normalizeForMatch(view), normalizeForMatch(search))
  const trailing = exact.length > 0 || unicode.length > 0 ? [] : findLineOccurrences(view, search)
  return {
    matches: (exact.length > 0 ? exact : unicode.length > 0 ? unicode : trailing).map((match) => ({
      start: match.start + countBefore(removed, match.start),
      end: match.end + countBefore(removed, match.end),
    })),
    replace: (match: Match) => {
      const region = source.slice(match.start, match.end)
      return withRegionEndings(region, replacement, lineEnding(region, fileEnding))
    },
  }
}

const hintLines = 12
const hintLineLength = 200

/**
 * A short hint for an oldString miss, so the next attempt can succeed without rereading the file: newString is
 * already there (often an edit that already applied), or the lines closest to oldString, numbered like Read output.
 * Lines vote for where oldString starts when they match ignoring all whitespace; at least half must agree. Only the
 * span from the first to the last line that matched is shown, so padding oldString cannot reveal the lines after it.
 */
export const missHint = (source: string, oldString: string, newString: string) => {
  const view = source.replaceAll(crlf, "\n")
  const replacement = newString.replaceAll(crlf, "\n")
  if (replacement.trim().length >= 20 && normalizeForMatch(view).includes(normalizeForMatch(replacement)))
    return "newString is already in the file, so this edit may already be applied."
  const key = (line: string) => normalizeForMatch(line).replace(/\s+/g, " ").trim()
  const distinct = (line: string) => /[\p{L}\p{N}]/u.test(line)
  const lines = view.split("\n")
  const search = oldString.replaceAll(crlf, "\n").split("\n")
  const positions = new Map<string, number[]>()
  lines.forEach((line, index) => {
    const value = key(line)
    if (!distinct(value)) return
    const found = positions.get(value)
    if (found) found.push(index)
    else positions.set(value, [index])
  })
  const votes = new Map<number, number>()
  const wanted = search.filter((line, offset) => {
    const value = key(line)
    if (!distinct(value)) return false
    for (const index of positions.get(value) ?? []) votes.set(index - offset, (votes.get(index - offset) ?? 0) + 1)
    return true
  }).length
  const [start, count] = [...votes].reduce((best, vote) => (vote[1] > best[1] ? vote : best), [0, 0])
  if (count === 0 || count * 2 < wanted) return
  const matched = search.flatMap((line, offset) => {
    const value = key(line)
    const index = start + offset
    return value !== "" && index >= 0 && index < lines.length && key(lines[index]!) === value ? [index] : []
  })
  const from = matched[0]
  if (from === undefined) return
  const to = Math.min(matched.at(-1)! + 1, from + hintLines)
  return [
    "The closest lines in the file:",
    ...lines
      .slice(from, to)
      .map(
        (line, index) =>
          `${from + index + 1}: ${line.length > hintLineLength ? `${line.slice(0, hintLineLength)}…` : line}`,
      ),
  ].join("\n")
}

/** Number of sorted positions strictly before offset. */
const countBefore = (positions: number[], offset: number) => {
  let low = 0
  let high = positions.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (positions[middle]! < offset) low = middle + 1
    else high = middle
  }
  return low
}

export const editInputChecks = (input: EditInput) => {
  if (input.oldString === input.newString) return "No changes to apply: oldString and newString are identical."
  if (input.oldString === "") return "oldString must not be empty. Use write to create or overwrite a file."
  return undefined
}

/**
 * Compute the edited content, or the exact ToolFailure message for the
 * cannot-apply cases (mirrors the decisions in opencode's edit leaf).
 */
export function computeEdit(source: string, input: EditInput, displayPath: string): EditOutcome {
  // Strings that differ only in \r ask to change line endings themselves, so they apply to the exact
  // bytes. Every other edit matches the LF view Read shows the model and keeps the file's endings.
  const endingsOnly = input.oldString.replaceAll("\r", "") === input.newString.replaceAll("\r", "")
  const { matches, replace } = endingsOnly
    ? { matches: findOccurrences(source, input.oldString), replace: () => input.newString }
    : matchView(source, input.oldString, input.newString)
  const replacements = matches.length
  if (replacements === 0) {
    const hint = missHint(source, input.oldString, input.newString)
    throw new Error(
      `Could not find oldString in ${displayPath}. It must match exactly, including whitespace and indentation.` +
        (hint ? `\n\n${hint}` : ""),
    )
  }
  if (replacements > 1 && input.replaceAll !== true)
    throw new Error(
      `Found ${replacements} matches for oldString, but expected exactly one. Add more surrounding context to make oldString unique, or set replaceAll to true to replace every occurrence.`,
    )
  const replaced = (input.replaceAll === true ? matches : matches.slice(0, 1))
    .toReversed()
    .reduce((content, match) => `${content.slice(0, match.start)}${replace(match)}${content.slice(match.end)}`, source)
  if (replaced === source)
    throw new Error(
      endingsOnly
        ? `No changes to apply: ${displayPath} already has those line endings.`
        : `No changes to apply: the edit leaves ${displayPath} unchanged. Line endings follow the file; to change them, write \\r explicitly in oldString or newString.`,
    )
  return { replaced, replacements: input.replaceAll === true ? replacements : 1 }
}
