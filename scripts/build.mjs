import { build } from "esbuild"

const banner = `/* cowork-mcp v${process.env.npm_package_version ?? "0.1.0"} — free Claude-Desktop-native agentic workspace.\n   Portions adapted from opencode (MIT), see NOTICE. */`

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.cjs",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  banner: { js: banner },
  sourcemap: "inline",
  logLevel: "info",
})
