/**
 * ui-dev self-QA harness (Playwright + Chromium from ~/.cache/ms-playwright).
 *
 * Drives the real app at http://127.0.0.1:5173/, exercises the required flows
 * (generate → param → brushes → undo/redo → zoom → JSON/PNG export → autosave
 * reload → JSON import → dialogs), captures screenshots and fails on console
 * errors / failed assertions.
 *
 * Usage:
 *   node apps/web/scripts/qa-ui.mjs                     # expects dev servers already running
 *   WEB_URL=http://127.0.0.1:5173/ node apps/web/scripts/qa-ui.mjs
 *
 * Output: out/ui-qa/*.png + out/ui-qa/report.json
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { chromium } from "playwright-core";

const WEB_URL = process.env.WEB_URL ?? "http://127.0.0.1:5173/";
const CHROME =
  process.env.CHROME_PATH ??
  join(homedir(), ".cache", "ms-playwright", "chromium-1243", "chrome-linux64", "chrome");
const OUT = join(process.cwd(), "out", "ui-qa");
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, "run.log");
writeFileSync(LOG, "");

const consoleErrors = [];
const httpErrors = [];
const pageErrors = [];
const failedRequests = [];
const assertions = [];
const notes = [];

const crashChecks = [];

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  appendFileSync(LOG, line + "\n");
  console.log(line);
}

function check(name, ok, detail = "") {
  assertions.push({ name, ok: Boolean(ok), detail });
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ""}`);
}

async function screenshot(page, name) {
  const file = join(OUT, name);
  await page.screenshot({ path: file });
  notes.push(`screenshot ${file}`);
}

async function summary(page) {
  return page.evaluate(() => window.__atlasDebug?.getSummary() ?? null);
}

async function waitIdle(page, timeout = 90_000) {
  await page.waitForFunction(
    () => {
      const api = window.__atlasDebug;
      if (!api) return false;
      const s = api.getSummary();
      return (
        s.ready &&
        s.generation.phase !== "generating" &&
        s.generation.phase !== "queued" &&
        !s.render.rendering
      );
    },
    undefined,
    { timeout, polling: 120 },
  );
}

async function setRange(page, testId, value) {
  const selector = `[data-testid="${testId}"]`;
  const locator = page.locator(selector).first();
  await locator.evaluate((element, nextValue) => {
    element.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }),
    );
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(element, String(nextValue));
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    element.dispatchEvent(
      new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 }),
    );
  }, value);
}

async function dragOnCanvas(page, points, steps = 6) {
  const box = await page.locator('[data-testid="map-canvas"]').boundingBox();
  if (!box) throw new Error("map canvas has no bounding box");
  const start = points[0];
  const toScreen = (p) => ({
    x: box.x + p[0] * box.width,
    y: box.y + p[1] * box.height,
  });
  const first = toScreen(start);
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  for (let i = 1; i < points.length; i += 1) {
    const target = toScreen(points[i]);
    await page.mouse.move(target.x, target.y, { steps });
    await sleep(20);
  }
  await page.mouse.up();
}

async function clickCanvas(page, normalized) {
  const box = await page.locator('[data-testid="map-canvas"]').boundingBox();
  if (!box) throw new Error("map canvas has no bounding box");
  await page.mouse.click(
    box.x + normalized[0] * box.width,
    box.y + normalized[1] * box.height,
  );
}

async function main() {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none", "--hide-scrollbars"],
  });
  const context = await browser.newContext({
    viewport: { width: 1680, height: 1000 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") {
      const location = message.location();
      const entry = `${message.text()}${location.url ? ` @ ${location.url}` : ""}`;
      consoleErrors.push(entry);
      log(`BROWSER ERROR: ${entry}`);
    }
  });
  context.on("response", (response) => {
    if (response.status() >= 400) httpErrors.push(`${response.status()} ${response.url()}`);
  });
  page.on("pageerror", (error) => {
    pageErrors.push(String(error));
    log(`PAGE ERROR: ${String(error)}`);
  });
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (!url.includes("favicon") && request.failure()) {
      failedRequests.push(`${request.method()} ${url} :: ${request.failure()?.errorText}`);
    }
  });

  await page.goto(WEB_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector('[data-testid="map-canvas"]', { timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.__atlasDebug), undefined, { timeout: 20_000 });
  // Deterministic start: drop any autosave left by earlier manual runs.
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="map-canvas"]', { timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.__atlasDebug), undefined, { timeout: 20_000 });
  log("initial generation");
  await waitIdle(page);
  await sleep(300);
  await screenshot(page, "01-initial.png");

  // ── 1. layout & required test ids ───────────────────────────────────
  const layout = await page.evaluate(() => {
    const required = [
      "map-canvas",
      "brush-overlay",
      "generate",
      "seed-input",
      "reroll",
      "param-seaLevel",
      "style-showLabels",
      "style-showGraticule",
      "tool-elevation",
      "tool-river",
      "tool-biome",
      "undo",
      "redo",
      "export-png",
      "export-json",
      "import-json",
      "status",
      "statusbar",
    ];
    const missing = required.filter(
      (id) => document.querySelectorAll(`[data-testid="${id}"]`).length === 0,
    );
    const offenders = [...document.querySelectorAll("body *")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && (rect.right > window.innerWidth + 1 || rect.left < -1);
      })
      .slice(0, 5)
      .map((element) => `${element.tagName}.${element.className?.toString().slice(0, 40)}`);
    const head = document.querySelector(".stage-head")?.getBoundingClientRect();
    const wrap = document.querySelector(".stage-wrap")?.getBoundingClientRect();
    const zoom = document.querySelector('[data-testid="zoom-in"]')?.getBoundingClientRect();
    const hint = document.querySelector('[data-testid="tool-hint"]');
    const panels = [...document.querySelectorAll(".panel-scroll")].map((element) => ({
      overflowY: getComputedStyle(element).overflowY,
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
    }));
    const scrollingElement = document.scrollingElement;
    const pageScrollYPx = scrollingElement
      ? scrollingElement.scrollHeight - window.innerHeight
      : -1;
    const scrollHints = {
      params: Boolean(document.querySelector('[data-testid="params-scroll-hint"]')),
      style: Boolean(document.querySelector('[data-testid="style-scroll-hint"]')),
    };
    return {
      missing,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      offenders,
      title: document.title,
      toolbarOverlapsCanvas: Boolean(head && wrap && head.bottom > wrap.top + 1),
      zoomVisible: Boolean(
        zoom && zoom.right <= window.innerWidth && zoom.top >= 0 && zoom.bottom <= window.innerHeight,
      ),
      hintOpacity: hint ? Number(getComputedStyle(hint).opacity) : null,
      canvas: wrap ? { width: wrap.width, height: wrap.height } : null,
      panels,
      pageScrollYPx,
      scrollHints,
    };
  });
  check("required data-testids present", layout.missing.length === 0, layout.missing.join(","));
  check(
    "no horizontal overflow at 1680×1000",
    layout.scrollWidth <= layout.innerWidth && layout.offenders.length === 0,
    `scrollWidth=${layout.scrollWidth} viewport=${layout.innerWidth} offenders=${layout.offenders.join(" | ")}`,
  );
  const initial = await summary(page);
  check("initial generation ready", initial?.ready === true, `land=${initial?.layers?.landFraction}`);
  check("canvas painted", (await page.evaluate(() => Boolean(window.__atlasDebug.getSummary().render.baseVersion > 0))) === true);
  const fontState = await page.evaluate(async () => {
    try {
      await document.fonts.load('16px "EB Garamond"');
    } catch {
      // ignore
    }
    return {
      ebGaramond: document.fonts.check('16px "EB Garamond"'),
      loadedFaces: [...document.fonts].map((face) => `${face.family}:${face.style}:${face.status}`),
    };
  });
  check(
    "EB Garamond registered for the preview renderer",
    fontState.ebGaramond === true,
    JSON.stringify(fontState.loadedFaces),
  );
  check(
    "toolbar sits above the canvas (does not cover the cartouche)",
    layout.toolbarOverlapsCanvas === false,
    `overlap=${layout.toolbarOverlapsCanvas}`,
  );
  check(
    "zoom control visible in canvas top-right",
    layout.zoomVisible === true,
  );
  await page
    .waitForFunction(
      () => {
        const hint = document.querySelector('[data-testid="tool-hint"]');
        return hint ? Number(getComputedStyle(hint).opacity) < 0.05 : false;
      },
      undefined,
      { timeout: 6_000, polling: 100 },
    )
    .catch(() => {});
  const hintOpacity = await page.evaluate(() => {
    const hint = document.querySelector('[data-testid="tool-hint"]');
    return hint ? Number(getComputedStyle(hint).opacity) : null;
  });
  check(
    "fading tool hint becomes transparent after ~2s",
    hintOpacity !== null && hintOpacity < 0.05,
    `opacity=${hintOpacity}`,
  );
  check(
    "page itself does not scroll vertically",
    layout.pageScrollYPx <= 1,
    `overflow=${layout.pageScrollYPx}px`,
  );
  check(
    "both panels show a visible scroll-for-more affordance",
    layout.scrollHints.params === true && layout.scrollHints.style === true,
    JSON.stringify(layout.scrollHints),
  );
  check(
    "both side panels scroll independently",
    layout.panels.length === 2 &&
      layout.panels.every((panel) => panel.overflowY === "auto" || panel.overflowY === "overlay") &&
      layout.panels.every((panel) => panel.scrollHeight > panel.clientHeight),
    JSON.stringify(layout.panels),
  );
  check(
    "canvas fills the available stage height",
    Boolean(layout.canvas && layout.canvas.height > 700),
    `canvas=${JSON.stringify(layout.canvas)}`,
  );
  const bottomControlReachable = await page.evaluate(() => {
    const panel = document.querySelector(".panel--style .panel-scroll");
    if (!panel) return { ok: false, reason: "no style panel scroll container" };
    panel.scrollTop = panel.scrollHeight;
    const target = document.querySelector('[data-testid="style-coastHatching"]');
    if (!target) return { ok: false, reason: "coastHatching slider missing" };
    const rect = target.getBoundingClientRect();
    return {
      ok: rect.top >= 0 && rect.bottom <= window.innerHeight,
      rect: { top: rect.top, bottom: rect.bottom },
      panel: { clientHeight: panel.clientHeight, scrollHeight: panel.scrollHeight },
    };
  });
  await sleep(250);
  const hintGone = await page.evaluate(
    () => document.querySelector('[data-testid="style-scroll-hint"]') === null,
  );
  check(
    "bottom style slider is reachable by scrolling the panel",
    bottomControlReachable.ok === true,
    JSON.stringify(bottomControlReachable),
  );
  check("scroll hint disappears at panel bottom", hintGone);
  await page.evaluate(() => {
    const panel = document.querySelector(".panel--style .panel-scroll");
    if (panel) panel.scrollTop = 0;
  });

  // ── 2. style toggle only re-renders ─────────────────────────────────
  const beforeStyle = await summary(page);
  await page.locator('[data-testid="style-showGraticule"]').click();
  await page.waitForFunction(
    (version) => window.__atlasDebug.getSummary().render.baseVersion > version,
    beforeStyle.render.baseVersion,
    { timeout: 30_000, polling: 100 },
  );
  await waitIdle(page);
  const afterStyle = await summary(page);
  check(
    "style toggle re-renders without re-simulating",
    afterStyle.generation.seq === beforeStyle.generation.seq &&
      afterStyle.render.baseVersion > beforeStyle.render.baseVersion,
    `seq ${beforeStyle.generation.seq}->${afterStyle.generation.seq}, baseVersion ${beforeStyle.render.baseVersion}->${afterStyle.render.baseVersion}`,
  );
  await screenshot(page, "02-style-toggle.png");

  // ── 3. parameter slider triggers regeneration ──────────────────────
  const beforeParam = await summary(page);
  log("parameter slider");
  const generatingSeen = page.waitForFunction(
    () => document.querySelector('[data-testid="status"]')?.dataset.state === "generating",
    undefined,
    { timeout: 8_000, polling: 30 },
  );
  await setRange(page, "param-seaLevel", 0.52);
  let sawGenerating = true;
  await generatingSeen.catch(() => {
    sawGenerating = false;
  });
  await waitIdle(page);
  const afterParam = await summary(page);
  check("status exposes data-state=generating while busy", sawGenerating);
  check(
    "parameter slider triggers regeneration",
    afterParam.generation.seq > beforeParam.generation.seq,
    `seq ${beforeParam.generation.seq} -> ${afterParam.generation.seq}`,
  );
  check(
    "parameter change is undoable",
    afterParam.history.undo > beforeParam.history.undo,
    `undo stack ${beforeParam.history.undo} -> ${afterParam.history.undo}`,
  );
  await screenshot(page, "03-params.png");

  // ── naming language (new WorldParams field) ─────────────────────────
  log("naming language");
  const beforeNaming = await summary(page);
  await page.locator('[data-testid="param-namingLanguage"]').selectOption("latin");
  await waitIdle(page);
  const latinSummary = await summary(page);
  const latinLabels = await page.evaluate(() => {
    const layers = window.__atlasDebug.getLayers();
    return (layers?.autoLabels ?? []).map((label) => label.text).slice(0, 24);
  });
  check(
    "namingLanguage select regenerates with latin names",
    latinSummary.generation.seq > beforeNaming.generation.seq &&
      latinSummary.namingLanguage === "latin" &&
      latinLabels.length > 0 &&
      latinLabels.every((text) => !/[\u4e00-\u9fff]/.test(text)),
    `seq ${beforeNaming.generation.seq}->${latinSummary.generation.seq}, labels=${JSON.stringify(latinLabels.slice(0, 6))}`,
  );
  await page.locator('[data-testid="param-namingLanguage"]').selectOption("cjk");
  await waitIdle(page);
  const cjkLabels = await page.evaluate(() => {
    const layers = window.__atlasDebug.getLayers();
    return (layers?.autoLabels ?? []).map((label) => label.text).slice(0, 24);
  });
  check(
    "namingLanguage cjk produces Chinese names",
    cjkLabels.length > 0 && cjkLabels.every((text) => /[\u4e00-\u9fff]/.test(text)),
    JSON.stringify(cjkLabels.slice(0, 6)),
  );
  await page.locator('[data-testid="param-namingLanguage"]').selectOption("auto");
  await waitIdle(page);
  check(
    "namingLanguage auto round-trips",
    (await summary(page)).namingLanguage === "auto",
  );

  // worker must reuse the same pipeline instance so stage caches apply
  log("pipeline cache reuse");
  await page.locator('[data-testid="generate"]').click();
  await waitIdle(page);
  const firstRegen = await summary(page);
  await page.locator('[data-testid="generate"]').click();
  await waitIdle(page);
  const secondRegen = await summary(page);
  check(
    "same-document regeneration hits worker stage cache",
    secondRegen.generation.durationMs !== null &&
      firstRegen.generation.durationMs !== null &&
      secondRegen.generation.durationMs < 300 ||
      secondRegen.generation.durationMs < firstRegen.generation.durationMs * 0.6,
    `${firstRegen.generation.durationMs}ms -> ${secondRegen.generation.durationMs}ms`,
  );

  // ── 4. elevation brush + undo/redo ─────────────────────────────────
  log("elevation brush");
  await page.locator('[data-testid="tool-elevation"]').click();
  const beforeElevation = await summary(page);
  await dragOnCanvas(
    page,
    [
      [0.3, 0.52],
      [0.38, 0.48],
      [0.46, 0.54],
      [0.54, 0.5],
    ],
    8,
  );
  await waitIdle(page);
  const afterElevation = await summary(page);
  check(
    "elevation brush writes normalized stamps",
    afterElevation.overrides.elevation > beforeElevation.overrides.elevation,
    `stamps ${beforeElevation.overrides.elevation} -> ${afterElevation.overrides.elevation}`,
  );
  const firstStamp = await page.evaluate(() => {
    const stamp = window.__atlasDebug.getDocument().overrides.elevation[0];
    return stamp
      ? { x: stamp.x, y: stamp.y, radius: stamp.radius, mode: stamp.mode, value: stamp.value }
      : null;
  });
  check(
    "first stamp is in normalized world coordinates",
    Boolean(
      firstStamp &&
        firstStamp.x >= 0 &&
        firstStamp.x <= 1 &&
        firstStamp.y >= 0 &&
        firstStamp.y <= 1 &&
        firstStamp.radius > 0,
    ),
    JSON.stringify(firstStamp),
  );
  await screenshot(page, "04-elevation.png");

  await page.keyboard.press("Control+z");
  await waitIdle(page);
  const afterUndo = await summary(page);
  check(
    "Ctrl+Z undoes one brush stroke",
    afterUndo.overrides.elevation === beforeElevation.overrides.elevation,
    `stamps ${afterElevation.overrides.elevation} -> ${afterUndo.overrides.elevation}`,
  );
  await page.keyboard.press("Control+Shift+z");
  await waitIdle(page);
  const afterRedo = await summary(page);
  check(
    "Ctrl+Shift+Z redoes the stroke",
    afterRedo.overrides.elevation === afterElevation.overrides.elevation,
    `stamps ${afterUndo.overrides.elevation} -> ${afterRedo.overrides.elevation}`,
  );

  // ── 5. forced river drafting (2 clicks + Enter) ────────────────────
  log("river drafting");
  await page.locator('[data-testid="tool-river"]').click();
  await sleep(150);
  for (const point of [
    [0.32, 0.32],
    [0.45, 0.45],
    [0.58, 0.58],
  ]) {
    await clickCanvas(page, point);
    await sleep(160);
  }
  const draft = await summary(page);
  const draftCountVisible = await page.locator('[data-testid="river-draft-count"]').count();
  check("river tool options visible", draftCountVisible === 1, `locator count=${draftCountVisible}`);
  const draftText = await page.locator('[data-testid="river-draft-count"]').innerText();
  check(
    "river tool collects draft nodes",
    draftText.includes("3"),
    `draft="${draftText}", tool=${draft.tool}`,
  );
  await page.keyboard.press("Enter");
  await waitIdle(page);
  const afterRiver = await summary(page);
  check(
    "Enter commits forced river into riverForce",
    afterRiver.overrides.rivers >= 1 && afterRiver.riverForce[0]?.points === 3,
    JSON.stringify(afterRiver.riverForce),
  );
  await screenshot(page, "05-river.png");

  // ── 6. biome painting ───────────────────────────────────────────────
  await page.locator('[data-testid="tool-biome"]').click();
  await page.locator('[data-testid="biome-select"]').selectOption("9");
  const beforeBiome = await summary(page);
  await dragOnCanvas(
    page,
    [
      [0.3, 0.3],
      [0.4, 0.38],
      [0.5, 0.32],
    ],
    6,
  );
  await waitIdle(page);
  const afterBiome = await summary(page);
  check(
    "biome brush writes biome stamps",
    afterBiome.overrides.biome > beforeBiome.overrides.biome,
    `stamps ${beforeBiome.overrides.biome} -> ${afterBiome.overrides.biome}`,
  );
  await screenshot(page, "06-biome.png");

  // ── 6b. overrides survive seed changes; returning restores exactly ──
  log("seed round-trip with overrides");
  const beforeSeed = await summary(page);
  const originalSeed = beforeSeed.seed;
  await page.locator('[data-testid="reroll"]').click();
  await waitIdle(page);
  const rerolled = await summary(page);
  check(
    "reroll keeps brush overrides on the document",
    rerolled.seed !== originalSeed &&
      rerolled.overrides.elevation === beforeSeed.overrides.elevation &&
      rerolled.overrides.rivers === beforeSeed.overrides.rivers &&
      rerolled.overrides.biome === beforeSeed.overrides.biome,
    `seed ${originalSeed}->${rerolled.seed}, overrides ${rerolled.overrides.total}`,
  );
  const seedInput = page.locator('[data-testid="seed-input"]');
  await seedInput.fill(String(originalSeed));
  await seedInput.press("Enter");
  await waitIdle(page);
  const restored = await summary(page);
  check(
    "returning to the original seed restores the same world with edits",
    restored.seed === originalSeed &&
      Math.abs((restored.layers?.landFraction ?? 0) - (beforeSeed.layers?.landFraction ?? -1)) < 1e-9 &&
      restored.overrides.elevation === beforeSeed.overrides.elevation,
    `seed=${restored.seed}, land=${restored.layers?.landFraction}`,
  );

  // ── 7. pan / zoom without regeneration ─────────────────────────────
  await page.locator('[data-testid="tool-pan"]').click();
  const beforeZoom = await summary(page);
  const box = await page.locator('[data-testid="map-canvas"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -800);
  await sleep(250);
  const afterZoom = await summary(page);
  check(
    "wheel zoom changes view without regenerating",
    afterZoom.view.scale > beforeZoom.view.scale &&
      afterZoom.generation.seq === beforeZoom.generation.seq,
    `scale ${beforeZoom.view.scale.toFixed(3)} -> ${afterZoom.view.scale.toFixed(3)}, seq ${beforeZoom.generation.seq} -> ${afterZoom.generation.seq}`,
  );
  await screenshot(page, "07-zoom.png");
  await page.locator('[data-testid="zoom-fit"]').click();
  await sleep(200);
  const afterFit = await summary(page);
  check("fit button resets zoom", Math.abs(afterFit.view.scale - beforeZoom.view.scale) < 0.02, `scale=${afterFit.view.scale.toFixed(3)}`);

  // ── 8. JSON export ──────────────────────────────────────────────────
  const jsonDownloadPromise = page.waitForEvent("download", { timeout: 20_000 });
  await page.locator('[data-testid="export-json"]').click();
  const jsonDownload = await jsonDownloadPromise;
  const jsonPath = join(OUT, "exported.world.json");
  await jsonDownload.saveAs(jsonPath);
  const exported = JSON.parse(readFileSync(jsonPath, "utf8"));
  const exportedSummary = await summary(page);
  check(
    "JSON export has version=1 and matches document",
    exported.version === 1 &&
      exported.seed === exportedSummary.seed &&
      exported.overrides.elevation.length === exportedSummary.overrides.elevation &&
      exported.overrides.riverForce.length === exportedSummary.overrides.rivers,
    `seed=${exported.seed} elev=${exported.overrides.elevation.length} rivers=${exported.overrides.riverForce.length} biome=${exported.overrides.biome.length}`,
  );

  // ── 9. local PNG export via dialog ─────────────────────────────────
  await page.locator('[data-testid="export-png"]').click();
  await page.waitForSelector('[data-testid="export-dialog"]', { timeout: 10_000 });
  await screenshot(page, "08-export-dialog.png");
  await page.locator('[data-testid="export-size-1024"]').click();
  const pngDownloadPromise = page.waitForEvent("download", { timeout: 120_000 });
  await page.locator('[data-testid="export-start"]').click();
  const pngDownload = await pngDownloadPromise;
  const pngPath = join(OUT, "exported-1024.png");
  await pngDownload.saveAs(pngPath);
  const png = readFileSync(pngPath);
  check(
    "local PNG export downloads a valid PNG",
    png.length > 20_000 && png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47,
    `${png.length} bytes`,
  );
  await page.waitForSelector('[data-testid="export-result"]', { timeout: 20_000 });
  const successText = await page.locator('[data-testid="export-result"]').innerText();
  check(
    "local PNG export uses the bundled EB Garamond in its worker",
    successText.includes("EB Garamond 已加载"),
    successText.replace(/\n/g, " | ").slice(0, 240),
  );
  await screenshot(page, "09-export-success.png");
  await page.locator('[data-testid="export-dialog-close"]').click();

  // ── 10. backend render sanity (small size, direct API) ─────────────
  const apiStatus = await page.evaluate(async () => {
    const document = window.__atlasDebug.getDocument();
    const response = await fetch("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document, size: 512 }),
    });
    const blob = await response.blob();
    return {
      status: response.status,
      type: response.headers.get("content-type"),
      bytes: blob.size,
      renderMs: response.headers.get("x-atlas-render-ms"),
    };
  });
  check(
    "backend /api/render works (512 sanity)",
    apiStatus.status === 200 && (apiStatus.type ?? "").startsWith("image/") && apiStatus.bytes > 1000,
    JSON.stringify(apiStatus),
  );

  // ── 11. autosave + reload restore ──────────────────────────────────
  await page.waitForFunction(
    () => window.__atlasDebug.getSummary().save.phase === "saved",
    undefined,
    { timeout: 15_000, polling: 200 },
  );
  const beforeReload = await summary(page);
  const beforeReloadDoc = await page.evaluate(() => {
    const document = window.__atlasDebug.getDocument();
    return {
      seed: document.seed,
      name: document.name,
      elevation: document.overrides.elevation.length,
      rivers: document.overrides.riverForce.length,
      biome: document.overrides.biome.length,
      seaLevel: document.params.seaLevel,
      style: document.style,
    };
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="map-canvas"]', { timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.__atlasDebug), undefined, { timeout: 20_000 });
  await waitIdle(page);
  const afterReload = await summary(page);
  const afterReloadDoc = await page.evaluate(() => {
    const document = window.__atlasDebug.getDocument();
    return {
      seed: document.seed,
      name: document.name,
      elevation: document.overrides.elevation.length,
      rivers: document.overrides.riverForce.length,
      biome: document.overrides.biome.length,
      seaLevel: document.params.seaLevel,
      style: document.style,
    };
  });
  check(
    "autosave restores the document after reload",
    afterReload.autosaveRestored === true &&
      JSON.stringify(beforeReloadDoc) === JSON.stringify(afterReloadDoc),
    `restored=${afterReload.autosaveRestored} seed=${afterReloadDoc.seed} elev=${afterReloadDoc.elevation} rivers=${afterReloadDoc.rivers}`,
  );
  const autosaveShape = await page.evaluate(() => {
    const raw = localStorage.getItem("atlas_forge.world.v1");
    if (!raw) return null;
    const payload = JSON.parse(raw);
    return {
      keys: Object.keys(payload),
      documentKeys: Object.keys(payload.document ?? {}),
      hasView: JSON.stringify(payload).includes('"view":'),
      hasLayers: JSON.stringify(payload.document ?? {}).includes('"layers"'),
    };
  });
  check(
    "autosave stores only { version, savedAt, document } (no layers / view state)",
    Boolean(autosaveShape) &&
      JSON.stringify(autosaveShape.keys) === JSON.stringify(["version", "savedAt", "document"]) &&
      autosaveShape.hasView === false &&
      autosaveShape.hasLayers === false,
    JSON.stringify(autosaveShape),
  );
  await screenshot(page, "10-restored.png");

  // ── 12. JSON import round trip ─────────────────────────────────────
  const importSeed = exported.seed;
  await page
    .locator('[data-testid="import-json-input"]')
    .setInputFiles(jsonPath);
  await page.waitForFunction(
    (seed) => window.__atlasDebug.getDocument().seed === seed,
    importSeed,
    { timeout: 20_000, polling: 100 },
  );
  await waitIdle(page);
  const afterImport = await summary(page);
  check(
    "JSON import restores document (version=1 merge)",
    afterImport.seed === importSeed &&
      afterImport.overrides.elevation === exported.overrides.elevation.length &&
      afterImport.overrides.rivers === exported.overrides.riverForce.length &&
      afterImport.overrides.biome === exported.overrides.biome.length,
    `seed=${afterImport.seed} elev=${afterImport.overrides.elevation} rivers=${afterImport.overrides.rivers} biome=${afterImport.overrides.biome}`,
  );
  await screenshot(page, "11-imported.png");

  // ── 12b. legacy JSON without namingLanguage falls back to auto ─────
  log("legacy JSON import fallback");
  const legacyJson = JSON.parse(readFileSync(jsonPath, "utf8"));
  delete legacyJson.params.namingLanguage;
  const legacyPath = join(OUT, "exported-legacy.json");
  writeFileSync(legacyPath, JSON.stringify(legacyJson, null, 2));
  await page.locator('[data-testid="import-json-input"]').setInputFiles(legacyPath);
  await page.waitForFunction(
    (seed) => window.__atlasDebug.getDocument().seed === seed,
    legacyJson.seed,
    { timeout: 20_000, polling: 100 },
  );
  await waitIdle(page);
  const legacySummary = await summary(page);
  check(
    "legacy world JSON missing namingLanguage imports as auto",
    legacySummary.namingLanguage === "auto" &&
      legacySummary.overrides.elevation === legacyJson.overrides.elevation.length,
    `namingLanguage=${legacySummary.namingLanguage}`,
  );

  // ── 13. dialogs & shortcuts ────────────────────────────────────────
  await page.locator('[data-testid="help"]').click();
  await page.waitForSelector('[data-testid="help-dialog"]', { timeout: 10_000 });
  await screenshot(page, "12-help.png");
  await page.keyboard.press("Escape");
  await sleep(200);
  check(
    "help dialog opens and closes with Escape",
    (await page.locator('[data-testid="help-dialog"]').count()) === 0,
  );

  const undoBeforeShortcut = (await summary(page)).overrides.elevation;
  await page.keyboard.press("1");
  await sleep(100);
  check("shortcut 1 selects elevation tool", (await summary(page)).tool === "elevation");
  await page.keyboard.press("v");
  check("shortcut V selects pan tool", (await summary(page)).tool === "pan");
  await page.keyboard.press("f");
  await sleep(120);
  check("shortcut F fits the map", (await summary(page)).view.scale > 0);
  check("undo stack still healthy", (await summary(page)).history.undo > 0, `elevation stamps=${undoBeforeShortcut}`);

  await screenshot(page, "13-final.png");

  // ── report ─────────────────────────────────────────────────────────
  const report = {
    when: new Date().toISOString(),
    webUrl: WEB_URL,
    viewport: { width: 1680, height: 1000 },
    assertions,
    failedAssertions: assertions.filter((entry) => !entry.ok),
    consoleErrors,
    pageErrors,
    failedRequests,
    httpErrors,
    notes,
  };
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  await browser.close();

  const hardFailures =
    report.failedAssertions.length +
    consoleErrors.length +
    pageErrors.length +
    failedRequests.length +
    httpErrors.length;
  console.log(
    `\nQA summary: ${assertions.filter((a) => a.ok).length}/${assertions.length} checks passed; ` +
      `${consoleErrors.length} console errors; ${pageErrors.length} page errors; ` +
      `${failedRequests.length} failed requests; ${httpErrors.length} HTTP errors.`,
  );
  if (hardFailures > 0) {
    console.error("QA FAILED");
    process.exitCode = 1;
  } else {
    console.log("QA PASSED");
  }
}

main().catch((error) => {
  console.error("QA harness crashed:", error);
  process.exitCode = 1;
});
