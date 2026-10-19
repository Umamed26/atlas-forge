/**
 * Atlas Forge desktop shell (v0.7).
 *
 * The renderer is the existing Vite build of the web app; this process owns the
 * OS integration (window, menu, dialogs, recent files, offline exports).
 * packages/core and packages/render are imported directly — never duplicated —
 * so the desktop build and the browser share one pipeline and one renderer.
 *
 * Renderer location:
 *  - dev: the Vite dev server (http://127.0.0.1:5173);
 *  - packaged: a privileged `app://atlas/` protocol that serves dist/renderer.
 *    A custom standard/secure scheme gives the renderer a real origin, so ESM
 *    module scripts, module workers and CSP `'self'` behave exactly like they do
 *    on http(s); loading the Vite bundle directly from file:// does not (opaque
 *    origin, CORS-blocked module scripts). Every request is path-normalized and
 *    confined to the renderer directory.
 *
 * Security baseline (see also scripts/csp.json + scripts/copy-assets.mjs):
 *  - contextIsolation + Chromium sandbox on every renderer, no Node integration;
 *  - the preload is a single-file CJS bridge (`dist/preload/index.cjs`), no raw
 *    ipcRenderer is ever exposed to page scripts;
 *  - window.open goes to shell.openExternal (http/https only) and is always denied;
 *  - navigation is restricted to the dev server origin or `app://atlas/`;
 *  - permission requests are denied by default;
 *  - CSP is attached as a header to app:// responses (protocol.handle) and to
 *    http(s) main frames (dev), plus injected as a <meta> tag at build time as
 *    defense in depth.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { IPC, type DesktopMenuCommand, type DesktopWorldFile, type RecentWorldFile } from "../../shared/ipc";
import cspPolicies from "../../scripts/csp.json";
import { registerExportHandlers } from "./exports";
import { registerFileHandlers } from "./files";
import { buildMenu } from "./menu";
import { addRecentFile, clearRecentFiles, loadRecentFiles } from "./recent";

const __dirname = dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged && process.env.ATLAS_DESKTOP_DEV === "1";
const DEV_SERVER_URL = process.env.ATLAS_WEB_URL ?? "http://127.0.0.1:5173/";
const RENDERER_DIR = join(__dirname, "..", "renderer");
const RENDERER_ENTRY = join(RENDERER_DIR, "index.html");
const PRELOAD_PATH = join(__dirname, "..", "preload", "index.cjs");
const CSP_HEADER = isDev ? cspPolicies.dev : cspPolicies.prod;

const APP_SCHEME = "app";
const APP_HOST = "atlas";
const APP_ENTRY_URL = `${APP_SCHEME}://${APP_HOST}/index.html`;
const APP_URL_PREFIX = `${APP_SCHEME}://${APP_HOST}/`;

// A privileged standard/secure scheme is required for ESM modules, module workers,
// localStorage and CSP 'self' to work with the packaged renderer.
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

// E2E/QA runs must be able to use an isolated profile: the single-instance lock is
// keyed by userData, so parallel probes on the default dir would fight each other.
const userDataOverride = process.env.ATLAS_DESKTOP_USER_DATA_DIR;
if (userDataOverride) app.setPath("userData", resolve(userDataOverride));

// Force the Chromium sandbox for every renderer, including windows created later.
// The per-window `sandbox: true` below documents the same intent.
app.enableSandbox();

let mainWindow: BrowserWindow | null = null;
let pendingOpenPath: string | null = null;

// ── app:// renderer protocol ───────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

function contentTypeFor(file: string): string {
  return MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

function textResponse(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Serve a request against dist/renderer, refusing anything outside that directory. */
function handleAppRequest(request: Request): Response {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return textResponse(400, "Bad request");
  }
  if (url.host !== APP_HOST) return textResponse(404, "Unknown app host");

  let requestedPath: string;
  try {
    requestedPath = decodeURIComponent(url.pathname);
  } catch {
    return textResponse(400, "Malformed path");
  }

  const relativePath =
    requestedPath === "" || requestedPath === "/" ? "index.html" : requestedPath.replace(/^\/+/, "");
  const rendererRoot = resolve(RENDERER_DIR);
  const target = resolve(rendererRoot, relativePath);
  if (target !== rendererRoot && !target.startsWith(`${rendererRoot}${sep}`)) {
    console.warn(`[security] blocked app:// path escape: ${request.url}`);
    return textResponse(403, "Forbidden");
  }

  let body: Buffer;
  try {
    body = readFileSync(target);
  } catch {
    return textResponse(404, `Not found: ${relativePath}`);
  }

  return new Response(new Uint8Array(body), {
    status: 200,
    headers: {
      "content-type": contentTypeFor(target),
      "content-security-policy": CSP_HEADER,
      "cache-control": "no-store",
    },
  });
}

function installAppProtocol(): void {
  protocol.handle(APP_SCHEME, (request) => handleAppRequest(request));
}

// ── security baseline ──────────────────────────────────────────────────────

function isHttpUrl(value: string): boolean {
  try {
    const { protocol: scheme } = new URL(value);
    return scheme === "http:" || scheme === "https:";
  } catch {
    return false;
  }
}

function isDevServerUrl(value: string): boolean {
  let devOrigin: string;
  try {
    devOrigin = new URL(DEV_SERVER_URL).origin;
  } catch {
    return false;
  }
  try {
    return new URL(value).origin === devOrigin;
  } catch {
    return false;
  }
}

/** Only the dev server (dev) or the packaged app:// renderer (prod) may be navigated to. */
function isAllowedNavigation(url: string): boolean {
  if (isDev) return isDevServerUrl(url);
  return url === APP_ENTRY_URL || url.startsWith(APP_URL_PREFIX);
}

/**
 * CSP header for http(s) responses (the dev server). Packaged app:// responses get
 * the same policy from protocol.handle; the build also injects an equivalent meta
 * tag (scripts/copy-assets.mjs) as defense in depth.
 */
function installContentSecurityPolicy(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = details.responseHeaders ?? {};
    if (details.resourceType !== "mainFrame") {
      callback({ responseHeaders });
      return;
    }
    callback({
      responseHeaders: { ...responseHeaders, "Content-Security-Policy": [CSP_HEADER] },
    });
  });
}

/** Deny every permission request/check the renderer could make. */
function denyPermissions(): void {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    console.warn(`[security] denied permission request: ${permission}`);
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
}

/** Guards applied to every WebContents, including ones created in the future. */
function installWindowGuards(): void {
  app.on("web-contents-created", (_event, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (isHttpUrl(url)) {
        void shell.openExternal(url).catch((error) => console.warn("[security] openExternal failed", error));
      } else {
        console.warn(`[security] blocked window.open("${url}")`);
      }
      return { action: "deny" };
    });

    contents.on("will-navigate", (event, url) => {
      if (!isAllowedNavigation(url)) {
        console.warn(`[security] blocked navigation to ${url}`);
        event.preventDefault();
      }
    });

    contents.on("will-redirect", (event, url) => {
      if (!isAllowedNavigation(url)) {
        console.warn(`[security] blocked redirect to ${url}`);
        event.preventDefault();
      }
    });

    contents.on("will-attach-webview", (event) => {
      console.warn("[security] blocked <webview> attach");
      event.preventDefault();
    });
  });
}

// ── window / renderer loading ──────────────────────────────────────────────

function resolveRendererEntry(): { url: string; kind: "dev" | "app" } {
  if (isDev) return { url: DEV_SERVER_URL, kind: "dev" };
  return { url: APP_ENTRY_URL, kind: "app" };
}

function failStartup(message: string): void {
  console.error(`[desktop] ${message}`);
  dialog.showErrorBox("Atlas Forge 无法启动", message);
  app.quit();
}

function createWindow(): void {
  const entry = resolveRendererEntry();

  if (!existsSync(PRELOAD_PATH)) {
    failStartup(`缺少 preload 构建产物：${PRELOAD_PATH}\n请先运行 pnpm desktop:build`);
    return;
  }
  if (entry.kind === "app" && !existsSync(RENDERER_ENTRY)) {
    failStartup(`缺少渲染层构建产物：${RENDERER_ENTRY}\n请先运行 pnpm desktop:build`);
    return;
  }
  if (entry.kind === "dev" && !isDevServerUrl(entry.url)) {
    failStartup(`ATLAS_WEB_URL 必须指向本机 dev server（127.0.0.1 / localhost）：${entry.url}`);
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1680,
    height: 1000,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: "#151310",
    show: false,
    title: "Atlas Forge",
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow?.show());

  const window = mainWindow;
  void window.loadURL(entry.url).catch((error) => console.error(`[desktop] loadURL failed: ${entry.url}`, error));

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    console.error(`[desktop] renderer failed to load (${errorCode} ${errorDescription}): ${validatedURL}`);
  });

  window.webContents.on("did-finish-load", () => {
    if (pendingOpenPath) {
      const path = pendingOpenPath;
      pendingOpenPath = null;
      openPathInWindow(path);
    }
  });

  window.on("closed", () => {
    mainWindow = null;
  });
}

function sendMenuCommand(command: DesktopMenuCommand): void {
  mainWindow?.webContents.send(IPC.menuCommand, command);
}

function openPathInWindow(path: string): void {
  const handler = fileHandlers.readWorldFile;
  const file = handler(path);
  if (file) mainWindow?.webContents.send(IPC.openWorldFile, file);
}

const fileHandlers = registerFileHandlers({
  getWindow: () => mainWindow,
  onRecent: (entry) => {
    addRecentFile(entry);
    rebuildMenu();
  },
});

function rebuildMenu(): void {
  Menu.setApplicationMenu(
    buildMenu({
      isDev,
      recentFiles: loadRecentFiles(),
      onCommand: sendMenuCommand,
      onOpenRecent: (path) => openPathInWindow(path),
      onClearRecent: () => {
        clearRecentFiles();
        rebuildMenu();
      },
    }),
  );
}

// ── exports (offline, no HTTP server needed) ──────────────────────────────
registerExportHandlers({ getWindow: () => mainWindow });

app
  .whenReady()
  .then(() => {
    mkdirSync(app.getPath("userData"), { recursive: true });

    installAppProtocol();
    denyPermissions();
    installContentSecurityPolicy();
    installWindowGuards();

    ipcMain.handle(IPC.appInfo, () => ({
      platform: process.platform,
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      userDataDir: app.getPath("userData"),
      offlineExports: { png: [1024, 2048, 4096, 8192], svg: [1024, 2048, 4096, 8192] },
    }));
    ipcMain.handle(IPC.recentFiles, () => loadRecentFiles());
    ipcMain.handle(IPC.clearRecent, () => {
      clearRecentFiles();
      rebuildMenu();
    });
    ipcMain.on(IPC.log, (_event, level: string, message: string) => {
      const line = `[renderer:${level}] ${message}`;
      if (level === "error") console.error(line);
      else if (level === "warn") console.warn(line);
      else console.log(line);
    });
    ipcMain.on(IPC.setDocumentState, (_event, state: { dirty: boolean; name: string }) => {
      if (!mainWindow) return;
      mainWindow.setTitle(`${state.dirty ? "• " : ""}${state.name} — Atlas Forge`);
    });

    rebuildMenu();
    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((error: unknown) => {
    console.error("[desktop] failed to start", error);
    dialog.showErrorBox("Atlas Forge 无法启动", error instanceof Error ? error.message : String(error));
    app.quit();
  });

// macOS "open file" / second instance with a path argument.
app.on("open-file", (event, path) => {
  event.preventDefault();
  if (mainWindow) openPathInWindow(path);
  else pendingOpenPath = path;
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    const candidate = argv.find((arg) => arg.endsWith(".json"));
    if (candidate) openPathInWindow(candidate);
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

export { existsSync, readFileSync, writeFileSync, dialog, basename };
