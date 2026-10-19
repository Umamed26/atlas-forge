/**
 * Desktop integration for the renderer.
 *
 * Owns everything that only makes sense inside the Electron shell:
 *   - native menu commands (`onMenuCommand`) → open/save/save-as/new/export/help
 *   - OS "open file" events (`onOpenWorldFile`, recent menu, file association)
 *   - drag & drop import using the preload path resolver (Electron 32+ removed
 *     `File.path`, so the DOM File is resolved by `atlasDesktopFilePath`)
 *   - dirty tracking + window title via `setDocumentState`
 *   - recent files (max 3)
 *
 * In a plain browser `isDesktop()` is false: no listener is attached and every
 * action is a no-op, so the existing JSON import/export flows stay untouched.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { createDefaultDocument, type WorldDocument } from "@atlas/core";

import { countIssues, formatDocumentIssues } from "../lib/coreDocumentAdapter";
import {
  desktopFilePath,
  getRecentFiles,
  isDesktop,
  onMenuCommand,
  onOpenWorldFile,
  openWorld as bridgeOpenWorld,
  pathBasename,
  readWorldFile as bridgeReadWorldFile,
  saveWorld as bridgeSaveWorld,
  saveWorldAs as bridgeSaveWorldAs,
  setDocumentState,
  type DesktopMenuCommand,
  type DesktopWorldFile,
  type RecentWorldFile,
} from "../lib/desktopBridge";
import { normalizeDocumentDetailed } from "../lib/documentIO";
import { randomSeed } from "../lib/utils";
import { useWorldStore } from "../state/worldStore";

export type DesktopBusy = "open" | "save" | null;

export interface DesktopIntegrationOptions {
  onOpenExport(format: "png" | "svg"): void;
  onOpenHelp(): void;
}

export interface DesktopIntegration {
  /** True only in the Electron renderer (window.atlasDesktop present). */
  available: boolean;
  dirty: boolean;
  /** Path of the file the current document was opened from / saved to. */
  path: string | null;
  recent: RecentWorldFile[];
  busy: DesktopBusy;
  /** A file is hovering the window (render the drop overlay). */
  dragging: boolean;
  openWorld(): Promise<void>;
  saveWorld(): Promise<void>;
  saveWorldAs(): Promise<void>;
  openRecent(path: string): Promise<void>;
}

const MAX_RECENT = 3;

/** Electron wraps IPC rejections in a noisy prefix; keep the useful part. */
function errorMessage(error: unknown): string {
  const raw =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  return raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, "");
}

export function useDesktopIntegration(options: DesktopIntegrationOptions): DesktopIntegration {
  const available = isDesktop();
  const [dirty, setDirty] = useState(false);
  const [documentPath, setDocumentPath] = useState<string | null>(null);
  const [recent, setRecent] = useState<RecentWorldFile[]>([]);
  const [busy, setBusy] = useState<DesktopBusy>(null);
  const [dragging, setDragging] = useState(false);

  // `savedDocumentRef` is the document identity on disk (null = unsaved new
  // world). Identity comparison is exact: every store mutation creates a new
  // document object, so no deep JSON comparison is needed.
  const savedDocumentRef = useRef<WorldDocument | null>(useWorldStore.getState().document);
  const currentDocumentRef = useRef<WorldDocument>(useWorldStore.getState().document);
  const pathRef = useRef<string | null>(null);
  const busyRef = useRef<DesktopBusy>(null);

  const setName = useWorldStore((state) => state.document.name);

  const setPath = useCallback((next: string | null) => {
    pathRef.current = next;
    setDocumentPath(next);
  }, []);

  const markClean = useCallback((savedDocument: WorldDocument | null) => {
    savedDocumentRef.current = savedDocument;
    currentDocumentRef.current = useWorldStore.getState().document;
    setDirty(currentDocumentRef.current !== savedDocument);
  }, []);

  const beginBusy = useCallback((kind: Exclude<DesktopBusy, null>): boolean => {
    if (busyRef.current !== null) return false;
    busyRef.current = kind;
    setBusy(kind);
    return true;
  }, []);

  const endBusy = useCallback(() => {
    busyRef.current = null;
    setBusy(null);
  }, []);

  const notify = useCallback((kind: "info" | "success" | "error", text: string) => {
    useWorldStore.getState().pushToast(kind, text);
  }, []);

  // ── dirty tracking: any document replacement re-evaluates the identity ──
  useEffect(() => {
    if (!available) return;
    return useWorldStore.subscribe((state) => {
      if (state.document === currentDocumentRef.current) return;
      currentDocumentRef.current = state.document;
      setDirty(state.document !== savedDocumentRef.current);
    });
  }, [available]);

  // ── window title: dirty marker + world name (debounced, deduped) ────────
  const lastTitleRef = useRef("");
  useEffect(() => {
    if (!available) return;
    const signature = `${dirty ? 1 : 0}|${setName}`;
    const timer = window.setTimeout(() => {
      if (lastTitleRef.current === signature) return;
      lastTitleRef.current = signature;
      setDocumentState({ dirty, name: setName || "未命名世界" });
    }, 150);
    return () => window.clearTimeout(timer);
  }, [available, dirty, setName]);

  // ── recent files ────────────────────────────────────────────────────────
  const refreshRecent = useCallback(async () => {
    if (!available) return;
    try {
      const files = await getRecentFiles();
      setRecent(files.slice(0, MAX_RECENT));
    } catch {
      // Recent files are a convenience; a broken recent list must not fail.
      setRecent([]);
    }
  }, [available]);

  useEffect(() => {
    if (available) void refreshRecent();
  }, [available, refreshRecent]);

  // Kept in a ref so the always-mounted listeners never resubscribe when the
  // action callbacks change identity (they close over the store, not props).
  const openPathRef = useRef<(path: string) => Promise<void>>(async () => {});

  // ── import a world file returned by the main process ────────────────────
  const importDesktopFile = useCallback(
    (file: DesktopWorldFile): boolean => {
      const store = useWorldStore.getState();
      // Re-normalize in the renderer with the same core normalizer the browser
      // import path uses: the main process already validated, this is the
      // authoritative "issues > 0 → toast" checkpoint required by the UI.
      const normalized = normalizeDocumentDetailed(file.document);
      const issues = [...(normalized.issues ?? []), ...(file.issues ?? [])];
      const errors = countIssues(issues, "error");
      if (!normalized.document || errors > 0) {
        notify("error", `无法打开 ${pathBasename(file.path)}：${formatDocumentIssues(issues)}`);
        return false;
      }
      store.importDocument(normalized.document);
      store.requestPipelineReset();
      setPath(file.path);
      // importDocument stamps `updatedAt`, so compare against the document the
      // store actually installed (not the normalized input).
      markClean(useWorldStore.getState().document);
      const warningCount = countIssues(issues, "warning");
      const name = useWorldStore.getState().document.name || "未命名世界";
      notify(
        "success",
        warningCount > 0
          ? `已打开「${name}」，并自动修复 ${warningCount} 处字段`
          : `已打开「${name}」`,
      );
      void refreshRecent();
      return true;
    },
    [markClean, notify, refreshRecent, setPath],
  );

  // ── open / save ─────────────────────────────────────────────────────────
  const openWorld = useCallback(async () => {
    if (!available || !beginBusy("open")) return;
    try {
      const file = await bridgeOpenWorld();
      if (!file) return; // dialog canceled
      importDesktopFile(file);
    } catch (error) {
      notify("error", `打开世界失败：${errorMessage(error)}`);
    } finally {
      endBusy();
    }
  }, [available, beginBusy, endBusy, importDesktopFile, notify]);

  const openByPath = useCallback(
    async (path: string) => {
      if (!available || !path || !beginBusy("open")) return;
      try {
        const file = await bridgeReadWorldFile(path);
        if (!file) {
          notify("error", `无法读取 ${pathBasename(path)}`);
          return;
        }
        importDesktopFile(file);
      } catch (error) {
        notify("error", `打开世界失败：${errorMessage(error)}`);
      } finally {
        endBusy();
      }
    },
    [available, beginBusy, endBusy, importDesktopFile, notify],
  );
  openPathRef.current = openByPath;

  const saveToDisk = useCallback(
    async (forceDialog: boolean) => {
      if (!available || !beginBusy("save")) return;
      // Snapshot the document before the native dialog (which can stay open for
      // minutes). Edits made meanwhile keep the title dirty.
      const document = useWorldStore.getState().document;
      try {
        const result = forceDialog
          ? await bridgeSaveWorldAs(document)
          : await bridgeSaveWorld(document, pathRef.current ?? undefined);
        if (!result || result.canceled) return;
        if (!result.path) {
          notify("error", "保存失败：主进程没有返回文件路径");
          return;
        }
        setPath(result.path);
        markClean(document);
        notify("success", `已保存：${result.path}`);
        void refreshRecent();
      } catch (error) {
        notify("error", `保存失败：${errorMessage(error)}`);
      } finally {
        endBusy();
      }
    },
    [available, beginBusy, endBusy, markClean, notify, refreshRecent, setPath],
  );

  const saveWorld = useCallback(() => saveToDisk(false), [saveToDisk]);
  const saveWorldAs = useCallback(() => saveToDisk(true), [saveToDisk]);

  // ── new world (menu command) ────────────────────────────────────────────
  const newWorld = useCallback(() => {
    const store = useWorldStore.getState();
    const document = createDefaultDocument({ name: "未命名世界", seed: randomSeed() });
    store.commitDocument(document, { history: "push", sim: "now", render: true });
    store.requestPipelineReset();
    savedDocumentRef.current = null;
    currentDocumentRef.current = useWorldStore.getState().document;
    setPath(null);
    setDirty(true);
    notify("info", "已新建世界；保存后会写入 JSON 文件");
    // A newly created world has no path: remember that the next plain save opens
    // the native save dialog instead of overwriting the previous file.
  }, [notify, setPath]);

  // ── decorations shortcut (menu "视图 → 地图装饰") ────────────────────────
  const revealDecorations = useCallback(() => {
    const group = document.querySelector<HTMLElement>('[data-testid="group-style-decorations"]');
    if (!group) return;
    const collapsed = !group.classList.contains("is-open");
    if (collapsed) group.querySelector<HTMLButtonElement>(".panel-group-head")?.click();
    const focus = () => group.classList.add("is-desktop-focus");
    // Let React commit the expand (its className update would wipe a class added
    // synchronously before the re-render).
    if (collapsed) window.setTimeout(focus, 40);
    else focus();
    window.setTimeout(() => group.classList.remove("is-desktop-focus"), 1800);
    window.setTimeout(() => group.scrollIntoView({ block: "center", behavior: "smooth" }), 80);
  }, []);

  // ── native menu commands ────────────────────────────────────────────────
  const actionsRef = useRef({
    openWorld,
    saveWorld,
    saveWorldAs,
    newWorld,
    revealDecorations,
    onOpenExport: options.onOpenExport,
    onOpenHelp: options.onOpenHelp,
  });
  actionsRef.current = {
    openWorld,
    saveWorld,
    saveWorldAs,
    newWorld,
    revealDecorations,
    onOpenExport: options.onOpenExport,
    onOpenHelp: options.onOpenHelp,
  };

  useEffect(() => {
    if (!available) return;
    return onMenuCommand((command: DesktopMenuCommand) => {
      const actions = actionsRef.current;
      switch (command) {
        case "new-world":
          actions.newWorld();
          break;
        case "open-world":
          void actions.openWorld();
          break;
        case "save-world":
          actions.saveWorld();
          break;
        case "save-world-as":
          actions.saveWorldAs();
          break;
        case "export-png":
          actions.onOpenExport("png");
          break;
        case "export-svg":
          actions.onOpenExport("svg");
          break;
        case "open-decorations":
          actions.revealDecorations();
          break;
        case "open-settings":
        case "help":
          actions.onOpenHelp();
          break;
      }
    });
  }, [available]);

  // ── OS "open file" (menu recent, file association, second instance) ─────
  const importRef = useRef(importDesktopFile);
  importRef.current = importDesktopFile;
  useEffect(() => {
    if (!available) return;
    return onOpenWorldFile((file) => {
      importRef.current(file);
    });
  }, [available]);

  // ── drag & drop import ──────────────────────────────────────────────────
  useEffect(() => {
    if (!available) return;
    let depth = 0;
    const hasFiles = (event: DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");

    const onDragEnter = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      // Electron navigates the window to a dropped file unless we prevent this.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setDragging(false);
      const file = event.dataTransfer?.files?.[0];
      if (!file) {
        notify("error", "拖入的文件为空");
        return;
      }
      const path = desktopFilePath(file);
      if (!path) {
        notify("error", "无法读取拖入文件的路径，请从系统文件管理器拖入 .json 世界文件");
        return;
      }
      void openPathRef.current(path);
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [available, notify]);

  return {
    available,
    dirty,
    path: documentPath,
    recent,
    busy,
    dragging,
    openWorld,
    saveWorld,
    saveWorldAs,
    openRecent: openByPath,
  };
}
