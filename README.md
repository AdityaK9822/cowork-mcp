# cowork-mcp

**A free, Claude-Desktop-native agentic workspace — a sandboxed, audited, undoable MCP file server.**

cowork-mcp lets your free Claude account act as a coding agent with real hands on the directories *you* choose. It is a stdio [Model Context Protocol](https://modelcontextprotocol.io) server: no IDE, no paid tier, no network access, no telemetry. Distributed as a one-click Claude Desktop Extension (`.dxt`) with a manual `claude_desktop_config.json` fallback.

> **Status — v0.1.0.** The core engine and the security/policy layer are implemented and fully tested (51 tests, clean typecheck). MCP server wiring, the tool layer, and DXT packaging are being built on top — see [PLAN.md](PLAN.md) for the roadmap and current milestone state.

---

## Why

Anthropic's official `server-filesystem` MCP is bare-bones IO. cowork-mcp ships **coding-agent-grade** surface instead:

- tolerate-CRLF **exact-match editing** with unique-match enforcement and did-you-mean hints
- **paged reads** (BOM handling, tail reads, binary/media sniffing, truncation with a resume offset)
- **ripgrep-powered search** (system `rg` from PATH, or a bounded pure-JS fallback — never downloads anything)
- all of it wrapped in an **authoritative workspace sandbox** with an audit journal and undo snapshots

The model can never widen its own sandbox. The same server later serves Cursor, Zed, or Cline — bring your own agent.

## Tools

| Tool   | Tier | What it does                                                                                                       |
| ------ | ---- | ------------------------------------------------------------------------------------------------------------------ |
| `read` | A    | ≤2000 lines / ≤50KB per page; negative offset = tail; BOM handled; NUL → binary reject; images/PDFs → MCP content blocks; truncated pages return a `next` offset |
| `list` | A    | Directory entries, dirs-first, paginated with `next` offset                                                        |
| `glob` | A    | Sorted, capped path matches                                                                                        |
| `grep` | A    | Pattern, optional path/include, literal & case-sensitive modes, bounded results; rg syntax with a JS fallback       |
| `workspace_status` | A | Workspaces, denylist summary, snapshot inventory, version                                                    |
| `write` | B   | Create-or-overwrite, ≤10MB, binary sniff, atomic (temp + rename), snapshot taken first                             |
| `edit`  | B   | Exact match with CRLF / unicode / trailing-whitespace fallbacks; unique match enforced; miss hints; unified diff returned |

Every call — including denials and errors — is appended to the audit journal. Every Tier B mutation takes an undo snapshot **before** touching a byte.

## Security model

**Workspace allowlist (authoritative).** Only directories you configure exist for the model. Paths are resolved lexically (`~`, `..`, Windows normalization) *and* physically (realpath / symlink resolution) against each workspace's real root. Relative paths resolve against exactly one workspace — ambiguous targets error with did-you-mean suggestions. The allowlist is fixed at startup: changing it means editing config and restarting, by design.

**Protected-path denylist.** Defaults block `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.git/**`, `.npmrc`, plus `<home>/.aws/**`, `<home>/.ssh/**`, and the server's own data directory. That last set is a hard floor: user config can add entries or whitelist *exact* relative paths, but never remove the floor. Applies to reads and writes alike.

**Limits.** Reads cap at 2000 lines / 50KB / 2000-char lines; writes at 10MB with NUL-byte rejection; search results bounded (default 100, cap 1000); binary sniffing via NUL + magic bytes.

**Snapshots.** Before any mutation, the original bytes are copied to `<dataHome>/snapshots/<workspace>/<path>/<NNN>` with a metadata sidecar. The last 20 versions per file are kept under a global byte cap with oldest-first eviction. `workspace_status` exposes the inventory.

**Audit.** A JSONL journal at `<dataHome>/audit.jsonl` records `{ts, tool, workspace, args, result: ok|denied|error, …}` for every call. Secret-looking values are redacted, long values truncated with a sha256 digest of the full args, and the file rotates at 5MB.

**Zero network, zero telemetry.** The server never opens a socket and never downloads anything — ripgrep is used from your PATH if present.

## Architecture

```
Claude Desktop (free)
   │  stdio (JSON-RPC)
   ▼
cowork-mcp (Node 20+, single bundled CJS file)
   ├─ config.ts    workspaces from argv → env → ~/.cowork-mcp/config.json (resolved once at startup)
   ├─ policy/      roots · denylist · limits        ← user constraints land here
   ├─ core/        paging · exact-match · fuzzy · diff · mime · rg  (ported from opencode)
   └─ (server.ts + tools/ + .dxt packaging — in progress, see PLAN.md)
```

- Runtime: Node ≥ 20, TypeScript. Dependencies: `@modelcontextprotocol/sdk`, `zod`, `picomatch`, `diff`.
- State lives under `~/.cowork-mcp/` (override with `COWORK_HOME`), never inside your workspaces.
- Pure algorithms are adapted from the [opencode](https://github.com/anomalyco/opencode) project (MIT); every lifted file carries an attribution header — see [NOTICE](NOTICE).

## Getting started (development)

```sh
git clone https://github.com/AdityaK9822/cowork-mcp.git
cd cowork-mcp
npm install

npm run typecheck   # tsc --noEmit
npm test            # bun test — 51 tests across core, security, and rg suites
npm run build       # esbuild → single dist/index.cjs
npm run pack:dxt    # build + Claude Desktop extension bundle (in progress)
```

Prerequisites: **Node.js ≥ 20** and the [Bun](https://bun.sh) runtime for tests. ripgrep (`rg`) on your PATH is optional but recommended for grep; otherwise a bounded pure-JS fallback is used.

## Configuration

Workspaces are resolved once at startup, in precedence order: **CLI args → `COWORK_WORKSPACES` env → config file**.

```sh
# As CLI args (repeatable)
cowork-mcp --workspace ~/projects/app --workspace ~/notes

# As an environment variable (":" on macOS/Linux, ";" on Windows)
COWORK_WORKSPACES=~/projects/app:~/notes cowork-mcp
```

Or in `~/.cowork-mcp/config.json` (this file also holds denylist extensions, which only come from the file):

```json
{
  "workspaces": [
    "/Users/you/projects/app",
    "/Users/you/notes"
  ],
  "deny": {
    "relative": ["secrets/**"],
    "absolute": ["/var/db/private/**"],
    "allow":    ["notes/.env.example"]
  }
}
```

- `deny.relative` — workspace-relative glob patterns (slash-less patterns match basenames at any depth)
- `deny.absolute` — patterns matched against realpath'd locations
- `deny.allow` — exact relative paths punched through the relative denylist (no globs)

Missing or invalid workspace entries are skipped with a warning at startup; overlapping workspaces resolve to the longest root.

## Testing

The security matrix in [test/security.test.ts](test/security.test.ts) gives every documented threat its own named test: `..` traversal, symlink file/dir escapes, symlink swap between resolve and write, Windows drive/UNC strings, unicode look-alike filenames, empty paths, overlapping workspaces, and more. [test/core.test.ts](test/core.test.ts) covers the paging and exact-match families (CRLF mixes, unicode variants, trailing whitespace tiers, replaceAll overlaps), and [test/rg.test.ts](test/rg.test.ts) covers grep/glob behavior and the rg fallback path.

## License

[MIT](LICENSE). Includes code adapted from [opencode](https://github.com/anomalyco/opencode) (MIT) — see [NOTICE](NOTICE) for the full attribution map. ripgrep is an optional external tool used from your PATH (MIT); cowork-mcp never downloads anything at runtime.
