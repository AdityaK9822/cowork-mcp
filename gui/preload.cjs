// cowork-gui preload: the ONLY bridge between the sandboxed renderer and the
// privileged main process. The surface is deliberately tiny and fixed.

const { contextBridge, ipcRenderer, webUtils } = require("electron")

contextBridge.exposeInMainWorld("cowork", {
  getState: () => ipcRenderer.invoke("cowork:getState"),
  pickFolder: () => ipcRenderer.invoke("cowork:pickFolder"),
  /** Renderer passes the File object from a drop; the absolute path never leaves the preload otherwise. */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return undefined
    }
  },
  validate: (candidate) => ipcRenderer.invoke("cowork:validate", candidate),
  dryRun: (payload) => ipcRenderer.invoke("cowork:dryRun", payload),
  apply: (payload) => ipcRenderer.invoke("cowork:apply", payload),
  cancel: () => ipcRenderer.invoke("cowork:cancel"),
})
