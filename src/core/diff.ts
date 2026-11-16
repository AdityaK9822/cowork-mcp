// Adapted from opencode (MIT) — packages/core/src/tool/plugin/file-diff.ts
import { createTwoFilesPatch, diffLines } from "diff"

export interface FileDiffInfo {
  file: string
  patch: string
  status: "added" | "modified" | "removed"
  additions: number
  deletions: number
}

export function fileDiff(file: string, before: string, after: string, status: FileDiffInfo["status"] = "modified"): FileDiffInfo {
  const counts = diffLines(before, after).reduce(
    (result, item) => ({
      additions: result.additions + (item.added ? (item.count ?? 0) : 0),
      deletions: result.deletions + (item.removed ? (item.count ?? 0) : 0),
    }),
    { additions: 0, deletions: 0 },
  )
  return { file, patch: createTwoFilesPatch(file, file, before, after), status, ...counts }
}
