/**
 * M1 security matrix. Each threat from PLAN.md §4 is a named test here.
 * Run from the package directory: bun test test/security.test.ts
 */
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ToolFailure } from "../src/errors.js"
import { contains, realPathLexical, resolvePath, Roots, type Workspace } from "../src/policy/roots.js"
import { DEFAULT_RELATIVE, loadDenylist } from "../src/policy/denylist.ts"
import { assertWritable, containsNul, LIMITS } from "../src/policy/limits.ts"

const tmp = async () => await fs.mkdtemp(path.join(os.tmpdir(), "cowork-test-"))

describe("contains (FSUtil semantics port)", () => {
  test("opencode's fixture cases", () => {
    expect(contains("/a/b", "/a/b/c")).toBe(true)
    expect(contains("/a/b", "/a/b")).toBe(true)
    expect(contains("/a/b", "/a/c")).toBe(false)
    expect(contains("/a/b", "/a/bad")).toBe(false)
    expect(contains("C:\\a", "D:\\b")).toBe(false)
  })
  test("hidden-dot siblings do not sneak past the prefix check", () => {
    expect(contains("/a/b", "/a/b/..hidden")).toBe(true)
    expect(contains("/a/b", "/a/b/..")).toBe(false)
  })
})

describe("resolvePath", () => {
  test("expands ~ and resolves lexically", () => {
    const home = os.homedir()
    expect(resolvePath("/", "~/x", home)).toBe(path.join(home, "x"))
    expect(resolvePath("/ws", "a/../b")).toBe(path.join("/", "ws", "b"))
  })
})

describe("realPathLexical", () => {
  test("resolves through existing symlinks and tolerates missing tails", async () => {
    const dir = await tmp()
    await fs.mkdir(path.join(dir, "real"))
    await fs.symlink("real", path.join(dir, "link"))
    const expected = path.join(await fs.realpath(dir), "real", "newfile.txt")
    expect(await realPathLexical(path.join(dir, "link", "newfile.txt"))).toBe(expected)
  })
})

async function fixture() {
  const root = await tmp()
  const outside = await tmp()
  await fs.mkdir(path.join(root, "sub"), { recursive: true })
  await fs.writeFile(path.join(root, "a.txt"), "hello")
  await fs.writeFile(path.join(root, "sub", "b.txt"), "bravo")
  await fs.writeFile(path.join(outside, "secret.txt"), "outside")
  await fs.symlink(path.join(outside, "secret.txt"), path.join(root, "link-file"))
  await fs.symlink(outside, path.join(root, "link-dir"))
  return { root, outside }
}

const ws = async (root: string): Promise<Workspace> => ({
  name: path.basename(root),
  root,
  real: await fs.realpath(root),
})

describe("Roots sandbox", () => {
  test(".. traversal is contained", async () => {
    const { root, outside } = await fixture()
    const roots = new Roots([await ws(root)])
    await expect(roots.resolve(`../${path.basename(outside)}/secret.txt`)).rejects.toThrow(ToolFailure)
  })

  test("symlinked file escaping the workspace is rejected (physical check)", async () => {
    const { root } = await fixture()
    const roots = new Roots([await ws(root)])
    await expect(roots.resolve("link-file")).rejects.toThrow(ToolFailure)
  })

  test("symlinked directory escaping the workspace is rejected", async () => {
    const { root } = await fixture()
    const roots = new Roots([await ws(root)])
    await expect(roots.resolve("link-dir/a.txt")).rejects.toThrow(ToolFailure)
  })

  test("relative and absolute in-workspace paths resolve to the same target", async () => {
    const { root } = await fixture()
    const roots = new Roots([await ws(root)])
    const byRelative = await roots.resolve("sub/b.txt")
    const byAbsolute = await roots.resolve(path.join(root, "sub", "b.txt"))
    expect(byRelative.real).toBe(byAbsolute.real)
    expect(byRelative.relative).toBe("sub/b.txt")
  })

  test("empty path is rejected", async () => {
    const { root } = await fixture()
    const roots = new Roots([await ws(root)])
    await expect(roots.resolve("   ")).rejects.toThrow(ToolFailure)
  })

  test("overlapping workspaces: existence first, then most specific", async () => {
    const outer = await tmp()
    const inner = path.join(outer, "nested")
    await fs.mkdir(inner, { recursive: true })
    await fs.writeFile(path.join(inner, "x.txt"), "x")
    await fs.writeFile(path.join(outer, "other.txt"), "o")
    await fs.writeFile(path.join(outer, "tie.txt"), "tie-outer")
    await fs.writeFile(path.join(inner, "tie.txt"), "tie-inner")
    const roots = new Roots([await ws(outer), await ws(inner)])
    // An existing target wins over a would-be path in a more specific grant.
    expect((await roots.resolve("x.txt")).workspace.real).toBe(await fs.realpath(inner))
    expect((await roots.resolve("other.txt")).workspace.real).toBe(await fs.realpath(outer))
    // When both workspaces have the file, the nested (more specific) grant wins.
    const tie = await roots.resolve("tie.txt")
    expect(tie.workspace.real).toBe(await fs.realpath(inner))
    expect(tie.relative).toBe("tie.txt")
  })

  test("no workspace can reach the data home by tilde", async () => {
    const roots = new Roots([await ws(await fixture().then((f) => f.root))])
    await expect(roots.resolve("~/.cowork-mcp/config.json")).rejects.toThrow(ToolFailure)
  })
})

describe("denylist", () => {
  const list = (overrides?: Parameters<typeof loadDenylist>[2]) => loadDenylist("/data-home", "/home", overrides)

  test("default relative patterns fire at any depth", () => {
    const deny = list()
    expect(deny.check("/ws/.env", ".env").allowed).toBe(false)
    expect(deny.check("/ws/app/.env.local", "app/.env.local").allowed).toBe(false)
    expect(deny.check("/ws/server.key", "server.key").allowed).toBe(false)
    expect(deny.check("/ws/certs/x.pem", "certs/x.pem").allowed).toBe(false)
    expect(deny.check("/ws/id_rsa_old", "id_rsa_old").allowed).toBe(false)
    expect(deny.check("/ws/.git/config", ".git/config").allowed).toBe(false)
    expect(deny.check("/ws/pkg/.npmrc", "pkg/.npmrc").allowed).toBe(false)
    expect(DEFAULT_RELATIVE.length).toBeGreaterThan(0)
  })

  test("ordinary files pass", () => {
    const deny = list()
    expect(deny.check("/ws/src/main.ts", "src/main.ts").allowed).toBe(true)
    expect(deny.check("/ws/envfile.txt", "envfile.txt").allowed).toBe(true)
  })

  test("hard floor: home credentials and data home are never bypassable", () => {
    const deny = list({ allow: ["/home/.ssh/id_ed25519"] })
    expect(deny.check("/home/.ssh/id_ed25519", ".ssh/id_ed25519").allowed).toBe(false)
    expect(deny.check("/data-home/audit.jsonl", "audit.jsonl").allowed).toBe(false)
  })

  test("config can tighten but exact-allow only lifts relative rules", () => {
    const deny = list({ allow: [".env"] })
    expect(deny.check("/ws/.env", ".env").allowed).toBe(true)
    expect(deny.check("/ws/app/.env", "app/.env").allowed).toBe(false)
    expect(deny.check("/ws/x.key", "x.key").allowed).toBe(false)
  })

  test("user-added rules are appended", () => {
    const deny = list({ relative: ["secrets/**"] })
    expect(deny.check("/ws/secrets/a.txt", "secrets/a.txt").allowed).toBe(false)
  })

  test("glob characters in allow entries are rejected at load", () => {
    expect(() => list({ allow: ["data/*.json"] })).toThrow(ToolFailure)
  })
})

describe("limits", () => {
  test("binary sniff and write caps", () => {
    expect(containsNul(Buffer.from("abc\0def"))).toBe(true)
    expect(() => assertWritable("x".repeat(LIMITS.MAX_WRITE_BYTES + 1))).toThrow(ToolFailure)
    expect(() => assertWritable("has \u0000 nul")).toThrow(ToolFailure)
    expect(assertWritable("normal")).toBe(6)
  })
})
