/** File dialogs + world JSON read/write, executed in the main process. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { app, dialog, ipcMain, type BrowserWindow } from "electron";

import { normalizeWorldDocument, type WorldDocument } from "@atlas/core";

import {
  IPC,
  type DesktopWorldFile,
  type RecentWorldFile,
  type SaveWorldRequest,
  type SaveWorldResult,
} from "../../shared/ipc";

function windowOrUndefined(window: BrowserWindow | null): BrowserWindow {
  // Electron's dialog overload without a parent window takes no argument; the
  // typed overloads require BaseWindow, so pass the window only when present.
  return window as BrowserWindow;
}

interface FileHandlerDeps {
  getWindow: () => BrowserWindow | null;
  onRecent: (entry: RecentWorldFile) => void;
}

function hashDocument(document: WorldDocument): string {
  return createHash("sha256").update(JSON.stringify(document)).digest("hex").slice(0, 16);
}

export function registerFileHandlers(deps: FileHandlerDeps) {
  const readWorldFile = (path: string): DesktopWorldFile | null => {
    try {
      const text = readFileSync(path, "utf8");
      const normalized = normalizeWorldDocument(JSON.parse(text) as unknown);
      return {
        path,
        document: normalized.document,
        issues: normalized.issues.map((issue) => ({ ...issue })),
      };
    } catch (error) {
      void dialog.showMessageBox(windowOrUndefined(deps.getWindow()), {
        type: "error",
        title: "无法打开世界",
        message: `文件读取失败：${basename(path)}`,
        detail: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  };

  const writeWorldFile = (path: string, document: WorldDocument): SaveWorldResult => {
    try {
      writeFileSync(path, JSON.stringify(document, null, 2), "utf8");
      deps.onRecent({
        path,
        name: basename(path, ".json"),
        savedAt: new Date().toISOString(),
        hash: hashDocument(document),
      });
      return { canceled: false, path };
    } catch (error) {
      void dialog.showMessageBox(windowOrUndefined(deps.getWindow()), {
        type: "error",
        title: "保存失败",
        message: `无法写入 ${basename(path)}`,
        detail: error instanceof Error ? error.message : String(error),
      });
      return { canceled: true };
    }
  };

  ipcMain.handle(IPC.openWorld, async (): Promise<DesktopWorldFile | null> => {
    const window = deps.getWindow();
    const result = await dialog.showOpenDialog(windowOrUndefined(window), {
      title: "打开世界",
      defaultPath: app.getPath("documents"),
      filters: [{ name: "Atlas World", extensions: ["json"] }],
      properties: ["openFile"],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return readWorldFile(result.filePaths[0]);
  });

  ipcMain.handle(IPC.readWorldFile, (_event, path: string): DesktopWorldFile | null => {
    if (typeof path !== "string" || path.length === 0) return null;
    return readWorldFile(path);
  });

  const save = async (request: SaveWorldRequest, forceDialog: boolean): Promise<SaveWorldResult> => {
    const window = deps.getWindow();
    let target = request.path;
    if (!target || forceDialog) {
      const result = await dialog.showSaveDialog(windowOrUndefined(window), {
        title: "保存世界",
        defaultPath: target ?? `${request.document.name || "world"}.atlas.json`,
        filters: [{ name: "Atlas World", extensions: ["json"] }],
      });
      if (result.canceled || !result.filePath) return { canceled: true };
      target = result.filePath;
    }
    return writeWorldFile(target, request.document);
  };

  ipcMain.handle(IPC.saveWorld, (_event, request: SaveWorldRequest) => save(request, false));
  ipcMain.handle(IPC.saveWorldAs, (_event, request: SaveWorldRequest) => save(request, true));

  return { readWorldFile, writeWorldFile };
}
