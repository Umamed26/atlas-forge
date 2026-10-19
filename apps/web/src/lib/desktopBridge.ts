/**
 * Renderer-side bridge to the Electron shell (v0.7).
 *
 * Contract source of truth: `apps/desktop/shared/ipc.ts` — **do not edit that
 * contract here**. The types below are a structural mirror because `@atlas/web`
 * must stay a plain browser package: the desktop package is optional at
 * runtime and the web build has no `window.atlasDesktop` at all. If the IPC
 * contract changes, update this mirror in the same commit.
 *
 * Design rules:
 *   - `getDesktop()` is the single place that touches `window.atlasDesktop`;
 *     every helper is a no-op (`null` / `[]` / noop unsubscribe) in the browser.
 *   - Helpers never swallow real IPC errors: calls reject and the calling hook
 *     turns the rejection into a user-facing toast. A missing desktop bridge is
 *     not an error — it simply returns the no-op value.
 *   - No Node / Electron import may leak into the renderer bundle.
 */
import type { DocumentIssue, WorldDocument } from "@atlas/core";

// ── Mirrored IPC payload types (see apps/desktop/shared/ipc.ts) ───────────

export interface DesktopWorldFile {
  path: string;
  document: WorldDocument;
  /** Normalization issues reported by core (empty = clean file). */
  issues?: DocumentIssue[];
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
  platform: string;
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

/** Preload also exposes `atlasDesktopFilePath(file)` for drag&drop paths. */
export type DesktopFilePathResolver = (file: File) => string;

declare global {
  interface Window {
    atlasDesktop?: AtlasDesktopApi;
    atlasDesktopFilePath?: DesktopFilePathResolver;
  }
}

// ── Detection helpers ─────────────────────────────────────────────────────

function desktopWindow(): Window | null {
  if (typeof window === "undefined") return null;
  return window;
}

/** The Electron bridge, or null when running in a plain browser. */
export function getDesktop(): AtlasDesktopApi | null {
  const scope = desktopWindow();
  if (!scope) return null;
  const bridge = scope.atlasDesktop;
  return bridge && bridge.isDesktop === true ? bridge : null;
}

/** UI gating switch: true only inside the Electron shell. */
export function isDesktop(): boolean {
  return getDesktop() !== null;
}

/**
 * Resolve the filesystem path of a dropped/selected File. Electron 32+ removed
 * `File.path`; the preload uses `webUtils.getPathForFile` instead. Returns ""
 * outside the desktop shell (browser file drop has no path by design).
 */
export function desktopFilePath(file: File): string {
  const scope = desktopWindow();
  const resolve = scope?.atlasDesktopFilePath;
  if (!resolve) return "";
  try {
    return resolve(file) || "";
  } catch {
    return "";
  }
}

// ── Typed no-op helpers (browser = null / [] / noop) ──────────────────────

export function getAppInfo(): Promise<DesktopAppInfo | null> {
  const desktop = getDesktop();
  return desktop ? desktop.getAppInfo() : Promise.resolve(null);
}

export function openWorld(): Promise<DesktopWorldFile | null> {
  const desktop = getDesktop();
  return desktop ? desktop.openWorld() : Promise.resolve(null);
}

export function readWorldFile(path: string): Promise<DesktopWorldFile | null> {
  const desktop = getDesktop();
  if (!desktop || !path) return Promise.resolve(null);
  return desktop.readWorldFile(path);
}

export function saveWorld(document: WorldDocument, path?: string): Promise<SaveWorldResult | null> {
  const desktop = getDesktop();
  if (!desktop) return Promise.resolve(null);
  const request: SaveWorldRequest = path ? { document, path } : { document };
  return desktop.saveWorld(request);
}

export function saveWorldAs(document: WorldDocument): Promise<SaveWorldResult | null> {
  const desktop = getDesktop();
  return desktop ? desktop.saveWorldAs({ document }) : Promise.resolve(null);
}

export function exportPng(request: DesktopExportRequest): Promise<DesktopExportResult | null> {
  const desktop = getDesktop();
  return desktop ? desktop.exportPng(request) : Promise.resolve(null);
}

export function exportSvg(request: DesktopExportRequest): Promise<DesktopExportResult | null> {
  const desktop = getDesktop();
  return desktop ? desktop.exportSvg(request) : Promise.resolve(null);
}

export function getRecentFiles(): Promise<RecentWorldFile[]> {
  const desktop = getDesktop();
  return desktop ? desktop.getRecentFiles() : Promise.resolve([]);
}

export function setDocumentState(state: DocumentState): void {
  const desktop = getDesktop();
  if (!desktop) return;
  try {
    desktop.setDocumentState(state);
  } catch {
    // Title updates are cosmetic: never let them break a save/open flow.
  }
}

export function onMenuCommand(handler: (command: DesktopMenuCommand) => void): () => void {
  const desktop = getDesktop();
  if (!desktop) return () => {};
  return desktop.onMenuCommand(handler);
}

export function onOpenWorldFile(handler: (file: DesktopWorldFile) => void): () => void {
  const desktop = getDesktop();
  if (!desktop) return () => {};
  return desktop.onOpenWorldFile(handler);
}

export function desktopLog(level: "info" | "warn" | "error", message: string): void {
  const desktop = getDesktop();
  if (!desktop) return;
  try {
    desktop.log(level, message);
  } catch {
    // Logging is best-effort.
  }
}

/** Last path segment, for compact toasts (works for POSIX and Windows paths). */
export function pathBasename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const segment = normalized.slice(normalized.lastIndexOf("/") + 1);
  return segment || path;
}
