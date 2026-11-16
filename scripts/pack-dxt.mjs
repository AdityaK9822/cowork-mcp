#!/usr/bin/env node
// Packs dist/ + manifest.json into a .dxt bundle (a zip with manifest at root).
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(scriptDir, "..")
const out = path.join(root, "cowork-mcp.dxt")
fs.rmSync(out, { force: true })
const staging = fs.mkdtempSync(path.join(root, ".dxt-"))
fs.copyFileSync(path.join(root, "manifest.json"), path.join(staging, "manifest.json"))
fs.mkdirSync(path.join(staging, "dist"), { recursive: true })
fs.copyFileSync(path.join(root, "dist", "index.cjs"), path.join(staging, "dist", "index.cjs"))
for (const file of ["LICENSE", "NOTICE"]) fs.copyFileSync(path.join(root, file), path.join(staging, file))
execFileSync("zip", ["-rq", out, "."], { cwd: staging })
fs.rmSync(staging, { recursive: true, force: true })
console.log(`packed ${out} (${(fs.statSync(out).size / 1024 / 1024).toFixed(1)} MB)`)
