// cowork-mcp entrypoint: load config once, build the policy stack, serve stdio.

import { loadConfig } from "./config.js"
import { loadDenylist } from "./policy/denylist.js"
import { Roots } from "./policy/roots.js"
import { Audit } from "./policy/audit.js"
import { Snapshots } from "./policy/snapshot.js"
import fs from "node:fs/promises"
import path from "node:path"
import { serve } from "./server.js"

const warn = (message: string) => process.stderr.write(`${message}\n`)

async function main() {
  const config = await loadConfig(process.argv.slice(2), process.env, warn)
  await fs.mkdir(config.dataHome, { recursive: true })
  await fs.mkdir(path.join(config.dataHome, "snapshots"), { recursive: true })

  const roots = new Roots(config.workspaces)
  const denylist = loadDenylist(config.dataHome, config.homedir, config.deny)
  const audit = new Audit(path.join(config.dataHome, "audit.jsonl"))
  const snapshots = new Snapshots(path.join(config.dataHome, "snapshots"))

  if (config.workspaces.length === 0)
    warn(
      "cowork-mcp: no workspaces configured. Add directories via the extension settings, --workspace /path, COWORK_WORKSPACES, or ~/.cowork-mcp/config.json.",
    )

  await serve({ roots, denylist, audit, snapshots })
}

main().catch((error) => {
  warn(`cowork-mcp: fatal: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
