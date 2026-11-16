// `cowork-audit` — read-only viewer for the JSONL audit journal.

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const home = process.env.COWORK_HOME ? path.resolve(process.env.COWORK_HOME) : path.join(os.homedir(), ".cowork-mcp")
const file = process.argv[2] ?? path.join(home, "audit.jsonl")

async function main() {
  const raw = await fs.readFile(file, "utf8").catch(() => {
    process.stderr.write(`No audit journal at ${file}\n`)
    process.exit(0)
  })

  const lines = raw.split("\n").filter((line) => line.trim() !== "")
  const marks = { ok: "ok  ", denied: "DENY", error: "ERR " } as const
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as { ts: string; tool: string; workspace?: string; result: string; reason?: string; bytes?: number }
      const when = entry.ts.replace("T", " ").slice(0, 19)
      const scope = entry.workspace ? ` [${entry.workspace}]` : ""
      const detail = entry.reason ? ` — ${entry.reason.slice(0, 120)}` : entry.bytes !== undefined ? ` (${entry.bytes}B)` : ""
      process.stdout.write(`${when}  ${marks[entry.result as keyof typeof marks] ?? "    "}  ${entry.tool}${scope}${detail}\n`)
    } catch {}
  }
  process.stdout.write(`\n${lines.length} entries\n`)
  const denied = lines.filter((line) => line.includes('"denied"')).length
  if (denied > 0) process.stdout.write(`${denied} denied — inspect these first\n`)
}

main()
