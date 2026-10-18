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
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

const ROOT = process.cwd();
const OUT = join(ROOT, "out", "e2e");
const WEB_URL = process.env.WEB_URL ?? "http://127.0.0.1:5173/";
const API_HEALTH_URL = process.env.API_URL ?? "http://127.0.0.1:8787/api/health";
const API_RENDER_URL = API_HEALTH_URL.replace(/\/api\/health$/, "/api/render");
/**
 * Resolve Chromium: explicit CHROME_PATH, then a cached Playwright build, then
 * let playwright-core resolve its own managed browser (installed in CI).
 */
function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = join(homedir(), ".cache", "ms-playwright");
  try {
    const builds = readdirSync(root)
      .filter((entry) => entry.startsWith("chromium-"))
      .sort()
      .reverse();
    for (const build of builds) {
      for (const candidate of [
        join(root, build, "chrome-linux64", "chrome"),
        join(root, build, "chrome-linux", "chrome"),
        join(root, build, "chrome-linux64", "headless_shell"),
        join(root, build, "chrome-linux", "headless_shell"),
      ]) {
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // no cache directory: fall back to playwright-managed browser
  }
  return null;
}
const CHROME = findChromium();
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
  if (CHROME && !existsSync(CHROME)) throw new Error(`chromium not found at ${CHROME}`);
  if (!NO_SERVER) await startServers();

  const launchOptions = {
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    ...(CHROME ? { executablePath: CHROME } : {}),
  };
  if (!CHROME) notes.push("using playwright-managed browser (no cached chromium found)");
  const browser = await chromium.launch(launchOptions);
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

  // 5d. Places & labels editing (new feature): add -> rename -> undo/redo ->
  //     drag -> hide -> restore -> add label.
  let placeId = null;
  try {
    await page.locator('[data-testid="tool-places"]').click();
    await page.locator('[data-testid="place-mode-settlement"]').click();
    await page.locator('[data-testid="place-kind-select"]').selectOption("port");
    await page.locator('[data-testid="place-add"]').click();
    const pbox = await page.locator('[data-testid="map-canvas"]').boundingBox();
    if (pbox) {
      const spot = { x: pbox.x + pbox.width * 0.52, y: pbox.y + pbox.height * 0.55 };
      await page.mouse.click(spot.x, spot.y);
      await sleep(400);
      await waitGenerated(page);

      const findPlace = () =>
        page.evaluate(() => {
          const doc = globalThis.__atlasDebug?.getDocument?.() ?? null;
          const settlements = doc?.settlements ?? [];
          const user = settlements.find((entry) => String(entry.id).startsWith("user-s-"));
          return user ? { id: user.id, name: user.name, x: user.x, y: user.y, pinned: user.pinned } : null;
        });
      let place = await findPlace();
      notes.push(`places: created user settlement = ${JSON.stringify(place)}`);
      if (place) {
        placeId = place.id;
        // Select it through the place list, then rename via the inspector.
        await page.locator(`[data-testid="place-list-item-${placeId}"]`).click();
        await page.locator('[data-testid="place-rename"]').click();
        await page.locator('[data-testid="place-rename-input"]').fill("测试港");
        await page.locator('[data-testid="place-rename-commit"]').click();
        await sleep(300);
        await waitGenerated(page);
        let renamed = await findPlace();
        notes.push(`places: rename -> ${JSON.stringify(renamed)}`);

        // Undo then redo the rename.
        await page.keyboard.press("Control+z");
        await sleep(300);
        await waitGenerated(page);
        const undone = await findPlace();
        await page.keyboard.press("Control+Shift+z");
        await sleep(300);
        await waitGenerated(page);
        const redone = await findPlace();
        notes.push(
          `places: undo name=${undone?.name} redo name=${redone?.name}`,
        );

        // Drag the marker: derive its current screen position from the live view
        // transform (clicking the list row may have re-centered the map).
        const beforeDrag = await findPlace();
        const viewState = await page.evaluate(() => globalThis.__atlasDebug?.getSummary?.()?.view ?? null);
        if (beforeDrag && viewState) {
          const markerX = pbox.x + viewState.offsetX + beforeDrag.x * viewState.baseSize * viewState.scale;
          const markerY = pbox.y + viewState.offsetY + beforeDrag.y * viewState.baseSize * viewState.scale;
          await page.mouse.move(markerX, markerY);
          await page.mouse.down();
          for (let i = 1; i <= 10; i += 1) {
            await page.mouse.move(markerX + i * 6, markerY + i * 3);
            await sleep(16);
          }
          await page.mouse.up();
        } else {
          notes.push("places: drag skipped (no place or view state)");
        }
        await sleep(400);
        await waitGenerated(page);
        const afterDrag = await findPlace();
        const moved =
          beforeDrag && afterDrag &&
          (Math.abs(afterDrag.x - beforeDrag.x) > 0.002 || Math.abs(afterDrag.y - beforeDrag.y) > 0.002);
        notes.push(`places: drag moved=${moved} from=(${beforeDrag?.x},${beforeDrag?.y}) to=(${afterDrag?.x},${afterDrag?.y})`);

        // Hide then restore.
        await page.locator(`[data-testid="place-list-item-${placeId}"]`).click();
        await page.locator('[data-testid="place-hide"]').click();
        await sleep(300);
        await waitGenerated(page);
        const hiddenState = await page.evaluate(() => {
          const doc = globalThis.__atlasDebug?.getDocument?.() ?? null;
          return doc?.overrides?.hiddenIds ?? [];
        });
        notes.push(`places: hiddenIds after hide = ${JSON.stringify(hiddenState)}`);
        const row = page.locator(`[data-testid="place-hidden-item-${placeId}"]`);
        if ((await row.count()) > 0) {
          await row.locator('[data-testid="place-restore"]').click();
          await sleep(300);
          await waitGenerated(page);
        } else {
          notes.push("places: hidden restore row not found");
        }
        const restored = await page.evaluate((id) => {
          const doc = globalThis.__atlasDebug?.getDocument?.() ?? null;
          const ids = doc?.overrides?.hiddenIds ?? [];
          const visible = (doc?.settlements ?? []).some((entry) => entry.id === id);
          return { stillHidden: ids.includes(id), inDocument: visible };
        }, placeId);
        notes.push(`places: restore -> ${JSON.stringify(restored)}`);

        // Add a label (region) at another spot.
        await page.locator('[data-testid="place-mode-label"]').click();
        await page.locator('[data-testid="place-kind-select"]').selectOption("region");
        await page.locator('[data-testid="place-name-input"]').fill("测试之地");
        await page.locator('[data-testid="place-add"]').click();
        await page.mouse.click(pbox.x + pbox.width * 0.4, pbox.y + pbox.height * 0.38);
        await sleep(400);
        await waitGenerated(page);
        const labelState = await page.evaluate(() => {
          const doc = globalThis.__atlasDebug?.getDocument?.() ?? null;
          const labels = doc?.labels ?? [];
          return labels.find((entry) => String(entry.id).startsWith("user-l-")) ?? null;
        });
        notes.push(`places: user label = ${JSON.stringify(labelState)}`);
        await shot(page, "05d-places-edited.png");
      }
    }
  } catch (error) {
    notes.push(`places flow failed: ${String(error)}`);
  }

  // 5e. Polish round: renderer-sourced hit boxes, hover cost, keyboard guard,
  //     shortcut single-source, naming helper.
  try {
    const pbox2 = await page.locator('[data-testid="map-canvas"]').boundingBox();
    const hitBoxes = await page.evaluate(() => globalThis.__atlasDebug?.getPlaceHitBoxes?.() ?? []);
    const hitSummary = await page.evaluate(() => globalThis.__atlasDebug?.getSummary?.() ?? null);
    notes.push(
      `polish: hitBoxes source=${hitSummary?.hitBoxesSource} count=${hitBoxes.length} hitTestMs=${hitSummary?.perf?.hitTestMs}`,
    );

    // Click near the right edge of the widest label bbox -> tail of the text must hit.
    const candidate = hitBoxes
      .filter((box) => box.entity === "label" && box.screen.width >= 36)
      .sort((a, b) => b.screen.width - a.screen.width)[0];
    if (pbox2 && candidate) {
      await page.locator('[data-testid="tool-places"]').click();
      const tx = pbox2.x + candidate.screen.x + candidate.screen.width - 3;
      const ty = pbox2.y + candidate.screen.y + candidate.screen.height / 2;
      await page.mouse.click(tx, ty);
      await sleep(250);
      const selected = await page.evaluate(
        () => globalThis.__atlasDebug?.getSummary?.()?.places?.selected ?? null,
      );
      notes.push(
        `polish: label-tail click selected=${JSON.stringify(selected)} expected=${candidate.id}`,
      );
    } else {
      notes.push("polish: no label bbox available for tail-click check");
    }

    // Hover/pointer moves must not trigger a generation.
    const seqBeforeHover = await page.evaluate(
      () => globalThis.__atlasDebug?.getSummary?.()?.generation?.seq ?? -1,
    );
    if (pbox2) {
      await page.mouse.move(pbox2.x + pbox2.width * 0.3, pbox2.y + pbox2.height * 0.3);
      for (let i = 0; i < 24; i += 1) {
        await page.mouse.move(
          pbox2.x + pbox2.width * (0.3 + (i % 6) * 0.06),
          pbox2.y + pbox2.height * (0.3 + (i % 4) * 0.05),
        );
        await sleep(12);
      }
    }
    await sleep(400);
    const seqAfterHover = await page.evaluate(
      () => globalThis.__atlasDebug?.getSummary?.()?.generation?.seq ?? -1,
    );
    notes.push(`polish: hover regenerated=${seqBeforeHover !== seqAfterHover} (seq ${seqBeforeHover}->${seqAfterHover})`);

    // Delete/Backspace inside the rename input must not delete the place.
    if (placeId) {
      const nameBefore = await page.evaluate((id) => {
        const doc = globalThis.__atlasDebug?.getDocument?.() ?? null;
        return (doc?.settlements ?? []).find((entry) => entry.id === id)?.name ?? null;
      }, placeId);
      await page.locator(`[data-testid="place-list-item-${placeId}"]`).click();
      await page.locator('[data-testid="place-rename"]').click();
      const renameInput = page.locator('[data-testid="place-rename-input"]');
      await renameInput.fill("临时改名");
      await renameInput.press("Delete");
      await renameInput.press("Backspace");
      await page.keyboard.press("Escape");
      await sleep(250);
      const nameAfter = await page.evaluate((id) => {
        const doc = globalThis.__atlasDebug?.getDocument?.() ?? null;
        return (doc?.settlements ?? []).find((entry) => entry.id === id)?.name ?? null;
      }, placeId);
      const stillExists = nameAfter !== null;
      notes.push(
        `polish: rename-input guard unchanged=${nameBefore === nameAfter} stillExists=${stillExists}`,
      );
    }

    // Shortcut single source: HelpDialog rows == debug getShortcuts() length.
    const shortcuts = await page.evaluate(() => globalThis.__atlasDebug?.getShortcuts?.()?.length ?? 0);
    let helpRows = null;
    try {
      await page.locator('[data-testid="help"]').click();
      await page.waitForSelector('[data-testid="help-dialog"]', { timeout: 5_000 });
      helpRows = await page.evaluate(
        () => document.querySelectorAll('[data-testid="help-dialog"] .shortcut-table tbody tr').length,
      );
      await page.keyboard.press("Escape");
      await sleep(200);
    } catch (error) {
      notes.push(`polish: help shortcut check failed: ${String(error)}`);
    }
    notes.push(`polish: shortcuts debug=${shortcuts} helpRows=${helpRows}`);

    // Pure helper probes: hit priority topmost + deterministic naming dedupe.
    const probes = await page.evaluate(() => {
      const debug = globalThis.__atlasDebug;
      return {
        hitPriority: debug?.testHitPriority?.() ?? null,
        naming: debug?.getNamingDemo?.() ?? null,
      };
    });
    notes.push(
      `polish: hitPriority=${JSON.stringify(probes.hitPriority)} naming=${JSON.stringify(probes.naming)}`,
    );
  } catch (error) {
    notes.push(`polish probes failed: ${String(error)}`);
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
      `exported JSON version=${exported.version} seed=${exported.seed} places=${JSON.stringify({
        settlements: exported.settlements?.length,
        labels: exported.labels?.length,
        hiddenIds: exported.overrides?.hiddenIds?.length,
        pinned: (exported.settlements ?? []).filter((entry) => entry.pinned).length,
      })} overrides=${JSON.stringify({
        elev: exported.overrides?.elevation?.length,
        river: exported.overrides?.riverForce?.length,
        biome: exported.overrides?.biome?.length,
      })}`,
    );
  } catch (error) {
    notes.push(`JSON export failed: ${String(error)}`);
  }

  // 7b. Invalid JSON import must be rejected without replacing the document.
  try {
    const seedBefore = await page.evaluate(() => globalThis.__atlasDebug?.getDocument?.()?.seed ?? null);
    const badPath = join(OUT, "invalid-world.json");
    writeFileSync(badPath, '{ "version": 1, "seed": 42, "params": { "seaLevel": ');
    await page.locator('[data-testid="import-json-input"]').setInputFiles(badPath);
    await sleep(800);
    const seedAfter = await page.evaluate(() => globalThis.__atlasDebug?.getDocument?.()?.seed ?? null);
    const toast = await page
      .locator('[data-testid="toast"]')
      .first()
      .textContent()
      .catch(() => null);
    notes.push(
      `import-invalid: docUnchanged=${seedBefore === seedAfter} toast=${String(toast).trim().slice(0, 120)}`,
    );
    await shot(page, "07c-import-invalid.png");
  } catch (error) {
    notes.push(`import-invalid check failed: ${String(error)}`);
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
    const filenamePreview =
      (await page.locator('[data-testid="export-filename"]').first().textContent().catch(() => null)) ??
      (await page
        .locator(".export-summary-row")
        .nth(1)
        .locator("strong")
        .first()
        .textContent()
        .catch(() => null));
    notes.push(`export: filename preview=${String(filenamePreview).trim()}`);
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
    const resultFilename = await page
      .locator('[data-testid="export-result-filename"]')
      .first()
      .textContent()
      .catch(() => null);
    notes.push(`export: result filename=${String(resultFilename).trim()}`);
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
    const placesAfterReload = await page.evaluate((id) => {
      const doc = globalThis.__atlasDebug?.getDocument?.() ?? null;
      return {
        userSettlements: (doc?.settlements ?? []).filter((entry) => String(entry.id).startsWith("user-s-")).length,
        userLabels: (doc?.labels ?? []).filter((entry) => String(entry.id).startsWith("user-l-")).length,
        hiddenIds: (doc?.overrides?.hiddenIds ?? []).length,
        restoredPlace: id ? (doc?.settlements ?? []).some((entry) => entry.id === id) : null,
      };
    }, placeId);
    notes.push(
      `autosave restore: sameSeedAndOverrides=${same} seed=${after?.seed} editTotal=${after?.overrides?.total} places=${JSON.stringify(placesAfterReload)}`,
    );
    await shot(page, "09-after-reload.png");
  } catch (error) {
    notes.push(`autosave restore check failed: ${String(error)}`);
  }

  // 13. Collapsible groups remember their state across reloads.
  try {
    const paramsGroup = page.locator('[data-testid="group-params"]');
    const toggle = paramsGroup.locator('.panel-group-head').first();
    await toggle.click();
    await sleep(300);
    const collapsedNow = (await page.locator('[data-testid="param-seaLevel"]').count()) === 0 ||
      !(await page.locator('[data-testid="param-seaLevel"]').isVisible().catch(() => false));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="map-canvas"]', { timeout: 30_000 });
    await waitGenerated(page);
    await sleep(900);
    const stillVisible = await page
      .locator('[data-testid="param-seaLevel"]')
      .isVisible()
      .catch(() => false);
    notes.push(`layout: params collapsed=${collapsedNow} persisted=${!stillVisible}`);
    await shot(page, "11-collapsed-persisted.png");
  } catch (error) {
    notes.push(`layout persistence check failed: ${String(error)}`);
  }

  // 14. Narrow desktop viewports must not overflow horizontally.
  try {
    for (const viewport of [
      { width: 1280, height: 800, name: "12-narrow-1280.png" },
      { width: 1024, height: 768, name: "12-narrow-1024.png" },
    ]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await sleep(600);
      const overflow = await page.evaluate(() => {
        const el = document.scrollingElement ?? document.documentElement;
        return {
          horizontal: el.scrollWidth - el.clientWidth,
          vertical: el.scrollHeight - el.clientHeight,
        };
      });
      notes.push(`narrow ${viewport.width}x${viewport.height}: overflow=${JSON.stringify(overflow)}`);
      await shot(page, viewport.name);
    }
    await page.setViewportSize({ width: 1680, height: 1000 });
    await sleep(300);
  } catch (error) {
    notes.push(`narrow viewport check failed: ${String(error)}`);
  }

  // 15. Corrupted autosave must show recovery instead of silently overwriting.
  try {
    const backupSeed = await page.evaluate(() => {
      try {
        const raw = localStorage.getItem("atlas_forge.world.backup.v1");
        return raw ? (JSON.parse(raw)?.document?.seed ?? null) : null;
      } catch {
        return null;
      }
    });
    // A normal reload flushes the current document on beforeunload, which would
    // overwrite our corruption. Inject the corrupt value before the app boots.
    await page.addInitScript(() => {
      try {
        localStorage.setItem("atlas_forge.world.v1", "{ corrupted autosave ");
      } catch {
        // ignore
      }
    });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="map-canvas"]', { timeout: 30_000 }).catch(() => {});
    await sleep(1_500);
    const recovery = await page.locator('[data-testid="autosave-recovery"]').count();
    notes.push(`autosave-recovery: panel=${recovery} backupSeed=${backupSeed}`);
    if (recovery > 0) {
      await shot(page, "13-autosave-recovery.png");
      await page.locator('[data-testid="autosave-recover"]').click();
      await waitGenerated(page);
      await sleep(900);
      const recoveredSeed = await page.evaluate(
        () => globalThis.__atlasDebug?.getDocument?.()?.seed ?? null,
      );
      notes.push(`autosave-recovery: recoveredSeed=${recoveredSeed}`);
      await shot(page, "14-after-recovery.png");
    }
  } catch (error) {
    notes.push(`autosave recovery check failed: ${String(error)}`);
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
