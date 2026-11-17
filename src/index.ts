// cowork-mcp entrypoint: load config once, build the policy stack, serve stdio.

import { loadConfig } from "./config.js"
import { loadDenylist } from "./policy/denylist.js"
import { Roots } from "./policy/roots.js"
import { Audit } from "./policy/audit.js"
import { Snapshots } from "./policy/snapshot.js"
import { openConfigFile } from "./policy/config-file.js"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { serve } from "./server.js"
import { VERSION } from "./version.js"

const warn = (message: string) => process.stderr.write(`${message}\n`)

/**
 * Resolve bundled helper paths relative to the running bundle file:
 *   <root>/dist/index.cjs (packaged) or <root>/src/index.ts → <root> via argv[1].
 * Packaged GUI (scripts/build-gui.mjs): dist/cowork-gui-<os>-<arch>/{runtime, app}.
 * Dev GUI: gui/node_modules/.bin/electron with app dir gui/. Both share the
 * launch contract `<gui> <guiDir> --request <file> --lock <file>`.
 * Picker: dist/config-picker.cjs, always built.
 */
type HelperOS = "darwin" | "linux" | "win32"
const isHelperOS = (platform: NodeJS.Platform): platform is HelperOS =>
  platform === "darwin" || platform === "linux" || platform === "win32"

function resolveHelpers(): { gui?: string; guiDir?: string; picker?: string } {
  const script = process.argv[1] ? path.resolve(process.argv[1]) : ""
  const root = script ? path.dirname(path.dirname(script)) : process.cwd()
  const dist = path.join(root, "dist")
  const helpers: { gui?: string; guiDir?: string; picker?: string } = {}
  const picker = path.join(dist, "config-picker.cjs")
  if (fsSync.existsSync(picker)) helpers.picker = picker

  const guiRoot = isHelperOS(process.platform) ? path.join(dist, `cowork-gui-${process.platform}-${process.arch}`) : undefined
  if (guiRoot && fsSync.existsSync(guiRoot)) {
    const runtime =
      process.platform === "darwin"
        ? path.join(guiRoot, "Electron.app", "Contents", "MacOS", "Electron")
        : process.platform === "win32"
          ? path.join(guiRoot, "electron.exe")
          : path.join(guiRoot, "electron")
    if (fsSync.existsSync(runtime) && fsSync.existsSync(path.join(guiRoot, "app", "package.json"))) {
      helpers.gui = runtime
      helpers.guiDir = path.join(guiRoot, "app")
      return helpers
    }
  }

  // Dev checkout: the gui/ workspace with its own electron dependency.
  const devElectron = path.join(root, "gui", "node_modules", ".bin", "electron")
  if (fsSync.existsSync(devElectron)) {
    helpers.gui = devElectron
    helpers.guiDir = path.join(root, "gui")
  }
  return helpers
}

async function main() {
  const config = await loadConfig(process.argv.slice(2), process.env, warn)
  await fs.mkdir(config.dataHome, { recursive: true })
  await fs.mkdir(path.join(config.dataHome, "snapshots"), { recursive: true })

  const roots = new Roots(config.workspaces)
  const denylist = loadDenylist(config.dataHome, config.homedir, config.deny)
  const audit = new Audit(path.join(config.dataHome, "audit.jsonl"))
  const snapshots = new Snapshots(path.join(config.dataHome, "snapshots"))
  const configHandle = await openConfigFile(config.configPath)

  if (config.workspaces.length === 0)
    warn(
      "cowork-mcp: no workspaces configured. Add directories via the extension settings, --workspace /path, COWORK_WORKSPACES, or ~/.cowork-mcp/config.json.",
    )

  await serve({ roots, denylist, audit, snapshots, config: configHandle, helpers: resolveHelpers() })
}

main().catch((error) => {
  warn(`cowork-mcp: fatal: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
