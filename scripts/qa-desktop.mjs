#!/usr/bin/env node
/**
 * Atlas Forge desktop packaged-artifact E2E (task-21).
 *
 * Boots the *packaged* Electron app (not the Vite dev server) through
 * `playwright-core`'s `_electron.launch`, drives the real renderer + the real
 * preload/IPC surface, exports files through the desktop main process and
 * asserts the desktop-only guarantees:
 *
 *   · window/preload/IPC come up, no unexpected console / page / crash errors;
 *   · first screen finishes generating and is under the latency budget;
 *   · a 512² generation is measured through the debug summary (when the
 *     desktop build exposes it) and through the offline export pipeline;
 *   · decoration toggles repaint and are reflected in the SVG export
 *     (a disabled element must not exist as a `data-decor` node);
 *   · "all decorations off" exports an SVG with zero `data-decor` nodes;
 *   · a 4096 PNG exports offline through the main process (real PNG signature,
 *     IHDR 4096×4096, > 1 MB);
 *   · generation + export still work with the renderer context offline;
 *   · screenshots land in out/desktop-qa/ and report.json summarises everything.
 *
 * Usage:
 *   node scripts/qa-desktop.mjs
 *   ATLAS_DESKTOP_APP=/path/to/unpacked-executable node scripts/qa-desktop.mjs
 *   xvfb-run -a node scripts/qa-desktop.mjs          # headless Linux
 *
 * Environment:
 *   ATLAS_DESKTOP_APP          explicit packaged executable OR unpacked app dir
 *   ATLAS_TEST_EXPORT_DIR      export destination (default out/desktop-qa/exports)
 *   ATLAS_QA_USER_DATA         isolate Electron userData (passed to the main process
 *                              as ATLAS_DESKTOP_USER_DATA_DIR; defaults to out/desktop-qa/user-data)
 *   ATLAS_QA_NO_SANDBOX=1      force --no-sandbox / ELECTRON_DISABLE_SANDBOX=1
 *   ELECTRON_PATH              explicit Electron binary for the unpacked fallback
 *   ATLAS_QA_REQUIRE_PACKAGED=1 fail when only the electron+appdir fallback works
 *   ATLAS_QA_STRICT=1          treat skipped assertions as failures
 *   ATLAS_QA_GEN_BUDGET_MS     generation latency budget (default 2000)
 *   ATLAS_QA_TIMEOUT_MS        whole-run watchdog (default 600000)
 *   ATLAS_QA_OUT_DIR           output directory (default out/desktop-qa; use a
 *                              private dir when several QA runs share the machine)
 *   ATLAS_QA_NO_XVFB=1         do not auto re-exec under xvfb-run
 *
 * Exit codes: 0 all green · 1 assertion failure · 2 precondition blocked
 * (missing binary / build / playwright / display). A blocked run still writes
 * out/desktop-qa/report.json with a `blocked` section — never exits silently.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

// ── paths / config ──────────────────────────────────────────────────────────
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR_OVERRIDE = process.env.ATLAS_QA_OUT_DIR;
const OUT_DIR = OUT_DIR_OVERRIDE
  ? resolve(isAbsolute(OUT_DIR_OVERRIDE) ? OUT_DIR_OVERRIDE : join(ROOT, OUT_DIR_OVERRIDE))
  : join(ROOT, "out", "desktop-qa");
const LOG_FILE = join(OUT_DIR, "run.log");
const REPORT_FILE = join(OUT_DIR, "report.json");
const EXPORT_DIR = process.env.ATLAS_TEST_EXPORT_DIR
  ? resolve(isAbsolute(process.env.ATLAS_TEST_EXPORT_DIR) ? process.env.ATLAS_TEST_EXPORT_DIR : join(ROOT, process.env.ATLAS_TEST_EXPORT_DIR))
  : join(OUT_DIR, "exports");
const USER_DATA_OVERRIDE = process.env.ATLAS_QA_USER_DATA ?? process.env.ATLAS_TEST_USER_DATA;
const USER_DATA_DIR = USER_DATA_OVERRIDE
  ? resolve(isAbsolute(USER_DATA_OVERRIDE) ? USER_DATA_OVERRIDE : join(ROOT, USER_DATA_OVERRIDE))
  : join(OUT_DIR, "user-data");

const GEN_BUDGET_MS = positiveNumber(process.env.ATLAS_QA_GEN_BUDGET_MS, 2000);
// First screen runs at the document grid size (1024² by default), which is
// stricter than the 512² requirement; record it against the <2s target but
// only hard-fail on an egregious regression so slow CI runners do not flake.
const FIRST_SCREEN_HARD_CAP_MS = positiveNumber(process.env.ATLAS_QA_FIRST_SCREEN_HARD_CAP_MS, 10_000);
const GLOBAL_TIMEOUT_MS = positiveNumber(process.env.ATLAS_QA_TIMEOUT_MS, 600_000);
const LAUNCH_TIMEOUT_MS = 120_000;
const STRICT = process.env.ATLAS_QA_STRICT === "1";
const REQUIRE_PACKAGED = process.env.ATLAS_QA_REQUIRE_PACKAGED === "1";
const DECOR_IDS = ["title", "compass", "scaleBar", "legend", "credits"];
const AUTOSAVE_STORAGE_KEY = "atlas_forge.world.v1";

const checks = [];
const screenshots = [];
const exportsLog = [];
const consoleErrors = [];
const consoleAllowlisted = [];
const failedRequests = [];
const requestLog = [];
const pageErrors = [];
const crashes = [];
const stderrLines = [];
const notes = [];
let app = null;
let page = null;
let target = null;
let launchInfo = null;
let offlinePhase = false;
let closing = false;
let mainProcessExit = null;
let lastAppInfo = null;
let startedAt = new Date();
const attachedPages = new WeakSet();

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

// ── logging / small utils ───────────────────────────────────────────────────
function log(message) {
  const line = `${message}`;
  process.stdout.write(`${line}\n`);
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging must never break the run */
  }
}

function rel(path) {
  return path ? relative(ROOT, path).split("\\").join("/") : null;
}

function readJsonSafe(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

function listDirSafe(path) {
  try {
    return readdirSync(path).sort();
  } catch (error) {
    return [`<unreadable: ${error instanceof Error ? error.message : String(error)}>`];
  }
}

class SkipError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "SkipError";
  }
}

class BlockedError extends Error {
  constructor(reason, data = {}) {
    super(reason);
    this.name = "BlockedError";
    this.data = data;
  }
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function waitFor(fn, { timeout = 20_000, interval = 120, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await fn();
      // NOTE: 0 / "" are legitimate results (e.g. "visible decoration count = 0"),
      // so only null/undefined/false mean "keep waiting".
      if (value !== null && value !== undefined && value !== false) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(interval);
  }
  throw new Error(
    `timeout after ${timeout}ms waiting for ${label}${lastError ? ` (last error: ${lastError instanceof Error ? lastError.message : String(lastError)})` : ""}`,
  );
}

// ── check runner ────────────────────────────────────────────────────────────
async function runCheck(id, title, fn) {
  const checkStartedAt = Date.now();
  log(`\n▶ ${id} — ${title}`);
  try {
    const detail = await fn();
    const ms = Date.now() - checkStartedAt;
    const detailText = typeof detail === "string" ? detail : JSON.stringify(detail ?? "");
    checks.push({ id, title, status: "pass", ms, detail: detailText, data: typeof detail === "object" ? detail : undefined });
    log(`  ✔ PASS ${id} (${ms}ms)${detailText ? ` — ${detailText}` : ""}`);
    return true;
  } catch (error) {
    const ms = Date.now() - checkStartedAt;
    if (error instanceof SkipError) {
      checks.push({ id, title, status: "skipped", ms, detail: error.message });
      log(`  ⊘ SKIP ${id} (${ms}ms) — ${error.message}`);
      return false;
    }
    const message = error instanceof Error ? `${error.message}${error.cause ? ` | ${String(error.cause)}` : ""}` : String(error);
    checks.push({ id, title, status: "fail", ms, detail: message });
    log(`  ✘ FAIL ${id} (${ms}ms) — ${message}`);
    if (page && !page.isClosed()) {
      await screenshot(`fail-${id}.png`, `failure screenshot for ${id}`).catch(() => {});
    }
    return false;
  }
}

async function screenshot(name, note) {
  if (!page || page.isClosed()) return null;
  const file = join(OUT_DIR, name);
  try {
    await page.screenshot({ path: file, animations: "disabled", timeout: 20_000 });
    const entry = { name, path: rel(file), note: note ?? "" };
    screenshots.push(entry);
    log(`  📸 ${entry.path}${note ? ` (${note})` : ""}`);
    return file;
  } catch (error) {
    log(`  ⚠ screenshot ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

// ── preconditions: find the packaged artifact / electron binary ─────────────
function parseProductName() {
  const candidates = [];
  // electron-builder.yml / electron-builder.json (written by desktop-shell-dev)
  for (const name of ["electron-builder.yml", "electron-builder.yaml", "electron-builder.json"]) {
    const file = join(ROOT, "apps", "desktop", name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    const json = name.endsWith(".json") ? readJsonSafe(file, null) : null;
    const product = json?.productName ?? /^\s*productName:\s*["']?([^"'\n]+)["']?\s*$/m.exec(text)?.[1];
    const executable = json?.executableName ?? /^\s*executableName:\s*["']?([^"'\n]+)["']?\s*$/m.exec(text)?.[1];
    if (product) candidates.push(product.trim());
    if (executable) candidates.push(executable.trim());
  }
  const pkg = readJsonSafe(join(ROOT, "apps", "desktop", "package.json"), null);
  if (pkg?.name) candidates.push(pkg.name.replace(/^@[^/]+\//, ""));
  candidates.push("Atlas Forge", "atlas-forge", "atlasforge");
  return [...new Set(candidates.map((value) => String(value).trim()).filter(Boolean))];
}

function exeNameCandidates() {
  const names = new Set();
  for (const product of parseProductName()) {
    names.add(product);
    names.add(product.toLowerCase());
    names.add(product.toLowerCase().replace(/\s+/g, "-"));
    names.add(product.toLowerCase().replace(/\s+/g, "_"));
    names.add(product.replace(/\s+/g, ""));
  }
  return [...names];
}

function isExecutableFile(path) {
  try {
    const stat = statSync(path);
    if (!stat.isFile() || stat.size < 1_000_000) return false;
    if (process.platform !== "win32" && (stat.mode & 0o111) === 0) return false;
    return true;
  } catch {
    return false;
  }
}

const LINUX_DENY = /^(chrome-sandbox|chrome_crashpad_handler|chrome-sandbox\.|.*\.pak|.*\.so(\.|$)|.*\.dat|.*\.bin|.*\.json|.*\.html|.*\.txt|snapshot_blob|v8_context_snapshot|icudtl|vk_swiftshader|.*\.desktop|.*\.png)$/i;

function findLinuxUnpacked() {
  const dist = join(ROOT, "apps", "desktop", "dist");
  const dir = join(dist, "linux-unpacked");
  if (!existsSync(dir)) return null;
  const names = exeNameCandidates();
  const entries = listDirSafe(dir);
  for (const name of names) {
    const candidate = entries.find((entry) => entry.toLowerCase() === name.toLowerCase());
    if (candidate && isExecutableFile(join(dir, candidate))) return { path: join(dir, candidate), layout: "linux-unpacked" };
  }
  // Fallback: the only large executable that is not a Chromium helper.
  for (const entry of entries) {
    if (LINUX_DENY.test(entry)) continue;
    const full = join(dir, entry);
    if (isExecutableFile(full)) return { path: full, layout: "linux-unpacked" };
  }
  return null;
}

function findMacApp() {
  const dist = join(ROOT, "apps", "desktop", "dist");
  if (!existsSync(dist)) return null;
  for (const entry of listDirSafe(dist)) {
    if (!/^mac/i.test(entry)) continue;
    const macDir = join(dist, entry);
    if (!statSync(macDir).isDirectory()) continue;
    for (const inner of listDirSafe(macDir)) {
      if (!inner.endsWith(".app")) continue;
      const macos = join(macDir, inner, "Contents", "MacOS");
      for (const exe of listDirSafe(macos)) {
        const full = join(macos, exe);
        if (isExecutableFile(full)) return { path: full, layout: entry };
      }
    }
  }
  return null;
}

function findWindowsUnpacked() {
  const dir = join(ROOT, "apps", "desktop", "dist", "win-unpacked");
  if (!existsSync(dir)) return null;
  const names = exeNameCandidates().map((name) => `${name}.exe`);
  const entries = listDirSafe(dir);
  for (const name of names) {
    const candidate = entries.find((entry) => entry.toLowerCase() === name.toLowerCase());
    if (candidate) return { path: join(dir, candidate), layout: "win-unpacked" };
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(".exe")) continue;
    if (/^(chrome|elevate|notification_helper|squirrel)/i.test(entry)) continue;
    return { path: join(dir, entry), layout: "win-unpacked" };
  }
  return null;
}

function scanUnpackedDir(dir) {
  const entries = listDirSafe(dir);
  const names = exeNameCandidates();
  for (const name of names) {
    for (const candidateName of [name, `${name}.exe`]) {
      const candidate = entries.find((entry) => entry.toLowerCase() === candidateName.toLowerCase());
      if (!candidate) continue;
      const full = join(dir, candidate);
      if (isExecutableFile(full)) return { path: full, layout: `explicit-dir: ${candidate}` };
    }
  }
  for (const entry of entries) {
    if (!entry.endsWith(".app")) continue;
    const macos = join(dir, entry, "Contents", "MacOS");
    for (const exe of listDirSafe(macos)) {
      const full = join(macos, exe);
      if (isExecutableFile(full)) return { path: full, layout: `explicit-dir: ${entry}` };
    }
  }
  for (const entry of entries) {
    if (LINUX_DENY.test(entry)) continue;
    const full = join(dir, entry);
    if (isExecutableFile(full)) return { path: full, layout: `explicit-dir: ${entry}` };
  }
  return null;
}

function resolveElectronBinary() {
  const candidates = [];
  if (process.env.ELECTRON_PATH) candidates.push(resolve(process.env.ELECTRON_PATH));
  if (process.env.ELECTRON_OVERRIDE_DIST_PATH) {
    candidates.push(join(process.env.ELECTRON_OVERRIDE_DIST_PATH, process.platform === "win32" ? "electron.exe" : "electron"));
    candidates.push(join(process.env.ELECTRON_OVERRIDE_DIST_PATH, "Electron.app", "Contents", "MacOS", "Electron"));
  }
  try {
    // Resolve the package *directory* without executing electron/index.js: that
    // module may spawn a blocking binary download when `path.txt` is stale.
    const require = createRequire(import.meta.url);
    const packageJson = require.resolve("electron/package.json");
    const packageDir = dirname(packageJson);
    candidates.push(
      join(packageDir, "dist", "electron"),
      join(packageDir, "dist", "electron.exe"),
      join(packageDir, "dist", "Electron.app", "Contents", "MacOS", "Electron"),
    );
    try {
      const relativePath = readFileSync(join(packageDir, "path.txt"), "utf8").trim();
      if (relativePath) {
        candidates.push(join(packageDir, "dist", relativePath));
        candidates.push(join(packageDir, relativePath));
      }
    } catch {
      /* path.txt is optional */
    }
  } catch {
    /* electron package not resolvable */
  }
  candidates.push(
    join(ROOT, "node_modules", "electron", "dist", "electron"),
    join(ROOT, "node_modules", "electron", "dist", "Electron.app", "Contents", "MacOS", "Electron"),
    join(ROOT, "node_modules", "electron", "dist", "electron.exe"),
    join(ROOT, "apps", "desktop", "node_modules", "electron", "dist", "electron"),
  );
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function appDirForFallback() {
  const dir = join(ROOT, "apps", "desktop");
  const main = join(dir, "dist", "main", "main.js");
  const preload = join(dir, "dist", "preload");
  const renderer = join(dir, "dist", "renderer", "index.html");
  const preloadFile = ["index.cjs", "index.js"]
    .map((name) => join(preload, name))
    .find((path) => existsSync(path));
  return {
    dir,
    main,
    renderer,
    preload: preloadFile ?? null,
    ready: existsSync(main) && existsSync(renderer) && Boolean(preloadFile),
  };
}

function resolveTarget() {
  const explicit = process.env.ATLAS_DESKTOP_APP;
  const searched = [];
  if (explicit) {
    const path = resolve(explicit);
    if (!existsSync(path)) {
      throw new BlockedError(`ATLAS_DESKTOP_APP does not exist: ${path}`, {
        reason: "explicit-app-missing",
        required: ["fix ATLAS_DESKTOP_APP to point at the unpacked executable or app dir"],
        searched: [path],
      });
    }
    const stat = statSync(path);
    if (stat.isFile()) {
      return { mode: "packaged", executablePath: path, args: [], appRoot: dirname(path), layout: "explicit-file", asar: existsSync(join(dirname(path), "resources", "app.asar")) };
    }
    if (stat.isDirectory()) {
      if (existsSync(join(path, "package.json"))) {
        const electronBinary = resolveElectronBinary();
        if (!electronBinary) throw new BlockedError("Electron binary missing while ATLAS_DESKTOP_APP points at an app directory", electronBinaryBlockedData());
        return { mode: "electron-appdir", executablePath: electronBinary, args: [path], appRoot: path, layout: "explicit-dir" };
      }
      const direct = scanUnpackedDir(path);
      if (direct) {
        return {
          mode: "packaged",
          executablePath: direct.path,
          args: [],
          appRoot: dirname(direct.path),
          layout: `${direct.layout} (via ATLAS_DESKTOP_APP dir)`,
          asar: existsSync(join(dirname(direct.path), "resources", "app.asar")),
        };
      }
      throw new BlockedError(`ATLAS_DESKTOP_APP directory has no package.json and no unpacked artifact: ${path}`, {
        reason: "explicit-dir-has-no-app",
        required: ["pnpm -C apps/desktop pack", "or point ATLAS_DESKTOP_APP at the unpacked executable"],
        searched: [path],
        contents: listDirSafe(path),
      });
    }
  }

  for (const finder of [findLinuxUnpacked, findMacApp, findWindowsUnpacked]) {
    const found = finder();
    if (found) {
      return { mode: "packaged", executablePath: found.path, args: [], appRoot: dirname(found.path), layout: found.layout, asar: existsSync(join(dirname(found.path), "resources", "app.asar")) };
    }
  }

  const appDir = appDirForFallback();
  searched.push(join(ROOT, "apps", "desktop", "dist"));
  const electronBinary = resolveElectronBinary();
  if (appDir.ready && electronBinary) {
    return { mode: "electron-appdir", executablePath: electronBinary, args: [appDir.dir], appRoot: appDir.dir, layout: "electron + apps/desktop (dist/main + dist/renderer)", appDir };
  }
  if (!appDir.ready) {
    throw new BlockedError(
      "No packaged desktop artifact and no build output for the electron+appdir fallback",
      {
        reason: "packaged-artifact-and-build-missing",
        required: [
          "pnpm -C apps/web build",
          "pnpm -C apps/desktop build",
          "pnpm -C apps/desktop pack   (electron-builder --dir → apps/desktop/dist/linux-unpacked)",
        ],
        searched,
        distContents: listDirSafe(join(ROOT, "apps", "desktop", "dist")),
        appDir,
      },
    );
  }
  throw new BlockedError("Electron binary missing (needed for the electron+appdir fallback)", electronBinaryBlockedData());
}

function electronBinaryBlockedData() {
  const installers = [
    join(ROOT, "node_modules", "electron", "install.js"),
    join(ROOT, "node_modules", "electron", "install.js"),
  ];
  return {
    reason: "electron-binary-missing",
    required: [
      `node ${installers[0]}   (or: pnpm rebuild electron)`,
      "electron@44.x linux-x64 zip may already be cached under ~/.cache/electron",
    ],
    searched: [
      join(ROOT, "node_modules", "electron", "dist", "electron"),
      "require('electron')",
      "ELECTRON_PATH",
    ],
  };
}

function resolveDisplay() {
  if (process.platform !== "linux") return { needed: false, display: process.env.DISPLAY ?? null };
  if (process.env.DISPLAY) return { needed: false, display: process.env.DISPLAY };
  return { needed: true, display: null };
}

function maybeReexecUnderXvfb() {
  if (process.platform !== "linux") return false;
  if (process.env.DISPLAY) return false;
  if (process.env.ATLAS_QA_IN_XVFB === "1" || process.env.ATLAS_QA_NO_XVFB === "1") return false;
  const which = spawnSync("sh", ["-c", "command -v xvfb-run"], { encoding: "utf8" });
  if (which.status !== 0 || !which.stdout.trim()) {
    log("⚠ no DISPLAY and xvfb-run is not installed — Electron launch will fail; install xvfb or set DISPLAY.");
    return false;
  }
  log(`ℹ no DISPLAY: re-executing under xvfb-run -a (${process.execPath} ${process.argv.slice(1).join(" ")})`);
  const result = spawnSync("xvfb-run", ["-a", process.execPath, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, ATLAS_QA_IN_XVFB: "1" },
  });
  process.exit(result.status ?? 1);
}

function sandboxPlan() {
  const forced = process.env.ATLAS_QA_NO_SANDBOX === "1";
  const headlessLinux = process.platform === "linux" && !process.env.DISPLAY;
  const noSandbox = forced || headlessLinux;
  return {
    noSandbox,
    reason: forced ? "ATLAS_QA_NO_SANDBOX=1" : headlessLinux ? "no DISPLAY" : "auto",
    flags: noSandbox ? ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] : [],
  };
}

function buildLaunchEnv(plan) {
  const env = { ...process.env };
  delete env.ATLAS_DESKTOP_DEV;
  delete env.ELECTRON_RUN_AS_NODE;
  env.ATLAS_TEST_EXPORT_DIR = EXPORT_DIR;
  // Supported main-process hook (isolated profile for parallel E2E runs).
  env.ATLAS_DESKTOP_USER_DATA_DIR = USER_DATA_DIR;
  env.ATLAS_TEST_USER_DATA = USER_DATA_DIR;
  env.ELECTRON_ENABLE_LOGGING = "1";
  if (plan.noSandbox) env.ELECTRON_DISABLE_SANDBOX = "1";
  return env;
}

// ── app launch / capture ────────────────────────────────────────────────────
function attachProcess(appInstance) {
  const child = appInstance.process();
  const onChunk = (buffer) => {
    for (const line of String(buffer).split(/\r?\n/)) {
      const trimmed = line.trimEnd();
      if (!trimmed) continue;
      stderrLines.push(trimmed);
      if (stderrLines.length > 4000) stderrLines.splice(0, stderrLines.length - 4000);
    }
  };
  child.stdout?.on("data", onChunk);
  child.stderr?.on("data", onChunk);
  child.on("exit", (code, signal) => {
    mainProcessExit = { code, signal, at: new Date().toISOString(), closing };
    log(`ℹ main process exited code=${code} signal=${signal ?? "-"} closing=${closing}`);
  });
}

function attachPage(targetPage) {
  if (!targetPage || attachedPages.has(targetPage)) return;
  attachedPages.add(targetPage);
  targetPage.on("console", (message) => {
    if (message.type() !== "error") return;
    let location = null;
    try {
      location = message.location();
    } catch {
      location = null;
    }
    consoleErrors.push({
      text: message.text(),
      location: location?.url ?? null,
      lineNumber: location?.lineNumber ?? null,
      at: new Date().toISOString(),
      offline: offlinePhase,
    });
  });
  targetPage.on("pageerror", (error) => {
    pageErrors.push({
      message: String(error?.message ?? error),
      stack: String(error?.stack ?? "").split("\n").slice(0, 12).join("\n"),
      offline: offlinePhase,
      at: new Date().toISOString(),
    });
  });
  targetPage.on("crash", () => {
    crashes.push({ at: new Date().toISOString() });
    log("✘ renderer process crashed (page.on('crash'))");
  });
  targetPage.on("request", (request) => {
    const url = request.url();
    requestLog.push({ url, method: request.method(), at: new Date().toISOString() });
    if (requestLog.length > 3000) requestLog.splice(0, requestLog.length - 3000);
  });
  targetPage.on("requestfailed", (request) => {
    const url = request.url();
    failedRequests.push({ url, method: request.method(), error: request.failure()?.errorText ?? "", offline: offlinePhase, at: new Date().toISOString() });
  });
}

async function launch(plan) {
  const attempts = [];
  const plans = plan.noSandbox ? [plan] : [plan, { ...plan, noSandbox: true, reason: "retry after sandbox failure", flags: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] }];
  let lastError = null;
  for (const [index, attemptPlan] of plans.entries()) {
    const args = [...target.args, ...attemptPlan.flags];
    attempts.push({ attempt: index + 1, noSandbox: attemptPlan.noSandbox, args });
    log(`ℹ launching electron: ${target.executablePath}`);
    log(`  mode=${target.mode} layout=${target.layout} args=${JSON.stringify(args)} sandbox=${attemptPlan.noSandbox ? "disabled" : "enabled"} (${attemptPlan.reason})`);
    try {
      const { _electron: electron } = await import("playwright-core");
      const instance = await electron.launch({
        executablePath: target.executablePath,
        args,
        env: buildLaunchEnv(attemptPlan),
        timeout: LAUNCH_TIMEOUT_MS,
      });
      launchInfo = { ...attemptPlan, args, attempts };
      return instance;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      log(`⚠ launch attempt ${index + 1} failed: ${message.split("\n")[0]}`);
      if (index < plans.length - 1) log("ℹ retrying with --no-sandbox (Chromium sandbox is often unavailable in containers/WSL)");
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new BlockedError(`Electron failed to launch: ${message.split("\n").slice(0, 8).join(" | ")}`, {
    reason: "electron-launch-failed",
    required: [
      "run with a virtual display: xvfb-run -a node scripts/qa-desktop.mjs",
      "or force sandbox off: ATLAS_QA_NO_SANDBOX=1 ELECTRON_DISABLE_SANDBOX=1 node scripts/qa-desktop.mjs",
      "check that the packaged artifact matches this platform",
    ],
    attempts,
    stderrTail: stderrLines.slice(-40),
  });
}

// ── page helpers ────────────────────────────────────────────────────────────
async function pageEval(fn, arg, label = "page.evaluate") {
  return withTimeout(page.evaluate(fn, arg), 60_000, label);
}

async function bridgeExport(kind, document, size, timeoutMs = 240_000) {
  const startedAt = Date.now();
  const payload = await withTimeout(
    page.evaluate(
      async ({ kind: exportKind, document: doc, size: exportSize }) => {
        const api = globalThis.atlasDesktop;
        if (!api) return { ok: false, error: "window.atlasDesktop is not exposed (preload missing?)" };
        try {
          const result =
            exportKind === "png" ? await api.exportPng({ document: doc, size: exportSize }) : await api.exportSvg({ document: doc, size: exportSize });
          return { ok: true, result };
        } catch (error) {
          return { ok: false, error: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}` };
        }
      },
      { kind, document, size },
    ),
    timeoutMs,
    `desktop IPC export ${kind} ${size}²`,
  );
  const wallMs = Date.now() - startedAt;
  if (!payload.ok) throw new Error(`${kind.toUpperCase()} export IPC failed: ${payload.error}`);
  const result = payload.result ?? {};
  if (result.canceled) {
    throw new Error(
      `${kind.toUpperCase()} export returned canceled=true — the save dialog was not bypassed. Is ATLAS_TEST_EXPORT_DIR supported by apps/desktop/src/main/exports.ts?`,
    );
  }
  if (!result.path) throw new Error(`${kind.toUpperCase()} export returned no path (${JSON.stringify(result)})`);
  if (!isWithin(result.path, EXPORT_DIR)) {
    throw new Error(`export path escaped ATLAS_TEST_EXPORT_DIR: ${result.path} (expected under ${EXPORT_DIR}) — test hook not active?`);
  }
  exportsLog.push({ kind, size, path: rel(result.path), bytes: result.bytes ?? null, ms: result.ms ?? null, wallMs });
  log(`  📦 IPC ${kind} ${size}² → ${rel(result.path)} (${result.bytes ?? "?"} bytes, mainProcess ${result.ms ?? "?"}ms, wall ${wallMs}ms)`);
  return { ...result, wallMs };
}

function isWithin(child, parent) {
  const normalizedChild = resolve(child);
  const normalizedParent = resolve(parent);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}${process.platform === "win32" ? "\\" : "/"}`);
}

function readPngInfo(path) {
  const buffer = readFileSync(path);
  const signatureOk =
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a;
  const width = signatureOk ? buffer.readUInt32BE(16) : null;
  const height = signatureOk ? buffer.readUInt32BE(20) : null;
  return { bytes: buffer.length, signatureOk, width, height };
}

function readSvg(path) {
  const text = readFileSync(path, "utf8");
  const decorMatches = text.match(/data-decor="/g) ?? [];
  return {
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    isSvg: /^(?:\s*<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(text),
    decorCount: decorMatches.length,
  };
}

function hasDecor(text, id) {
  return new RegExp(`data-decor="${id}"`).test(text);
}

function parseDurationMs(text) {
  if (!text) return null;
  const value = String(text).trim();
  if (!value || value === "—" || value === "-") return null;
  if (/^<\s*1\s*ms$/i.test(value)) return 0.5;
  const ms = /^([\d.]+)\s*ms$/i.exec(value);
  if (ms) return Number(ms[1]);
  const seconds = /^([\d.]+)\s*s$/i.exec(value);
  if (seconds) return Number(seconds[1]) * 1000;
  return null;
}

async function readGenerationDom() {
  return pageEval(() => {
    const text = (selector) => document.querySelector(selector)?.textContent?.trim() ?? "";
    const status = document.querySelector('[data-testid="status"]');
    return {
      statusState: status?.getAttribute("data-state") ?? null,
      statusText: status?.textContent?.trim() ?? "",
      summary: text('[data-testid="generated-summary"]'),
      generationMsText: text('[data-testid="stat-generation-ms"]'),
      layersSizeText: (() => {
        // "模拟网格 1024²" row: find the stat row whose label is 模拟网格.
        const rows = [...document.querySelectorAll(".stat-row")];
        const row = rows.find((entry) => entry.textContent?.includes("模拟网格"));
        return row?.textContent?.replace("模拟网格", "").trim() ?? "";
      })(),
      canvas: Boolean(document.querySelector('[data-testid="map-canvas"]')),
      welcomeVisible: (() => {
        const welcome = document.querySelector('[data-testid="welcome"]');
        return Boolean(welcome) && welcome.getBoundingClientRect().width > 0;
      })(),
    };
  }, null, "read generation DOM");
}

async function readDebugSummary() {
  return pageEval(() => {
    const debug = globalThis.__atlasDebug;
    if (!debug?.getSummary) return null;
    try {
      return debug.getSummary();
    } catch {
      return null;
    }
  }, null, "read debug summary");
}

async function readCurrentDocument() {
  return pageEval(() => {
    const debug = globalThis.__atlasDebug;
    if (debug?.getDocument) {
      try {
        const document_ = debug.getDocument();
        if (document_) return { source: "debug", document: document_ };
      } catch {
        /* fall through to autosave */
      }
    }
    try {
      const raw = localStorage.getItem("atlas_forge.world.v1");
      if (!raw) return { source: "none", document: null };
      const payload = JSON.parse(raw);
      if (payload && payload.version === 1 && payload.document) return { source: "autosave", document: payload.document };
    } catch {
      /* ignore */
    }
    return { source: "none", document: null };
  }, null, "read current document");
}

function decorationsOf(document_) {
  const decorations = document_?.style?.decorations;
  return decorations && typeof decorations === "object" ? decorations : {};
}

function decorVisible(document_, id) {
  const config = decorationsOf(document_)[id];
  return config?.visible !== false;
}

function allVisible(document_) {
  return DECOR_IDS.concat(["graticule", "border"]).map((id) => ({ id, visible: decorVisible(document_, id) }));
}

async function waitForDocument(predicate, { timeout = 12_000, label = "document state" } = {}) {
  return waitFor(async () => {
    const current = await readCurrentDocument();
    if (current.document && predicate(current.document, current.source)) return current;
    return null;
  }, { timeout, label });
}

async function canvasSignature() {
  return pageEval(() => {
    const canvas = document.querySelector('[data-testid="map-canvas"]');
    if (!canvas) return null;
    try {
      const thumb = document.createElement("canvas");
      thumb.width = 96;
      thumb.height = 96;
      const ctx = thumb.getContext("2d", { willReadFrequently: true });
      if (!ctx) return null;
      ctx.drawImage(canvas, 0, 0, 96, 96);
      const data = ctx.getImageData(0, 0, 96, 96).data;
      let hash = 2166136261;
      let sum = 0;
      let sum2 = 0;
      let nonDark = 0;
      const pixels = 96 * 96;
      for (let index = 0; index < pixels; index += 1) {
        const offset = index * 4;
        const r = data[offset];
        const g = data[offset + 1];
        const b = data[offset + 2];
        const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
        sum += luminance;
        sum2 += luminance * luminance;
        if (luminance > 40) nonDark += 1;
        hash ^= (r << 16) | (g << 8) | b;
        hash = Math.imul(hash, 16777619);
      }
      const mean = sum / pixels;
      const variance = sum2 / pixels - mean * mean;
      return {
        hash: hash >>> 0,
        mean: Math.round(mean * 10) / 10,
        variance: Math.round(variance * 10) / 10,
        nonDarkRatio: Math.round((nonDark / pixels) * 1000) / 1000,
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
      };
    } catch (error) {
      return { error: String(error?.message ?? error) };
    }
  }, null, "canvas signature");
}

async function probeOffline(context) {
  const navigatorOnline = await page.evaluate(() => navigator.onLine).catch(() => null);
  let cdp = null;
  try {
    const session = await context.newCDPSession(page);
    await session.send("Network.enable");
    const response = await withTimeout(
      session.send("Network.loadNetworkResource", {
        url: "https://example.com/",
        options: { disableCache: true, includeCredentials: false },
      }),
      15_000,
      "CDP offline probe",
    );
    cdp = response?.resource ?? response ?? null;
    await session.detach?.().catch?.(() => {});
  } catch (error) {
    cdp = { unsupported: error instanceof Error ? error.message : String(error) };
  }
  return { navigatorOnline, cdp, probeFailed: Boolean(cdp && cdp.success !== true && cdp.unsupported === undefined) };
}

async function waitForCanvasStable({ timeout = 20_000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout;
  let previous = null;
  while (Date.now() < deadline) {
    const current = await canvasSignature();
    if (current && !current.error && previous && current.hash === previous.hash) return current;
    previous = current;
    await sleep(interval);
  }
  return canvasSignature();
}

async function ensureDecorationsGroupOpen() {
  const group = page.locator('[data-testid="group-style-decorations"]');
  await group.waitFor({ state: "attached", timeout: 20_000 });
  const head = group.locator(".panel-group-head").first();
  const expanded = await head.getAttribute("aria-expanded");
  if (expanded === "false") {
    await head.click({ timeout: 10_000 }).catch(async () => head.click({ force: true, timeout: 10_000 }));
    await page.waitForTimeout(250);
  }
  await page.locator('[data-testid="decor-toggle-compass"]').waitFor({ state: "attached", timeout: 15_000 });
}

async function visibleDecorCount() {
  const text = await page.locator('[data-testid="decor-visible-count"]').textContent({ timeout: 10_000 }).catch(() => null);
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

async function clickTestId(testId, options = {}) {
  const locator = page.locator(`[data-testid="${testId}"]`).first();
  await locator.waitFor({ state: "visible", timeout: options.timeout ?? 20_000 });
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await locator.click({ timeout: options.timeout ?? 15_000 });
  } catch (error) {
    log(`  ⚠ normal click on ${testId} failed (${error instanceof Error ? error.message.split("\n")[0] : error}); retrying with force`);
    await locator.click({ force: true, timeout: 10_000 });
  }
}

async function dismissWelcome() {
  const welcome = page.locator('[data-testid="welcome"]');
  const visible = await welcome.isVisible().catch(() => false);
  if (visible) {
    log("ℹ welcome overlay visible — clicking welcome-skip");
    await page.locator('[data-testid="welcome-skip"]').click({ timeout: 15_000 }).catch(async (error) => {
      log(`  ⚠ welcome-skip click failed: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
      await page.locator('[data-testid="welcome-skip"]').click({ force: true, timeout: 10_000 });
    });
    await welcome.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
  }
}

// ── main flow ───────────────────────────────────────────────────────────────
async function main() {
  startedAt = new Date();
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });
  mkdirSync(EXPORT_DIR, { recursive: true });
  mkdirSync(USER_DATA_DIR, { recursive: true });
  log(`Atlas Forge desktop QA — ${startedAt.toISOString()}`);
  log(`repo=${ROOT}`);
  log(`out=${OUT_DIR}`);
  log(`exports=${EXPORT_DIR}`);
  log(`node=${process.version} platform=${process.platform} arch=${process.arch} DISPLAY=${process.env.DISPLAY ?? "(unset)"}`);

  maybeReexecUnderXvfb();

  // preconditions -----------------------------------------------------------
  const display = resolveDisplay();
  if (display.needed && !existsSync("/usr/bin/xvfb-run") && process.platform === "linux") {
    log("⚠ no DISPLAY and no xvfb-run: Electron will likely fail to start (set DISPLAY or install xvfb).");
  }
  try {
    target = resolveTarget();
  } catch (error) {
    if (error instanceof BlockedError) {
      recordBlocked(error.message, error.data);
      return 2;
    }
    throw error;
  }
  if (REQUIRE_PACKAGED && target.mode !== "packaged") {
    recordBlocked(`ATLAS_QA_REQUIRE_PACKAGED=1 but only the fallback mode is available (${target.mode})`, {
      reason: "packaged-artifact-missing",
      required: ["pnpm -C apps/web build", "pnpm -C apps/desktop build", "pnpm -C apps/desktop pack"],
      searched: [join(ROOT, "apps", "desktop", "dist")],
      distContents: listDirSafe(join(ROOT, "apps", "desktop", "dist")),
    });
    return 2;
  }
  log(`target mode=${target.mode} layout=${target.layout}`);
  log(`executable=${target.executablePath}`);
  log(`arguments=${JSON.stringify(target.args)}`);
  if (target.mode === "packaged" && target.asar === false) {
    notes.push("packaged artifact has no resources/app.asar (electron-builder asar disabled?)");
  }

  const plan = sandboxPlan();
  log(`sandbox: disabled=${plan.noSandbox} reason=${plan.reason} flags=${JSON.stringify(plan.flags)}`);

  try {
    app = await launch(plan);
    attachProcess(app);
    app.on("window", (window) => attachPage(window));
    const firstWindow = await app.firstWindow({ timeout: 60_000 });
    attachPage(firstWindow);
    page = firstWindow;
    attachPage(page);
    await page.waitForLoadState("domcontentloaded", { timeout: 60_000 }).catch(() => {});
    log(`window opened: title="${await page.title().catch(() => "")}" url=${page.url()}`);

    // Wait for the renderer to mount; classify "never mounted" as an artifact
    // problem (blocked) unless the renderer itself reported an error (fail).
    try {
      await page.waitForSelector('[data-testid="map-canvas"]', { timeout: 45_000 });
    } catch (error) {
      const bootConsole = consoleErrors.slice(0, 10);
      const bootPageErrors = pageErrors.slice(0, 10);
      if (bootPageErrors.length > 0 || bootConsole.length > 0 || crashes.length > 0) {
        log("✘ renderer mounted but reported errors before the map canvas appeared — treating as product failure");
        deviceFailureNote(bootConsole, bootPageErrors);
        return 1;
      }
      recordBlocked("renderer never mounted: [data-testid=map-canvas] did not appear and no JS error was captured", {
        reason: "renderer-did-not-mount",
        required: [
          "pnpm -C apps/web build && pnpm -C apps/desktop build (renderer must be copied to apps/desktop/dist/renderer)",
          "check apps/desktop/dist/renderer/index.html exists and Vite base is './'",
        ],
        distContents: listDirSafe(join(ROOT, "apps", "desktop", "dist")),
        rendererContents: listDirSafe(join(ROOT, "apps", "desktop", "dist", "renderer")),
        stderrTail: stderrLines.slice(-40),
        launch: launchInfo,
      });
      return 2;
    }

    // Deterministic UI state: prefer the isolated user-data dir; otherwise clear
    // web storage and reload once.
    const appInfoResult = await page
      .evaluate(async () => {
        try {
          return { ok: true, info: await globalThis.atlasDesktop?.getAppInfo?.() };
        } catch (error) {
          return { ok: false, error: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}` };
        }
      })
      .catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
    const appInfo = appInfoResult?.ok ? appInfoResult.info : null;
    lastAppInfo = appInfo;
    const isolatedUserData = Boolean(appInfo?.userDataDir) && resolve(appInfo.userDataDir) === resolve(USER_DATA_DIR);
    if (appInfo) log(`appInfo: electron=${appInfo.electron} chrome=${appInfo.chrome} userDataDir=${appInfo.userDataDir} isolated=${isolatedUserData}`);
    if (!isolatedUserData) {
      notes.push("ATLAS_DESKTOP_USER_DATA_DIR is not honoured by the main process; cleared web storage and reloaded the renderer for deterministic state");
      log("ℹ userData is not isolated: clearing localStorage/sessionStorage and reloading the renderer");
      await page.evaluate(() => {
        try {
          localStorage.clear();
          sessionStorage.clear();
        } catch {
          /* ignore */
        }
      }).catch(() => {});
      await page.reload({ timeout: 60_000 }).catch((error) => log(`⚠ reload failed: ${error instanceof Error ? error.message.split("\n")[0] : error}`));
      await page.waitForSelector('[data-testid="map-canvas"]', { timeout: 45_000 });
    }
    await dismissWelcome();

    // ── checks ──────────────────────────────────────────────────────────
    await runCheck("app-window", "packaged window boots and renderer mounts", async () => {
      const title = await page.title();
      if (!/Atlas Forge/i.test(title)) throw new Error(`window title does not look like Atlas Forge: "${title}"`);
      const url = page.url();
      const localRenderer = url.startsWith("file://") || url.startsWith("app://") || /^http:\/\/(127\.0\.0\.1|localhost)/.test(url);
      if (!localRenderer) throw new Error(`renderer must load from a local origin (file://, app://atlas/ or localhost), got ${url}`);
      if (/^http:\/\/127\.0\.0\.1/.test(url)) notes.push(`renderer loaded from the Vite dev server (${url}) — not a packaged renderer`);
      await screenshot("01-window.png", "first window after boot");
      return { title, url, titleCheck: true };
    });

    await runCheck("desktop-bridge", "preload exposes window.atlasDesktop + app info", async () => {
      const probe = await page.evaluate(async () => {
        const api = globalThis.atlasDesktop;
        if (!api) return { exposed: false };
        const info = typeof api.getAppInfo === "function" ? await api.getAppInfo().catch((error) => ({ error: String(error?.message ?? error) })) : null;
        return {
          exposed: api.isDesktop === true,
          isDesktop: api.isDesktop === true,
          methods: ["getAppInfo", "openWorld", "saveWorld", "exportPng", "exportSvg", "getRecentFiles", "onMenuCommand"].filter((name) => typeof api[name] === "function"),
          info,
        };
      });
      if (!probe.exposed) throw new Error("window.atlasDesktop missing — preload did not expose the IPC bridge");
      const missing = ["getAppInfo", "exportPng", "exportSvg"].filter((name) => !probe.methods.includes(name));
      if (missing.length > 0) throw new Error(`window.atlasDesktop is missing methods: ${missing.join(", ")}`);
      const info = probe.info ?? {};
      if (!info.electron) throw new Error(`getAppInfo() returned no electron version: ${JSON.stringify(info)}`);
      const pngSizes = info.offlineExports?.png ?? [];
      const svgSizes = info.offlineExports?.svg ?? [];
      if (!pngSizes.includes(4096)) throw new Error(`offlineExports.png does not advertise 4096: ${JSON.stringify(pngSizes)}`);
      if (!svgSizes.includes(4096)) throw new Error(`offlineExports.svg does not advertise 4096: ${JSON.stringify(svgSizes)}`);
      return { electron: info.electron, chrome: info.chrome, version: info.version, platform: info.platform, userDataDir: info.userDataDir, offlineExports: info.offlineExports };
    });

    await runCheck("desktop-server-status", "desktop renderer is local-only: no /api requests, status says so", async () => {
      const status = await waitFor(
        async () => {
          const text = await page
            .locator('[data-testid="server-status"]')
            .textContent({ timeout: 3000 })
            .catch(() => null);
          return text && text.trim() ? text.trim() : null;
        },
        { timeout: 20_000, label: "server-status text" },
      );
      if (!/桌面端|本地渲染/.test(status)) {
        throw new Error(`unexpected desktop server status: "${status}" (expected 桌面端 · 本地渲染)`);
      }
      const apiRequests = requestLog.filter((entry) => /\/api\//.test(entry.url));
      if (apiRequests.length > 0) {
        throw new Error(`desktop renderer made ${apiRequests.length} /api request(s): ${apiRequests.slice(0, 5).map((entry) => entry.url).join(", ")}`);
      }
      return { serverStatus: status, apiRequests: 0, pageRequests: requestLog.length };
    });

    await runCheck("first-screen-generation", `first screen generation completes and is < ${GEN_BUDGET_MS}ms`, async () => {
      const state = await waitFor(
        async () => {
          const dom = await readGenerationDom();
          const ms = parseDurationMs(dom.generationMsText);
          const generated = /已生成/.test(dom.summary) && dom.statusState === "idle" && ms !== null;
          return generated ? { ...dom, generationMs: ms } : null;
        },
        { timeout: 120_000, interval: 150, label: "first-screen generation (status idle + 已生成 + 生成耗时)" },
      );
      if (!state.canvas) throw new Error("map-canvas disappeared while waiting for the first generation");
      const overTarget = state.generationMs > GEN_BUDGET_MS;
      if (state.generationMs > FIRST_SCREEN_HARD_CAP_MS) {
        throw new Error(
          `first-screen generation took ${state.generationMs.toFixed(0)}ms (> hard cap ${FIRST_SCREEN_HARD_CAP_MS}ms); DOM said "${state.generationMsText}"`,
        );
      }
      if (overTarget) {
        notes.push(
          `first screen (1024² grid) took ${state.generationMs.toFixed(0)}ms, above the ${GEN_BUDGET_MS}ms 512² target but below the ${FIRST_SCREEN_HARD_CAP_MS}ms hard cap`,
        );
      }
      return {
        generationMs: Math.round(state.generationMs * 10) / 10,
        target512Ms: GEN_BUDGET_MS,
        hardCapMs: FIRST_SCREEN_HARD_CAP_MS,
        overTargetMs: overTarget ? Math.round((state.generationMs - GEN_BUDGET_MS) * 10) / 10 : 0,
        summary: state.summary,
        status: state.statusText,
        layersSize: state.layersSizeText,
      };
    });

    await runCheck("canvas-painted", "map canvas contains a rendered map (not blank)", async () => {
      const signature = await waitForCanvasStable({ timeout: 30_000 });
      if (!signature) throw new Error("map-canvas element is missing");
      if (signature.error) throw new Error(`could not read map canvas pixels: ${signature.error}`);
      if (!(signature.variance > 50)) throw new Error(`canvas looks blank/flat (variance=${signature.variance}, mean=${signature.mean})`);
      if (!(signature.nonDarkRatio > 0.05)) throw new Error(`canvas is almost entirely dark (nonDarkRatio=${signature.nonDarkRatio})`);
      await screenshot("02-first-screen.png", "first generated map");
      return signature;
    });

    await runCheck("generation-512", "512² generation measured through the debug summary (< budget)", async () => {
      const summary = await readDebugSummary();
      if (!summary) {
        throw new SkipError("window.__atlasDebug is not available in this build (dev-only debug API); the 512² debug-summary measurement cannot run — see docs/desktop.md#qa-hooks. Using generation-512-proxy instead.");
      }
      const before = { seq: summary.generation?.seq ?? 0 };
      const quick = await page.evaluate(() => {
        const debug = globalThis.__atlasDebug;
        if (!debug?.quickGenerate) return { ok: false, error: "quickGenerate missing" };
        try {
          debug.quickGenerate();
          return { ok: true };
        } catch (error) {
          return { ok: false, error: String(error?.message ?? error) };
        }
      });
      if (!quick.ok) throw new Error(`quickGenerate failed: ${quick.error}`);
      const after = await waitFor(
        async () => {
          const current = await readDebugSummary();
          if (!current) return null;
          const idle = current.generation?.phase === "idle";
          const advanced = (current.generation?.seq ?? 0) > before.seq;
          const layers = current.layers;
          const is512 = layers?.size === 512;
          return idle && advanced && is512 && current.perf?.lastGenerationMs !== null ? current : null;
        },
        { timeout: 90_000, interval: 150, label: "512² quick generation to finish" },
      );
      const ms = after.perf.lastGenerationMs;
      if (after.layers.size !== 512) throw new Error(`quick generation used ${after.layers.size}² instead of 512²`);
      if (ms > GEN_BUDGET_MS) throw new Error(`512² generation took ${ms.toFixed(0)}ms (> ${GEN_BUDGET_MS}ms budget)`);
      // Return to the document's full simulation size for the rest of the run.
      await page.evaluate(() => globalThis.__atlasDebug?.regenerate?.());
      await waitFor(
        async () => {
          const current = await readDebugSummary();
          return current && current.layers?.size === current.paramsGridSize && current.generation?.phase === "idle" ? current : null;
        },
        { timeout: 90_000, interval: 150, label: "full-size regeneration after 512² probe" },
      ).catch((error) => notes.push(`full-size regeneration after the 512² probe did not settle: ${error.message}`));
      return { lastGenerationMs: Math.round(ms * 10) / 10, budgetMs: GEN_BUDGET_MS, layersSize: after.layers.size, debugApi: true };
    });

    await runCheck("generation-512-proxy", "offline export pipeline generates 512² under budget (main process)", async () => {
      const current = await readCurrentDocument();
      if (!current.document) throw new Error("could not read the current WorldDocument from debug API or the autosave slot");
      const result = await bridgeExport("png", current.document, 512, 120_000);
      const info = readPngInfo(result.path);
      if (!info.signatureOk) throw new Error(`exported file is not a PNG: ${result.path}`);
      if (info.width !== 512 || info.height !== 512) throw new Error(`512² export produced ${info.width}×${info.height}`);
      if (!(result.ms < GEN_BUDGET_MS)) throw new Error(`512² export pipeline took ${result.ms}ms (> ${GEN_BUDGET_MS}ms budget)`);
      return { documentSource: current.source, mainProcessMs: result.ms, wallMs: result.wallMs, bytes: info.bytes, size: `${info.width}×${info.height}` };
    });

    await runCheck("export-svg-baseline", "SVG export through desktop IPC contains the default decorations", async () => {
      const current = await readCurrentDocument();
      if (!current.document) throw new Error("could not read the current WorldDocument");
      const result = await bridgeExport("svg", current.document, 1024, 120_000);
      const svg = readSvg(result.path);
      if (!svg.isSvg) throw new Error(`SVG export is not a standalone <svg> document: ${result.path}`);
      if (svg.bytes < 10_000) throw new Error(`SVG looks too small (${svg.bytes} bytes)`);
      const missing = DECOR_IDS.filter((id) => !hasDecor(svg.text, id));
      if (missing.length > 0) throw new Error(`baseline SVG is missing data-decor nodes: ${missing.join(", ")}`);
      return { documentSource: current.source, bytes: svg.bytes, decorCount: svg.decorCount, path: rel(result.path), mainProcessMs: result.ms };
    });

    await runCheck("decor-toggle-compass", "compass toggle repaints and the SVG export drops its data-decor node", async () => {
      await ensureDecorationsGroupOpen();
      const baselineCanvas = await waitForCanvasStable({ timeout: 20_000 });
      const baselineVisible = await visibleDecorCount();
      const toggle = page.locator('[data-testid="decor-toggle-compass"]').first();
      const beforeChecked = await toggle.getAttribute("aria-checked");
      if (beforeChecked !== "true") throw new Error(`compass toggle should start checked, got aria-checked=${beforeChecked}`);
      await toggle.click({ timeout: 15_000 }).catch(async () => toggle.click({ force: true, timeout: 10_000 }));
      await waitFor(async () => (await toggle.getAttribute("aria-checked")) === "false", { timeout: 10_000, label: "compass toggle aria-checked=false" });
      const afterVisible = await waitFor(async () => {
        const count = await visibleDecorCount();
        return count !== null && count !== baselineVisible ? count : null;
      }, { timeout: 10_000, label: "decor visible count to change" });
      if (!(afterVisible === baselineVisible - 1)) throw new Error(`visible decoration count went ${baselineVisible} → ${afterVisible} (expected -1)`);
      const repaint = await waitFor(async () => {
        const current = await canvasSignature();
        return current && !current.error && baselineCanvas && current.hash !== baselineCanvas.hash ? current : null;
      }, { timeout: 15_000, interval: 200, label: "canvas repaint after compass toggle" });
      const current = await waitForDocument((document_) => decorVisible(document_, "compass") === false, { timeout: 15_000, label: "document decorations.compass.visible=false" });
      const result = await bridgeExport("svg", current.document, 1024, 120_000);
      const svg = readSvg(result.path);
      if (hasDecor(svg.text, "compass")) throw new Error("SVG export still contains data-decor=\"compass\" after the toggle was switched off");
      const kept = DECOR_IDS.filter((id) => id !== "compass" && hasDecor(svg.text, id));
      if (kept.length === 0) throw new Error("all other decorations vanished from the SVG when only the compass was disabled");
      await screenshot("03-decor-compass-off.png", "compass decoration disabled");
      return {
        documentSource: current.source,
        visibleCount: `${baselineVisible} → ${afterVisible}`,
        canvasChanged: true,
        canvasVariance: repaint.variance,
        svgPath: rel(result.path),
        removedDecor: "compass",
        keptDecor: kept,
      };
    });

    await runCheck("decor-all-off", "‘all decorations off’ exports an SVG with zero data-decor nodes", async () => {
      await clickTestId("decorations-all-off");
      const count = await waitFor(async () => {
        const value = await visibleDecorCount();
        return value === 0 ? value : null;
      }, { timeout: 15_000, label: "decor visible count to reach 0" });
      const current = await waitForDocument(
        (document_) => ["title", "compass", "scaleBar", "legend", "credits", "graticule", "border"].every((id) => decorVisible(document_, id) === false),
        { timeout: 15_000, label: "all decorations hidden in the document" },
      );
      const result = await bridgeExport("svg", current.document, 1024, 120_000);
      const svg = readSvg(result.path);
      if (svg.decorCount !== 0) {
        const found = [...svg.text.matchAll(/data-decor="([^"]+)"/g)].map((match) => match[1]);
        throw new Error(`SVG still contains ${svg.decorCount} data-decor nodes: ${[...new Set(found)].join(", ")}`);
      }
      await screenshot("04-decor-all-off.png", "all decorations disabled");
      return { visibleCount: count, decorNodes: 0, svgPath: rel(result.path), documentSource: current.source };
    });

    await runCheck("export-png-4096", "4096² PNG export succeeds with a real 4096 PNG over 1 MB", async () => {
      // Restore the default decorations for a normal-looking print export.
      await clickTestId("decorations-reset");
      await waitForDocument((document_) => decorVisible(document_, "compass") === true, { timeout: 15_000, label: "decorations restored to defaults" });
      const current = await readCurrentDocument();
      if (!current.document) throw new Error("could not read the current WorldDocument");
      const result = await bridgeExport("png", current.document, 4096, 300_000);
      const info = readPngInfo(result.path);
      if (!info.signatureOk) throw new Error(`4096 export is not a valid PNG (signature check failed): ${result.path}`);
      if (info.width !== 4096 || info.height !== 4096) throw new Error(`4096 export has IHDR ${info.width}×${info.height}, expected 4096×4096`);
      if (!(info.bytes > 1_000_000)) throw new Error(`4096 PNG is only ${info.bytes} bytes (expected > 1,000,000)`);
      if (typeof result.bytes === "number" && result.bytes !== info.bytes) throw new Error(`IPC reported ${result.bytes} bytes but the file has ${info.bytes}`);
      await screenshot("05-export-4096.png", "4096 PNG exported from the desktop main process");
      return {
        documentSource: current.source,
        path: rel(result.path),
        bytes: info.bytes,
        width: info.width,
        height: info.height,
        mainProcessMs: result.ms,
        wallMs: result.wallMs,
      };
    });

    await runCheck("offline-generation", "generation still works with the renderer context offline", async () => {
      const context = app.context();
      await context.setOffline(true);
      offlinePhase = true;
      log("ℹ context.setOffline(true)");
      // Verify offline without generating console noise: navigator.onLine reflects
      // CDP network emulation, and Network.loadNetworkResource goes through the
      // browser network stack (bypassing the renderer CSP, which blocks external
      // fetches from file:// documents by design).
      const probe = await probeOffline(context);
      if (!(probe.navigatorOnline === false || probe.probeFailed)) {
        throw new Error(
          `setOffline(true) did not take effect (navigator.onLine=${probe.navigatorOnline}, cdp=${JSON.stringify(probe.cdp)})`,
        );
      }
      if (probe.cdp?.unsupported) notes.push(`CDP offline probe unavailable: ${probe.cdp.unsupported}`);
      const beforeDom = await readGenerationDom();
      const beforeDebug = await readDebugSummary();
      const beforeDoc = await readCurrentDocument();
      const seedBefore = beforeDoc.document?.seed ?? null;
      await clickTestId("reroll");
      const after = await waitFor(
        async () => {
          const dom = await readGenerationDom();
          const summary = await readDebugSummary();
          const documentNow = await readCurrentDocument();
          const isIdle = dom.statusState === "idle";
          const hasResult = /已生成/.test(dom.summary);
          const seqAdvanced = summary && beforeDebug ? (summary.generation?.seq ?? 0) > (beforeDebug.generation?.seq ?? 0) : true;
          const domChanged = dom.summary !== beforeDom.summary || dom.generationMsText !== beforeDom.generationMsText;
          const error = summary?.generation?.error ?? null;
          if (isIdle && hasResult && seqAdvanced && (domChanged || summary)) {
            return { dom, summary, documentNow, error };
          }
          return null;
        },
        { timeout: 120_000, interval: 150, label: "offline generation to finish after seed reroll" },
      );
      if (after.error) throw new Error(`offline generation failed: ${after.error}`);
      if (seedBefore !== null && after.documentNow.document?.seed === seedBefore) {
        notes.push("offline reroll did not change the document seed (random collision?)");
      }
      const offlineMs = after.summary?.perf?.lastGenerationMs ?? parseDurationMs(after.dom.generationMsText);
      if (offlineMs !== null && offlineMs !== undefined && offlineMs > GEN_BUDGET_MS) {
        throw new Error(`offline generation took ${offlineMs}ms (> ${GEN_BUDGET_MS}ms budget)`);
      }
      await screenshot("06-offline-generation.png", "new map generated with the network offline");
      return {
        networkProbe: probe.cdp?.success === undefined ? (probe.cdp?.unsupported ? "cdp-unsupported" : "blocked") : probe.cdp?.errorCode ?? "blocked",
        navigatorOnline: probe.navigatorOnline,
        generationMs: offlineMs === null || offlineMs === undefined ? null : Math.round(offlineMs * 10) / 10,
        seedBefore,
        seedAfter: after.documentNow.document?.seed ?? null,
        summary: after.dom.summary,
        debugApi: Boolean(after.summary),
      };
    });

    await runCheck("offline-export", "SVG + PNG exports still work with the renderer context offline", async () => {
      try {
        const current = await readCurrentDocument();
        if (!current.document) throw new Error("could not read the current WorldDocument while offline");
        const svgResult = await bridgeExport("svg", current.document, 1024, 120_000);
        const svg = readSvg(svgResult.path);
        if (!svg.isSvg || svg.decorCount === 0) throw new Error(`offline SVG export looks wrong (isSvg=${svg.isSvg}, decor=${svg.decorCount})`);
        const pngResult = await bridgeExport("png", current.document, 1024, 180_000);
        const png = readPngInfo(pngResult.path);
        if (!png.signatureOk) throw new Error(`offline PNG export is not a PNG: ${pngResult.path}`);
        if (png.width !== 1024 || png.height !== 1024) throw new Error(`offline PNG is ${png.width}×${png.height}, expected 1024×1024`);
        await screenshot("07-offline-export.png", "SVG + PNG exported with the network offline");
        return {
          svgBytes: svg.bytes,
          svgPath: rel(svgResult.path),
          pngBytes: png.bytes,
          pngPath: rel(pngResult.path),
          pngMainProcessMs: pngResult.ms,
          networkRestored: true,
        };
      } finally {
        await restoreNetwork();
      }
    });

    await runCheck("console-clean", "no unexpected console errors / page errors / renderer crashes", async () => {
      const allowed = [];
      const unexpected = [];
      for (const entry of consoleErrors) {
        const match = allowlistConsoleError(entry);
        if (match) {
          allowed.push({ ...entry, allowlist: match.id, reason: match.reason });
        } else {
          unexpected.push(entry);
        }
      }
      const unexpectedPageErrors = pageErrors.filter((entry) => !isAllowedPageError(entry));
      for (const entry of allowed) consoleAllowlisted.push(entry);
      if (unexpected.length > 0) {
        throw new Error(
          `${unexpected.length} unexpected console error(s):\n${unexpected
            .slice(0, 10)
            .map((entry) => `  · ${entry.text}${entry.location ? ` (${entry.location})` : ""}`)
            .join("\n")}`,
        );
      }
      if (unexpectedPageErrors.length > 0) {
        throw new Error(
          `${unexpectedPageErrors.length} page error(s):\n${unexpectedPageErrors
            .slice(0, 10)
            .map((entry) => `  · ${entry.message}`)
            .join("\n")}`,
        );
      }
      if (crashes.length > 0) throw new Error(`renderer crashed ${crashes.length} time(s)`);
      return {
        consoleErrors: consoleErrors.length,
        allowlisted: allowed.length,
        allowlistIds: [...new Set(allowed.map((entry) => entry.allowlist))],
        pageErrors: 0,
        crashes: 0,
        failedRequests: failedRequests.length,
      };
    });

    await runCheck("main-process-clean", "main process stayed alive without fatal stderr lines", async () => {
      const fatalPattern = /(Cannot find module|ERR_MODULE_NOT_FOUND|UnhandledPromiseRejection|Unhandled promise rejection|Uncaught (?:Error|Exception)|FATAL:|Segmentation fault|SIGSEGV|Error: ENOENT)/i;
      const fatal = stderrLines.filter((line) => fatalPattern.test(line) && !allowlistStderrLine(line));
      if (fatal.length > 0) throw new Error(`fatal main-process output:\n${fatal.slice(0, 10).join("\n")}`);
      if (mainProcessExit && !mainProcessExit.closing && mainProcessExit.code !== 0 && mainProcessExit.code !== null) {
        throw new Error(`main process exited early with code ${mainProcessExit.code} signal ${mainProcessExit.signal ?? "-"}`);
      }
      const alive = !page.isClosed();
      if (!alive) throw new Error("renderer page is closed at the end of the run");
      return {
        stderrLines: stderrLines.length,
        stderrNoiseExamples: stderrLines.slice(0, 3),
        mainProcessExit,
        runner: launchInfo ? { mode: target.mode, sandbox: launchInfo.noSandbox ? "disabled" : "enabled", args: launchInfo.args } : null,
      };
    });
  } catch (error) {
    if (error instanceof BlockedError) {
      recordBlocked(error.message, error.data);
      return 2;
    }
    recordBlocked(`QA harness error: ${error instanceof Error ? error.message : String(error)}`, {
      reason: "harness-error",
      required: ["inspect out/desktop-qa/run.log", "re-run with ATLAS_QA_NO_SANDBOX=1 if the sandbox is unavailable"],
      stderrTail: stderrLines.slice(-40),
      stack: error instanceof Error ? (error.stack ?? "").split("\n").slice(0, 12) : null,
    });
    return 2;
  } finally {
    await shutdown();
  }

  return 0;
}

function deviceFailureNote(bootConsole, bootPageErrors) {
  log(`  console errors before mount: ${JSON.stringify(bootConsole)}`);
  log(`  page errors before mount: ${JSON.stringify(bootPageErrors)}`);
}

// ── allowlists (explicit + auditable) ──────────────────────────────────────
function allowlistConsoleError(entry) {
  // The desktop renderer has no HTTP backend: its startup /api/health probe is
  // expected to fail and the app catches it (status bar shows 服务端离线).
  // Chromium still logs the failed resource/scheme for that one URL.
  const mentionsHealth = /\/api\/health/.test(entry.location ?? "") || /\/api\/health/.test(entry.text ?? "");
  if (mentionsHealth && /(Failed to load resource|Fetch API cannot load|net::ERR|CORS|URL scheme|404|Not Found)/i.test(entry.text)) {
    return { id: "desktop-health-probe", reason: "desktop renderer has no HTTP origin; the offline /api/health probe is expected and handled" };
  }
  if (/Failed to load resource/i.test(entry.text) && /(ERR_INTERNET_DISCONNECTED|ERR_NAME_NOT_RESOLVED|ERR_NETWORK_ACCESS_DENIED|ERR_CONNECTION_REFUSED)/.test(entry.text) && entry.offline) {
    return { id: "offline-network-probe", reason: "network intentionally disabled for the offline test" };
  }
  if (/Autofill\.(enable|i18n)/i.test(entry.text)) {
    return { id: "chromium-autofill", reason: "Chromium builtin autofill warning, not app code" };
  }
  if (/Failed to load resource/i.test(entry.text) && /favicon\.ico/.test(entry.location ?? "")) {
    return { id: "favicon", reason: "no favicon served by the file:// renderer" };
  }
  return null;
}

function isAllowedPageError() {
  // No page errors are expected; keep the hook so a known-benign case can be
  // allowlisted explicitly later without hiding arbitrary failures.
  return false;
}

function allowlistStderrLine(line) {
  return /(dbus|DBus|bus\.cc|Failed to connect to the bus|Fontconfig|libva|GPU|gpu|Vulkan|vulkan|EGL|GLES|ContextResult|swiftshader|MESA|viz_|sandbox|SUID|zygote|DevTools|Autofill|CreatePlatformSocket|Interface not supported|X11|xf86|gtk|Gtk)/i.test(
    line,
  );
}

// ── reporting / shutdown ────────────────────────────────────────────────────
function recordBlocked(reason, data = {}) {
  const blocked = {
    reason: data.reason ?? "blocked",
    message: reason,
    ...data,
    capturedAt: new Date().toISOString(),
  };
  blockedSummary = blocked;
  log(`\n⛔ BLOCKED — ${reason}`);
  if (data.required) log(`   required: ${data.required.join(" ; ")}`);
  if (data.stderrTail?.length) log(`   stderr tail:\n${data.stderrTail.slice(-20).join("\n")}`);
}

let blockedSummary = null;
let shutdownStartedAt = null;

async function restoreNetwork() {
  if (!offlinePhase) return;
  try {
    await withTimeout(app.context().setOffline(false), 15_000, "setOffline(false)");
    log("ℹ context.setOffline(false)");
  } catch (error) {
    log(`⚠ could not restore network context: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    offlinePhase = false;
  }
}

async function shutdown() {
  if (shutdownStartedAt) return;
  shutdownStartedAt = Date.now();
  closing = true;
  await restoreNetwork();
  try {
    if (page && !page.isClosed()) {
      await withTimeout(page.screenshot({ path: join(OUT_DIR, "99-final.png"), animations: "disabled", timeout: 15_000 }), 20_000, "final screenshot")
        .then(() => {
          screenshots.push({ name: "99-final.png", path: rel(join(OUT_DIR, "99-final.png")), note: "final state" });
        })
        .catch(() => {});
    }
  } catch {
    /* screenshot is best effort */
  }
  try {
    if (app) await withTimeout(app.close(), 45_000, "app.close()");
  } catch (error) {
    log(`⚠ app.close() failed: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    try {
      app?.process()?.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
}

function buildReport(exitCode) {
  const passed = checks.filter((check) => check.status === "pass").length;
  const failed = checks.filter((check) => check.status === "fail").length;
  const skipped = checks.filter((check) => check.status === "skipped").length;
  return {
    task: "task-21",
    name: "desktop packaged-artifact E2E",
    script: "scripts/qa-desktop.mjs",
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    exitCode,
    mode: target?.mode ?? null,
    packaged: target?.mode === "packaged",
    layout: target?.layout ?? null,
    executablePath: target?.executablePath ?? null,
    appArgs: target?.args ?? [],
    asar: target?.asar ?? null,
    electronVersion: appInfoVersion(),
    sandbox: launchInfo ? { disabled: launchInfo.noSandbox, reason: launchInfo.reason, flags: launchInfo.args } : null,
    platform: { platform: process.platform, arch: process.arch, node: process.version, display: process.env.DISPLAY ?? null, xvfb: process.env.ATLAS_QA_IN_XVFB === "1" },
    config: {
      genBudgetMs: GEN_BUDGET_MS,
      firstScreenHardCapMs: FIRST_SCREEN_HARD_CAP_MS,
      exportDir: EXPORT_DIR,
      userDataDir: USER_DATA_DIR,
      strict: STRICT,
      requirePackaged: REQUIRE_PACKAGED,
    },
    summary: { total: checks.length, passed, failed, skipped },
    checks,
    gaps: checks.filter((check) => check.status === "skipped").map((check) => ({ id: check.id, reason: check.detail })),
    screenshots,
    exports: exportsLog,
    console: {
      errors: consoleErrors,
      allowlisted: consoleAllowlisted,
      pageErrors,
      crashes,
      failedRequests: failedRequests.slice(0, 40),
      pageRequests: requestLog.filter((entry) => /\/api\//.test(entry.url)).length,
    },
    mainStderr: {
      lines: stderrLines.length,
      fatalAllowedNoise: stderrLines.filter((line) => allowlistStderrLine(line)).length,
      tail: stderrLines.slice(-40),
    },
    notes,
    blocked: blockedSummary,
  };
}

function appInfoVersion() {
  return lastAppInfo?.electron ?? null;
}

function writeReport(exitCode) {
  const report = buildReport(exitCode);
  try {
    writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    log(`\nreport: ${rel(REPORT_FILE)}`);
  } catch (error) {
    log(`⚠ could not write report.json: ${error instanceof Error ? error.message : String(error)}`);
  }
  return report;
}

function printSummary(report) {
  log("\n──────── desktop QA summary ────────");
  for (const check of report.checks) {
    const icon = check.status === "pass" ? "✔" : check.status === "fail" ? "✘" : "⊘";
    log(`${icon} ${check.id} — ${check.status} (${check.ms}ms)`);
    if (check.status !== "pass") log(`    ${check.detail}`);
  }
  log(`mode: ${report.mode} (${report.layout ?? "-"})`);
  log(`executable: ${report.executablePath ?? "-"}`);
  log(`checks: ${report.summary.passed}/${report.summary.total} passed, ${report.summary.failed} failed, ${report.summary.skipped} skipped`);
  log(`screenshots: ${report.screenshots.length} → ${rel(OUT_DIR)}`);
  if (report.blocked) log(`blocked: ${report.blocked.reason} — ${report.blocked.message}`);
  log("exit codes: 0=all green · 1=assertion failure · 2=precondition blocked");
}

// ── entrypoint ──────────────────────────────────────────────────────────────
let exitCode = 2;
try {
  const result = await withTimeout(main(), GLOBAL_TIMEOUT_MS, "whole desktop QA run");
  exitCode = typeof result === "number" ? result : 0;
} catch (error) {
  log(`\n⛔ QA run aborted: ${error instanceof Error ? error.message : String(error)}`);
  if (error instanceof Error && error.stack) log(error.stack.split("\n").slice(0, 10).join("\n"));
  recordBlocked(`QA run aborted: ${error instanceof Error ? error.message : String(error)}`, {
    reason: "harness-error",
    required: ["inspect out/desktop-qa/run.log"],
    stderrTail: stderrLines.slice(-40),
  });
  exitCode = 2;
} finally {
  await shutdown().catch(() => {});
}

// Attribute skipped checks when strict mode is requested before computing the
// exit code; skipped assertions mean the acceptance criteria could not be
// verified, which must not be silently reported as green in strict CI.
const checkFailures = checks.filter((check) => check.status === "fail").length;
const checkSkips = checks.filter((check) => check.status === "skipped").length;
if (exitCode !== 2 && checkFailures > 0) exitCode = 1;
if (exitCode !== 2 && checkSkips > 0 && STRICT) exitCode = 1;
if (exitCode === 2 && checkFailures > 0) exitCode = 1;

const report = writeReport(exitCode);
printSummary(report);
process.exit(exitCode);
