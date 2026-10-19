#!/usr/bin/env node
/**
 * Launch the Electron shell.
 *
 *   node scripts/dev.mjs             # HMR renderer from the Vite dev server
 *   node scripts/dev.mjs --packaged  # built renderer from dist/renderer (file://)
 *
 * The dev server (pnpm dev / pnpm dev:web -> http://127.0.0.1:5173) is expected to
 * be started by the caller; this script waits for it and reports a clear timeout
 * instead of launching Electron against a dead URL.
 *
 * Environment:
 *   ATLAS_WEB_URL                 dev server URL (default http://127.0.0.1:5173/)
 *   ATLAS_DESKTOP_DEV_TIMEOUT_MS  readiness timeout (default 60000)
 *   ATLAS_DESKTOP_NO_SANDBOX=1    append --no-sandbox (headless CI / WSL only)
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = dirname(HERE);
const DIST_DIR = join(APP_DIR, "dist");

const argv = process.argv.slice(2);
const packaged = argv.includes("--packaged");
const skipBuild = argv.includes("--no-build");
const noSandbox = process.env.ATLAS_DESKTOP_NO_SANDBOX === "1";
const devServerUrl = process.env.ATLAS_WEB_URL ?? "http://127.0.0.1:5173/";
const devServerTimeoutMs = Number(process.env.ATLAS_DESKTOP_DEV_TIMEOUT_MS ?? 60_000);

/**
 * Resolve the Electron executable without triggering Electron's download helper
 * (`require("electron")` runs install.js when path.txt is missing). CI installs the
 * real binary; this checkout may only have dist/ linked, so fall back to it.
 */
function resolveElectronBinary() {
  const executableName = process.platform === "win32" ? "electron.exe" : "electron";
  const override = process.env.ELECTRON_OVERRIDE_DIST_PATH;

  let packageDir;
  try {
    packageDir = dirname(require.resolve("electron/package.json"));
  } catch (error) {
    throw new Error(`[dev] cannot resolve the electron package: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (override) {
    const overridePath = join(override, executableName);
    if (existsSync(overridePath)) return overridePath;
    throw new Error(`[dev] electron binary missing at ${overridePath} (ELECTRON_OVERRIDE_DIST_PATH)`);
  }

  const pathFile = join(packageDir, "path.txt");
  if (existsSync(pathFile)) {
    const relative = readFileSync(pathFile, "utf8").trim();
    if (relative) {
      const candidate = join(packageDir, "dist", relative);
      if (existsSync(candidate)) return candidate;
    }
  }

  const fallback = join(packageDir, "dist", executableName);
  if (existsSync(fallback)) return fallback;

  throw new Error(
    `[dev] electron binary missing at ${fallback}\n` +
      `[dev] run "pnpm install" (or "node node_modules/electron/install.js") so the Electron distribution is present.`,
  );
}

function buildMainAndPreload() {
  console.log("[dev] building main + preload bundles...");
  const result = spawnSync(process.execPath, [join(HERE, "build.mjs"), "--no-assets"], {
    cwd: APP_DIR,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`[dev] build failed with exit code ${result.status ?? "unknown"}`);
}

async function waitForDevServer(url) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < devServerTimeoutMs) {
    try {
      // Any HTTP response means the dev server is listening (it may still be
      // compiling the first module graph; that is fine, Electron will reload).
      const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(2000) });
      console.log(`[dev] Vite dev server ready at ${url} (HTTP ${response.status})`);
      return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `[dev] timed out after ${devServerTimeoutMs}ms waiting for ${url}\n` +
      `[dev] start the web dev server first ("pnpm dev" or "pnpm dev:web") or set ATLAS_WEB_URL.\n` +
      `[dev] last error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}

async function main() {
  const electronBinary = resolveElectronBinary();
  if (!skipBuild) buildMainAndPreload();

  if (!existsSync(join(DIST_DIR, "main", "main.js"))) {
    throw new Error(`[dev] missing ${join(DIST_DIR, "main", "main.js")} after build`);
  }

  if (packaged) {
    const index = join(DIST_DIR, "renderer", "index.html");
    if (!existsSync(index)) {
      throw new Error(`[dev] --packaged needs ${index}; run "pnpm desktop:build" first.`);
    }
  } else {
    await waitForDevServer(devServerUrl);
  }

  const args = [];
  if (noSandbox) {
    console.warn("[dev] ATLAS_DESKTOP_NO_SANDBOX=1 -> launching with --no-sandbox (local/CI only)");
    args.push("--no-sandbox");
  }
  args.push(APP_DIR);

  const env = { ...process.env };
  if (packaged) {
    delete env.ATLAS_DESKTOP_DEV;
    delete env.ATLAS_WEB_URL;
  } else {
    env.ATLAS_DESKTOP_DEV = "1";
    env.ATLAS_WEB_URL = devServerUrl;
  }

  console.log(`[dev] electron: ${electronBinary}`);
  console.log(`[dev] app dir:  ${APP_DIR}`);
  console.log(`[dev] renderer: ${packaged ? "dist/renderer (file://)" : devServerUrl}`);

  const child = spawn(electronBinary, args, { cwd: APP_DIR, env, stdio: "inherit" });
  let stopping = false;

  const forwardSignal = (signal, exitCode) => {
    if (stopping) return;
    stopping = true;
    if (!child.killed) child.kill(signal);
    setTimeout(() => process.exit(exitCode), 3000).unref();
  };
  process.on("SIGINT", () => forwardSignal("SIGINT", 130));
  process.on("SIGTERM", () => forwardSignal("SIGTERM", 143));

  child.on("error", (error) => {
    console.error("[dev] failed to spawn electron:", error);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`[dev] electron terminated by signal ${signal}`);
      process.exit(1);
    }
    console.log(`[dev] electron exited with code ${code ?? 0}`);
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
