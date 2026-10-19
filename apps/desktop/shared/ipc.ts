/**
 * Desktop IPC contract (v0.7).
 *
 * This file is the single source of truth for the bridge between the Electron
 * main process and the renderer. The preload script exposes exactly this API as
 * `window.atlasDesktop`; the web build simply does not have it, so the shared
 * renderer code degrades to browser downloads.
 *
 * Security: the renderer never receives Node primitives — only plain data and
 * promises. All filesystem / dialog work happens in the main process.
 */
import type { WorldDocument } from "@atlas/core";

export interface DesktopWorldFile {
  path: string;
  document: WorldDocument;
  /** Normalization issues reported by core (empty = clean file). */
  issues?: { path: string; message: string; severity: "error" | "warning" }[];
}

export interface SaveWorldRequest {
  document: WorldDocument;
  /** Existing path for a plain save; omit for "save as" / first save. */
  path?: string;
}

export interface SaveWorldResult {
  canceled: boolean;
  path?: string;
}

export interface DesktopExportRequest {
  document: WorldDocument;
  size: number;
  physical?: { dpi?: number; page?: string; widthMm?: number; heightMm?: number };
}

export interface DesktopExportResult {
  canceled: boolean;
  path?: string;
  bytes?: number;
  /** Export duration in milliseconds (simulation + render + encode). */
  ms?: number;
}

export interface RecentWorldFile {
  path: string;
  name: string;
  savedAt: string;
  /** Content hash so a renamed/edited file is not silently mistaken. */
  hash: string;
}

export type DesktopMenuCommand =
  | "new-world"
  | "open-world"
  | "save-world"
  | "save-world-as"
  | "export-png"
  | "export-svg"
  | "open-decorations"
  | "open-settings"
  | "help";

export interface DesktopAppInfo {
  platform: NodeJS.Platform;
  version: string;
  electron: string;
  chrome: string;
  userDataDir: string;
  offlineExports: { png: number[]; svg: number[] };
}

export interface DocumentState {
  dirty: boolean;
  name: string;
}

export interface AtlasDesktopApi {
  readonly isDesktop: true;
  getAppInfo(): Promise<DesktopAppInfo>;
  openWorld(): Promise<DesktopWorldFile | null>;
  /** Read a file the renderer dropped onto the window (path comes from Electron). */
  readWorldFile(path: string): Promise<DesktopWorldFile | null>;
  saveWorld(request: SaveWorldRequest): Promise<SaveWorldResult>;
  saveWorldAs(request: SaveWorldRequest): Promise<SaveWorldResult>;
  exportPng(request: DesktopExportRequest): Promise<DesktopExportResult>;
  exportSvg(request: DesktopExportRequest): Promise<DesktopExportResult>;
  getRecentFiles(): Promise<RecentWorldFile[]>;
  clearRecentFiles(): Promise<void>;
  /** Window title / dirty marker for the OS chrome. */
  setDocumentState(state: DocumentState): void;
  onMenuCommand(handler: (command: DesktopMenuCommand) => void): () => void;
  /** Menu "open", OS file association, drag&drop and second-instance opens. */
  onOpenWorldFile(handler: (file: DesktopWorldFile) => void): () => void;
  log(level: "info" | "warn" | "error", message: string): void;
}

export const IPC = {
  appInfo: "atlas:app-info",
  openWorld: "atlas:open-world",
  readWorldFile: "atlas:read-world-file",
  saveWorld: "atlas:save-world",
  saveWorldAs: "atlas:save-world-as",
  exportPng: "atlas:export-png",
  exportSvg: "atlas:export-svg",
  recentFiles: "atlas:recent-files",
  clearRecent: "atlas:clear-recent",
  setDocumentState: "atlas:set-document-state",
  log: "atlas:log",
  menuCommand: "atlas:menu-command",
  openWorldFile: "atlas:open-world-file",
} as const;

export type { WorldDocument };
