# cowork-mcp

A free, Claude-Desktop-native agentic workspace: give **Claude Desktop** (free plan) safe
read/search/edit access to directories you choose — no IDE, no Google login, no paid tier.

Every capability an agent needs on real codebases is built in: paged reads of huge files,
ripgrep-backed search, and **CRLF-tolerant exact edits** with unique-match enforcement and
"did you mean" recovery. Around it all sits a sandbox that is authoritative inside the server:
an allowlist it cannot widen, a protected-path denylist, atomic writes, **undo snapshots**,
and a **JSONL audit journal** of every call — including the denials.

Portions of the core algorithms are adapted from [opencode](https://github.com/anomalyco/opencode)
(MIT) — see [NOTICE](NOTICE).

## Install (Claude Desktop)

1. Double-click `cowork-mcp.dxt` (or `npm i -g cowork-mcp` and use the config-JSON path below).
2. Pick your workspace directory in the extension's native folder picker (up to three).
3. Done. Restart Claude Desktop if the tools don't appear immediately.

### Manual configuration (json)

`claude_desktop_config.json` → `mcpServers`:

```json
{
  "cowork-mcp": {
    "command": "node",
    "args": ["/path/to/cowork-mcp/dist/index.cjs", "--workspace", "/Users/you/projects/app"]
  }
}
```

Multiple `--workspace` flags, a `COWORK_WORKSPACES` env var, or `~/.cowork-mcp/config.json`
(`{"workspaces": ["/path/one", "/path/two"]}`) all work. Changes apply after a restart — the
server deliberately has no way to widen its own sandbox mid-session.

## The tools

| Tool | What it does |
|---|---|
| `workspace_status` | allowlist, denylist, snapshot inventory, limits |
| `read` | files or directories, paged (2,000 lines / 50 KB per page), negative offset = tail, images/PDFs render inline |
| `list` | directory entries, paginated |
| `glob` | path patterns, capped + sorted |
| `grep` | ripgrep syntax (falls back to a built-in engine; `COWORK_RG` forces a binary) |
| `write` | create-or-overwrite, ≤10 MB, atomic |
| `edit` | exact-string replace; CRLF/mixed endings preserved; unicode + trailing-whitespace fallbacks; unique-match enforced; misses return the closest lines so the next try succeeds without re-reading |

There is **no** shell, delete, or move tool. Every mutating call snapshots the previous bytes
first; nothing in v0 is irreversible.

## Safety model

- **Allowlist is authoritative.** Every path is realpath-resolved and re-checked against the
  workspace roots; lexical (`..`) and symlink escapes both fail.
- **Protected paths.** `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.git/**`, `.npmrc`,
  `~/.ssh/**`, `~/.aws/**` and the server's own data dir are denied for read *and* write.
  Your config can add rules or explicitly allowlist exact files; the home-credential floor
  cannot be lifted.
- **Audit journal** at `~/.cowork-mcp/audit.jsonl` (rotating, secret values redacted):
  `{ts, tool, workspace, args, result: ok|denied|error}`. Inspect with
  `npx cowork-audit` (or `node dist/audit.cjs`).
- **Snapshots** under `~/.cowork-mcp/snapshots/` keep the last 20 revisions per file.
  They are plain copies — restore by copying back (an in-server `restore` tool is planned).
- **Known limits** (documented, best-effort): hard-link escapes and processes outside the
  server are out of scope; treat the denylist as defense-in-depth, not a secret store.

## Development

```sh
npm install
npm run build      # esbuild → dist/index.cjs + dist/audit.cjs
npm test           # bun test: security matrix, core ports, stdio integration
npm run typecheck  # tsc --noEmit
npm run pack:dxt   # bundle → cowork-mcp.dxt
```

A local smoke test without Claude Desktop:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}' | \
  node dist/index.cjs --workspace "$PWD"
```

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE) for the opencode attribution.
