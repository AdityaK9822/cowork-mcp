#!/usr/bin/env node
// Packages the cowork-gui helper as UNMODIFIED Electron runtime + app dir —
// the same layout `npx electron .` runs, which is why it avoids Electron's
// re-packaging pitfalls (ICU/resources, re-signing). Output:
//
//   dist/cowork-gui-<os>-<arch>/
//     Electron.app | electron | electron.exe   ← runtime, copied as-is
//     app/                                     ← main.cjs, preload.cjs, renderer/, deps
//
// Launch contract (see src/index.ts resolveHelpers):
//   <runtime binary> <app dir> --request <file> --lock <file>

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, "..")
const gui = path.join(root, "gui")
const electronDist = path.join(gui, "node_modules", "electron", "dist")
const outRoot = path.join(root, "dist")

if (!fs.existsSync(electronDist)) {
  console.log("cowork-gui deps not installed — skipping helper build (picker fallback stays available)")
  console.log("  npm --prefix gui install && npm run build:gui")
  process.exit(0)
}

const platform = process.platform
const arch = process.arch
const suffix = { darwin: "darwin", linux: "linux", win32: "win32" }[platform]
if (!suffix) {
  console.log(`unsupported helper platform ${platform} — skipping (picker stays available)`)
  process.exit(0)
}
const outDir = path.join(outRoot, `cowork-gui-${suffix}-${arch}`)
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outRoot, { recursive: true })

// Runtime: Electron.app on macOS, plain dir with the `electron` binary elsewhere.
// Copied AS-IS — default_app.asar stays because it is what dispatches
// `electron <app dir>`; stripping it yields a silent exit 1.
// macOS uses ditto: fs.cpSync dereferences the .app's framework symlinks,
// which breaks Chromium's ICU-resource lookup (renderer/helper crashes).
import { execFileSync } from "node:child_process"
const runtimeSrc = path.join(electronDist, platform === "darwin" ? "Electron.app" : ".")
const runtimeDst = path.join(outDir, platform === "darwin" ? "Electron.app" : ".")
if (platform === "darwin") execFileSync("ditto", [runtimeSrc, runtimeDst])
else fs.cpSync(runtimeSrc, runtimeDst, { recursive: true, verbatimSymlinks: true })

// App payload: entry points, renderer assets, production dependencies only.
const appDir = path.join(outDir, "app")
fs.mkdirSync(appDir, { recursive: true })
for (const file of ["main.cjs", "preload.cjs", "package.json"]) fs.copyFileSync(path.join(gui, file), path.join(appDir, file))
fs.cpSync(path.join(gui, "renderer"), path.join(appDir, "renderer"), { recursive: true })
fs.cpSync(path.join(gui, "node_modules", "picomatch"), path.join(appDir, "node_modules", "picomatch"), { recursive: true })

console.log(`cowork-gui packaged: ${outDir}`)
