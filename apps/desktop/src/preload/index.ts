/**
 * Preload: exposes the IPC contract as `window.atlasDesktop`.
 *
 * Runs with contextIsolation + sandbox enabled; only ipcRenderer.invoke/on are
 * used here, no Node modules leak into the renderer.
 */
import { contextBridge, ipcRenderer, webUtils } from "electron";

import { IPC, type AtlasDesktopApi, type DesktopMenuCommand, type DesktopWorldFile } from "../../shared/ipc";

const api: AtlasDesktopApi = {
  isDesktop: true,
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  openWorld: () => ipcRenderer.invoke(IPC.openWorld),
  readWorldFile: (path: string) => ipcRenderer.invoke(IPC.readWorldFile, path),
  saveWorld: (request) => ipcRenderer.invoke(IPC.saveWorld, request),
  saveWorldAs: (request) => ipcRenderer.invoke(IPC.saveWorldAs, request),
  exportPng: (request) => ipcRenderer.invoke(IPC.exportPng, request),
  exportSvg: (request) => ipcRenderer.invoke(IPC.exportSvg, request),
  getRecentFiles: () => ipcRenderer.invoke(IPC.recentFiles),
  clearRecentFiles: () => ipcRenderer.invoke(IPC.clearRecent),
  setDocumentState: (state) => ipcRenderer.send(IPC.setDocumentState, state),
  onMenuCommand: (handler) => {
    const listener = (_event: unknown, command: DesktopMenuCommand) => handler(command);
    ipcRenderer.on(IPC.menuCommand, listener);
    return () => ipcRenderer.removeListener(IPC.menuCommand, listener);
  },
  onOpenWorldFile: (handler) => {
    const listener = (_event: unknown, file: DesktopWorldFile) => handler(file);
    ipcRenderer.on(IPC.openWorldFile, listener);
    return () => ipcRenderer.removeListener(IPC.openWorldFile, listener);
  },
  log: (level, message) => ipcRenderer.send(IPC.log, level, message),
};

// File paths for drag&drop: the DOM File object no longer exposes .path in
// Electron 32+, so the renderer asks the preload to resolve it.
contextBridge.exposeInMainWorld("atlasDesktop", api);
contextBridge.exposeInMainWorld("atlasDesktopFilePath", (file: File) => {
  try {
    return webUtils.getPathForFile(file);
  } catch {
    return "";
  }
});
