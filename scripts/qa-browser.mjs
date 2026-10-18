/**
 * Browser QA harness for Atlas Forge (M6 end-to-end).
 *
 * Drives the real app with the cached Playwright Chromium:
 *   generate -> tweak params -> draw an elevation stroke -> undo -> export JSON
 *   -> server-side PNG render -> style toggle -> screenshots + error report
 *
 * Reuses an already-running dev server when available; otherwise starts
 * `pnpm dev` and tears the whole process group down afterwards.
 *
 * Usage:
 *   node scripts/qa-browser.mjs [--no-server]
 * Output: out/e2e/*.png, out/e2e/report.json, out/e2e/exported-world.json
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

const ROOT = process.cwd();
const OUT = join(ROOT, "out", "e2e");
const WEB_URL = process.env.WEB_URL ?? "http://127.0.0.1:5173/";
const API_HEALTH_URL = process.env.API_URL ?? "http://127.0.0.1:8787/api/health";
const API_RENDER_URL = API_HEALTH_URL.replace(/\/api\/health$/, "/api/render");
const CHROME =
  process.env.CHROME_PATH ??
  join(homedir(), ".cache", "ms-playwright", "chromium-1243", "chrome-linux64", "chrome");
const NO_SERVER = process.argv.includes("--no-server");

mkdirSync(OUT, { recursive: true });

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
const notes = [];
let serverProcess = null;
let startedServer = false;

async function urlOk(url, timeoutMs = 1500) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForUrl(url, timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await urlOk(url, 2000)) return true;
    await sleep(400);
  }
  return false;
}

async function startServers() {
  const webUp = await urlOk(WEB_URL);
  const apiUp = await urlOk(API_HEALTH_URL);
  if (webUp && apiUp) {
    notes.push("reusing already-running dev servers");
    return;
  }
  notes.push("starting pnpm dev");
  serverProcess = spawn("pnpm", ["dev"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, CI: "1" },
    detached: true,
  });
  startedServer = true;
  let log = "";
  serverProcess.stdout.on("data", (chunk) => (log += String(chunk)));
  serverProcess.stderr.on("data", (chunk) => (log += String(chunk)));
  const webReady = await waitForUrl(WEB_URL);
  const apiReady = await waitForUrl(API_HEALTH_URL);
  notes.push(`web ready=${webReady} api ready=${apiReady}`);
  if (!webReady) {
    notes.push(`server log tail:\n${log.slice(-4000)}`);
    throw new Error("web dev server did not become ready");
  }
}

async function stopServers() {
  const child = serverProcess;
  if (!startedServer || !child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* gone */
    }
  }
  await sleep(1_200);
  try {
    if (child.exitCode === null) process.kill(-child.pid, "SIGKILL");
  } catch {
    /* gone */
  }
}

async function shot(page, name) {
  const file = join(OUT, name);
  await page.screenshot({ path: file, fullPage: false });
  notes.push(`screenshot ${file}`);
}

async function waitState(page, states, timeoutMs = 40_000) {
  const wanted = states.map((state) => `[data-state="${state}"]`).join(",");
  try {
    await page.waitForSelector(`[data-testid="status"]${wanted}`, { timeout: timeoutMs });
    return true;
  } catch {
    notes.push(`waitState timeout, wanted ${states.join("|")}`);
    return false;
  }
}

async function waitGenerated(page) {
  const busy = await waitState(page, ["generating", "idle"], 15_000);
  if (busy) await waitState(page, ["idle", "error"], 60_000);
  return busy;
}

async function setSlider(page, testId, value) {
  const input = page.locator(`[data-testid="${testId}"]`).first();
  if ((await input.count()) === 0) {
    notes.push(`slider not found: ${testId}`);
    return false;
  }
  await input.evaluate((el, v) => {
    const pointer = (type) =>
      new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse" });
    el.dispatchEvent(pointer("pointerdown"));
    // React tracks the input value internally: use the native prototype setter
    // so the synthetic input event is not swallowed by the value tracker.
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    descriptor?.set?.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(pointer("pointerup"));
    el.blur();
  }, value);
  notes.push(`slider ${testId} -> ${value}`);
  return true;
}

async function main() {
  if (!existsSync(CHROME)) throw new Error(`chromium not found at ${CHROME}`);
  if (!NO_SERVER) await startServers();

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const context = await browser.newContext({
    viewport: { width: 1680, height: 1000 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const location = msg.location();
    if (/favicon/i.test(location.url ?? "")) return;
    consoleErrors.push(`${msg.text()} @ ${location.url ?? "?"}`);
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (/favicon/i.test(url)) return;
    failedRequests.push(`${request.method()} ${url} :: ${request.failure()?.errorText}`);
  });

  await page.goto(WEB_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector('[data-testid="map-canvas"]', { timeout: 30_000 });
  await page
    .waitForFunction(() => globalThis.__atlasDebug?.getSummary?.()?.layers != null, { timeout: 60_000 })
    .catch(() => notes.push("layers did not become ready in time"));
  await waitGenerated(page);
  await sleep(500);
  await shot(page, "01-initial.png");

  // 0. Bundled EB Garamond must be registered in the browser (preview == server export).
  try {
    const fontReady = await page.evaluate(() => document.fonts.check('16px "EB Garamond"'));
    notes.push(`browser font EB Garamond ready=${fontReady}`);
  } catch (error) {
    notes.push(`font check failed: ${String(error)}`);
  }

  // 1. Explicit regenerate.
  await page.locator('[data-testid="generate"]').click();
  await waitGenerated(page);
  await shot(page, "02-generate.png");

  // 2. Parameter change (sea level).
  const sliderOk = await setSlider(page, "param-seaLevel", 0.47);
  if (sliderOk) await waitGenerated(page);
  {
    const seaLevel = await page.evaluate(
      () => globalThis.__atlasDebug?.getDocument?.()?.params?.seaLevel ?? null,
    );
    notes.push(`param seaLevel applied=${seaLevel}`);
  }
  await shot(page, "03-param-seaLevel.png");

  // 3. Elevation brush stroke on the map.
  await page.locator('[data-testid="tool-elevation"]').click();
  const canvas = page.locator('[data-testid="map-canvas"]').first();
  const box = await canvas.boundingBox();
  if (box) {
    const px = (fx) => box.x + box.width * fx;
    const py = (fy) => box.y + box.height * fy;
    await page.mouse.move(px(0.42), py(0.45));
    await page.mouse.down();
    for (let i = 1; i <= 16; i += 1) {
      await page.mouse.move(px(0.42 + i * 0.012), py(0.45 + Math.sin(i / 3) * 0.03));
      await sleep(14);
    }
    await page.mouse.up();
    notes.push("drew elevation brush stroke");
    await sleep(300);
    await waitGenerated(page);
    await shot(page, "04-brush-elevation.png");
  } else {
    notes.push("map canvas has no bounding box");
  }

  // 4. Undo the stroke.
  await page.keyboard.press("Control+z");
  await sleep(400);
  await waitGenerated(page);
  await shot(page, "05-undo.png");

  // 4b. Forced-river tool: click a short path and commit, then verify override survives.
  try {
    await page.locator('[data-testid="tool-river"]').click();
    const rbox = await page.locator('[data-testid="map-canvas"]').boundingBox();
    if (rbox) {
      const points = [
        [0.30, 0.58],
        [0.37, 0.62],
        [0.44, 0.60],
        [0.51, 0.63],
      ];
      for (const [fx, fy] of points) {
        await page.mouse.click(rbox.x + rbox.width * fx, rbox.y + rbox.height * fy);
        await sleep(120);
      }
      await page.locator('[data-testid="river-commit"]').click();
      await sleep(300);
      await waitGenerated(page);
      const riverSummary = await page.evaluate(() => globalThis.__atlasDebug?.getSummary?.() ?? null);
      notes.push(
        `river force: rivers=${riverSummary?.overrides?.rivers} points=${riverSummary?.overrides?.riverPoints}`,
      );
      await shot(page, "05b-river-forced.png");
    }
  } catch (error) {
    notes.push(`river tool failed: ${String(error)}`);
  }

  // 4c. Naming language switch must update params and regenerate names.
  try {
    const select = page.locator('[data-testid="param-namingLanguage"]');
    if ((await select.count()) === 0) {
      notes.push("naming select not found");
    } else {
      if (!(await select.isVisible())) {
        await page.locator('[data-testid="section-human"] .section-toggle').click();
        await sleep(250);
      }
      await select.selectOption("latin");
      await waitGenerated(page);
      const naming = await page.evaluate(
        () => globalThis.__atlasDebug?.getSummary?.()?.namingLanguage ?? null,
      );
      notes.push(`naming language applied=${naming}`);
      await shot(page, "05c-naming-latin.png");
    }
  } catch (error) {
    notes.push(`naming switch failed: ${String(error)}`);
  }

  // 5. Zoom with wheel over the map.
  const canvas2 = page.locator('[data-testid="map-canvas"]');
  const box2 = await canvas2.boundingBox();
  if (box2) {
    await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
    await page.mouse.wheel(0, -700);
    await sleep(350);
    await shot(page, "06-zoom.png");
    await page.locator('[data-testid="zoom-fit"]').click();
    await sleep(250);
  }

  // 6. Live debug document summary.
  let summary = null;
  try {
    summary = await page.evaluate(() => globalThis.__atlasDebug?.getSummary?.() ?? null);
    notes.push(`debug summary: ${JSON.stringify(summary)}`);
  } catch (error) {
    notes.push(`debug summary failed: ${String(error)}`);
  }

  // 7. JSON export round-trip.
  let exported = null;
  try {
    const downloadPromise = page.waitForEvent("download", { timeout: 20_000 });
    await page.locator('[data-testid="export-json"]').click();
    const download = await downloadPromise;
    const path = join(OUT, "exported-world.json");
    await download.saveAs(path);
    exported = JSON.parse(readFileSync(path, "utf8"));
    notes.push(
      `exported JSON version=${exported.version} seed=${exported.seed} overrides=${JSON.stringify({
        elev: exported.overrides?.elevation?.length,
        river: exported.overrides?.riverForce?.length,
        biome: exported.overrides?.biome?.length,
      })}`,
    );
  } catch (error) {
    notes.push(`JSON export failed: ${String(error)}`);
  }

  // 8. Server-side large render (512 for speed) using the exported document.
  if (exported) {
    try {
      const res = await fetch(API_RENDER_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ document: exported, size: 512 }),
      });
      const buffer = Buffer.from(await res.arrayBuffer());
      const okPng = buffer.length > 8 && buffer[0] === 0x89 && buffer[1] === 0x50;
      writeFileSync(join(OUT, "server-render-512.png"), buffer);
      notes.push(
        `server render 512: status=${res.status} content-type=${res.headers.get("content-type")} renderMs=${res.headers.get("x-atlas-render-ms")} png=${okPng} bytes=${buffer.length}`,
      );
    } catch (error) {
      notes.push(`server render failed: ${String(error)}`);
    }
  }

  // 9. Style toggle (labels off/on) then final screenshot.
  try {
    await page.locator('[data-testid="style-showLabels"]').click();
    await sleep(500);
    await shot(page, "07-labels-off.png");
    await page.locator('[data-testid="style-showLabels"]').click();
    await sleep(500);
  } catch (error) {
    notes.push(`style toggle failed: ${String(error)}`);
  }

  // 10. Right/left panels must be internally scrollable (not clipped by viewport).
  try {
    const panelInfo = await page.evaluate(() => ({
      scrollers: [...document.querySelectorAll('[data-testid="params-scroll"], [data-testid="style-scroll"]')].map(
        (el) => ({
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          overflowY: getComputedStyle(el).overflowY,
        }),
      ),
      pageOverflow: document.scrollingElement
        ? document.scrollingElement.scrollHeight - document.scrollingElement.clientHeight
        : null,
    }));
    notes.push(`panels: ${JSON.stringify(panelInfo)}`);
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('[data-testid="params-scroll"], [data-testid="style-scroll"]')) {
        el.scrollTop = el.scrollHeight;
      }
    });
    await sleep(300);
    await shot(page, "08-panels-scrolled.png");
  } catch (error) {
    notes.push(`panel scroll check failed: ${String(error)}`);
  }

  // 11. Local PNG export dialog -> download 1024.
  try {
    await page.locator('[data-testid="export-png"]').click();
    await page.waitForSelector('[data-testid^="export-size-"]', { timeout: 10_000 });
    const downloadPromise = page.waitForEvent("download", { timeout: 90_000 });
    await page.locator('[data-testid="export-size-1024"]').first().click();
    await page.locator('[data-testid="export-start"]').click();
    const download = await downloadPromise;
    const pngPath = join(OUT, "client-render-1024.png");
    await download.saveAs(pngPath);
    const bytes = readFileSync(pngPath);
    notes.push(
      `client PNG export: bytes=${bytes.length} png=${bytes[0] === 0x89 && bytes[1] === 0x50}`,
    );
    await shot(page, "08b-export-result.png");
    const closeButton = page.locator('[data-testid="export-dialog-close"]');
    if (await closeButton.count()) await closeButton.click().catch(() => {});
  } catch (error) {
    notes.push(`client PNG export failed: ${String(error)}`);
  }

  // 12. Autosave restore: reload and compare document summary.
  try {
    const before = await page.evaluate(() => globalThis.__atlasDebug?.getSummary?.() ?? null);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="map-canvas"]', { timeout: 30_000 });
    await waitGenerated(page);
    await sleep(800);
    const after = await page.evaluate(() => globalThis.__atlasDebug?.getSummary?.() ?? null);
    const same =
      before?.seed === after?.seed &&
      JSON.stringify(before?.overrides) === JSON.stringify(after?.overrides);
    notes.push(
      `autosave restore: sameSeedAndOverrides=${same} seed=${after?.seed} editTotal=${after?.overrides?.total}`,
    );
    await shot(page, "09-after-reload.png");
  } catch (error) {
    notes.push(`autosave restore check failed: ${String(error)}`);
  }

  await shot(page, "10-final.png");
  await browser.close();

  const report = {
    when: new Date().toISOString(),
    webUrl: WEB_URL,
    consoleErrors,
    pageErrors,
    failedRequests,
    notes,
  };
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  const hardFailures = pageErrors.length + consoleErrors.length + failedRequests.length;
  if (hardFailures > 0) {
    console.error(`QA FAILED: ${hardFailures} runtime errors`);
    process.exitCode = 1;
  }
  await stopServers();
  process.exit(process.exitCode ?? 0);
}

main().catch(async (error) => {
  console.error("QA harness error:", error);
  await stopServers();
  process.exit(1);
});
