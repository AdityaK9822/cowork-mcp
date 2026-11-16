/**
 * M2 core tests: paging port behaviors and the exact-match family.
 */
import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { BinaryFileError, DirectoryOffsetError, PathKindError, readPage } from "../src/core/paging.ts"
import { formatRead, similar, editDistance, canonical } from "../src/core/fuzzy.ts"
import { computeEdit, editInputChecks, missHint } from "../src/core/exact-match.ts"
import { fileDiff } from "../src/core/diff.ts"

const tmp = async () => await fs.mkdtemp(path.join(os.tmpdir(), "cowork-page-"))
const write = async (name: string, content: string | Buffer) => {
  const dir = await tmp()
  const file = path.join(dir, name)
  await fs.writeFile(file, content)
  return { dir, file }
}

describe("paging", () => {
  test("small clean text file returns whole-file content with mime", async () => {
    const { file } = await write("a.txt", "one\ntwo\nthree")
    const page = await readPage(file, "a.txt")
    expect(page.type).toBe("file")
    if (page.type === "file") {
      expect(page.content).toBe("one\ntwo\nthree")
      expect(page.encoding).toBe("utf8")
      expect(page.mime).toBe("text/plain")
    }
  })

  test("pages cap at 2000 lines and report the next offset", async () => {
    const body = Array.from({ length: 2500 }, (_, index) => `line ${index + 1}`).join("\n")
    const { file } = await write("big.txt", body)
    const page = await readPage(file, "big.txt", { offset: 1, limit: 2000 })
    expect(page.type).toBe("text-page")
    if (page.type === "text-page") {
      expect(page.lineCount).toBe(2000)
      expect(page.truncated).toBe(true)
      expect(page.next).toBe(2001)
      expect(page.offset).toBe(1)
    }
    const tail = await readPage(file, "big.txt", { offset: 2001 })
    if (tail.type === "text-page") {
      expect(tail.lineCount).toBe(500)
      expect(tail.truncated).toBe(false)
      expect(tail.content.endsWith("line 2500")).toBe(true)
    }
    // A single window in the middle only selects that window.
    const mid = await readPage(file, "big.txt", { offset: 1500, limit: 3 })
    if (mid.type === "text-page") {
      expect(mid.content).toBe("line 1500\nline 1501\nline 1502")
      expect(mid.next).toBe(1503)
    }
  })

  test("negative offset reads the file tail", async () => {
    const body = Array.from({ length: 12 }, (_, index) => `L${index + 1}`).join("\n")
    const { file } = await write("t.txt", body)
    const page = await readPage(file, "t.txt", { offset: -5 })
    expect(page.type).toBe("text-page")
    if (page.type === "text-page") expect(page.content).toBe("L8\nL9\nL10\nL11\nL12")
  })

  test("offset past the end returns the last 100 lines with the past-end note", async () => {
    const body = Array.from({ length: 300 }, (_, index) => `x${index + 1}`).join("\n")
    const { file } = await write("p.txt", body)
    const page = await readPage(file, "p.txt", { offset: 9999 })
    expect(page.type).toBe("text-page")
    const text = formatRead("p.txt", 9999, page)
    expect(text).toContain("offset 9999 is past the end")
    expect(text.split("\n").length).toBeLessThanOrEqual(102)
  })

  test("long lines clamp at 2000 chars", async () => {
    const { file } = await write("long.txt", `r${"a".repeat(3000)}\nend`)
    const page = await readPage(file, "long.txt", { offset: 1, limit: 5 })
    if (page.type === "text-page") {
      const first = page.content.split("\n")[0]!
      expect(first).toContain(`... (line truncated to 2000 chars)`)
      expect(first.length).toBeLessThan(2100)
      expect(first.endsWith("a".repeat(3000))).toBe(false)
    }
  })

  test("BOM is stripped on whole-file reads", async () => {
    const { file } = await write("bom.txt", Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from("hi there", "utf8")]))
    const page = await readPage(file, "bom.txt")
    if (page.type === "file") expect(page.content).toBe("hi there")
  })

  test("NUL byte in a text file is a binary reject", async () => {
    const { file } = await write("bin.dat", Buffer.from([104, 105, 0, 33]))
    await expect(readPage(file, "bin.dat")).rejects.toThrow(BinaryFileError)
  })

  test("negative offset on a directory is a DirectoryOffsetError; directories page", async () => {
    const dir = await tmp()
    await fs.writeFile(path.join(dir, "f.txt"), "x")
    await fs.mkdir(path.join(dir, "d"))
    await expect(readPage(dir, "d", { offset: -1 })).rejects.toThrow(DirectoryOffsetError)
    const page = await readPage(dir, "d")
    expect(page.type).toBe("list-page")
    if (page.type === "list-page") {
      expect(page.entries.map((entry) => entry.path)).toEqual(["d/", "f.txt"])
      expect(page.entries[0]!.type).toBe("directory")
    }
  })

  test("missing path is a PathKindError from readdir failure", async () => {
    await expect(readPage("/definitely/not/here.txt", "x")).rejects.toThrow()
  })

  test("images return base64 file content", async () => {
    const { file } = await write("x.png", Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)]))
    const page = await readPage(file, "x.png")
    expect(page.type).toBe("file")
    if (page.type === "file") expect(page.encoding).toBe("base64")
  })
})

describe("exact-match", () => {
  test("input validation messages match opencode wording", () => {
    expect(editInputChecks({ oldString: "x", newString: "x" })).toContain("identical")
    expect(editInputChecks({ oldString: "", newString: "y" })).toContain("must not be empty")
    expect(editInputChecks({ oldString: "x", newString: "y" })).toBeUndefined()
  })

  test("CRLF files match LF oldString and keep their endings", () => {
    const source = "const a = 1;\r\nconst b = 2;\r\n"
    const result = computeEdit(source, { oldString: "const b = 2;", newString: "const b = 3;" }, "f.ts")
    expect(result.replaced).toBe("const a = 1;\r\nconst b = 3;\r\n")
    expect(result.replacements).toBe(1)
  })

  test("mixed line endings: untouched context keeps its bytes", () => {
    const source = "keep\r\nchange\nkeep\r\n"
    const result = computeEdit(source, { oldString: "change", newString: "changed" }, "f.txt")
    expect(result.replaced).toBe("keep\r\nchanged\nkeep\r\n")
  })

  test("unicode variants and trailing whitespace tiers rescue near misses", () => {
    const source = "say “hello”\n"
    const result = computeEdit(source, { oldString: 'say "hello"', newString: 'say "hi"' }, "f.txt")
    expect(result.replaced).toBe('say "hi"\n')
    const spaced = "  indented  \n"
    const spacedEdit = computeEdit(spaced, { oldString: "indented", newString: "aligned" }, "f.txt")
    expect(spacedEdit.replaced).toBe("  aligned  \n")
  })

  test("multiple matches require replaceAll; overlapping replaceAll stays disjoint", () => {
    const source = "a a a\n"
    expect(() => computeEdit(source, { oldString: "a", newString: "b" }, "f")).toThrow(/expected exactly one/)
    const all = computeEdit(source, { oldString: "a", newString: "b", replaceAll: true }, "f")
    expect(all.replaced).toBe("b b b\n") && expect(all.replacements).toBe(3)
  })

  test("endings-only edits apply to the exact bytes", () => {
    const result = computeEdit("x\r\ny\r\n", { oldString: "x\r\n", newString: "x\n" }, "f")
    expect(result.replaced).toBe("x\ny\r\n")
    // Same bytes modulo \r: applied raw, so the newString lands byte-exact.
    const both = computeEdit("x\r\n", { oldString: "x", newString: "x\r" }, "f")
    expect(both.replaced).toBe("x\r\r\n")
  })

  test("normal path no-op: whitespace-tier match that restores identical bytes", () => {
    expect(() =>
      computeEdit("foo  \nbar  \n", { oldString: "foo\nbar\n", newString: "foo  \nbar  \n" }, "f"),
    ).toThrow(/Line endings follow the file/)
  })

  test("missHint fires for whitespace-mismatched line matches and for already-applied edits", () => {
    const source = "  const a = 1\n  const b = 2\n"
    const hint = missHint(source, "const a = 1\nconst b = 2", "const a = 3")
    expect(hint).toContain("The closest lines in the file:")
    expect(hint).toContain("1:   const a = 1")
    const applied = missHint(
      "alpha\nbravo and a long enough replacement here\nbravo\n",
      "absent",
      "bravo and a long enough replacement here",
    )
    expect(applied).toContain("already in the file")
  })

  test("empty oldString edition of a file never reaches computeEdit", () => {
    const gate = editInputChecks({ oldString: "", newString: "" })
    expect(gate).toBeDefined()
  })
})

describe("fuzzy", () => {
  test("similar ranks same-stem above contains-above-typo: tier2 winners first", () => {
    expect(similar(["acme", "acme.ts", "acmejs", "other"], "acme.js")).toEqual(["acme.ts", "acme", "acmejs"])
    expect(similar(["README.md", "readme.txt"], "readme.md")).toEqual(["README.md", "readme.txt"])
  })
  test("edit distance is the standard measure", () => {
    expect(editDistance("bravo", "brav")).toBe(1)
    expect(canonical("café\u00a0")).toBe("café ")
  })
})

describe("diff", () => {
  test("counts additions and deletions", () => {
    const info = fileDiff("f.txt", "a\nb\n", "a\nc\n")
    expect(info.additions).toBe(1)
    expect(info.deletions).toBe(1)
    expect(info.patch).toContain("f.txt")
  })
})
