import { ipcRenderer, contextBridge } from 'electron'

// Expose some APIs to the Renderer process
contextBridge.exposeInMainWorld('ipcRenderer', {
  on(
    channel: string,
    listener: (event: Electron.IpcRendererEvent, ...args: unknown[]) => void,
  ) {
    return ipcRenderer.on(channel, listener)
  },
  off(
    channel: string,
    listener: (event: Electron.IpcRendererEvent, ...args: unknown[]) => void,
  ) {
    return ipcRenderer.off(channel, listener)
  },
  send(channel: string, ...args: unknown[]) {
    return ipcRenderer.send(channel, ...args)
  },
  invoke(channel: string, ...args: unknown[]) {
    return ipcRenderer.invoke(channel, ...args)
  },
})
