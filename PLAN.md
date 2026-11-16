# cowork-mcp — End-to-End Plan

**v1 · 2026-11-16 · sole planning artifact for the cowork-mcp project.**
Free, Claude-Desktop-native agentic workspace: the user's free Claude account runs the agent;
this stdio MCP server is its hands on user-specified local directories. No IDE, no Google login,
no paid tier. Distributed as a one-click Desktop Extension (.dxt).

**Positioning:** Anthropic's official `server-filesystem` MCP is bare-bones IO. We ship
coding-agent-grade surface — tolerate-CRLF exact edits, paged reads, ripgrep, did-you-mean
errors — wrapped in an authoritative workspace sandbox with an audit journal and undo
snapshots. Same server later serves Cursor/Zed/Cline ("bring your own agent").

**Code reuse:** pure algorithms lifted from the OpenCode repo (MIT). No Effect framework.
Attribution headers in every lifted file + LICENSE + NOTICE.

---

## 1. Scope

### In (v0)
- 7 tools: `read`, `list`, `glob`, `grep`, `workspace_status` (Tier A) + `write`, `edit` (Tier B)
- Workspace allowlist (authoritative inside the server), realpath containment
- Protected-path denylist, size/type limits
- Atomic writes + pre-edit undo snapshots + JSONL audit journal
- DXT bundle with native directory pickers + manual `claude_desktop_config.json` fallback

### Out (v0) — explicit contract
- Shell execution, `delete`, `move` (Tier C)
- Git integration, local dashboard, multi-workspace profiles
- Code index / symbol graph (users can run external CodeGraph MCP instead)
- MCP `roots` support
- Any network access from the server itself; zero telemetry

---

## 2. Architecture

```
Claude Desktop (free)
   │  stdio (JSON-RPC)
   ▼
cowork-mcp (Node 20+, single bundled CJS file)
   ├─ config.ts    workspaces from argv → env → ~/.cowork-mcp/config.json (resolved once at startup)
   ├─ policy/      roots · denylist · limits · snapshot · audit   ← user constraints land here
   ├─ core/        paging · exact-match · fuzzy · diff · mime · rg (ported from opencode)
   ├─ tools/       one file per tool: zod schema + description + handler
   └─ server.ts    MCP wiring, uniform error mapping
```

- Runtime: Node ≥ 20, TypeScript. Deps: `@modelcontextprotocol/sdk`, `zod`, `picomatch`, `diff`.
- ripgrep: system `rg` from PATH (or `COWORK_RG` override); otherwise a bounded pure-JS grep
  fallback for small trees. **Never downloads anything** (zero-network rule).
- Determinism rule: the model can never widen its sandbox — no in-session grant tool;
  workspace changes = edit config + restart (Desktop restarts MCP servers on config change).
- State lives under `~/.cowork-mcp/` (override: `COWORK_HOME`), never inside workspaces.

---

## 3. Tool catalog

| Tool | Tier | Notes |
|---|---|---|
| `workspace_status` | A | workspaces, denylist summary, snapshot inventory, version |
| `read` | A | ≤2000 lines / ≤50KB page; negative offset = tail; BOM handled; NUL → binary reject; images/PDFs → MCP content blocks; truncated → `next` offset |
| `list` | A | entries dirs-first, paginated, `next` offset |
| `glob` | A | sorted paths, capped |
| `grep` | A | pattern, path?, include?, literal, caseSensitive, limit; rg syntax w/ JS fallback |
| `write` | B | create-or-overwrite, ≤10MB, binary sniff, atomic |
| `edit` | B | exact match w/ CRLF+unicode+trailing-ws fallbacks; unique-match enforced; miss hints; unified diff in result |

Tool descriptions are opencode's proven prompt-engineered strings, ported. All Tier B tools:
snapshot → mutate. Every call (including denials and errors) appends an audit entry.

---

## 4. Policy layer (security model)

**roots** — workspace allowlist is authoritative. `resolvePath` ports opencode's tilde +
Windows normalize + `path.resolve`; containment checks both lexical (`..`) and physical
(realpath/symlink) resolution against each workspace's real root. `~/.cowork-mcp/` itself is
denylisted from all tools. Relative paths resolve against exactly one workspace; ambiguous or
missing targets error with the nearest existing parent named + did-you-mean suggestions.

**denylist** — defaults: `.env*`, `*.pem`, `*.key`, `id_rsa*`, `.git/**`, `.npmrc`
(relative, matchBase) plus `<home>/.aws/**`, `<home>/.ssh/**`, `<dataHome>/**` (absolute).
Hard floor: the data dir + home credential dirs are never bypassable. User config can only
ADD entries, or whitelist *exact* relative paths (no globs). Applies to read AND write.

**limits** — read caps 2000 lines / 50KB / 2000-char lines; write ≤10MB + NUL-byte reject;
bounded search results (default 100, cap 1000); binary sniff via NUL + magic bytes.

**Threat checklist (each = one named test):** `..` traversal · symlink file/dir escaping root ·
symlink swap between resolve and write (parent realpath re-verified + O_EXCL temp + rename) ·
Windows drive/UNC strings · unicode look-alike filenames · empty path · overlapping workspaces
(longest root wins) · workspace root missing at startup (warn + skip) · hard-link escape
(documented out of scope in README).

**snapshots** — before any Tier B mutation: copy to
`<dataHome>/snapshots/<wsHash>/<pathHash>/<NNN>` with a sidecar meta.json (relative path, ts,
size). Keep last 20 per file, global byte cap with oldest-first eviction. Restore is manual in
v0 (documented one-liner). `workspace_status` exposes inventory.

**audit** — JSONL `{ts, tool, workspace, args, result: ok|denied|error, reason?, bytes}` at
`<dataHome>/audit.jsonl`. Everything logged including denials; rotating 5MB cap; secret-looking
values redacted; long values truncated with a sha256 digest of full args.

---

## 5. Mutation data flow

```
edit(path, old, new)
 1. resolvePath (lexical: ~, .., windows normalize)
 2. roots: realpath containment vs allowlist   → DENY → audit + typed error (no path leak)
 3. denylist check                             → DENY → audit + typed error
 4. read file; exact-match                     → 0 matches  → missHint error
                                               → >1 & !replaceAll → disambiguation error
                                               → identical  → no-op error
 5. snapshot old bytes → 6. atomic write: tmp (O_EXCL, same dir) → rename
 7. audit entry (with diff stats) → 8. return unified diff + counts
```

Failure at any step = no partial state. Snapshot strictly precedes mutate.

---

## 6. Reuse map — opencode (MIT) → `src/`

| Source (packages/core/src/) | Into | Notes |
|---|---|---|
| `tool/read-filesystem.ts` | `core/paging.ts` | checkpoint streaming pages, list paging, caps; fs directly |
| `tool/plugin/edit.ts` | `core/exact-match.ts` | matchView family, alignLines LCS, withRegionEndings, missHint — near-verbatim |
| `tool/plugin/read.ts` | `core/fuzzy.ts` | similar/do-you-mean, editDistance, canonical, line-numbered output |
| `tool/plugin/grep.ts` + `ripgrep.ts` | `core/rg.ts` | spawn wrapper, NDJSON parse, bounded results, model formatting |
| `file-access.ts` | `policy/roots.ts` | resolvePath + contains; approval flow → hard allowlist |
| `file-write.ts` (+ `util/bom`) | `tools/write.ts` | BOM-preserving commit + snapshot + tmp/rename |
| `tool/plugin/file-diff.ts` | `core/diff.ts` | unified diff + add/del counts |

Attribution header: `// Adapted from opencode (MIT) — packages/core/src/...`

---

## 7. Testing strategy

- **Unit** (bun test): paging edges (BOM/CRLF/huge lines/tail/empty/binary), exact-match
  (CRLF mix, unicode variants, trailing-ws tier, replaceAll overlaps, endings-only), fuzzy
  ranking, roots/denylist security matrix (every §4 threat = one named test).
- **Integration:** hand-rolled stdio MCP client speaking JSON-RPC to the bundled server;
  happy paths + denial paths + audit assertions.
- **Manual (M5):** real Claude Desktop — .dxt install, folder picker, permission tiers,
  restart on config change.

Typecheck: `npm run typecheck` (tsc --noEmit). Tests: `npm test` (bun test).

---

## 8. Milestones — each ends runnable

| M | Deliverable | Exit criteria |
|---|---|---|
| M0 | Scaffold | config + `workspace_status` over stdio; esbuild → single dist .cjs |
| M1 | Policy core | roots/denylist/limits BEFORE any tool consumes them; security matrix green |
| M2 | Read side | read/list/glob/grep live; paging port + golden tests pass |
| M3 | Write side | write/edit live; snapshot→atomic→audit integration-tested |
| M4 | Polish | final descriptions, error UX, `cowork audit` CLI viewer, README |
| M5 | Packaging | manifest.json (platform rg entries) → .dxt; manual Desktop QA |

Defaults pending user constraints: no file-type restriction · allowlist pinned at startup ·
denylist tighten-only · 20 snapshots/file · 10MB write cap · zero network · zero telemetry.
