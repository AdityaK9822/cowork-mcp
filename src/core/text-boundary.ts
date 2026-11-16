/**
 * Codepoint-safe prefixing. Simplified port of opencode's TextBoundary.head
 * (which uses grapheme segmentation): we cut on Unicode code points, which is
 * correct for surrogate pairs but can split multi-codepoint emoji clusters —
 * an acceptable trade for a truncation marker.
 */
export function head(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  let cut = text.slice(0, maxLength)
  const last = cut.charCodeAt(cut.length - 1)
  // Drop a trailing lone high surrogate so we never split a pair in half.
  if (last >= 0xd800 && last <= 0xdbff && text.length > maxLength) cut = cut.slice(0, -1)
  return cut
}
