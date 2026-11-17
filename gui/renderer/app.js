// cowork-gui renderer logic. Runs sandboxed: the only privilege is the
// preload bridge. Drag-drop yields File objects; the ABSOLUTE PATH is read
// here via webUtils.getPathForFile (Electron ≥ 32 replacement for File.path).

const { getState, pickFolder, pathForFile, validate, dryRun, apply, cancel } = window.cowork

const TOOL_NAMES = ["read", "list", "glob", "grep", "write", "edit"]
const state = {
  reason: "",
  configPath: "",
  workspaces: [],
  floor: { relative: [] },
  selected: null, // index into state.workspaces, or "candidate"
  candidate: null, // { real, beliefs: { readOnly, tools, denyRelative, denyAllow } }
}

const $ = (id) => document.getElementById(id)

function toolToggles(initial) {
  const tools = {}
  for (const tool of TOOL_NAMES) tools[tool] = tool === "read" ? true : initial?.[tool] !== false
  return tools
}

// ---------- rendering ----------

function workspaceBadges(ws) {
  const badges = []
  if (ws.readOnly) badges.push("read-only")
  const disabled = TOOL_NAMES.filter((tool) => tool !== "read" && !ws.tools[tool])
  if (disabled.length > 0) badges.push(`no ${disabled.join(", ")}`)
  if (ws.denyRelative.length > 0) badges.push(`${ws.denyRelative.length} deny rule${ws.denyRelative.length === 1 ? "" : "s"}`)
  return badges
}

function renderWorkspaces() {
  const list = $("workspace-list")
  list.innerHTML = ""
  state.workspaces.forEach((ws, index) => {
    const item = document.createElement("li")
    item.tabIndex = 0
    if (state.selected === index) item.classList.add("selected")
    const label = document.createElement("span")
    label.className = "mono"
    label.textContent = ws.path
    const badges = document.createElement("span")
    badges.className = "badges"
    for (const badge of workspaceBadges(ws)) {
      const pill = document.createElement("span")
      pill.className = `badge${ws.readOnly ? " warn" : ""}`
      pill.textContent = badge
      badges.appendChild(pill)
    }
    item.append(label, badges)
    item.onclick = () => selectWorkspace(index)
    item.onkeydown = (event) => (event.key === "Enter" || event.key === " ") && selectWorkspace(index)
    list.appendChild(item)
  })
}

function currentBeliefs() {
  if (state.selected === "candidate") return state.candidate.beliefs
  const ws = state.workspaces[state.selected]
  if (!ws) return null
  return { readOnly: ws.readOnly, tools: ws.tools, denyRelative: ws.denyRelative, denyAllow: ws.denyAllow, path: ws.path, real: ws.real }
}

function renderPermissions() {
  const beliefs = currentBeliefs()
  const section = $("permissions")
  if (!beliefs) {
    section.hidden = true
    return
  }
  section.hidden = false
  $("perm-target").textContent = beliefs.real ?? beliefs.path
  $("readonly").checked = beliefs.readOnly
  const grid = $("tool-toggles")
  grid.innerHTML = ""
  for (const tool of TOOL_NAMES) {
    const label = document.createElement("label")
    const box = document.createElement("input")
    box.type = "checkbox"
    box.checked = beliefs.tools[tool]
    box.disabled = tool === "read" || (beliefs.readOnly && (tool === "write" || tool === "edit"))
    box.onchange = () => {
      beliefs.tools[tool] = box.checked
      markDirty()
    }
    const text = document.createElement("span")
    text.textContent = tool
    label.append(box, text)
    grid.appendChild(label)
  }
  renderPills("deny-list", beliefs.denyRelative)
  renderPills("allow-list", beliefs.denyAllow)
  $("floor").textContent = state.floor.relative.join("  ")
  updateDryRun()
}

function renderPills(id, values) {
  const row = $(id)
  row.innerHTML = ""
  for (const value of values) {
    const pill = document.createElement("span")
    pill.className = "pill"
    pill.title = "Click to remove"
    pill.textContent = value
    pill.onclick = () => {
      values.splice(values.indexOf(value), 1)
      renderPermissions()
      markDirty()
    }
    row.appendChild(pill)
  }
}

async function updateDryRun() {
  const beliefs = currentBeliefs()
  if (!beliefs) return
  const root = beliefs.real ?? beliefs.path
  const result = await dryRun({ root, denyRelative: beliefs.denyRelative })
  const scope = result.bounded ? `first ${result.visited} entries` : `${result.visited} entries`
  $("dryrun").textContent = `Preview: ${result.matched} file${result.matched === 1 ? "" : "s"} currently match the deny rules (${scope})`
}

function markDirty() {
  $("apply").disabled = false
}

function selectWorkspace(index) {
  state.selected = index
  state.candidate = null
  $("candidate").textContent = ""
  renderWorkspaces()
  renderPermissions()
}

function showCandidate(real) {
  state.candidate = {
    real,
    path: real,
    readOnly: false,
    tools: toolToggles(),
    denyRelative: [],
    denyAllow: [],
  }
  state.selected = "candidate"
  renderWorkspaces()
  renderPermissions()
  markDirty()
}

// ---------- interactions ----------

async function acceptCandidate(path) {
  const verdict = await validate(path)
  const line = $("candidate")
  if (verdict.problems.length > 0) {
    line.className = "candidate bad"
    line.textContent = `✗ ${path} — ${verdict.problems.join("; ")}`
    return
  }
  line.className = "candidate ok"
  line.textContent = `✓ ready to connect: ${verdict.real}`
  showCandidate(verdict.real)
}

function wireDropzone() {
  const zone = $("dropzone")
  zone.addEventListener("dragover", (event) => {
    event.preventDefault()
    zone.classList.add("armed")
  })
  zone.addEventListener("dragleave", () => zone.classList.remove("armed"))
  zone.addEventListener("drop", (event) => {
    event.preventDefault()
    zone.classList.remove("armed")
    const files = [...(event.dataTransfer?.files ?? [])]
    // Electron ≥ 32: File.path was removed; the preload resolves the absolute path.
    const first = files[0]
    const path = first ? pathForFile(first) : undefined
    if (path) acceptCandidate(path)
  })
}

function wireInputs() {
  $("browse").onclick = async () => {
    const path = await pickFolder()
    if (path) acceptCandidate(path)
  }
  $("deny-input").onkeydown = (event) => {
    if (event.key !== "Enter") return
    const beliefs = currentBeliefs()
    if (!beliefs) return
    for (const raw of $("deny-input").value.split(",")) {
      const pattern = raw.trim()
      if (pattern && !beliefs.denyRelative.includes(pattern)) beliefs.denyRelative.push(pattern)
    }
    $("deny-input").value = ""
    renderPermissions()
    markDirty()
  }
  $("allow-input").onkeydown = (event) => {
    if (event.key !== "Enter") return
    const beliefs = currentBeliefs()
    if (!beliefs) return
    for (const raw of $("allow-input").value.split(",")) {
      const value = raw.trim().replaceAll("\\", "/")
      if (value && !/[*?[\]!{}]/.test(value) && !beliefs.denyAllow.includes(value)) beliefs.denyAllow.push(value)
    }
    $("allow-input").value = ""
    renderPermissions()
    markDirty()
  }
  $("readonly").onchange = () => {
    const beliefs = currentBeliefs()
    if (!beliefs) return
    beliefs.readOnly = $("readonly").checked
    renderPermissions()
    markDirty()
  }
  $("apply").onclick = async () => {
    // Rebuild the full workspace list with the current beliefs applied.
    const workspaces = state.workspaces.map((ws) => ({ ...ws }))
    if (state.selected === "candidate") workspaces.push({ ...state.candidate })
    else if (state.selected !== null) Object.assign(workspaces[state.selected], currentBeliefs())
    const result = await apply({ workspaces })
    if (!result.ok) {
      $("candidate").className = "candidate bad"
      $("candidate").textContent = result.error
      return
    }
    window.close()
  }
  $("cancel").onclick = async () => {
    await cancel()
    window.close()
  }
}

async function boot() {
  const loaded = await getState()
  state.reason = loaded.reason
  state.configPath = loaded.configPath
  state.workspaces = loaded.workspaces.map((ws) => ({ ...ws, tools: toolToggles(ws.tools) }))
  state.floor = loaded.floor
  $("reason-text").textContent = state.reason || "Configure your Cowork workspaces."
  const auditList = $("audit-list")
  auditList.innerHTML = ""
  for (const entry of loaded.audit) {
    const item = document.createElement("li")
    const time = document.createElement("span")
    time.textContent = entry.ts.replace("T", " ").slice(0, 19)
    const mark = document.createElement("span")
    mark.className = entry.result
    mark.textContent = entry.result === "ok" ? "ok  " : entry.result.toUpperCase()
    const rest = document.createElement("span")
    rest.textContent = `${entry.tool}${entry.workspace ? ` [${entry.workspace}]` : ""}${entry.reason ? ` — ${entry.reason.slice(0, 90)}` : ""}`
    item.append(time, mark, rest)
    auditList.appendChild(item)
  }
  renderWorkspaces()
  wireDropzone()
  wireInputs()
  $("apply").disabled = true
}

boot()
