import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { globSearch, grep, InvalidPatternError, resolveRg } from "../src/core/rg.ts"

const tmp = async () => await fs.mkdtemp(path.join(os.tmpdir(), "cowork-rg-"))

async function project() {
  const dir = await tmp()
  await fs.mkdir(path.join(dir, "src"), { recursive: true })
  await fs.writeFile(path.join(dir, "src", "a.ts"), "const alpha = 1;\nconst beta = 2;\n")
  await fs.writeFile(path.join(dir, "src", "b.ts"), "export const gamma = alpha;\n")
  await fs.writeFile(path.join(dir, ".env"), "SECRET=nope\n")
  await fs.writeFile(path.join(dir, "README.md"), "# alpha project\n")
  return dir
}

describe("grep", () => {
  test("finds matches across files with line numbers", async () => {
    const dir = await project()
    const result = await grep({ cwd: dir, pattern: "alpha", limit: 10 })
    const paths = result.matches.map((m) => m.path)
    expect(paths).toContain(path.join("src", "a.ts"))
    expect(paths).toContain("README.md")
    expect(result.matches.every((m) => m.line > 0)).toBe(true)
    expect(result.engine === "rg" || result.engine === "js").toBe(true)
  })

  test("literal mode escapes the pattern", async () => {
    const dir = await project()
    const result = await grep({ cwd: dir, pattern: "gamma = alpha", literal: true, limit: 10 })
    expect(result.matches.length).toBe(1)
  })

  test("include glob narrows files", async () => {
    const dir = await project()
    const result = await grep({ cwd: dir, pattern: "alpha", include: "*.ts", limit: 10 })
    expect(result.matches.every((m) => m.path.endsWith(".ts"))).toBe(true)
  })

  test("hidden files are excluded by default", async () => {
    const dir = await project()
    const result = await grep({ cwd: dir, pattern: "SECRET", limit: 10 })
    expect(result.matches).toEqual([])
  })

  test("case-insensitive flag", async () => {
    const dir = await project()
    const result = await grep({ cwd: dir, pattern: "ALPHA", caseSensitive: false, limit: 10 })
    expect(result.matches.length).toBeGreaterThan(0)
  })

  test("limit truncates", async () => {
    const dir = await project()
    const result = await grep({ cwd: dir, pattern: ".", limit: 2 })
    expect(result.matches.length).toBe(2)
    expect(result.truncated).toBe(true)
  })

  test("invalid regex throws InvalidPatternError", async () => {
    const dir = await project()
    await expect(grep({ cwd: dir, pattern: "([unclosed", limit: 10 })).rejects.toThrow(InvalidPatternError)
  })
})

describe("glob", () => {
  test("finds files matching a pattern", async () => {
    const dir = await project()
    const result = await globSearch({ cwd: dir, pattern: "src/*.ts", limit: 10 })
    expect(result.files).toEqual([path.join("src", "a.ts"), path.join("src", "b.ts")])
  })

  test("hidden files excluded by default, included on request", async () => {
    const dir = await project()
    expect((await globSearch({ cwd: dir, pattern: "**/*", limit: 100 })).files.every((f) => !f.startsWith("."))).toBe(true)
    expect((await globSearch({ cwd: dir, pattern: ".env", hidden: true, limit: 10 })).files).toEqual([".env"])
  })

  test("limit truncates and sorts", async () => {
    const dir = await project()
    const result = await globSearch({ cwd: dir, pattern: "**/*", limit: 2 })
    expect(result.files.length).toBe(2)
    expect(result.truncated).toBe(true)
  })
})

describe("rg resolution", () => {
  test("COWORK_RG missing path throws; empty PATH falls back", async () => {
    await expect(resolveRg({ COWORK_RG: "/definitely/missing/rg" })).rejects.toThrow()
    const none = await resolveRg({ PATH: "" })
    expect(none === undefined || typeof none === "string").toBe(true)
  })
})
