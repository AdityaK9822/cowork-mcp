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
2. Pick your workspace directory in the extension's native folder picker (up to three — the
   in-app config window can add unlimited workspaces).
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

`~/.cowork-mcp/config.json` is the **single persistent store** for workspaces. CLI
`--workspace` flags and `COWORK_WORKSPACES` are additive, session-scoped grants on top of it
(they are never written back). Changes apply after a restart — the server deliberately has no
way to widen its own sandbox mid-session.

## The tools

| Tool | What it does |
|---|---|
| `workspace_status` | allowlist with per-workspace permissions, denylist, pending-config flag, snapshot inventory, limits |
| `workspace_request_config` | opens the configuration window **on the user's screen** so they can connect folders (drag-drop or picker) and edit permissions; the model can request it, only the user can complete it |
| `read` | files or directories, paged (2,000 lines / 50 KB per page), negative offset = tail, images/PDFs render inline |
| `list` | directory entries, paginated |
| `glob` | path patterns, capped + sorted |
| `grep` | ripgrep syntax (falls back to a built-in engine; `COWORK_RG` forces a binary) |
| `write` | create-or-overwrite, ≤10 MB, atomic |
| `edit` | exact-string replace; CRLF/mixed endings preserved; unicode + trailing-whitespace fallbacks; unique-match enforced; misses return the closest lines so the next try succeeds without re-reading |

There is **no** shell, delete, or move tool. Every mutating call snapshots the previous bytes
first.

## Connecting workspaces and permissions (v2)

When the model calls `workspace_request_config`, your OS gets a **configuration window**:

- **Connect** by dragging a folder onto the drop zone or clicking *Browse…*. Selections are
  realpath-resolved and validated (no data-home, no nesting inside existing workspaces).
- **Permissions** per workspace, editable in the same window:
  - **Read-only** — blocks `write`/`edit` for that workspace
  - **Per-tool toggles** — `list`, `glob`, `grep`, `write`, `edit` can each be disabled
    (`read` is always on; a workspace cannot be made inert)
  - **Deny globs** — workspace-relative protected-path patterns extending the global floor,
    with exact-path allow exceptions
  - **Dry-run preview** — how many files the deny rules currently match before you apply
- **Apply** writes `config.json` atomically and journals one audit entry with `source: "gui"`;
  changes take effect when Claude Desktop restarts this server. **Cancel** is audited too.

The window is the *only* writer besides manual editing; the model can never edit its own
sandbox. Without the window helper (headless, or not bundled), `workspace_request_config`
falls back to the platform's native folder picker (`osascript` / PowerShell / zenity), which
connects folders with default permissions only.

## The config file

```jsonc
// ~/.cowork-mcp/config.json
{
  "workspaces": [
    "/Users/you/notes",                    // legacy form — default grants
    {
      "path": "/Users/you/projects/app",   // v2 form
      "readOnly": false,
      "tools":  { "list": true, "glob": true, "grep": true, "write": true, "edit": true },
      "deny":   { "relative": ["secrets/**"], "allow": ["secrets/PUBLIC.md"] }
    }
  ],
  "deny": { "relative": [], "absolute": [], "allow": [] }  // global extensions (file-only)
}
```

Missing or invalid entries are skipped with a startup warning. Enabling **no** tool, or a
`read: false` toggle, is coerced back: the model can never be granted a workspace that
cannot be inspected.

## Safety model

- **Allowlist is authoritative.** Every path is realpath-resolved and re-checked against the
  workspace roots; lexical (`..`) and symlink escapes both fail.
- **Per-workspace gates** run before every call: tool toggles, read-only, and deny globs —
  denials are typed, model-visible, and audited.
- **Workspace-wide search is rule-aware.** `grep`/`glob` over whole workspaces (no `path`
  argument) now filter protected-path matches, closing the gap where a bulk search could
  surface `.env` content.
- **Protected paths.** `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.git/**`, `.npmrc`,
  `~/.ssh/**`, `~/.aws/**` and the server's own data dir are denied for read *and* write.
  Config can add rules or explicitly allowlist exact files; the home-credential floor
  cannot be lifted — not by config, and not by the GUI.
- **Audit journal** at `~/.cowork-mcp/audit.jsonl` (rotating, secret values redacted):
  `{ts, tool, workspace, args, result: ok|denied|error, source?}`. Inspect with
  `node dist/audit.cjs`.
- **Snapshots** under `~/.cowork-mcp/snapshots/` keep the last 20 revisions per file.
  They are plain copies — restore by copying back (an in-server `restore` tool is planned).
- **Known limits** (documented, best-effort): hard-link escapes and processes outside the
  server are out of scope; treat the denylist as defense-in-depth, not a secret store.

## Development

```sh
npm install
npm run build      # esbuild → dist/index.cjs + dist/audit.cjs + dist/config-picker.cjs
npm test           # bun test: security matrix, core ports, policy, stdio integration
npm run typecheck  # tsc --noEmit
npm --prefix gui install   # optional: Electron helper deps (~200 MB, only needed to package the GUI)
npm run pack:dxt   # bundle → cowork-mcp.dxt (includes the config window when built)
```

The `.dxt` bundle is ~280 MB when the Electron helper is included and is **not committed** —
build it locally with `npm run pack:dxt`. Without the helper, the DXT is ~0.7 MB and the
model falls back to the native folder picker.

A local smoke test without Claude Desktop:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}' | \
  node dist/index.cjs --workspace "$PWD"
```

Set `COWORK_NO_GUI=1` to disable config-window launching entirely (CI/integration tests do).

## License

MIT — see [LICENSE](LICENSE) and [NOTICE](NOTICE) for the opencode attribution.
