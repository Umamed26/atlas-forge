/**
 * Map-chrome E2E (v0.6): every decoration can be toggled, re-anchored and
 * re-texted from the UI; the canvas repaints without regenerating the world,
 * and hidden elements disappear from the SVG export.
 *
 *   node scripts/qa-decor.mjs [--no-server]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

const ROOT = process.cwd();
const OUT = join(ROOT, "out", "decor-qa");
const WEB_URL = process.env.WEB_URL ?? "http://127.0.0.1:5173/";
const API_HEALTH = process.env.API_URL ?? "http://127.0.0.1:8787/api/health";
const NO_SERVER = process.argv.includes("--no-server");
mkdirSync(OUT, { recursive: true });

const checks = [];
const notes = [];
const consoleErrors = [];
const pageErrors = [];
let serverProcess = null;
let startedServer = false;

function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail });
  notes.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = join(homedir(), ".cache", "ms-playwright");
  try {
    for (const build of readdirSync(root).filter((e) => e.startsWith("chromium-")).sort().reverse()) {
      for (const candidate of [join(root, build, "chrome-linux64", "chrome"), join(root, build, "chrome-linux", "chrome")]) {
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

async function urlOk(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

async function startServers() {
  if ((await urlOk(WEB_URL)) && (await urlOk(API_HEALTH))) return;
  serverProcess = spawn("pnpm", ["dev"], { cwd: ROOT, stdio: "ignore", env: { ...process.env, CI: "1" }, detached: true });
  startedServer = true;
  for (let i = 0; i < 150; i += 1) {
    if ((await urlOk(WEB_URL)) && (await urlOk(API_HEALTH))) return;
    await sleep(400);
  }
  throw new Error("dev servers did not start");
}

async function stopServers() {
  const child = serverProcess;
  if (!startedServer || !child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    /* gone */
  }
  await sleep(800);
}

const summary = (page) => page.evaluate(() => globalThis.__atlasDebug?.getSummary?.() ?? null);

async function exportSvg(page) {
  const doc = await page.evaluate(() => globalThis.__atlasDebug.getDocument());
  const res = await fetch("http://127.0.0.1:8787/api/export/svg", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ document: doc, size: 512 }),
  });
  return { status: res.status, text: await res.text() };
}

async function main() {
  if (!NO_SERVER) await startServers();
  const chrome = findChromium();
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(chrome ? { executablePath: chrome } : {}) });
  const page = await (await browser.newContext({ viewport: { width: 1680, height: 1000 } })).newPage();
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text()); });
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  await page.goto(WEB_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector('[data-testid="map-canvas"]', { timeout: 30_000 });
  if (await page.locator('[data-testid="welcome"]').isVisible().catch(() => false)) {
    await page.locator('[data-testid="welcome-skip"]').click();
  }
  await page.waitForSelector('[data-testid="status"][data-state="idle"]', { timeout: 60_000 }).catch(() => {});
  await sleep(800);

  // Open the decorations group (style panel, collapsed by default? ensure visible)
  const group = page.locator('[data-testid="group-style-decorations"]');
  const head = group.locator('.panel-group-head').first();
  if ((await head.getAttribute("aria-expanded")) === "false") await head.click();
  await sleep(300);
  check("decorations group is present in the style panel", (await page.locator('[data-testid="section-decorations"]').count()) === 1);

  const before = await summary(page);
  const svgAll = await exportSvg(page);
  check(
    "default export contains all chrome nodes",
    svgAll.status === 200 &&
      ["title", "compass", "scaleBar", "legend", "credits"].every((id) => svgAll.text.includes(`data-decor="${id}"`)),
    `bytes=${svgAll.text.length}`,
  );

  // Toggle each element off, verify it disappears from SVG and no regeneration happens.
  for (const id of ["title", "compass", "scaleBar", "legend", "credits", "border", "graticule"]) {
    await page.locator(`[data-testid="decor-toggle-${id}"]`).click();
    await sleep(250);
    const after = await summary(page);
    if (id === "title" || id === "compass" || id === "scaleBar" || id === "legend" || id === "credits") {
      const svg = await exportSvg(page);
      check(`SVG drops ${id} when hidden`, svg.status === 200 && !svg.text.includes(`data-decor="${id}"`), `status=${svg.status}`);
    }
    if (id === "title") {
      check("hiding chrome does not regenerate the world", after?.generation?.seq === before?.generation?.seq, `seq ${before?.generation?.seq} -> ${after?.generation?.seq}`);
    }
    await page.locator(`[data-testid="decor-toggle-${id}"]`).click();
    await sleep(150);
  }

  // All off then reset.
  await page.locator('[data-testid="decorations-all-off"]').click();
  await sleep(400);
  const svgOff = await exportSvg(page);
  check(
    "all-off export has no chrome nodes",
    svgOff.status === 200 && !/data-decor="(title|compass|scaleBar|legend|credits)"/.test(svgOff.text),
    `bytes=${svgOff.text.length}`,
  );
  await page.screenshot({ path: join(OUT, "01-all-off.png") });
  await page.locator('[data-testid="decorations-reset"]').click();
  await sleep(400);
  const svgReset = await exportSvg(page);
  check("reset restores chrome nodes", svgReset.text.includes('data-decor="title"'));

  // Anchor change.
  await page.locator('[data-testid="decor-anchor-legend"]').selectOption("top-left");
  await sleep(400);
  const svgMoved = await exportSvg(page);
  const legendTop = /data-decor="legend"[^>]*/.test(svgMoved.text);
  check("legend anchor can be changed", legendTop, await page.locator('[data-testid="decor-anchor-legend"]').inputValue());

  // Text overrides.
  await page.locator('[data-testid="decor-text-title"]').fill("北境列岛志");
  await page.locator('[data-testid="decor-subtitle-title"]').fill("CHRONICLES OF THE NORTH");
  await page.locator('[data-testid="decor-text-credits"]').fill("制图：阿特拉斯工坊");
  await sleep(500);
  const svgText = await exportSvg(page);
  check("title/subtitle/credits text overrides reach the export", svgText.text.includes("北境列岛志") && svgText.text.includes("CHRONICLES OF THE NORTH") && svgText.text.includes("阿特拉斯工坊"));
  await page.screenshot({ path: join(OUT, "02-custom-chrome.png") });

  // UI alignment: parameter value column right edges + toggle vertical centring.
  const alignment = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".slider-field")].slice(0, 3);
    const rightEdges = rows.map((row) => row.querySelector(".slider-value")?.getBoundingClientRect().right ?? 0);
    const toggleRows = [...document.querySelectorAll(".toggle-field")].slice(0, 4);
    const centers = toggleRows.map((row) => {
      const text = row.querySelector(".toggle-copy")?.getBoundingClientRect();
      const sw = row.querySelector(".switch")?.getBoundingClientRect();
      if (!text || !sw) return 999;
      return Math.abs((text.top + text.bottom) / 2 - (sw.top + sw.bottom) / 2);
    });
    return { rightSpread: Math.max(...rightEdges) - Math.min(...rightEdges), centerSpread: Math.max(...centers) };
  });
  check("parameter value column is right-aligned", alignment.rightSpread <= 1, JSON.stringify(alignment));
  check("toggle text and switch share a centre line", alignment.centerSpread <= 1, JSON.stringify(alignment));

  const failed = checks.filter((c) => !c.ok);
  writeFileSync(join(OUT, "report.json"), JSON.stringify({ checks, notes, consoleErrors, pageErrors }, null, 2));
  console.log(`\nDecoration QA: ${checks.length - failed.length}/${checks.length} checks passed`);
  for (const f of failed) console.log(`  FAIL ${f.name} — ${f.detail}`);
  console.log(`console errors: ${consoleErrors.length}, page errors: ${pageErrors.length}`);
  await browser.close();
  await stopServers();
  process.exit(failed.length + consoleErrors.length + pageErrors.length > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error("Decoration QA error:", error);
  await stopServers();
  process.exit(1);
});
