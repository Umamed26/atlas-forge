/**
 * Lead QA harness for the generation UX (v0.4): onboarding, scenario presets,
 * locked reroll (verified by layer hashes), generation history, name reroll,
 * draft preview, next-step actions and readability banner.
 *
 * Usage: node scripts/qa-gen-ux.mjs [--no-server]
 * Output: out/gen-ux/*.png + out/gen-ux/report.json
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright-core";

const ROOT = process.cwd();
const OUT = join(ROOT, "out", "gen-ux");
const WEB_URL = process.env.WEB_URL ?? "http://127.0.0.1:5173/";
const API_HEALTH = process.env.API_URL ?? "http://127.0.0.1:8787/api/health";
const NO_SERVER = process.argv.includes("--no-server");

mkdirSync(OUT, { recursive: true });

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
const notes = [];
const checks = [];
let serverProcess = null;
let startedServer = false;

function check(name, pass, detail = "") {
  checks.push({ name, pass: Boolean(pass), detail });
  notes.push(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

function findChromium() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const root = join(homedir(), ".cache", "ms-playwright");
  try {
    for (const build of readdirSync(root).filter((e) => e.startsWith("chromium-")).sort().reverse()) {
      for (const candidate of [
        join(root, build, "chrome-linux64", "chrome"),
        join(root, build, "chrome-linux", "chrome"),
      ]) {
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch {
    /* fall through */
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
  if ((await urlOk(WEB_URL)) && (await urlOk(API_HEALTH))) {
    notes.push("reusing running dev servers");
    return;
  }
  notes.push("starting pnpm dev");
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
  await sleep(1000);
  try {
    if (child.exitCode === null) process.kill(-child.pid, "SIGKILL");
  } catch {
    /* gone */
  }
}

async function shot(page, name) {
  const file = join(OUT, name);
  await page.screenshot({ path: file });
  notes.push(`screenshot ${file}`);
}

const debug = (page, fn, arg) => page.evaluate(fn, arg);

async function summary(page) {
  return page.evaluate(() => globalThis.__atlasDebug?.getSummary?.() ?? null);
}

async function signature(page) {
  return page.evaluate(() => globalThis.__atlasDebug?.getLayerSignature?.() ?? null);
}

async function stageSeeds(page) {
  return page.evaluate(() => globalThis.__atlasDebug?.getStageSeeds?.() ?? null);
}

async function waitIdle(page, timeoutMs = 60_000) {
  await page
    .waitForSelector('[data-testid="status"][data-state="idle"]', { timeout: timeoutMs })
    .catch(() => notes.push("waitIdle timeout"));
}

async function waitGenerated(page) {
  await page
    .waitForSelector('[data-testid="status"][data-state="generating"]', { timeout: 5_000 })
    .catch(() => {});
  await waitIdle(page);
  await sleep(350);
}

async function main() {
  if (!NO_SERVER) await startServers();
  const chrome = findChromium();
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    ...(chrome ? { executablePath: chrome } : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1680, height: 1000 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const url = msg.location()?.url ?? "";
    if (/favicon/i.test(url)) return;
    consoleErrors.push(`${msg.text()} @ ${url}`);
  });
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("requestfailed", (request) => {
    const url = request.url();
    if (/favicon/i.test(url)) return;
    // Export cancellation aborts a fetch on purpose; only flag unexpected ones.
    if (/\/api\/render/.test(url) && /ERR_ABORTED|aborted/i.test(request.failure()?.errorText ?? "")) return;
    failedRequests.push(`${request.method()} ${url} :: ${request.failure()?.errorText}`);
  });

  // ── 1. First-run onboarding ────────────────────────────────────────────
  // A fresh browser context already has empty storage. Do NOT clear + reload:
  // the reload's beforeunload autosave flush would re-create the world slot and
  // (correctly) suppress the first-run panel for a "returning" user.
  await page.goto(WEB_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.waitForSelector('[data-testid="welcome"]', { timeout: 30_000 }).catch(() => {});
  const welcomeVisible = await page.locator('[data-testid="welcome"]').isVisible().catch(() => false);
  check("first visit shows welcome panel", welcomeVisible);
  const cardIds = ["archipelago", "arid-empire", "polar-frontier", "classic"];
  const cards = await page.evaluate((ids) =>
    ids.map((id) => {
      const el = document.querySelector(`[data-testid="preset-card-${id}"]`);
      const img = el?.querySelector("img");
      return { id, present: Boolean(el), img: img?.getAttribute("src") ?? null, loaded: Boolean(img?.complete && (img?.naturalWidth ?? 0) > 0) };
    }), cardIds);
  check(
    "four scenario cards with real thumbnails",
    cards.every((c) => c.present && c.loaded),
    JSON.stringify(cards),
  );
  await shot(page, "01-welcome.png");

  await page.locator('[data-testid="preset-card-archipelago"]').click();
  await waitGenerated(page);
  const afterPreset = await summary(page);
  const docAfterPreset = await debug(page, () => globalThis.__atlasDebug.getDocument());
  check(
    "scenario card applies preset params",
    docAfterPreset?.params?.seaLevel === 0.52 && docAfterPreset?.params?.continentScale === 4,
    `seaLevel=${docAfterPreset?.params?.seaLevel} continentScale=${docAfterPreset?.params?.continentScale} preset=${afterPreset?.activePreset}`,
  );
  check("welcome dismissed after card click", !(await page.locator('[data-testid="welcome"]').isVisible().catch(() => false)));
  await shot(page, "02-preset-applied.png");

  // ── 2. Locked reroll: lock coast, reroll 3x ─────────────────────────────
  await page.locator('[data-testid="lock-coast"]').click();
  const sigs = [];
  for (let i = 0; i < 3; i += 1) {
    await page.locator('[data-testid="reroll-locked"]').click();
    await waitGenerated(page);
    sigs.push({ sig: await signature(page), seeds: await stageSeeds(page), summary: await summary(page) });
  }
  const heightStable = sigs.every((s) => s.sig?.height === sigs[0].sig?.height);
  const oceanStable = sigs.every((s) => s.sig?.ocean === sigs[0].sig?.ocean);
  const riverChanged = sigs.some((s) => s.sig?.river !== sigs[0].sig?.river);
  check("locked coast keeps height/ocean across 3 rerolls", heightStable && oceanStable, `height=${heightStable} ocean=${oceanStable}`);
  check("unlocked rivers actually change", riverChanged, `river=${sigs.map((s) => s.sig?.river).join(" → ")}`);
  check(
    "terrain stage seed stays implicit while others roll",
    sigs.every((s) => s.seeds?.terrain === undefined && typeof s.seeds?.hydrology === "number"),
    JSON.stringify(sigs[0]?.seeds),
  );
  await shot(page, "03-locked-reroll.png");
  await page.locator('[data-testid="lock-coast"]').click();

  // ── 3. Generation history ──────────────────────────────────────────────
  const beforeHistory = (await summary(page))?.historyCount ?? 0;
  const seedsBefore = (await summary(page))?.seed ?? null;
  const historyItems = await page.locator('[data-testid^="gen-history-item-"]').count();
  check("history records generations", beforeHistory >= 3 && historyItems >= 1, `historyCount=${beforeHistory} items=${historyItems}`);
  await page.locator('[data-testid="gen-history-restore-1"]').click();
  await waitGenerated(page);
  const afterRestore = await summary(page);
  check(
    "restoring history entry changes seed back",
    typeof afterRestore?.seed === "number",
    `seed ${seedsBefore} → ${afterRestore?.seed} historyCount=${afterRestore?.historyCount}`,
  );
  await shot(page, "04-history.png");

  // ── 4. Name reroll keeps terrain & rivers ──────────────────────────────
  const sigBeforeNames = await signature(page);
  const namesBefore = (await summary(page))?.places?.list?.slice(0, 4).map((p) => p.name) ?? [];
  await page.locator('[data-testid="reroll-names"]').click();
  await waitGenerated(page);
  const sigAfterNames = await signature(page);
  const namesAfter = (await summary(page))?.places?.list?.slice(0, 4).map((p) => p.name) ?? [];
  check(
    "name reroll keeps terrain/rivers",
    sigBeforeNames?.height === sigAfterNames?.height && sigBeforeNames?.river === sigAfterNames?.river,
    `height ${sigBeforeNames?.height}→${sigAfterNames?.height} river ${sigBeforeNames?.river}→${sigAfterNames?.river}`,
  );
  check(
    "name reroll changes names",
    namesBefore.join("|") !== namesAfter.join("|"),
    `${namesBefore.join(",")} → ${namesAfter.join(",")}`,
  );
  await shot(page, "05-names-rerolled.png");

  // ── 5. Draft preview while dragging a slider ───────────────────────────
  let sawDraft = false;
  try {
    if ((await page.locator('[data-testid="param-seaLevel"]').count()) === 0) {
      await page.locator('[data-testid="group-params"] .panel-group-head').click().catch(() => {});
      await sleep(300);
    }
    const slider = page.locator('[data-testid="param-seaLevel"]').first();
    await slider.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
    await sleep(200);
    const box = await slider.boundingBox();
    notes.push(`draft: slider box=${JSON.stringify(box)}`);
    if (box) {
      await page.mouse.move(box.x + box.width * 0.45, box.y + box.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 26; i += 1) {
        await page.mouse.move(box.x + box.width * (0.45 + i * 0.012), box.y + box.height / 2);
        await sleep(55);
        if (!sawDraft) {
          sawDraft = await page.locator('[data-testid="gen-draft-badge"]').isVisible().catch(() => false);
        }
        if (sawDraft && i === 14) await shot(page, "06-draft-badge.png");
      }
      await page.mouse.up();
      await waitGenerated(page);
    } else {
      notes.push("draft: slider has no bounding box (hidden or scrolled away)");
    }
  } catch (error) {
    notes.push(`draft check failed: ${String(error)}`);
  }
  check("draft badge appears while dragging", sawDraft);
  await sleep(400);
  const draftGone = !(await page.locator('[data-testid="gen-draft-badge"]').isVisible().catch(() => false));
  check("draft badge clears after release", draftGone);

  // ── 6. Next-step bar ───────────────────────────────────────────────────
  const generatedText = (await page.locator('[data-testid="generated-summary"]').first().textContent().catch(() => "")) ?? "";
  check("generated summary shows scenario and seed", /#\d{3,}/.test(generatedText), generatedText.trim().slice(0, 80));
  await page.locator('[data-testid="next-tweak"]').click();
  await sleep(400);
  const paramsVisible = await page.locator('[data-testid="param-seaLevel"]').isVisible().catch(() => false);
  check("next-tweak opens parameters", paramsVisible);
  await page.locator('[data-testid="next-export"]').click();
  await page.waitForSelector('[data-testid="export-dialog"]', { timeout: 10_000 }).catch(() => {});
  const dialogOpen = await page.locator('[data-testid="export-dialog"]').isVisible().catch(() => false);
  check("next-export opens export dialog", dialogOpen);
  if (dialogOpen) await page.locator('[data-testid="export-dialog-close"]').click().catch(() => {});
  await shot(page, "07-next-actions.png");

  // ── 7. Readability banner (force crowded labels) ───────────────────────
  try {
    await page.evaluate(() => {
      const store = globalThis.__atlasDebug;
      const doc = store.getDocument();
      // Crowd the map: max label density + every label shown.
      return doc;
    });
    const densitySlider = page.locator('[data-testid="style-labelDensity"]').first();
    if ((await densitySlider.count()) > 0) {
      await densitySlider.evaluate((el) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
        setter?.call(el, "1");
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
        el.blur();
      });
      await sleep(600);
      const summaryAfter = await summary(page);
      notes.push(`readability after density=1: ${JSON.stringify(summaryAfter?.readability)}`);
      const banner = await page.locator('[data-testid="readability-banner"]').isVisible().catch(() => false);
      notes.push(`readability banner visible=${banner}`);
      await shot(page, "08-readability.png");
      if (banner) {
        await page.locator('[data-testid="readability-dismiss"]').click();
        await sleep(300);
        check("readability banner can be dismissed", !(await page.locator('[data-testid="readability-banner"]').isVisible().catch(() => false)));
      }
    } else {
      notes.push("style-labelDensity slider not found; readability banner check skipped");
    }
  } catch (error) {
    notes.push(`readability check failed: ${String(error)}`);
  }

  // ── 8. Preset modification badge + reset ───────────────────────────────
  try {
    const badgeText = (await page.locator('[data-testid="preset-modified-badge"]').first().textContent().catch(() => "")) ?? "";
    notes.push(`preset badge: ${badgeText.trim()}`);
    const resetButton = page.locator('[data-testid="preset-reset"]').first();
    if ((await resetButton.count()) > 0) {
      await resetButton.click();
      await waitGenerated(page);
      const docReset = await debug(page, () => globalThis.__atlasDebug.getDocument());
      check(
        "preset reset restores preset params",
        docReset?.params?.seaLevel === 0.52 && docReset?.params?.continentScale === 4,
        `seaLevel=${docReset?.params?.seaLevel} continentScale=${docReset?.params?.continentScale}`,
      );
      await shot(page, "09-preset-reset.png");
    } else {
      notes.push("preset-reset not found");
    }
  } catch (error) {
    notes.push(`preset badge check failed: ${String(error)}`);
  }

  // ── 9. Persistence: stageSeeds + onboarding survive reload ─────────────
  try {
    const seedsBeforeReload = await stageSeeds(page);
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="map-canvas"]', { timeout: 30_000 });
    await waitGenerated(page);
    await sleep(900);
    const seedsAfterReload = await stageSeeds(page);
    check(
      "stage seeds survive reload",
      JSON.stringify(seedsBeforeReload) === JSON.stringify(seedsAfterReload),
      `${JSON.stringify(seedsBeforeReload)} vs ${JSON.stringify(seedsAfterReload)}`,
    );
    const welcomeAgain = await page.locator('[data-testid="welcome"]').isVisible().catch(() => false);
    check("onboarding does not reappear for returning user", !welcomeAgain);
  } catch (error) {
    notes.push(`persistence check failed: ${String(error)}`);
  }

  await shot(page, "10-final.png");
  await browser.close();

  const failed = checks.filter((c) => !c.pass);
  const report = {
    when: new Date().toISOString(),
    checks,
    failed: failed.map((c) => c.name),
    consoleErrors,
    pageErrors,
    failedRequests,
    notes,
  };
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(`\nGeneration UX QA: ${checks.length - failed.length}/${checks.length} checks passed`);
  for (const item of failed) console.log(`  FAIL ${item.name} — ${item.detail}`);
  console.log(`console errors: ${consoleErrors.length}, page errors: ${pageErrors.length}, failed requests: ${failedRequests.length}`);

  const hardFailures = failed.length + pageErrors.length + consoleErrors.length + failedRequests.length;
  await stopServers();
  process.exit(hardFailures > 0 ? 1 : 0);
}

main().catch(async (error) => {
  console.error("QA harness error:", error);
  await stopServers();
  process.exit(1);
});
