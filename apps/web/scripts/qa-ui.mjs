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
  // Give effects/setTimeout(0) a chance to dispatch a just-requested generation
  // so we never observe the previous idle state right after an edit.
  await sleep(140);
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


/** Convert a normalized world point to page coordinates via the live view. */
async function pagePointForWorld(page, wx, wy) {
  const view = (await summary(page)).view;
  const box = await page.locator('[data-testid="map-canvas"]').boundingBox();
  return {
    x: box.x + view.offsetX + wx * view.baseSize * view.scale,
    y: box.y + view.offsetY + wy * view.baseSize * view.scale,
  };
}

/**
 * Pick a normalized world point not covered by existing place boxes and away
 * from the map chrome, so a newly added long label is actually drawn (the
 * layout legitimately skips labels that collide with labels or decorations).
 */
async function findFreeWorldPoint(page) {
  const boxes = await page.evaluate(() => window.__atlasDebug.getPlaceHitBoxes());
  const view = (await summary(page)).view;
  for (let gy = 0.25; gy <= 0.75; gy += 0.05) {
    for (let gx = 0.2; gx <= 0.8; gx += 0.05) {
      const wx = gx + ((Math.round(gy * 100) * 37) % 7) * 0.004;
      const screenX = view.offsetX + wx * view.baseSize * view.scale;
      const screenY = view.offsetY + gy * view.baseSize * view.scale;
      const free = boxes.every((box) => {
        const b = box.screen;
        const pad = 28;
        return (
          screenX < b.x - pad ||
          screenX > b.x + b.width + pad ||
          screenY < b.y - pad ||
          screenY > b.y + b.height + pad
        );
      });
      if (free) return [wx, gy];
    }
  }
  return [0.5, 0.5];
}

async function placeMarkerScreen(page, placeId) {
  return page.evaluate((id) => {
    const data = window.__atlasDebug.getSummary();
    const entry = data.places.list.find((place) => place.id === id);
    if (!entry) return null;
    const view = data.view;
    return {
      x: view.offsetX + entry.x * view.baseSize * view.scale,
      y: view.offsetY + entry.y * view.baseSize * view.scale,
    };
  }, placeId);
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
    const errorText = request.failure()?.errorText ?? "";
    if (url.includes("favicon")) return;
    if (url.includes("/api/health")) {
      notes.push(`env: health probe request failed (${errorText})`);
      return;
    }
    // Cancelling a running export intentionally aborts its fetch; that is a
    // product feature, not a failed request.
    if (url.includes("/api/render") && errorText.includes("ERR_ABORTED")) {
      notes.push(`expected aborted export request: ${url}`);
      return;
    }
    if (request.failure()) {
      failedRequests.push(`${request.method()} ${url} :: ${errorText}`);
    }
  });

  await page.goto(WEB_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector('[data-testid="map-canvas"]', { timeout: 30_000 });
  await page.waitForFunction(() => Boolean(window.__atlasDebug), undefined, { timeout: 20_000 });
  // Deterministic start: drop any autosave left by earlier manual runs.
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem("atlas_forge.ui.onboarded", "1");
  });
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
      "tool-places",
      "group-places",
      "group-params",
      "group-brushes",
      "group-history",
      "group-diagnostics",
      "algorithm-badge",
      "diag-climate-toggle",
      "preset-open",
      "generated-summary",
      "next-reroll",
      "next-tweak",
      "next-export",
      "lock-coast",
      "lock-style",
      "reroll-locked",
      "reroll-names",
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


  // ── 6c. places & labels editing ─────────────────────────────────────
  log("places editing");
  await page.keyboard.press("4");
  await page.waitForTimeout(150);
  const toolAfterShortcut = await summary(page);
  check(
    "shortcut 4 switches to the places tool",
    toolAfterShortcut.tool === "places" &&
      (await page.locator('[data-testid="tool-places"]').getAttribute("aria-pressed")) === "true",
    `tool=${toolAfterShortcut.tool}`,
  );

  // place a new settlement (port) with an explicit name
  await page.locator('[data-testid="place-mode-settlement"]').click();
  await page.locator('[data-testid="place-kind-select"]').selectOption("port");
  await page.locator('[data-testid="place-name-input"]').fill("测试港");
  await page.locator('[data-testid="place-add"]').click();
  check("placement mode arms after clicking place-add", (await summary(page)).places.armed === true);
  await clickCanvas(page, [0.42, 0.46]);
  await waitIdle(page);
  const afterAdd = await summary(page);
  const added = afterAdd.places.list.find((entry) => entry.name === "测试港");
  check(
    "placing a settlement creates a pinned user entry",
    Boolean(added && added.entity === "settlement" && added.userAdded && added.pinned),
    JSON.stringify(added ?? null),
  );
  check(
    "user placement ids use the stable user-s- prefix",
    typeof added?.id === "string" && added.id.startsWith("user-s-"),
    added?.id ?? "(missing)",
  );
  const addedId = added?.id;
  const docAfterAdd = await page.evaluate((id) => {
    const entry = window.__atlasDebug.getDocument().settlements.find((settlement) => settlement.id === id);
    return entry
      ? { name: entry.name, kind: entry.kind, x: entry.x, y: entry.y, pinned: entry.pinned }
      : null;
  }, addedId);
  check(
    "document.settlements stores the new place with normalized coordinates",
    Boolean(
      docAfterAdd &&
        docAfterAdd.pinned === true &&
        docAfterAdd.x >= 0 &&
        docAfterAdd.x <= 1 &&
        docAfterAdd.y >= 0 &&
        docAfterAdd.y <= 1,
    ),
    JSON.stringify(docAfterAdd),
  );

  // canvas hover + click selection + Esc
  const canvasBox = await page.locator('[data-testid="map-canvas"]').boundingBox();
  const markerBeforeLocate = await placeMarkerScreen(page, addedId);
  await page.mouse.move(canvasBox.x + markerBeforeLocate.x, canvasBox.y + markerBeforeLocate.y);
  await page.waitForTimeout(150);
  const hoverCursor = await page.evaluate(
    () => document.querySelector('[data-testid="map-canvas"]').style.cursor,
  );
  check(
    "hovering a place shows the pointer cursor",
    hoverCursor === "pointer",
    `cursor=${hoverCursor ?? "(none)"}`,
  );
  await page.mouse.click(canvasBox.x + markerBeforeLocate.x, canvasBox.y + markerBeforeLocate.y);
  await page.waitForTimeout(150);
  check(
    "clicking a place on the canvas selects it",
    (await summary(page)).places.selected?.id === addedId,
    JSON.stringify((await summary(page)).places.selected),
  );
  await page.keyboard.press("Escape");
  await page.waitForTimeout(120);
  check("Esc clears the place selection", (await summary(page)).places.selected === null);

  // list selection + locate
  await page.locator(`[data-testid="place-list-item-${addedId}"]`).click();
  await page.waitForTimeout(200);
  check(
    "place list click selects the entry",
    (await summary(page)).places.selected?.id === addedId,
    JSON.stringify((await summary(page)).places.selected),
  );
  check(
    "place locate centers the view at >= 1:1 zoom",
    (await summary(page)).view.scale >= 0.99,
    `scale=${(await summary(page)).view.scale}`,
  );

  // rename through the inspector
  await page.locator('[data-testid="place-rename"]').click();
  await page.locator('[data-testid="place-rename-input"]').fill("金湾港");
  await page.locator('[data-testid="place-rename-commit"]').click();
  await waitIdle(page);
  const renamedDoc = await page.evaluate(
    (id) => window.__atlasDebug.getDocument().settlements.find((entry) => entry.id === id),
    addedId,
  );
  await page.waitForFunction(
    (id) =>
      window.__atlasDebug.getLayers()?.settlements?.find((entry) => entry.id === id)?.name === "金湾港",
    addedId,
    { timeout: 30_000, polling: 100 },
  );
  const renamedLayer = await page.evaluate(
    (id) => window.__atlasDebug.getLayers().settlements.find((entry) => entry.id === id),
    addedId,
  );
  check(
    "inspector rename writes a pinned document entry",
    renamedDoc?.name === "金湾港" && renamedDoc?.pinned === true,
    renamedDoc?.name,
  );
  check("regenerated layers reflect the rename", renamedLayer?.name === "金湾港", renamedLayer?.name);

  // double click to rename on the canvas
  const marker = await placeMarkerScreen(page, addedId);
  await page.mouse.dblclick(canvasBox.x + marker.x, canvasBox.y + marker.y);
  await page.waitForTimeout(250);
  check(
    "double-clicking a place opens the rename input",
    (await page.locator('[data-testid="place-rename-input"]').count()) === 1,
  );
  await page.locator('[data-testid="place-rename-input"]').fill("雾岭港");
  await page.keyboard.press("Enter");
  await waitIdle(page);
  check(
    "double-click rename commits",
    (await page.evaluate(
      (id) => window.__atlasDebug.getDocument().settlements.find((entry) => entry.id === id)?.name,
      addedId,
    )) === "雾岭港",
  );

  await screenshot(page, "06b-places-inspector.png");

  // drag to move, ghost shown, no regeneration until pointerup
  const beforeMove = await page.evaluate(
    (id) => window.__atlasDebug.getDocument().settlements.find((entry) => entry.id === id),
    addedId,
  );
  const seqBeforeDrag = (await summary(page)).generation.seq;
  const dragMarker = await placeMarkerScreen(page, addedId);
  await page.mouse.move(canvasBox.x + dragMarker.x, canvasBox.y + dragMarker.y);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + dragMarker.x + 90, canvasBox.y + dragMarker.y + 50, { steps: 10 });
  await page.waitForTimeout(180);
  const ghostCount = await page.locator('[data-testid="place-drag-ghost"]').count();
  await screenshot(page, "06c-place-drag-ghost.png");
  const midDrag = await summary(page);
  await page.mouse.up();
  check("drag ghost is visible while dragging", ghostCount === 1, `count=${ghostCount}`);
  check(
    "dragging does not regenerate until pointerup",
    midDrag.generation.seq === seqBeforeDrag,
    `seq ${seqBeforeDrag} -> ${midDrag.generation.seq}`,
  );
  await waitIdle(page);
  const afterMove = await page.evaluate(
    (id) => window.__atlasDebug.getDocument().settlements.find((entry) => entry.id === id),
    addedId,
  );
  await page.waitForFunction(
    (id) => {
      const layer = window.__atlasDebug.getLayers()?.settlements?.find((entry) => entry.id === id);
      const doc = window.__atlasDebug.getDocument().settlements.find((entry) => entry.id === id);
      return Boolean(layer && doc && Math.abs(layer.x - doc.x) < 0.002 && Math.abs(layer.y - doc.y) < 0.002);
    },
    addedId,
    { timeout: 30_000, polling: 100 },
  );
  const movedLayer = await page.evaluate(
    (id) => window.__atlasDebug.getLayers().settlements.find((entry) => entry.id === id),
    addedId,
  );
  check(
    "drag commits new normalized coordinates into a pinned entry",
    Boolean(
      beforeMove &&
        afterMove &&
        afterMove.pinned === true &&
        Math.hypot(afterMove.x - beforeMove.x, afterMove.y - beforeMove.y) > 0.02,
    ),
    `before=(${beforeMove?.x?.toFixed(3)},${beforeMove?.y?.toFixed(3)}) after=(${afterMove?.x?.toFixed(3)},${afterMove?.y?.toFixed(3)})`,
  );
  check(
    "regenerated layers move with the pinned entry",
    Boolean(
      afterMove &&
        movedLayer &&
        Math.abs(movedLayer.x - afterMove.x) < 0.002 &&
        Math.abs(movedLayer.y - afterMove.y) < 0.002,
    ),
    `layer=(${movedLayer?.x?.toFixed(3)},${movedLayer?.y?.toFixed(3)})`,
  );

  // undo rename / move
  await page.locator('[data-testid="place-list-item-' + addedId + '"]').click();
  await page.waitForTimeout(120);
  await page.locator('[data-testid="place-rename"]').click();
  await page.locator('[data-testid="place-rename-input"]').fill("临时名");
  await page.locator('[data-testid="place-rename-commit"]').click();
  await waitIdle(page);
  await page.keyboard.press("Control+z");
  await waitIdle(page);
  check(
    "undo reverts a place rename",
    (await page.evaluate(
      (id) => window.__atlasDebug.getDocument().settlements.find((entry) => entry.id === id)?.name,
      addedId,
    )) === "雾岭港",
  );
  await page.keyboard.press("Control+z");
  await waitIdle(page);
  const afterMoveUndo = await page.evaluate(
    (id) => window.__atlasDebug.getDocument().settlements.find((entry) => entry.id === id),
    addedId,
  );
  check(
    "undo reverts a place move",
    Boolean(
      afterMoveUndo &&
        beforeMove &&
        Math.abs(afterMoveUndo.x - beforeMove.x) < 1e-6 &&
        Math.abs(afterMoveUndo.y - beforeMove.y) < 1e-6,
    ),
    `x=${afterMoveUndo?.x?.toFixed(4)} vs ${beforeMove?.x?.toFixed(4)}`,
  );
  await page.keyboard.press("Control+Shift+z");
  await waitIdle(page);

  // hide -> hidden list -> restore
  await page.locator(`[data-testid="place-list-item-${addedId}"]`).click();
  await page.waitForTimeout(120);
  await page.locator('[data-testid="place-hide"]').click();
  await page.waitForFunction(
    (id) => window.__atlasDebug.getLayers()?.settlements?.some((entry) => entry.id === id) === false,
    addedId,
    { timeout: 30_000, polling: 100 },
  );
  await waitIdle(page);
  const afterHide = await summary(page);
  check(
    "hide writes the id into overrides.hiddenIds",
    afterHide.places.hiddenIds.includes(addedId),
    JSON.stringify(afterHide.places.hiddenIds.slice(-3)),
  );
  check(
    "hidden place disappears from layers.settlements",
    (await page.evaluate(
      (id) => window.__atlasDebug.getLayers().settlements.some((entry) => entry.id === id),
      addedId,
    )) === false,
  );
  await screenshot(page, "06d-place-hidden.png");
  check(
    "hidden list shows the entry for restore",
    (await page.locator(`[data-testid="place-hidden-item-${addedId}"]`).count()) === 1,
  );
  const layersHiddenSupport = await page.evaluate(() => {
    const hidden = window.__atlasDebug.getLayers().hidden;
    return hidden && Array.isArray(hidden.settlements) ? "supported" : "missing";
  });
  if (layersHiddenSupport === "supported") {
    check(
      "layers.hidden carries the hidden settlement data",
      (await page.evaluate(
        (id) => window.__atlasDebug.getLayers().hidden.settlements.some((entry) => entry.id === id),
        addedId,
      )) === true,
    );
  } else {
    log("layers.hidden not present yet in this core build; UI fallback list verified");
  }
  await page.locator(`[data-testid="place-hidden-item-${addedId}"] [data-testid="place-restore"]`).click();
  await page.waitForFunction(
    (id) => window.__atlasDebug.getLayers()?.settlements?.some((entry) => entry.id === id) === true,
    addedId,
    { timeout: 30_000, polling: 100 },
  );
  await waitIdle(page);
  const afterRestore = await summary(page);
  check(
    "restore removes the id from hiddenIds",
    !afterRestore.places.hiddenIds.includes(addedId),
  );
  check(
    "restored place is back in layers.settlements",
    (await page.evaluate(
      (id) => window.__atlasDebug.getLayers().settlements.some((entry) => entry.id === id),
      addedId,
    )) === true,
  );

  // generated entries: hide -> layers.hidden -> restore
  const generatedSettlement = (await summary(page)).places.list.find(
    (entry) => entry.entity === "settlement" && !entry.userAdded,
  );
  if (generatedSettlement) {
    await page.locator(`[data-testid="place-list-item-${generatedSettlement.id}"]`).click();
    await page.waitForTimeout(150);
    await page.locator('[data-testid="place-hide"]').click();
    await waitIdle(page);
    check(
      "hiding a generated settlement hides it and lists it for restore",
      (await page.evaluate(
        (id) => window.__atlasDebug.getLayers().settlements.some((entry) => entry.id === id),
        generatedSettlement.id,
      )) === false &&
        (await page.locator(`[data-testid="place-hidden-item-${generatedSettlement.id}"]`).count()) === 1,
    );
    const generatedHiddenLayer = await page.evaluate((id) => {
      const hidden = window.__atlasDebug.getLayers().hidden;
      if (!hidden || !Array.isArray(hidden.settlements)) return "missing";
      const entry = hidden.settlements.find((item) => item.id === id);
      return entry ? { name: entry.name } : null;
    }, generatedSettlement.id);
    check(
      "layers.hidden carries generated hidden entries with their data",
      typeof generatedHiddenLayer === "object" &&
        generatedHiddenLayer !== null &&
        typeof generatedHiddenLayer.name === "string" &&
        generatedHiddenLayer.name.length > 0,
      JSON.stringify(generatedHiddenLayer),
    );
    await page
      .locator(`[data-testid="place-hidden-item-${generatedSettlement.id}"] [data-testid="place-restore"]`)
      .click();
    await page.waitForFunction(
      (id) => window.__atlasDebug.getLayers()?.settlements?.some((entry) => entry.id === id) === true,
      generatedSettlement.id,
      { timeout: 30_000, polling: 100 },
    );
    await waitIdle(page);
    check(
      "restoring a generated settlement puts it back into layers",
      (await page.evaluate(
        (id) => window.__atlasDebug.getLayers().settlements.some((entry) => entry.id === id),
        generatedSettlement.id,
      )) === true,
    );
  }

  // hide again + undo (undo must bring the place back)
  await page.locator(`[data-testid="place-list-item-${addedId}"]`).click();
  await page.waitForTimeout(120);
  await page.locator('[data-testid="place-hide"]').click();
  await waitIdle(page);
  await page.keyboard.press("Control+z");
  await waitIdle(page);
  check(
    "undo reverts hiding a place",
    !(await summary(page)).places.hiddenIds.includes(addedId),
  );

  // place a label entry (auto-generated name)
  await page.locator('[data-testid="place-mode-label"]').click();
  await page.locator('[data-testid="place-kind-select"]').selectOption("water");
  await page.locator('[data-testid="place-name-input"]').fill("");
  await page.locator('[data-testid="place-add"]').click();
  await clickCanvas(page, [0.35, 0.62]);
  await waitIdle(page);
  const userLabels = await page.evaluate(() =>
    window.__atlasDebug
      .getLayers()
      .autoLabels.filter((label) => label.id.startsWith("user-l-"))
      .map((label) => ({ id: label.id, text: label.text, kind: label.kind, pinned: label.pinned })),
  );
  check(
    "placing a label creates a pinned user label with a generated name",
    userLabels.length >= 1 &&
      userLabels.some((label) => label.kind === "water" && label.pinned === true && label.text.length > 0),
    JSON.stringify(userLabels),
  );
  const userLabelId = userLabels[0]?.id;
  if (userLabelId) {
    await page.locator(`[data-testid="place-list-item-${userLabelId}"]`).click();
    await page.waitForTimeout(150);
    await page.locator('[data-testid="place-delete"]').click();
    await page.waitForFunction(
      (id) => window.__atlasDebug.getLayers()?.autoLabels?.some((label) => label.id === id) === false,
      userLabelId,
      { timeout: 30_000, polling: 100 },
    );
    await waitIdle(page);
    check(
      "delete removes a user-added label from the document and layers",
      (await page.evaluate(
        (id) => window.__atlasDebug.getDocument().labels.some((label) => label.id === id),
        userLabelId,
      )) === false &&
        (await page.evaluate(
          (id) => window.__atlasDebug.getLayers().autoLabels.some((label) => label.id === id),
          userLabelId,
        )) === false,
    );
    await page.keyboard.press("Control+z");
    await waitIdle(page);
    check(
      "undo reverts deleting a user-added label",
      (await page.evaluate(
        (id) => window.__atlasDebug.getDocument().labels.some((label) => label.id === id),
        userLabelId,
      )) === true,
    );
  }
  await page.keyboard.press("v");
  await page.waitForTimeout(120);


  // ── 6e. P0: renderer-sourced hit boxes / undo semantics / keyboard ──
  log("P0 hit boxes / undo / keyboard");
  await page.keyboard.press("4");
  await sleep(200);
  await page.waitForFunction(
    () => window.__atlasDebug.getSummary().hitBoxesSource !== null,
    undefined,
    { timeout: 30_000, polling: 100 },
  );
  const hitInfo = await page.evaluate(() => {
    const data = window.__atlasDebug.getSummary();
    return {
      source: data.hitBoxesSource,
      count: data.hitBoxCount,
      perf: data.perf,
      boxes: window.__atlasDebug.getPlaceHitBoxes(),
    };
  });
  check(
    "hit boxes are measured by the renderer (same source as painting)",
    hitInfo.source === "renderer" && hitInfo.count > 0,
    `source=${hitInfo.source} boxes=${hitInfo.count}`,
  );
  check(
    "hit boxes expose image/world/screen rectangles",
    hitInfo.boxes.length > 0 &&
      hitInfo.boxes.every(
        (box) => box.image.width > 0 && box.world.width > 0 && box.screen.width > 0,
      ),
  );
  check(
    "hit test latency is measured and cheap",
    typeof hitInfo.perf.hitTestMs === "number" &&
      hitInfo.perf.hitTestMs >= 0 &&
      hitInfo.perf.hitTestMs < 5,
    `${hitInfo.perf.hitTestMs}ms`,
  );
  const hitPriority = await page.evaluate(() => window.__atlasDebug.testHitPriority());
  check(
    "overlapping boxes resolve by drawOrder (topmost wins)",
    hitPriority.hitId === "high-box" && hitPriority.usedBoxes === true,
    JSON.stringify(hitPriority),
  );
  const seqBeforeHover = (await summary(page)).generation.seq;
  await page.mouse.move(
    canvasBox.x + canvasBox.width * 0.45,
    canvasBox.y + canvasBox.height * 0.42,
  );
  await sleep(250);
  check(
    "hovering places never regenerates the world",
    (await summary(page)).generation.seq === seqBeforeHover,
  );

  // a custom label: click near its bbox tail (far from the anchor point)
  await page.locator('[data-testid="place-mode-label"]').click();
  await page.locator('[data-testid="place-kind-select"]').selectOption("custom");
  await page.locator('[data-testid="place-name-input"]').fill("极长测试标注名称");
  await page.locator('[data-testid="place-add"]').click();
  const freeSpot = await findFreeWorldPoint(page);
  const spotPoint = await pagePointForWorld(page, freeSpot[0], freeSpot[1]);
  await page.mouse.click(spotPoint.x, spotPoint.y);
  await waitIdle(page);
  await page.waitForFunction(
    () => {
      const data = window.__atlasDebug.getSummary();
      const place = data.places.list.find((entry) => entry.name === "极长测试标注名称");
      if (!place) return false;
      return window.__atlasDebug
        .getPlaceHitBoxes()
        .some((box) => box.id === place.id && box.entity === "label");
    },
    undefined,
    { timeout: 30_000, polling: 100 },
  );
  const longLabel = await page.evaluate(() => {
    const data = window.__atlasDebug.getSummary();
    const place = data.places.list.find((entry) => entry.name === "极长测试标注名称");
    if (!place) return null;
    const box = window.__atlasDebug
      .getPlaceHitBoxes()
      .find((entry) => entry.id === place.id && entry.entity === "label");
    return box ? { id: place.id, screen: box.screen, drawOrder: box.drawOrder } : null;
  });
  check(
    "long custom label renders with a renderer bbox wider than the marker hit radius",
    Boolean(longLabel && longLabel.screen.width > 60),
    JSON.stringify(longLabel),
  );
  if (longLabel) {
    await page.mouse.click(
      canvasBox.x + longLabel.screen.x + longLabel.screen.width - 3,
      canvasBox.y + longLabel.screen.y + longLabel.screen.height / 2,
    );
    await sleep(250);
    check(
      "clicking a label's bbox tail selects the label",
      (await summary(page)).places.selected?.id === longLabel.id,
      JSON.stringify((await summary(page)).places.selected),
    );
    await screenshot(page, "06e-hit-boxes.png");
  }

  // ── undo history semantics ──
  await page.locator(`[data-testid="place-list-item-${addedId}"]`).click();
  await sleep(150);
  const renameBase = await summary(page);
  await page.locator('[data-testid="place-rename"]').click();
  await page.locator('[data-testid="place-rename-input"]').fill("取消测试");
  await page.keyboard.press("Escape");
  await sleep(220);
  const afterCancelRename = await summary(page);
  check(
    "cancelling a rename adds no history entry",
    afterCancelRename.history.undo === renameBase.history.undo,
    `${renameBase.history.undo} -> ${afterCancelRename.history.undo}`,
  );
  check(
    "Esc after a cancelled rename returns focus to the canvas",
    (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "map-canvas",
  );
  await page.locator('[data-testid="place-rename"]').click();
  await page.locator('[data-testid="place-rename-input"]').fill("雾岭港");
  await page.keyboard.press("Enter");
  await waitIdle(page);
  const afterRenameCommit = await summary(page);
  check(
    "rename commit adds exactly one history entry",
    afterRenameCommit.history.undo === renameBase.history.undo + 1,
    `${renameBase.history.undo} -> ${afterRenameCommit.history.undo}`,
  );
  check(
    "rename commit returns focus to the canvas",
    (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) === "map-canvas",
  );
  await page.locator('[data-testid="place-rename"]').click();
  const renameInput = page.locator('[data-testid="place-rename-input"]');
  await renameInput.fill("测试删除键");
  await renameInput.press("End");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Delete");
  await sleep(180);
  check(
    "Backspace/Delete inside the rename input do not delete the place",
    (await summary(page)).places.list.some((entry) => entry.id === addedId),
  );
  await page.keyboard.press("Escape");
  await sleep(180);

  // style slider drag: many input events, exactly one history entry
  const styleBase = await summary(page);
  await page.locator('[data-testid="style-paperTexture"]').evaluate((element) => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    for (const value of [0.6, 0.65, 0.7]) {
      setter.call(element, String(value));
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 }));
  });
  await sleep(450);
  check(
    "style slider drag adds exactly one history entry",
    (await summary(page)).history.undo === styleBase.history.undo + 1,
    `${styleBase.history.undo} -> ${(await summary(page)).history.undo}`,
  );

  // drag commit: exactly one history entry
  await page.locator(`[data-testid="place-list-item-${addedId}"]`).click();
  await sleep(150);
  const dragBase = await summary(page);
  const historyDragMarker = await placeMarkerScreen(page, addedId);
  await page.mouse.move(canvasBox.x + historyDragMarker.x, canvasBox.y + historyDragMarker.y);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + historyDragMarker.x + 60, canvasBox.y + historyDragMarker.y + 30, {
    steps: 6,
  });
  await page.mouse.up();
  await waitIdle(page);
  check(
    "drag commit adds exactly one history entry",
    (await summary(page)).history.undo === dragBase.history.undo + 1,
    `${dragBase.history.undo} -> ${(await summary(page)).history.undo}`,
  );
  await page.keyboard.press("Control+z");
  await waitIdle(page);

  // hide adds exactly one history entry
  await page.locator(`[data-testid="place-list-item-${addedId}"]`).click();
  await sleep(150);
  const hideBase = await summary(page);
  await page.locator('[data-testid="place-hide"]').click();
  await page.waitForFunction(
    (id) => window.__atlasDebug.getLayers().settlements.some((entry) => entry.id === id) === false,
    addedId,
    { timeout: 30_000, polling: 100 },
  );
  await waitIdle(page);
  check(
    "hiding a place adds exactly one history entry",
    (await summary(page)).history.undo === hideBase.history.undo + 1,
    `${hideBase.history.undo} -> ${(await summary(page)).history.undo}`,
  );
  await page.keyboard.press("Control+z");
  await waitIdle(page);

  // cross-feature undo chain: rename -> style toggle -> export -> import
  log("cross-feature undo chain");
  await page.locator(`[data-testid="place-list-item-${addedId}"]`).click();
  await sleep(150);
  await page.locator('[data-testid="place-rename"]').click();
  await page.locator('[data-testid="place-rename-input"]').fill("跨功能名");
  await page.keyboard.press("Enter");
  await waitIdle(page);
  const styleBeforeToggle = await page.evaluate(
    () => window.__atlasDebug.getDocument().style.showCompass,
  );
  await page.locator('[data-testid="style-showCompass"]').click();
  await sleep(300);
  const afterStyleToggle = await summary(page);
  const crossDownload = page.waitForEvent("download", { timeout: 20_000 });
  await page.locator('[data-testid="export-json"]').click();
  const crossJsonPath = join(OUT, "cross-undo.json");
  await (await crossDownload).saveAs(crossJsonPath);
  const afterCrossExport = await summary(page);
  check(
    "JSON export adds no history entry",
    afterCrossExport.history.undo === afterStyleToggle.history.undo,
    `${afterStyleToggle.history.undo} -> ${afterCrossExport.history.undo}`,
  );
  await page.locator('[data-testid="import-json-input"]').setInputFiles(crossJsonPath);
  await page.waitForFunction(
    (seed) => window.__atlasDebug.getDocument().seed === seed,
    afterCrossExport.seed,
    { timeout: 20_000, polling: 100 },
  );
  await waitIdle(page);
  const afterCrossImport = await summary(page);
  check(
    "JSON import pushes one history entry",
    afterCrossImport.history.undo === afterCrossExport.history.undo + 1,
    `${afterCrossExport.history.undo} -> ${afterCrossImport.history.undo}`,
  );
  await page.keyboard.press("Control+z");
  await waitIdle(page);
  check(
    "undo after import returns to the renamed/toggled document",
    (await page.evaluate(
      (id) => window.__atlasDebug.getDocument().settlements.find((entry) => entry.id === id)?.name,
      addedId,
    )) === "跨功能名" &&
      (await page.evaluate(() => window.__atlasDebug.getDocument().style.showCompass)) ===
        !styleBeforeToggle,
  );
  await page.keyboard.press("Control+z");
  await waitIdle(page);
  check(
    "undo style toggle restores the previous style",
    (await page.evaluate(() => window.__atlasDebug.getDocument().style.showCompass)) ===
      styleBeforeToggle,
  );
  await page.keyboard.press("Control+z");
  await waitIdle(page);
  check(
    "undo rename reaches the pre-rename document",
    (await page.evaluate(
      (id) => window.__atlasDebug.getDocument().settlements.find((entry) => entry.id === id)?.name,
      addedId,
    )) === "雾岭港",
  );

  // naming: pure generator + UI de-duplication
  const namingDemo = await page.evaluate(() => window.__atlasDebug.getNamingDemo());
  check(
    "pure place-name generator is deterministic for a fixed rng",
    namingDemo.deterministic[0] === namingDemo.deterministic[1],
    JSON.stringify(namingDemo.deterministic),
  );
  check(
    "duplicate names receive a stable numeric suffix",
    namingDemo.deduped === "新港-3",
    namingDemo.deduped,
  );
  await page.locator('[data-testid="place-mode-settlement"]').click();
  await page.locator('[data-testid="place-kind-select"]').selectOption("town");
  await page.locator('[data-testid="place-name-input"]').fill("重名港");
  await page.locator('[data-testid="place-add"]').click();
  await clickCanvas(page, [0.25, 0.7]);
  await waitIdle(page);
  await page.locator('[data-testid="place-name-input"]').fill("重名港");
  await page.locator('[data-testid="place-add"]').click();
  await clickCanvas(page, [0.28, 0.73]);
  await waitIdle(page);
  const duplicateNames = (await summary(page)).places.list
    .filter((entry) => entry.name.startsWith("重名港"))
    .map((entry) => entry.name)
    .sort();
  check(
    "UI auto-suffixes duplicate place names",
    duplicateNames.includes("重名港") && duplicateNames.includes("重名港-2"),
    JSON.stringify(duplicateNames),
  );

  // keyboard / Esc priority / single-source shortcuts
  await page.locator(`[data-testid="place-list-item-${addedId}"]`).click();
  await sleep(150);
  await page.locator('[data-testid="help"]').click();
  await page.waitForSelector('[data-testid="help-dialog"]');
  await page.keyboard.press("Escape");
  await sleep(180);
  check(
    "Esc closes the dialog before clearing place selection",
    (await page.locator('[data-testid="help-dialog"]').count()) === 0 &&
      (await summary(page)).places.selected?.id === addedId,
  );
  await page.keyboard.press("Escape");
  await sleep(150);
  check("second Esc clears the place selection", (await summary(page)).places.selected === null);
  const shortcutIds = await page.evaluate(() =>
    window.__atlasDebug.getShortcuts().map((entry) => entry.id),
  );
  await page.locator('[data-testid="help"]').click();
  await page.waitForSelector('[data-testid="help-dialog"]');
  const helpRows = await page.locator('[data-testid="help-dialog"] .shortcut-table tr').count();
  check(
    "HelpDialog renders the single-source shortcut list",
    helpRows === shortcutIds.length &&
      shortcutIds.includes("undo") &&
      shortcutIds.includes("escape"),
    `${helpRows} rows / ${shortcutIds.length} defs`,
  );
  await page.keyboard.press("Escape");
  await sleep(150);
  await page.keyboard.press("v");

  // ── 6d. seed round-trip keeps place edits ───────────────────────────
  const placesBeforeSeed = await summary(page);
  const userSettlementsBefore = placesBeforeSeed.places.userSettlements;

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
  check(
    "place edits survive seed changes and seed round-trips",
    rerolled.places.userSettlements === placesBeforeSeed.places.userSettlements &&
      rerolled.places.userLabels === placesBeforeSeed.places.userLabels &&
      restored.places.userSettlements === placesBeforeSeed.places.userSettlements &&
      restored.places.userLabels === placesBeforeSeed.places.userLabels &&
      restored.places.list.some((entry) => entry.id === addedId && entry.name === "雾岭港"),
    `settlements=${restored.places.userSettlements}/${placesBeforeSeed.places.userSettlements}`,
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
  check(
    "fit button resets zoom to the fitted scale",
    Math.abs(afterFit.view.scale - initial.view.scale) < 0.02,
    `fit=${afterFit.view.scale.toFixed(3)} initial=${initial.view.scale.toFixed(3)}`,
  );

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
  check(
    "JSON export includes user places and hiddenIds",
    Array.isArray(exported.settlements) &&
      Array.isArray(exported.labels) &&
      exported.settlements.length === exportedSummary.places.userSettlements &&
      exported.labels.length === exportedSummary.places.userLabels &&
      Array.isArray(exported.overrides.hiddenIds) &&
      exported.settlements.some((entry) => entry.id === addedId && entry.pinned === true),
    `settlements=${exported.settlements?.length} labels=${exported.labels?.length} hidden=${exported.overrides.hiddenIds?.length}`,
  );

  // ── 9. local PNG export via dialog ─────────────────────────────────
  await page.locator('[data-testid="export-png"]').click();
  await page.waitForSelector('[data-testid="export-dialog"]', { timeout: 10_000 });
  await screenshot(page, "08-export-dialog.png");
  await page.locator('[data-testid="export-size-1024"]').click();
  check(
    "export dialog previews the final filename under export-filename",
    /^atlas-.+-20261018-parchment-1024\.png$/.test(
      (await page.locator('[data-testid="export-filename"]').innerText()).trim(),
    ),
    await page.locator('[data-testid="export-filename"]').innerText(),
  );
  check(
    "export dialog exposes an export-size-summary row",
    (await page.locator('[data-testid="export-size-summary"]').innerText()).includes("1024"),
  );
  check(
    "export button reflects the selected size",
    (await page.locator('[data-testid="export-png"]').innerText()).includes("1024"),
    await page.locator('[data-testid="export-png"]').innerText(),
  );
  const pngDownloadPromise = page.waitForEvent("download", { timeout: 120_000 });
  await page.locator('[data-testid="export-start"]').click();
  const pngDownload = await pngDownloadPromise;
  const pngPath = join(OUT, "exported-1024.png");
  await pngDownload.saveAs(pngPath);
  const png = readFileSync(pngPath);
  check(
    "PNG filename follows atlas-<world>-<seed>-<preset>-<size>.png",
    /^atlas-.+-20261018-parchment-1024\.png$/.test(pngDownload.suggestedFilename()),
    pngDownload.suggestedFilename(),
  );
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

  // ── 9b. export UX: progress, cancellation, disabled reasons ────────
  log("export UX");
  await page.locator('[data-testid="export-png"]').click();
  await page.waitForSelector('[data-testid="export-dialog"]');
  await page.locator('[data-testid="export-size-4096"]').click();
  check(
    "export button reflects the large size too",
    (await page.locator('[data-testid="export-png"]').innerText()).includes("4096"),
    await page.locator('[data-testid="export-png"]').innerText(),
  );
  const cancelledDownload = page
    .waitForEvent("download", { timeout: 1500 })
    .catch(() => null);
  await page.locator('[data-testid="export-start"]').click();
  await page.waitForSelector('[data-testid="export-progress"]', { timeout: 10_000 });
  await sleep(600);
  const progressStage = await page.locator('[data-testid="export-progress-stage"]').innerText();
  const progressPercent = await page.locator('[data-testid="export-progress-percent"]').innerText();
  check(
    "server export shows staged progress with a percentage",
    progressStage.length > 0 && /%$/.test(progressPercent.trim()),
    `${progressStage} ${progressPercent}`,
  );
  await screenshot(page, "17-export-progress.png");
  await page.locator('[data-testid="export-cancel-running"]').click();
  await page.waitForSelector('[data-testid="export-cancelled"]', { timeout: 8_000 });
  check("cancelling a server export returns to idle", true);
  const lateDownload = await cancelledDownload;
  check("cancelled export produces no download", lateDownload === null);
  await page.locator('[data-testid="export-size-2048"]').click();
  await page.locator('[data-testid="export-dialog-close"]').click();
  await sleep(150);

  // disabled reason while a generation is in flight
  await page.locator('[data-testid="reroll"]').click();
  await page.locator('[data-testid="export-png"]').click();
  await page.waitForSelector('[data-testid="export-dialog"]');
  const disabledReason = await page
    .locator('[data-testid="export-disabled-reason"]')
    .innerText()
    .catch(() => "");
  check(
    "export explains a disabled start while generating",
    disabledReason.includes("生成"),
    disabledReason || "(missing)",
  );
  await page.locator('[data-testid="export-dialog-close"]').click();
  await waitIdle(page);


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
      settlements: document.settlements.length,
      labels: document.labels.length,
      hiddenIds: document.overrides.hiddenIds.length,
      placeNames: document.settlements.map((entry) => entry.name).sort(),
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
      settlements: document.settlements.length,
      labels: document.labels.length,
      hiddenIds: document.overrides.hiddenIds.length,
      placeNames: document.settlements.map((entry) => entry.name).sort(),
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
  check(
    "JSON import restores user places and hiddenIds",
    afterImport.places.userSettlements === exported.settlements.length &&
      afterImport.places.userLabels === exported.labels.length &&
      afterImport.places.hiddenIds.length === exported.overrides.hiddenIds.length &&
      afterImport.places.list.some((entry) => entry.id === addedId && entry.name === "雾岭港"),
    `settlements=${afterImport.places.userSettlements} labels=${afterImport.places.userLabels} hidden=${afterImport.places.hiddenIds.length}`,
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
  check(
    "legacy JSON without hiddenIds/places fields imports without crashing",
    Array.isArray((await page.evaluate(() => window.__atlasDebug.getDocument().overrides.hiddenIds))) &&
      legacySummary.places.userSettlements === (legacyJson.settlements?.length ?? 0) &&
      (await summary(page)).generation.phase !== "error",
    `hiddenIds=${JSON.stringify(await page.evaluate(() => window.__atlasDebug.getDocument().overrides.hiddenIds))} settlements=${legacySummary.places.userSettlements}`,
  );


  // ── 12c. import failure paths + autosave recovery ───────────────────
  log("import failure + autosave recovery");
  const seedBeforeBadImport = (await summary(page)).seed;
  const badJsonPath = join(OUT, "bad-world.json");
  writeFileSync(badJsonPath, "{ this is not valid json");
  await page.locator('[data-testid="import-json-input"]').setInputFiles(badJsonPath);
  await page.waitForSelector('[data-testid="toast"][data-kind="error"]', { timeout: 10_000 });
  const badToast = await page.locator('[data-testid="toast"]').innerText();
  check(
    "bad JSON import shows a readable error toast",
    badToast.includes("导入失败") || badToast.includes("JSON"),
    badToast.replace(/\n/g, " | ").slice(0, 180),
  );
  check(
    "bad JSON import keeps the current document",
    (await summary(page)).seed === seedBeforeBadImport,
  );
  await screenshot(page, "15-import-error.png");
  const badVersionPath = join(OUT, "bad-version.json");
  writeFileSync(badVersionPath, JSON.stringify({ version: 7, seed: 1 }));
  await page.locator('[data-testid="import-json-input"]').setInputFiles(badVersionPath);
  await sleep(700);
  check(
    "unsupported world version is rejected without replacing the document",
    (await summary(page)).seed === seedBeforeBadImport,
  );

  // localStorage quota failure → save error toast with an export-backup action
  log("autosave quota failure");
  await page.evaluate(() => {
    window.__originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function patchedSetItem() {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    };
  });
  await page.locator('[data-testid="style-showGraticule"]').click();
  await page.waitForFunction(
    () => window.__atlasDebug.getSummary().save.phase === "error",
    undefined,
    { timeout: 15_000, polling: 100 },
  );
  check(
    "quota failure surfaces a save error with a backup action",
    (await page.locator('[data-testid="toast-action"]').count()) === 1 &&
      (await page.locator('[data-testid="save-status"]').innerText()).includes("失败"),
  );
  const backupDownloadPromise = page.waitForEvent("download", { timeout: 20_000 });
  await page.locator('[data-testid="toast-action"]').click();
  const backupDownload = await backupDownloadPromise;
  check(
    "quota failure offers an immediate JSON backup download",
    backupDownload.suggestedFilename().endsWith(".world.json"),
    backupDownload.suggestedFilename(),
  );
  await page.evaluate(() => {
    if (window.__originalSetItem) Storage.prototype.setItem = window.__originalSetItem;
  });
  // restore a healthy save state so later reloads do not read a stale error
  await page.locator('[data-testid="style-showGraticule"]').click();
  await page.waitForFunction(
    () => window.__atlasDebug.getSummary().save.phase === "saved",
    undefined,
    { timeout: 20_000, polling: 150 },
  );
  await waitIdle(page);

  // corrupted autosave: recovery panel, backup restore, no silent overwrite
  log("corrupted autosave recovery");
  const backupDocument = JSON.parse(readFileSync(jsonPath, "utf8"));
  const backupPayload = JSON.stringify({
    version: 1,
    savedAt: Date.now() - 60_000,
    document: backupDocument,
  });
  const recoveryContext = await browser.newContext({
    viewport: { width: 1680, height: 1000 },
  });
  await recoveryContext.addInitScript((payload) => {
    try {
      localStorage.setItem("atlas_forge.world.v1", "{corrupted-json");
      localStorage.setItem("atlas_forge.world.backup.v1", payload);
      localStorage.setItem("atlas_forge.ui.onboarded", "1");
    } catch {
      // ignore
    }
  }, backupPayload);
  const recoveryPage = await recoveryContext.newPage();
  recoveryPage.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`recovery: ${message.text()}`);
  });
  recoveryPage.on("pageerror", (error) => pageErrors.push(`recovery: ${String(error)}`));
  await recoveryPage.goto(WEB_URL, { waitUntil: "domcontentloaded" });
  await recoveryPage.waitForSelector('[data-testid="autosave-recovery"]', {
    timeout: 30_000,
  });
  check(
    "corrupted autosave opens the recovery panel",
    (await recoveryPage.locator('[data-testid="autosave-recover"]').count()) === 1,
  );
  await recoveryPage.waitForTimeout(1800);
  const mainStillCorrupt = await recoveryPage.evaluate(() =>
    localStorage.getItem("atlas_forge.world.v1"),
  );
  check(
    "corrupted autosave is not silently overwritten",
    mainStillCorrupt === "{corrupted-json",
    String(mainStillCorrupt).slice(0, 40),
  );
  await recoveryPage.screenshot({ path: join(OUT, "16-autosave-recovery.png") });
  await recoveryPage.locator('[data-testid="autosave-recover"]').click();
  await recoveryPage.waitForFunction(() => Boolean(window.__atlasDebug), undefined, {
    timeout: 20_000,
  });
  await waitIdle(recoveryPage);
  const recovered = await summary(recoveryPage);
  check(
    "recovering the previous autosave restores the world",
    recovered.seed === backupDocument.seed &&
      recovered.places.userSettlements === backupDocument.settlements.length &&
      (await recoveryPage.locator('[data-testid="autosave-recovery"]').count()) === 0,
    `seed=${recovered.seed} settlements=${recovered.places.userSettlements}`,
  );
  await recoveryContext.close();

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
  await page.keyboard.press("4");
  await sleep(120);
  check("shortcut 4 selects places tool", (await summary(page)).tool === "places");
  await page.keyboard.press("v");
  check("shortcut V selects pan tool", (await summary(page)).tool === "pan");
  await page.keyboard.press("f");
  await sleep(120);
  check("shortcut F fits the map", (await summary(page)).view.scale > 0);
  check("undo stack still healthy", (await summary(page)).history.undo > 0, `elevation stamps=${undoBeforeShortcut}`);



  // ── 18. v0.4 generation experience ─────────────────────────────────
  log("v0.4 generation experience");
  await waitIdle(page);
  const v4base = await summary(page);
  check(
    "scenario metadata is exposed in the debug summary",
    typeof v4base.scenarioId === "string" &&
      v4base.scenarioName.length > 0 &&
      v4base.locks !== null,
    `scenario=${v4base.scenarioId} locks=${JSON.stringify(v4base.locks)}`,
  );
  check(
    "generated summary names the scenario and seed suffix",
    /已生成：.+ · #\d{4}/.test(
      await page.locator('[data-testid="generated-summary"]').innerText(),
    ),
    await page.locator('[data-testid="generated-summary"]').innerText(),
  );
  check(
    "five stage locks are present and default unlocked",
    (await page.locator('[data-testid="lock-coast"]').getAttribute("aria-pressed")) === "false" &&
      (await page.locator('[data-testid="lock-style"]').getAttribute("aria-pressed")) === "false",
  );

  // lock the coast, reroll three times: terrain must stay identical
  const presetBadgeBeforeLocks = await page.locator('[data-testid="preset-modified-badge"]').count();
  await page.locator('[data-testid="lock-coast"]').click();
  const lockedBase = await summary(page);
  const lockedHeights = [];
  const lockedOceans = [];
  const lockedRivers = [];
  const lockedLand = [];
  for (let index = 0; index < 3; index += 1) {
    await page.locator('[data-testid="reroll-locked"]').click();
    await sleep(260);
    await waitIdle(page);
    const state = await summary(page);
    const signature = await page.evaluate(() => window.__atlasDebug.getLayerSignature());
    lockedHeights.push(signature.height);
    lockedOceans.push(signature.ocean);
    lockedRivers.push(signature.river);
    lockedLand.push(state.layers.landFraction);
  }
  check(
    "locking the coastline keeps height/ocean hashes identical across 3 rerolls",
    lockedHeights.every((value) => value === lockedHeights[0]) &&
      lockedOceans.every((value) => value === lockedOceans[0]),
    JSON.stringify({ lockedHeights, lockedOceans }),
  );
  check(
    "rerolling unlocked stages actually changes the river hash at least once",
    lockedRivers.some((value) => value !== lockedRivers[0]),
    JSON.stringify(lockedRivers),
  );
  check(
    "locked-coast rerolls keep landFraction identical",
    lockedLand.every((value) => value === lockedLand[0]),
    JSON.stringify(lockedLand),
  );
  const lockedStageSeeds = await page.evaluate(() => window.__atlasDebug.getStageSeeds());
  check(
    "explicit stage seeds are stored and terrain stays unseeded while locked",
    lockedStageSeeds !== null &&
      typeof lockedStageSeeds.hydrology === "number" &&
      typeof lockedStageSeeds.human === "number" &&
      lockedStageSeeds.terrain === undefined,
    JSON.stringify(lockedStageSeeds),
  );
  check(
    "stage seeds do not count as preset parameter modifications",
    (await page.locator('[data-testid="preset-modified-badge"]').count()) ===
      presetBadgeBeforeLocks,
    `badge ${presetBadgeBeforeLocks} -> ${
      await page.locator('[data-testid="preset-modified-badge"]').count()
    }`,
  );
  const lockToast = await page.locator('[data-testid="toast"]').last().innerText();
  check(
    "reroll toast explains which stages were kept",
    lockToast.includes("已换：") &&
      lockToast.includes(" · 保留：") &&
      lockToast.includes("海岸"),
    lockToast.replace(/\n/g, " | ").slice(0, 160),
  );
  await screenshot(page, "22-locks.png");

  // unlock coast: reroll must now change the terrain, exactly one history entry
  await page.locator('[data-testid="lock-coast"]').click();
  const beforeUnlocked = await summary(page);
  await page.locator('[data-testid="next-reroll"]').click();
  await sleep(260);
  await waitIdle(page);
  const afterUnlocked = await summary(page);
  check(
    "unlocked reroll changes the terrain signature",
    afterUnlocked.layerSignature.height !== beforeUnlocked.layerSignature.height,
    `${beforeUnlocked.layerSignature.height} -> ${afterUnlocked.layerSignature.height}`,
  );
  check(
    "reroll adds exactly one history entry",
    afterUnlocked.history.undo === beforeUnlocked.history.undo + 1,
    `${beforeUnlocked.history.undo} -> ${afterUnlocked.history.undo}`,
  );
  check(
    "reroll changes some stage seed (document stageSeeds present)",
    (await page.evaluate(() => Boolean(window.__atlasDebug.getDocument().params.stageSeeds))) === true,
  );

  // next actions
  await page.locator('[data-testid="next-tweak"]').click();
  await sleep(300);
  check(
    "tweak expands the parameter group and focuses the first slider",
    (await page.locator('[data-testid="group-params"] .panel-group-body').count()) === 1 &&
      (await page.evaluate(() => document.activeElement?.getAttribute("data-testid"))) ===
        "param-seaLevel",
  );
  await page.locator('[data-testid="next-export"]').click();
  await page.waitForSelector('[data-testid="export-dialog"]');
  check("next-export opens the export dialog", true);
  await page.keyboard.press("Escape");
  await sleep(150);

  // preset badge + recommend + reset
  const setSliderValue = async (testId, value) => {
    await page.locator(`[data-testid="${testId}"]`).evaluate((element, nextValue) => {
      element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(element, String(nextValue));
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }, value);
    await sleep(260);
    await page.locator(`[data-testid="${testId}"]`).evaluate((element) => {
      element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 }));
    });
    await waitIdle(page);
  };
  await setSliderValue("param-seaLevel", 0.48);
  const badgeText = await page
    .locator('[data-testid="preset-modified-badge"]')
    .innerText()
    .catch(() => "");
  check(
    "parameter group header shows the modified-preset badge",
    /基于 .+ · 已改 \d+ 项/.test(badgeText),
    badgeText,
  );
  await screenshot(page, "26-preset-badge.png");
  await page.locator('[data-testid="param-recommend-seaLevel"]').click();
  await waitIdle(page);
  const seaLevelAfterRecommend = await page.evaluate(
    () => window.__atlasDebug.getDocument().params.seaLevel,
  );
  check(
    "restore-recommended returns the slider to the scenario baseline",
    Math.abs(seaLevelAfterRecommend - 0.42) < 1e-9,
    String(seaLevelAfterRecommend),
  );
  await setSliderValue("param-riverDensity", 0.72);
  await page.locator('[data-testid="preset-reset"]').click();
  await waitIdle(page);
  const resetParams = await page.evaluate(() => window.__atlasDebug.getDocument().params);
  check(
    "one-click preset reset restores the preset parameter baseline",
    Math.abs(resetParams.seaLevel - 0.42) < 1e-9 &&
      Math.abs(resetParams.riverDensity - 0.5) < 1e-9,
    JSON.stringify({ seaLevel: resetParams.seaLevel, riverDensity: resetParams.riverDensity }),
  );
  check(
    "preset badge disappears after restoring the baseline",
    (await page.locator('[data-testid="preset-modified-badge"]').count()) === 0,
  );

  // generation history: thumbnails, restore + reverse, one undo entry
  const historyBefore = await page.evaluate(() => window.__atlasDebug.getGenerationHistory());
  check(
    "recent generation history keeps thumbnails + metadata",
    historyBefore.length >= 2 &&
      historyBefore.every((entry) => entry.thumbnail.startsWith("data:image/png")),
    `entries=${historyBefore.length}`,
  );
  check(
    "generation history is capped at 10",
    historyBefore.length <= 10,
    String(historyBefore.length),
  );
  const undoBeforeRestore = (await summary(page)).history.undo;
  const seedOfTarget = historyBefore[0].seed;
  await page.locator('[data-testid="gen-history-restore-0"]').click();
  await waitIdle(page);
  const restoredState = await summary(page);
  check(
    "restoring a history entry generates that world again",
    (await page.evaluate(() => window.__atlasDebug.getDocument().seed)) === seedOfTarget,
    `seed=${seedOfTarget}`,
  );
  check(
    "restoring history adds exactly one undo entry",
    restoredState.history.undo === undoBeforeRestore + 1,
    `${undoBeforeRestore} -> ${restoredState.history.undo}`,
  );
  check(
    "restoring history also keeps the current world recoverable",
    (await page.evaluate(() => window.__atlasDebug.getGenerationHistory())).length >=
      historyBefore.length,
  );
  await screenshot(page, "23-history.png");

  // draft preview while dragging a slider
  const riverSlider = page.locator('[data-testid="param-riverDensity"]');
  await riverSlider.evaluate((element) => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    for (const value of [0.35, 0.42, 0.48]) {
      setter.call(element, String(value));
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
  });
  await page.waitForSelector('[data-testid="gen-draft-badge"]', { timeout: 15_000 });
  check("dragging a slider shows the 512² draft badge", true);
  await screenshot(page, "24-draft.png");
  const draftState = await summary(page);
  check(
    "draft preview is flagged while the full generation is pending",
    draftState.draftActive === true || draftState.generationKind === "draft",
    `draftActive=${draftState.draftActive} kind=${draftState.generationKind}`,
  );
  await riverSlider.evaluate((element) => {
    element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, button: 0 }));
  });
  await waitIdle(page);
  check(
    "releasing the slider removes the draft badge",
    (await page.locator('[data-testid="gen-draft-badge"]').count()) === 0,
  );

  // continuous real-mouse drag: draft requests are throttled (not debounced)
  await page.bringToFront();
  if (
    (await page
      .locator('[data-testid="group-params"] .panel-group-head')
      .getAttribute("aria-expanded")) === "false"
  ) {
    await page.locator('[data-testid="group-params"] .panel-group-head').click();
    await sleep(200);
  }
  await page.locator('[data-testid="param-seaLevel"]').scrollIntoViewIfNeeded();
  await sleep(250);
  const dragStartState = await summary(page);
  const dragSliderBox = await page.locator('[data-testid="param-seaLevel"]').boundingBox();
  const dragHistoryBefore = dragStartState.historyCount;
  const dragUndoBefore = dragStartState.history.undo;
  const dragStartX = dragSliderBox.x + dragSliderBox.width * 0.2;
  const dragY = dragSliderBox.y + dragSliderBox.height / 2;
  await page.mouse.move(dragStartX, dragY);
  await page.mouse.down();
  const dragStartedAt = Date.now();
  let sawDraftBadgeDuringDrag = false;
  const dragKinds = [];
  for (let step = 1; step <= 12; step += 1) {
    const fraction = 0.2 + 0.6 * (step / 12);
    await page.mouse.move(dragSliderBox.x + dragSliderBox.width * fraction, dragY, {
      steps: 2,
    });
    await sleep(75);
    if ((await page.locator('[data-testid="gen-draft-badge"]').count()) > 0) {
      sawDraftBadgeDuringDrag = true;
    }
    dragKinds.push((await summary(page)).generationKind);
  }
  const dragElapsedMs = Date.now() - dragStartedAt;
  const duringDrag = await summary(page);
  const draftRequestsDuringDrag = duringDrag.draftRequests - dragStartState.draftRequests;
  check(
    "continuous slider drag fires throttled draft requests (>= 2 in ~1s)",
    draftRequestsDuringDrag >= 2,
    `requests=${draftRequestsDuringDrag} kinds=${JSON.stringify(dragKinds)}`,
  );
  const throttleLimit = Math.ceil(dragElapsedMs / 150) + 2;
  check(
    "draft requests are throttled by elapsed time, not fired per pointer move",
    draftRequestsDuringDrag <= throttleLimit && draftRequestsDuringDrag < 12 * 4,
    `requests=${draftRequestsDuringDrag} over ${dragElapsedMs}ms (limit ${throttleLimit})`,
  );
  check(
    "draft badge becomes visible while the slider is still held",
    sawDraftBadgeDuringDrag || duringDrag.draftActive === true,
    `saw=${sawDraftBadgeDuringDrag} active=${duringDrag.draftActive}`,
  );
  check(
    "draft previews add no generation-history entries and at most one action snapshot",
    duringDrag.generationHistoryCount === dragHistoryBefore &&
      duringDrag.history.undo - dragUndoBefore <= 1,
    `undo ${dragUndoBefore} -> ${duringDrag.history.undo}, short-history ${dragHistoryBefore} -> ${duringDrag.generationHistoryCount}`,
  );
  await page.mouse.up();
  const fullSeqBefore = duringDrag.generation.seq;
  await page.waitForFunction(
    () => {
      const state = window.__atlasDebug.getSummary();
      return (
        state.draftActive === false &&
        state.generation.phase === "idle" &&
        state.generationKind === "full"
      );
    },
    undefined,
    { timeout: 45_000, polling: 100 },
  );
  const afterDrag = await summary(page);
  check(
    "releasing the slider clears the draft badge and runs a full generation",
    afterDrag.draftActive === false &&
      afterDrag.generationKind === "full" &&
      afterDrag.generation.seq > fullSeqBefore,
    `seq ${fullSeqBefore} -> ${afterDrag.generation.seq}`,
  );
  check(
    "the drag commits exactly one undo entry",
    afterDrag.history.undo === dragUndoBefore + 1,
    `${dragUndoBefore} -> ${afterDrag.history.undo}`,
  );
  await waitIdle(page);

  // cancel generation, old map stays, then regenerate
  const beforeCancel = await summary(page);
  await page.locator('[data-testid="next-reroll"]').click();
  await page.waitForSelector('[data-testid="gen-cancel"]', { timeout: 8_000 });
  await page.locator('[data-testid="gen-cancel"]').click();
  await page.waitForFunction(
    () => window.__atlasDebug.getSummary().generation.phase === "idle",
    undefined,
    { timeout: 10_000, polling: 100 },
  );
  const afterCancel = await summary(page);
  check(
    "cancelling generation keeps the previous map",
    afterCancel.layers !== null &&
      afterCancel.layerSignature.height === beforeCancel.layerSignature.height,
  );
  check(
    "cancel toast explains the previous map was kept",
    (await page.locator('[data-testid="toast"]').last().innerText()).includes("已取消"),
  );
  await page.locator('[data-testid="next-reroll"]').click();
  await sleep(250);
  await waitIdle(page);
  check("generation can be started again after cancel", (await summary(page)).layers !== null);

  // quick mode: 512² preview without touching params.gridSize
  const fullSizeSeed = await page.evaluate(() => window.__atlasDebug.getDocument().params.gridSize);
  await page.evaluate(() => window.__atlasDebug.quickGenerate());
  await waitIdle(page);
  const quickState = await summary(page);
  check(
    "quick mode regenerates a 512² preview",
    quickState.layers.size === 512 &&
      (await page.evaluate(() => window.__atlasDebug.getDocument().params.gridSize)) === fullSizeSeed,
    `layers=${quickState.layers.size} grid=${fullSizeSeed}`,
  );
  await page.locator('[data-testid="next-reroll"]').click();
  await sleep(250);
  await waitIdle(page);
  check("full-size generation restores 1024² layers", (await summary(page)).layers.size === 1024);

  // reroll names only
  const beforeNames = await summary(page);
  const undoBeforeNames = beforeNames.history.undo;
  await page.locator('[data-testid="reroll-names"]').click();
  await sleep(260);
  await waitIdle(page);
  const afterNames = await summary(page);
  check(
    "name reroll keeps terrain, rivers and biomes untouched",
    afterNames.layerSignature.height === beforeNames.layerSignature.height &&
      afterNames.layerSignature.river === beforeNames.layerSignature.river &&
      afterNames.layerSignature.biome === beforeNames.layerSignature.biome,
    JSON.stringify({ before: beforeNames.layerSignature, after: afterNames.layerSignature }),
  );
  check(
    "name reroll adds exactly one history entry",
    afterNames.history.undo === undoBeforeNames + 1,
    `${undoBeforeNames} -> ${afterNames.history.undo}`,
  );
  check(
    "document exposes stageSeeds after rerolls",
    (await page.evaluate(() => Boolean(window.__atlasDebug.getDocument().params.stageSeeds))) ===
      true,
  );
  await page.waitForFunction(
    () => window.__atlasDebug.getSummary().save.phase === "saved",
    undefined,
    { timeout: 20_000, polling: 150 },
  );
  const autosavedSeeds = await page.evaluate(() => {
    const raw = localStorage.getItem("atlas_forge.world.v1");
    if (!raw) return null;
    try {
      return JSON.parse(raw).document?.params?.stageSeeds ?? null;
    } catch {
      return null;
    }
  });
  check(
    "autosave JSON carries stageSeeds after a name reroll",
    autosavedSeeds !== null && typeof autosavedSeeds.human === "number",
    JSON.stringify(autosavedSeeds),
  );
  const v4SummaryAliases = await summary(page);
  check(
    "debug summary exposes historyCount / activePreset / locks",
    typeof v4SummaryAliases.historyCount === "number" &&
      v4SummaryAliases.activePreset === v4SummaryAliases.scenarioId &&
      typeof v4SummaryAliases.locks?.coast === "boolean",
    JSON.stringify({
      historyCount: v4SummaryAliases.historyCount,
      activePreset: v4SummaryAliases.activePreset,
      locks: v4SummaryAliases.locks,
    }),
  );

  // readability banner: force unreadable water world, fix + dismiss
  if (
    (await page
      .locator('[data-testid="group-params"] .panel-group-head')
      .getAttribute("aria-expanded")) === "false"
  ) {
    await page.locator('[data-testid="group-params"] .panel-group-head').click();
    await sleep(200);
  }
  await setSliderValue("param-seaLevel", 0.95);
  await setSliderValue("param-riverDensity", 0);
  await page.waitForSelector('[data-testid="readability-banner"]', { timeout: 20_000 });
  const readabilityText = await page.locator('[data-testid="readability-banner"]').innerText();
  check(
    "readability banner appears for unreadable worlds",
    readabilityText.includes("可能不好读"),
    readabilityText.replace(/\n/g, " | ").slice(0, 180),
  );
  await screenshot(page, "25-readability.png");
  const undoBeforeFix = (await summary(page)).history.undo;
  const beforeFixSnapshot = await page.evaluate(() => {
    const doc = window.__atlasDebug.getDocument();
    return JSON.stringify({ params: doc.params, style: doc.style });
  });
  await page.locator('[data-testid="readability-fix"]').click();
  await waitIdle(page);
  const afterFixSnapshot = await page.evaluate(() => {
    const doc = window.__atlasDebug.getDocument();
    return JSON.stringify({ params: doc.params, style: doc.style });
  });
  check(
    "one-click readability fix merges suggestions with one history entry",
    (await summary(page)).history.undo === undoBeforeFix + 1 &&
      afterFixSnapshot !== beforeFixSnapshot,
    `${undoBeforeFix} -> ${(await summary(page)).history.undo}`,
  );
  await page.locator('[data-testid="readability-dismiss"]').click();
  await sleep(200);
  check(
    "readability banner can be dismissed without blocking the editor",
    (await page.locator('[data-testid="readability-banner"]').count()) === 0,
  );

  // stageSeeds in export JSON; legacy JSON without stageSeeds still imports
  const v4Export = page.waitForEvent("download", { timeout: 20_000 });
  await page.locator('[data-testid="export-json"]').click();
  const v4JsonPath = join(OUT, "v4-export.json");
  await (await v4Export).saveAs(v4JsonPath);
  const v4Json = JSON.parse(readFileSync(v4JsonPath, "utf8"));
  check(
    "JSON export carries stageSeeds",
    Boolean(v4Json.params?.stageSeeds) &&
      typeof v4Json.params.stageSeeds.human === "number",
    JSON.stringify(v4Json.params?.stageSeeds ?? null),
  );
  delete v4Json.params.stageSeeds;
  const legacySeedsPath = join(OUT, "legacy-no-stage-seeds.json");
  writeFileSync(legacySeedsPath, JSON.stringify(v4Json));
  await page.locator('[data-testid="import-json-input"]').setInputFiles(legacySeedsPath);
  await page.waitForFunction(
    (seed) => window.__atlasDebug.getDocument().seed === seed,
    v4Json.seed,
    { timeout: 20_000, polling: 100 },
  );
  await waitIdle(page);
  check(
    "old JSON without stageSeeds imports and regenerates normally",
    (await summary(page)).generation.phase !== "error" &&
      (await page.evaluate(() => window.__atlasDebug.getDocument().params.stageSeeds)) ===
        undefined,
  );
  await page.waitForFunction(
    () => window.__atlasDebug.getSummary().save.phase === "saved",
    undefined,
    { timeout: 20_000, polling: 150 },
  );


  // ── 18b. v0.5 SVG export / diagnostics / algorithm migration ───────
  log("v0.5 svg / diagnostics / algorithm");
  const v5Algorithm = await page.evaluate(() => window.__atlasDebug.getAlgorithm());
  check(
    "new-world documents default to the classic terrain on the v2 pipeline",
    v5Algorithm.kind === "classic" && v5Algorithm.version >= 2,
    JSON.stringify(v5Algorithm),
  );
  check(
    "algorithm badge reports the default classic terrain for new worlds",
    (await page.locator('[data-testid="algorithm-badge"]').innerText()).includes("经典"),
    await page.locator('[data-testid="algorithm-badge"]').innerText(),
  );

  await page.waitForSelector('[data-testid="world-diagnostics"]', { timeout: 20_000 });
  const diagnostics = await page.evaluate(() => window.__atlasDebug.getDiagnostics());
  const diagValue = async (testId) =>
    (await page.locator(`[data-testid="${testId}"]`).innerText()).trim();
  check(
    "diagnostics land fraction matches the computed metrics",
    (await diagValue("diag-land-fraction")).includes(
      `${(diagnostics.landFraction * 100).toFixed(1)}%`,
    ),
    `${await diagValue("diag-land-fraction")} vs ${(diagnostics.landFraction * 100).toFixed(1)}%`,
  );
  check(
    "diagnostics river cells match the computed metrics",
    (await diagValue("diag-river-cells")) === String(diagnostics.riverCells),
    `${await diagValue("diag-river-cells")} vs ${diagnostics.riverCells}`,
  );
  check(
    "diagnostics Strahler max is a positive stream order",
    diagnostics.strahlerMax !== null &&
      diagnostics.strahlerMax >= 1 &&
      (await diagValue("diag-strahler")) === String(diagnostics.strahlerMax),
    `strahler=${diagnostics.strahlerMax}`,
  );
  check(
    "diagnostics hanging-river rate is ~0 for a healthy hydrology pass",
    diagnostics.hangingRiverRate === null ||
      diagnostics.hangingRiverRate < 0.02,
    `hanging=${diagnostics.hangingRiverRate}`,
  );
  check(
    "diagnostics plate count matches the active terrain model",
    // v0.5 ships the proven fBm terrain by default; the plate model is opt-in.
    // The panel must show a count for plates and "—" otherwise.
    (diagnostics.plateCount === null
      ? (await diagValue("diag-plate-count")).trim().includes("—")
      : diagnostics.plateCount > 0 &&
        diagnostics.plateCount < 64 &&
        (await diagValue("diag-plate-count")) === String(diagnostics.plateCount)),
    `plates=${diagnostics.plateCount}`,
  );
  check(
    "diagnostics biome bars and stage timings are populated",
    (await page.locator('[data-testid="diag-biome-bars"] .diag-biome').count()) >= 2 &&
      /地形[\s\S]*水文[\s\S]*合计/.test(await diagValue("diag-stage-timings")),
  );

  const diagSeqBefore = (await summary(page)).generation.seq;
  await page.locator('[data-testid="group-diagnostics"] .panel-group-head').click();
  await sleep(180);
  await page.locator('[data-testid="group-diagnostics"] .panel-group-head').click();
  await sleep(180);
  check(
    "opening/closing the diagnostics panel never regenerates",
    (await summary(page)).generation.seq === diagSeqBefore,
  );
  await page.locator('[data-testid="diag-climate-toggle"]').click();
  await sleep(400);
  const overlayOn = await summary(page);
  check(
    "climate diagnostics overlay toggles without regenerating",
    overlayOn.generation.seq === diagSeqBefore && overlayOn.climateOverlay === true,
    `seq ${diagSeqBefore} -> ${overlayOn.generation.seq}`,
  );
  await screenshot(page, "29-climate-overlay.png");
  await page.locator('[data-testid="diag-climate-toggle"]').click();
  await sleep(220);
  check("climate overlay can be switched off", (await summary(page)).climateOverlay === false);
  await screenshot(page, "28-diagnostics.png");

  // SVG vector export
  await page.locator('[data-testid="export-png"]').click();
  await page.waitForSelector('[data-testid="export-dialog"]');
  check(
    "export dialog exposes the SVG vector option",
    (await page.locator('[data-testid="export-format-svg"]').count()) === 1,
  );
  await page.locator('[data-testid="export-size-2048"]').click();
  await page.locator('[data-testid="export-format-svg"]').click();
  await sleep(350);
  await screenshot(page, "27-svg-option.png");
  check(
    "SVG filename preview follows atlas-<world>-<seed>-<preset>-<size>.svg",
    /^atlas-.+-20261018-(parchment|aged-ink)-2048\.svg$/.test(
      (await page.locator('[data-testid="export-filename"]').innerText()).trim(),
    ),
    await page.locator('[data-testid="export-filename"]').innerText(),
  );
  check(
    "SVG option shows a print-size hint",
    (await page.locator('[data-testid="export-print-size"]').innerText()).includes("@300dpi"),
    await page.locator('[data-testid="export-print-size"]').innerText(),
  );
  const svgDownload = page.waitForEvent("download", { timeout: 150_000 });
  await page.locator('[data-testid="export-start"]').click();
  const svgDownloaded = await svgDownload;
  const svgPath = join(OUT, "exported-2048.svg");
  await svgDownloaded.saveAs(svgPath);
  const svgText = readFileSync(svgPath, "utf8");
  check(
    "downloaded SVG filename follows the atlas naming scheme",
    /^atlas-.+-20261018-(parchment|aged-ink)-2048\.svg$/.test(svgDownloaded.suggestedFilename()),
    svgDownloaded.suggestedFilename(),
  );
  check(
    "downloaded file is valid SVG vector markup",
    svgText.trimStart().startsWith("<svg") &&
      (svgText.includes("<path") || svgText.includes("<text")),
    `${Buffer.byteLength(svgText)} bytes`,
  );
  check(
    "SVG vector export is non-trivial in size (> 10KB)",
    Buffer.byteLength(svgText) > 10_000,
    `${Buffer.byteLength(svgText)} bytes`,
  );
  await page.waitForSelector('[data-testid="export-result"]', { timeout: 30_000 });
  await page.locator('[data-testid="export-dialog-close"]').click();
  await sleep(150);

  // Old-world migration + upgrade (undoable)
  const v5ExportDownload = page.waitForEvent("download", { timeout: 20_000 });
  await page.locator('[data-testid="export-json"]').click();
  const v5ExportPath = join(OUT, "v05-export.json");
  await (await v5ExportDownload).saveAs(v5ExportPath);
  const v5Json = JSON.parse(readFileSync(v5ExportPath, "utf8"));
  check(
    "JSON export keeps algorithmVersion and terrainModel",
    v5Json.algorithmVersion === 2 &&
      (v5Json.params?.terrainModel === "fbm" || v5Json.params?.terrainModel === "plates"),
    JSON.stringify({
      algorithmVersion: v5Json.algorithmVersion,
      terrainModel: v5Json.params?.terrainModel,
    }),
  );
  delete v5Json.algorithmVersion;
  if (v5Json.params) delete v5Json.params.terrainModel;
  const v05LegacyPath = join(OUT, "v04-legacy.json");
  writeFileSync(v05LegacyPath, JSON.stringify(v5Json));
  await page.locator('[data-testid="import-json-input"]').setInputFiles(v05LegacyPath);
  await page.waitForFunction(
    () => window.__atlasDebug.getAlgorithm().kind === "classic",
    undefined,
    { timeout: 20_000, polling: 100 },
  );
  await waitIdle(page);
  check(
    "legacy JSON without algorithmVersion opens as classic fbm",
    (await page.evaluate(() => window.__atlasDebug.getAlgorithm().kind)) === "classic" &&
      (await page.evaluate(
        () => window.__atlasDebug.getDocument().params.terrainModel,
      )) === "fbm",
  );
  check(
    "algorithm badge switches to 经典算法",
    (await page.locator('[data-testid="algorithm-badge"]').innerText()).includes("经典"),
    await page.locator('[data-testid="algorithm-badge"]').innerText(),
  );
  check(
    "legacy import toast explains the classic migration",
    (await page.locator('[data-testid="toast"]').last().innerText()).includes("经典算法"),
  );
  check(
    "upgrade button is offered for classic worlds",
    (await page.locator('[data-testid="upgrade-algorithm"]').count()) === 1,
  );
  await screenshot(page, "30-algorithm-badge.png");
  const undoBeforeUpgrade = (await summary(page)).history.undo;
  await page.locator('[data-testid="upgrade-algorithm"]').click();
  await sleep(300);
  await waitIdle(page);
  const upgradedState = await summary(page);
  check(
    "upgrade switches the badge to 板块算法",
    (await page.locator('[data-testid="algorithm-badge"]').innerText()).includes("板块"),
  );
  check(
    "upgrade writes algorithmVersion=2 and terrainModel=plates",
    (await page.evaluate(() => {
      const doc = window.__atlasDebug.getDocument();
      return { version: doc.algorithmVersion, terrainModel: doc.params.terrainModel };
    })).version === 2 &&
      (await page.evaluate(
        () => window.__atlasDebug.getDocument().params.terrainModel,
      )) === "plates",
  );
  check(
    "upgrade adds exactly one undo entry",
    upgradedState.history.undo === undoBeforeUpgrade + 1,
    `${undoBeforeUpgrade} -> ${upgradedState.history.undo}`,
  );
  await page.keyboard.press("Control+z");
  await waitIdle(page);
  check(
    "undo restores the classic algorithm",
    (await page.evaluate(() => window.__atlasDebug.getAlgorithm().kind)) === "classic" &&
      (await page.evaluate(
        () => window.__atlasDebug.getDocument().params.terrainModel,
      )) === "fbm",
  );
  await page.waitForFunction(
    () => window.__atlasDebug.getSummary().save.phase === "saved",
    undefined,
    { timeout: 20_000, polling: 150 },
  );

  // ── 14. collapsible layout persistence ─────────────────────────────
  log("collapsible layout");
  await page.waitForFunction(
    () => window.__atlasDebug.getSummary().save.phase === "saved",
    undefined,
    { timeout: 15_000, polling: 150 },
  );
  await page.locator('[data-testid="group-params"] .panel-group-head').click();
  await sleep(220);
  check(
    "collapsing a section hides its body",
    (await page.locator('[data-testid="group-params"] .panel-group-body').count()) === 0,
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => Boolean(window.__atlasDebug), undefined, { timeout: 20_000 });
  await waitIdle(page);
  const collapsedAfterReload = await page
    .locator('[data-testid="group-params"] .panel-group-head')
    .getAttribute("aria-expanded");
  check(
    "collapsed state persists across reloads",
    collapsedAfterReload === "false",
    `aria-expanded=${collapsedAfterReload}`,
  );
  await screenshot(page, "19-collapsed-layout.png");
  await page.locator('[data-testid="group-params"] .panel-group-head').click();
  await sleep(220);
  check(
    "re-expanding a section restores its body",
    (await page.locator('[data-testid="group-params"] .panel-group-body').count()) === 1,
  );

  // ── 15. accessibility ──────────────────────────────────────────────
  log("accessibility");
  const ariaLabels = await page.evaluate(() => {
    const ids = ["reroll", "undo", "redo", "help", "zoom-in", "zoom-out"];
    return ids.map((id) => {
      const element = document.querySelector(`[data-testid="${id}"]`);
      return { id, label: element?.getAttribute("aria-label") ?? null };
    });
  });
  check(
    "icon buttons expose aria-labels",
    ariaLabels.every((entry) => typeof entry.label === "string" && entry.label.length > 0),
    JSON.stringify(ariaLabels),
  );
  const statusA11y = await page.evaluate(() => {
    const status = document.querySelector('[data-testid="status"]');
    return { role: status?.getAttribute("role"), live: status?.getAttribute("aria-live") };
  });
  check(
    "status text announces changes via aria-live",
    statusA11y.live === "polite",
    JSON.stringify(statusA11y),
  );
  await page.keyboard.press("4");
  await sleep(150);
  const firstListItem = page.locator('[data-testid^="place-list-item-"]').first();
  await firstListItem.focus();
  await page.keyboard.press("Enter");
  await sleep(220);
  check(
    "place list is keyboard reachable and Enter selects",
    (await summary(page)).places.selected !== null,
    JSON.stringify((await summary(page)).places.selected),
  );
  await page.locator('[data-testid="reset-all-params"]').click();
  await page.locator('[data-testid="reset-all-params"]').click();
  await sleep(250);
  check(
    "duplicate toasts collapse into a single toast",
    (await page.locator('[data-testid="toast"]').count()) <= 1,
  );
  await waitIdle(page);
  await page.waitForFunction(
    () => window.__atlasDebug.getSummary().hitBoxesSource !== null,
    undefined,
    { timeout: 30_000, polling: 120 },
  );


  // ── 19. first-run welcome panel (fresh profile) ────────────────────
  log("first-run welcome");
  const welcomeContext = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
  const welcomePage = await welcomeContext.newPage();
  welcomePage.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`welcome: ${message.text()}`);
  });
  welcomePage.on("pageerror", (error) => pageErrors.push(`welcome: ${String(error)}`));
  await welcomePage.goto(WEB_URL, { waitUntil: "domcontentloaded" });
  await welcomePage.waitForFunction(() => Boolean(window.__atlasDebug), undefined, {
    timeout: 30_000,
  });
  await welcomePage.waitForSelector('[data-testid="welcome"]', { timeout: 15_000 });
  check(
    "first visit shows the welcome scenario panel",
    (await welcomePage.locator('[data-testid="welcome"]').count()) === 1 &&
      (await welcomePage.locator('[data-testid^="preset-card-"]').count()) === 4,
  );
  await welcomePage.waitForFunction(
    () =>
      Array.from(document.querySelectorAll('[data-testid="welcome"] img.preset-thumb-img')).every(
        (image) => image.complete && image.naturalWidth > 0,
      ),
    undefined,
    { timeout: 15_000, polling: 100 },
  );
  check(
    "scenario cards show distinct tagline/description lines (no duplicate copy)",
    await welcomePage.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="welcome"] .preset-card')).every(
        (card) => {
          const tagline = card.querySelector(".preset-card-tagline")?.textContent?.trim() ?? "";
          const desc = card.querySelector(".preset-card-desc")?.textContent?.trim() ?? "";
          return tagline.length > 0 && desc.length > 0 && tagline !== desc;
        },
      ),
    ),
  );
  check(
    "welcome thumbnails no longer render the placeholder diamond glyph",
    (await welcomePage.locator(".preset-thumb-glyph").count()) === 0,
  );
  check(
    "scenario cards use the shipped preset thumbnails",
    (await welcomePage.locator('[data-testid="welcome"] img.preset-thumb-img').count()) === 4 &&
      (await welcomePage.evaluate(() =>
        Array.from(document.querySelectorAll('[data-testid="welcome"] img.preset-thumb-img')).every(
          (image) => image.naturalWidth > 0,
        ),
      )),
  );
  await welcomePage.screenshot({ path: join(OUT, "21-welcome.png") });
  await welcomePage.locator('[data-testid="preset-card-archipelago"]').click();
  await waitIdle(welcomePage);
  const welcomeState = await summary(welcomePage);
  check(
    "picking a preset applies the scenario and closes the welcome panel",
    welcomeState.scenarioId === "archipelago" &&
      (await welcomePage.locator('[data-testid="welcome"]').count()) === 0,
    `scenario=${welcomeState.scenarioId}`,
  );
  check(
    "generated summary names the picked scenario",
    (await welcomePage.locator('[data-testid="generated-summary"]').innerText()).includes(
      "群岛贸易",
    ),
    await welcomePage.locator('[data-testid="generated-summary"]').innerText(),
  );
  const archipelagoParams = await welcomePage.evaluate(
    () => window.__atlasDebug.getDocument().params,
  );
  check(
    "archipelago preset applies its true continentScale (4.0)",
    Math.abs(archipelagoParams.continentScale - 4) < 1e-9,
    String(archipelagoParams.continentScale),
  );
  check(
    "continent-scale slider accepts the 4.0 preset range",
    (await welcomePage
      .locator('[data-testid="param-continentScale"]')
      .getAttribute("max")) === "4",
  );
  check(
    "scenario documents are stamped with the plates algorithm version",
    (await welcomePage.evaluate(
      () => window.__atlasDebug.getDocument().algorithmVersion,
    )) === 2,
  );
  check(
    "welcome completion is persisted (onboarded)",
    (await welcomePage.evaluate(() =>
      localStorage.getItem("atlas_forge.ui.onboarded"),
    )) === "1",
  );
  const welcomeSeed = await welcomePage.evaluate(() =>
    window.__atlasDebug.getDocument().seed,
  );
  await welcomePage.locator('[data-testid="preset-open"]').click();
  await welcomePage.waitForSelector('[data-testid="welcome"]');
  check("the scenario button reopens the welcome panel", true);
  await welcomePage.locator('[data-testid="welcome-skip"]').click();
  await sleep(150);
  check(
    "skip closes the panel without replacing the document",
    (await welcomePage.locator('[data-testid="welcome"]').count()) === 0 &&
      (await welcomePage.evaluate(() => window.__atlasDebug.getDocument().seed)) ===
        welcomeSeed,
  );
  await welcomePage.locator('[data-testid="preset-open"]').click();
  await welcomePage.waitForSelector('[data-testid="welcome"]');
  await welcomePage.locator('[data-testid="welcome-random"]').click();
  await waitIdle(welcomePage);
  const randomState = await summary(welcomePage);
  check(
    "random-one picks a different scenario and closes the panel",
    randomState.scenarioId !== "archipelago" &&
      randomState.scenarioId.length > 0 &&
      (await welcomePage.locator('[data-testid="welcome"]').count()) === 0,
    `scenario=${randomState.scenarioId}`,
  );
  await welcomeContext.close();

  // ── 16. reduced motion ────────────────────────────────────────────
  log("reduced motion");
  const reducedContext = await browser.newContext({
    viewport: { width: 1680, height: 1000 },
    reducedMotion: "reduce",
  });
  const reducedPage = await reducedContext.newPage();
  await reducedPage.addInitScript(() => localStorage.setItem("atlas_forge.ui.onboarded", "1"));
  reducedPage.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(`reduced-motion: ${message.text()}`);
  });
  reducedPage.on("pageerror", (error) => pageErrors.push(`reduced-motion: ${String(error)}`));
  await reducedPage.goto(WEB_URL, { waitUntil: "domcontentloaded" });
  await reducedPage.waitForSelector('[data-testid="map-canvas"]', { timeout: 30_000 });
  const reducedTransition = await reducedPage.evaluate(
    () => getComputedStyle(document.querySelector(".btn")).transitionDuration,
  );
  check(
    "prefers-reduced-motion disables transitions",
    Number.parseFloat(reducedTransition) < 0.01,
    reducedTransition,
  );
  await reducedContext.close();

  // ── 17. narrow desktop layouts: 1280×800 and 1024×768 ─────────────
  log("responsive layouts");
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 1024, height: 768 },
  ]) {
    const narrowContext = await browser.newContext({ viewport });
    const narrowPage = await narrowContext.newPage();
    await narrowPage.addInitScript(() => localStorage.setItem("atlas_forge.ui.onboarded", "1"));
    narrowPage.on("console", (message) => {
      if (message.type() === "error") {
        consoleErrors.push(`${viewport.width}px console: ${message.text()}`);
      }
    });
    narrowPage.on("pageerror", (error) =>
      pageErrors.push(`${viewport.width}px pageerror: ${String(error)}`),
    );
    await narrowPage.goto(WEB_URL, { waitUntil: "domcontentloaded" });
    await narrowPage.waitForSelector('[data-testid="map-canvas"]', { timeout: 30_000 });
    await narrowPage.waitForFunction(() => Boolean(window.__atlasDebug), undefined, {
      timeout: 20_000,
    });
    await narrowPage.waitForFunction(
      () => {
        const data = window.__atlasDebug.getSummary();
        return data.ready && data.hitBoxesSource !== null;
      },
      undefined,
      { timeout: 60_000, polling: 120 },
    );
    const metrics = await narrowPage.evaluate(() => {
      const canvas = document.querySelector('[data-testid="map-canvas"]');
      const rect = canvas.getBoundingClientRect();
      const scrolling = document.scrollingElement;
      return {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        scrollWidth: scrolling.scrollWidth,
        scrollHeight: scrolling.scrollHeight,
        canvas: { width: rect.width, height: rect.height },
        topbarHeight: document.querySelector(".topbar")?.getBoundingClientRect().height ?? 0,
      };
    });
    check(
      `no page overflow at ${viewport.width}×${viewport.height}`,
      metrics.scrollWidth <= metrics.innerWidth + 1 &&
        metrics.scrollHeight <= metrics.innerHeight + 1,
      JSON.stringify(metrics),
    );
    check(
      `canvas stays usable at ${viewport.width}×${viewport.height}`,
      metrics.canvas.width > 220 && metrics.canvas.height > 250,
      JSON.stringify(metrics.canvas),
    );
    await narrowPage.screenshot({ path: join(OUT, `20-narrow-${viewport.width}.png`) });
    await narrowContext.close();
  }

  await page.bringToFront();
  await page.waitForFunction(
    () => {
      const state = window.__atlasDebug.getSummary();
      return (
        state.generation.phase === "idle" &&
        state.render.rendering === false &&
        state.hitBoxesSource !== null &&
        state.perf.lastGenerationMs !== null &&
        state.perf.lastRenderMs !== null
      );
    },
    undefined,
    { timeout: 60_000, polling: 150 },
  );
  const finalPerf = await summary(page);
  check(
    "polish does not regress generation/render budgets (sanity)",
    (finalPerf.perf.lastGenerationMs ?? 0) < 2000 &&
      (finalPerf.perf.lastRenderMs ?? 0) < 500 &&
      finalPerf.hitBoxCount > 0,
    JSON.stringify(finalPerf.perf),
  );
  log(
    `performance snapshot: ${JSON.stringify(finalPerf.perf)} hitBoxes=${finalPerf.hitBoxCount} places=${
      finalPerf.places.visibleSettlements + finalPerf.places.visibleLabels
    }`,
  );

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
    performance: finalPerf
      ? {
          ...finalPerf.perf,
          hitBoxCount: finalPerf.hitBoxCount,
          visiblePlaces: finalPerf.places.visibleSettlements + finalPerf.places.visibleLabels,
          places: finalPerf.places,
        }
      : null,
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
