// Sniffing + extension mapping. Magic-byte detection mirrors what opencode's
// Mime.detectMedia covers for model-facing reads; the extension table is a
// compact local equivalent of the `mime-types` dependency.

export const MEDIA_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"])

export type MediaMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "application/pdf"

export function detectMedia(bytes: Uint8Array): MediaMime | null {
  if (bytes.length < 8) return null
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png"
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif"
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)
    return "image/webp"
  if (bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "application/pdf"
  return null
}

const TEXT_TYPES: Record<string, string> = {
  js: "text/javascript", mjs: "text/javascript", cjs: "text/javascript", jsx: "text/javascript",
  ts: "text/typescript", tsx: "text/typescript", mts: "text/typescript", cts: "text/typescript",
  json: "application/json", jsonc: "application/json", json5: "application/json",
  md: "text/markdown", mdx: "text/markdown", txt: "text/plain", text: "text/plain", log: "text/plain",
  html: "text/html", htm: "text/html", css: "text/css", scss: "text/css", sass: "text/css", less: "text/css",
  yml: "text/yaml", yaml: "text/yaml", toml: "text/toml", ini: "text/plain", cfg: "text/plain", conf: "text/plain",
  xml: "text/xml", csv: "text/csv", tsv: "text/csv", tsvx: "text/plain",
  py: "text/x-python", rb: "text/x-ruby", go: "text/x-go", rs: "text/x-rust", java: "text/x-java-source",
  kt: "text/x-kotlin", kts: "text/x-kotlin", swift: "text/x-swift", c: "text/x-c", h: "text/x-c",
  cpp: "text/x-c++", hpp: "text/x-c++", cs: "text/x-csharp", php: "text/x-php", lua: "text/x-lua",
  sh: "text/x-shellscript", bash: "text/x-shellscript", zsh: "text/x-shellscript", fish: "text/x-shellscript",
  sql: "text/x-sql", graphql: "text/x-graphql", gql: "text/x-graphql", proto: "text/x-protobuf",
  r: "text/x-r", pl: "text/x-perl", dart: "text/x-dart", zig: "text/x-zig", nim: "text/x-nim",
  env: "text/plain", properties: "text/plain", gradle: "text/x-gradle", dockerfile: "text/x-dockerfile",
  makefile: "text/x-makefile", cmakelists: "text/x-cmake", patch: "text/x-diff", diff: "text/x-diff",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  ico: "image/x-icon", tif: "image/tiff", tiff: "image/tiff", bmp: "image/bmp", heic: "image/heic",
  svg: "image/svg+xml", pdf: "application/pdf", zip: "application/zip", gz: "application/gzip",
  tar: "application/x-tar", wasm: "application/wasm", woff: "font/woff", woff2: "font/woff2",
}

export function mimeType(name: string): string {
  const base = name.replaceAll("\\", "/").split("/").pop() ?? name
  const lower = base.toLowerCase()
  if (lower === "dockerfile" || lower === "makefile" || lower === "cmakelists.txt") {
    if (lower !== "cmakelists.txt") return TEXT_TYPES[lower] ?? "application/octet-stream"
    return "text/x-cmake"
  }
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : ""
  return (ext && TEXT_TYPES[ext]) || "application/octet-stream"
}
