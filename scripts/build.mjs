import { build } from "esbuild"

for (const entry of [
  { in: "src/index.ts", out: "dist/index.cjs" },
  { in: "src/audit-cli.ts", out: "dist/audit.cjs" },
  { in: "src/config-picker.ts", out: "dist/config-picker.cjs" },
]) {
  await build({
    entryPoints: [entry.in],
    outfile: entry.out,
    bundle: true,
    platform: "node",
    target: "node20",
    format: "cjs",
    banner: { js: `/* cowork-mcp — portions adapted from opencode (MIT), see NOTICE. */` },
    sourcemap: "inline",
    logLevel: "warning",
  })
}
console.log("built dist/index.cjs + dist/audit.cjs + dist/config-picker.cjs")
