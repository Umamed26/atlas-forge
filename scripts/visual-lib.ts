/**
 * Shared helpers for the visual regression harness (scripts/visual-*.ts) and
 * the qa:render append hook.
 *
 * The matrix is a fixed set of scenario-preset × seed combinations. Baseline
 * plates are rendered at 512² (sha256 is the primary assertion, pixel diff is
 * the auxiliary one) and stored together with 256² thumbnails, keeping the
 * committed baseline set around ~5MB. First-screen preset cards are rendered at
 * 1024² and downscaled to 256² for the web welcome screen.
 *
 * Scenario data always comes from core's `SCENARIO_PRESETS` — no duplicated
 * parameter tables.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";
import {
  DEFAULT_PARAMS,
  DEFAULT_STYLE,
  SCENARIO_PRESETS,
  createDefaultDocument,
  createPipeline,
  type Pipeline,
  type RenderStyle,
  type ScenarioPreset,
  type WorldDocument,
  type WorldLayers,
} from "@atlas/core";
import {
  RENDERER_VERSION,
  assessMapReadability,
  renderWorld,
  type Ctx2D,
  type ReadabilityReport,
  type RenderStats,
} from "@atlas/render";
import { installNodeFonts } from "@atlas/render/node-fonts";

// ── paths ─────────────────────────────────────────────────────────────────
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, "..");
export const BASELINE_DIR = join(REPO_ROOT, "packages", "render", "test", "baselines");
export const BASELINE_THUMB_DIR = join(BASELINE_DIR, "thumbs");
export const MANIFEST_PATH = join(BASELINE_DIR, "manifest.json");
export const PRESET_THUMB_DIR = join(REPO_ROOT, "apps", "web", "public", "presets");

// ── preset data (core is the single source of truth) ─────────────────────
export type ScenarioPresetData = ScenarioPreset;

export const SCENARIOS: readonly ScenarioPreset[] = SCENARIO_PRESETS;

export function findScenario(id: string): ScenarioPreset | undefined {
  return SCENARIOS.find((scenario) => scenario.id === id);
}

// ── fixed regression matrix ───────────────────────────────────────────────
export type StylePreset = RenderStyle["preset"];

export interface MatrixEntry {
  id: string;
  scenarioId: string;
  seed: number;
  /** Force a style preset on top of the scenario's own style. */
  stylePreset?: StylePreset;
}

/** Baseline plate edge length (kept small so the committed set stays ~5MB). */
export const BASELINE_SIZE = 512;
export const THUMB_SIZE = 256;
/** First-screen preset cards are rendered big and downscaled for crispness. */
export const PRESET_CARD_SIZE = 256;
export const PRESET_RENDER_SIZE = 1024;

/** 4 scenario presets × 2 fixed seeds (aged-ink is covered by polar-frontier). */
export const MATRIX: MatrixEntry[] = SCENARIOS.flatMap((scenario) =>
  [101, 202].map((seed) => ({ id: `${scenario.id}-${seed}`, scenarioId: scenario.id, seed })),
);

export interface BaselineMetrics {
  labelsDrawn: number;
  labelsSkipped: number;
  settlements: number;
  landFraction: number;
  rivers: number;
  biomeKinds: number;
  coastLines: number;
  riverCount: number;
  mountainGlyphs: number;
  forestGlyphs: number;
  readabilityScore: number;
}

export interface BaselineEntry {
  id: string;
  scenario: string;
  scenarioName: string;
  seed: number;
  stylePreset: StylePreset;
  width: number;
  height: number;
  thumbWidth: number;
  thumbHeight: number;
  sha256: string;
  thumbSha256: string;
  metrics: BaselineMetrics;
}

export interface BaselineManifest {
  schemaVersion: 1;
  rendererVersion: string;
  source: "core-scenario-presets";
  width: number;
  thumbSize: number;
  entries: BaselineEntry[];
}

// ── deterministic documents & rendering ──────────────────────────────────
let fontsInstalled = false;

export function ensureVisualFonts(): void {
  if (fontsInstalled) return;
  installNodeFonts(GlobalFonts, { quiet: true });
  fontsInstalled = true;
}

/** Build the canonical document for one matrix entry (fully deterministic). */
export function createEntryDocument(entry: MatrixEntry): WorldDocument {
  const scenario = findScenario(entry.scenarioId);
  if (!scenario) throw new Error(`unknown scenario preset: ${entry.scenarioId}`);
  const document = createDefaultDocument({
    name: scenario.name,
    seed: entry.seed,
    params: { ...DEFAULT_PARAMS, ...scenario.params },
    style: { ...DEFAULT_STYLE, ...scenario.style },
  });
  // Scenario styles may carry the default "Untitled World" title from
  // DEFAULT_STYLE; the cartouche should show the scenario name instead.
  document.style = { ...document.style, title: scenario.name };
  if (entry.stylePreset) document.style = { ...document.style, preset: entry.stylePreset };
  // The cartouche prints a year derived from createdAt: pin it so baselines stay
  // stable across calendar years / machines.
  document.createdAt = "2026-01-01T00:00:00.000Z";
  document.updatedAt = document.createdAt;
  document.id = `baseline-${entry.id}`;
  return document;
}

export interface RenderedEntry {
  entry: MatrixEntry;
  document: WorldDocument;
  layers: WorldLayers;
  stats: RenderStats;
  readability: ReadabilityReport;
  png: Buffer;
  thumbPng: Buffer;
  timings: { simMs: number; renderMs: number; encodeMs: number; totalMs: number };
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function downscale(source: ReturnType<typeof createCanvas>, size: number): Buffer {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(source, 0, 0, size, size);
  return canvas.toBuffer("image/png");
}

/** Render one matrix entry at 512² + 256² thumbnail. */
export function renderEntry(entry: MatrixEntry, pipeline: Pipeline): RenderedEntry {
  ensureVisualFonts();
  const startedAt = performance.now();
  const document = createEntryDocument(entry);
  const simStart = performance.now();
  const layers = pipeline.generate({ document, size: BASELINE_SIZE });
  const simMs = performance.now() - simStart;

  const canvas = createCanvas(BASELINE_SIZE, BASELINE_SIZE);
  const ctx = canvas.getContext("2d");
  const renderStart = performance.now();
  const stats = renderWorld({
    ctx: ctx as unknown as Ctx2D,
    width: BASELINE_SIZE,
    height: BASELINE_SIZE,
    document,
    layers,
    quality: "preview",
  });
  const renderMs = performance.now() - renderStart;

  const encodeStart = performance.now();
  const png = canvas.toBuffer("image/png");
  const thumbPng = downscale(canvas, THUMB_SIZE);
  const encodeMs = performance.now() - encodeStart;

  const readability = assessMapReadability({
    ctx: ctx as unknown as Ctx2D,
    document,
    layers,
    width: BASELINE_SIZE,
    height: BASELINE_SIZE,
    quality: "preview",
  });

  return {
    entry,
    document,
    layers,
    stats,
    readability,
    png,
    thumbPng,
    timings: { simMs, renderMs, encodeMs, totalMs: performance.now() - startedAt },
  };
}

/** Render the 1024² plate for a first-screen scenario card, downscaled to 256². */
export function renderPresetCard(scenario: ScenarioPreset, pipeline: Pipeline): Buffer {
  ensureVisualFonts();
  const document = createDefaultDocument({
    name: scenario.name,
    seed: 101,
    params: { ...DEFAULT_PARAMS, ...scenario.params },
    style: { ...DEFAULT_STYLE, ...scenario.style },
  });
  document.style = { ...document.style, title: scenario.name };
  document.createdAt = "2026-01-01T00:00:00.000Z";
  document.updatedAt = document.createdAt;
  document.id = `preset-card-${scenario.id}`;
  const layers = pipeline.generate({ document, size: PRESET_RENDER_SIZE });
  const canvas = createCanvas(PRESET_RENDER_SIZE, PRESET_RENDER_SIZE);
  const ctx = canvas.getContext("2d");
  renderWorld({
    ctx: ctx as unknown as Ctx2D,
    width: PRESET_RENDER_SIZE,
    height: PRESET_RENDER_SIZE,
    document,
    layers,
    quality: "preview",
  });
  return downscale(canvas, PRESET_CARD_SIZE);
}

export function metricsFor(rendered: RenderedEntry): BaselineMetrics {
  return {
    labelsDrawn: rendered.stats.labelsDrawn,
    labelsSkipped: rendered.stats.labelsSkipped,
    settlements: rendered.stats.settlements,
    landFraction: rendered.readability.metrics.landFraction,
    rivers: rendered.readability.metrics.rivers,
    biomeKinds: rendered.readability.metrics.biomeKinds,
    coastLines: rendered.stats.coastLines,
    riverCount: rendered.stats.riverCount,
    mountainGlyphs: rendered.stats.mountainGlyphs,
    forestGlyphs: rendered.stats.forestGlyphs,
    readabilityScore: rendered.readability.score,
  };
}

// ── baseline generation / loading ────────────────────────────────────────
export interface GenerateBaselineResult {
  manifest: BaselineManifest;
  totalBytes: number;
  totalMs: number;
}

/** Render the full matrix and write baseline PNGs, thumbnails, cards and manifest. */
export function generateBaselines(options: { log?: (line: string) => void } = {}): GenerateBaselineResult {
  const log = options.log ?? ((line: string) => console.log(line));
  ensureVisualFonts();
  mkdirSync(BASELINE_DIR, { recursive: true });
  mkdirSync(BASELINE_THUMB_DIR, { recursive: true });
  mkdirSync(PRESET_THUMB_DIR, { recursive: true });

  const pipeline = createPipeline();
  const startedAt = performance.now();
  const entries: BaselineEntry[] = [];
  let totalBytes = 0;

  for (const entry of MATRIX) {
    const rendered = renderEntry(entry, pipeline);
    writeFileSync(join(BASELINE_DIR, `${entry.id}.png`), rendered.png);
    writeFileSync(join(BASELINE_THUMB_DIR, `${entry.id}.png`), rendered.thumbPng);
    totalBytes += rendered.png.length + rendered.thumbPng.length;
    entries.push({
      id: entry.id,
      scenario: entry.scenarioId,
      scenarioName: rendered.document.name,
      seed: entry.seed,
      stylePreset: rendered.document.style.preset,
      width: BASELINE_SIZE,
      height: BASELINE_SIZE,
      thumbWidth: THUMB_SIZE,
      thumbHeight: THUMB_SIZE,
      sha256: sha256(rendered.png),
      thumbSha256: sha256(rendered.thumbPng),
      metrics: metricsFor(rendered),
    });
    log(
      `  ${entry.id.padEnd(24)} ${(rendered.png.length / 1024).toFixed(0)}KB  ` +
        `sim=${rendered.timings.simMs.toFixed(0)}ms render=${rendered.timings.renderMs.toFixed(0)}ms ` +
        `labels=${rendered.stats.labelsDrawn} settlements=${rendered.stats.settlements} ` +
        `score=${rendered.readability.score}`,
    );
  }

  // First-screen scenario cards (1024² render → 256² card, one per preset).
  for (const scenario of SCENARIOS) {
    const card = renderPresetCard(scenario, pipeline);
    writeFileSync(join(PRESET_THUMB_DIR, `${scenario.id}.png`), card);
    totalBytes += card.length;
  }

  const manifest: BaselineManifest = {
    schemaVersion: 1,
    rendererVersion: RENDERER_VERSION,
    source: "core-scenario-presets",
    width: BASELINE_SIZE,
    thumbSize: THUMB_SIZE,
    entries,
  };
  writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);

  // Remove stale plates from older matrices so the committed folder stays clean.
  const keep = new Set(MATRIX.map((entry) => `${entry.id}.png`));
  for (const [dir, suffix] of [
    [BASELINE_DIR, ""],
    [BASELINE_THUMB_DIR, ""],
  ] as Array<[string, string]>) {
    for (const file of readdirSync(dir)) {
      if (!suffix && file.endsWith(".png") && !keep.has(file)) {
        try {
          unlinkSync(join(dir, file));
        } catch {
          // best effort cleanup
        }
      }
    }
  }

  return { manifest, totalBytes, totalMs: performance.now() - startedAt };
}

export function loadManifest(): BaselineManifest | null {
  if (!existsSync(MANIFEST_PATH)) return null;
  try {
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as BaselineManifest;
  } catch {
    return null;
  }
}

// ── pixel comparison (auxiliary to the sha256 assertion) ─────────────────
export interface PixelDiff {
  totalPixels: number;
  diffPixels: number;
  ratio: number;
}

function canvasImageData(canvas: ReturnType<typeof createCanvas>): Uint8ClampedArray {
  const ctx = canvas.getContext("2d") as unknown as {
    getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
  };
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

/** Compare two PNG buffers pixel by pixel (any channel difference counts). */
export async function comparePngPixels(
  baselinePng: Buffer,
  candidatePng: Buffer,
): Promise<PixelDiff> {
  const [baselineImage, candidateImage] = await Promise.all([loadImage(baselinePng), loadImage(candidatePng)]);
  if (baselineImage.width !== candidateImage.width || baselineImage.height !== candidateImage.height) {
    return {
      totalPixels: baselineImage.width * baselineImage.height,
      diffPixels: baselineImage.width * baselineImage.height,
      ratio: 1,
    };
  }
  const width = baselineImage.width;
  const height = baselineImage.height;
  const load = (image: Awaited<ReturnType<typeof loadImage>>): Uint8ClampedArray => {
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0);
    return canvasImageData(canvas);
  };
  const a = load(baselineImage);
  const b = load(candidateImage);
  let diffPixels = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) {
      diffPixels += 1;
    }
  }
  return { totalPixels: width * height, diffPixels, ratio: diffPixels / (width * height) };
}

export interface CompareEntryResult {
  id: string;
  status: "ok" | "diff" | "missing-baseline" | "missing-entry";
  shaMatch: boolean;
  diffRatio?: number;
  thumbShaMatch?: boolean;
  metricsDelta?: Partial<Record<keyof BaselineMetrics, number>>;
  message?: string;
}

export interface CompareResult {
  ok: boolean;
  skipped: boolean;
  rendererVersion: string;
  baselineRendererVersion?: string;
  entries: CompareEntryResult[];
  totalMs: number;
}

const DIFF_THRESHOLD = 0.0015; // 0.15% of pixels

function metricsDelta(expected: BaselineMetrics, actual: BaselineMetrics): Partial<Record<keyof BaselineMetrics, number>> {
  const delta: Partial<Record<keyof BaselineMetrics, number>> = {};
  for (const key of Object.keys(expected) as Array<keyof BaselineMetrics>) {
    const diff = actual[key] - expected[key];
    if (diff !== 0) delta[key] = diff;
  }
  return delta;
}

export interface RunCompareOptions {
  /** When no manifest exists: "skip" logs and returns ok, "fail" throws. Default "fail". */
  missingBaseline?: "skip" | "fail";
  log?: (line: string) => void;
}

/** Re-render the matrix and compare against the committed baseline manifest. */
export async function runVisualCompare(options: RunCompareOptions = {}): Promise<CompareResult> {
  const log = options.log ?? ((line: string) => console.log(line));
  const startedAt = performance.now();
  const manifest = loadManifest();
  if (!manifest) {
    if (options.missingBaseline === "skip") {
      log("[visual] no baseline manifest found — skipped (run `pnpm qa:baseline` to create one)");
      return { ok: true, skipped: true, rendererVersion: RENDERER_VERSION, entries: [], totalMs: 0 };
    }
    throw new Error(
      `baseline manifest not found at ${MANIFEST_PATH}; run \`tsx scripts/visual-baseline.ts\` first`,
    );
  }

  ensureVisualFonts();
  const pipeline = createPipeline();
  const matrixById = new Map(MATRIX.map((entry) => [entry.id, entry]));
  const manifestIds = new Set(manifest.entries.map((entry) => entry.id));
  const results: CompareEntryResult[] = [];
  let failures = 0;

  if (manifest.rendererVersion !== RENDERER_VERSION) {
    log(
      `[visual] renderer version changed: baseline=${manifest.rendererVersion} current=${RENDERER_VERSION} ` +
        `(pixel comparison still runs; regenerate with qa:baseline after intentional visual changes)`,
    );
  }

  for (const expected of manifest.entries) {
    const matrixEntry = matrixById.get(expected.id);
    if (!matrixEntry) {
      results.push({ id: expected.id, status: "missing-entry", shaMatch: false });
      failures += 1;
      continue;
    }
    const rendered = renderEntry(matrixEntry, pipeline);
    const sha = sha256(rendered.png);
    // sha256 is the primary assertion; per-pixel diff explains a mismatch.
    const shaMatch = sha === expected.sha256;
    const thumbShaMatch = sha256(rendered.thumbPng) === expected.thumbSha256;
    let diffRatio: number | undefined;
    let message: string | undefined;
    let status: CompareEntryResult["status"] = "ok";

    if (!shaMatch) {
      const baselineFile = join(BASELINE_DIR, `${expected.id}.png`);
      if (!existsSync(baselineFile)) {
        status = "missing-baseline";
        message = "baseline image missing on disk";
      } else {
        const diff = await comparePngPixels(readFileSync(baselineFile), rendered.png);
        diffRatio = diff.ratio;
        status = diff.ratio > DIFF_THRESHOLD ? "diff" : "ok";
        message =
          status === "diff"
            ? `${(diff.ratio * 100).toFixed(3)}% pixels differ (threshold 0.15%)`
            : `sha changed but only ${(diff.ratio * 100).toFixed(4)}% pixels differ (within tolerance)`;
      }
    }
    const delta = metricsDelta(expected.metrics, metricsFor(rendered));
    if (status === "diff" || status === "missing-baseline") failures += 1;
    if (Object.keys(delta).length > 0 && status === "ok") {
      message = `${message ? `${message}; ` : ""}metrics changed`;
    }
    results.push({
      id: expected.id,
      status,
      shaMatch,
      diffRatio,
      thumbShaMatch,
      metricsDelta: Object.keys(delta).length > 0 ? delta : undefined,
      message,
    });

    const mark = status === "ok" ? "✓" : "✗";
    const detail: string[] = [];
    if (!shaMatch) {
      detail.push(diffRatio === undefined ? "sha only" : `${(diffRatio * 100).toFixed(3)}% diff`);
    }
    if (!thumbShaMatch) detail.push("thumb differs");
    if (Object.keys(delta).length > 0) {
      detail.push(
        `metrics ${Object.entries(delta)
          .map(([key, value]) => `${key}${value! > 0 ? "+" : ""}${value}`)
          .join(",")}`,
      );
    }
    log(
      `  ${mark} ${expected.id.padEnd(24)} ${detail.length > 0 ? detail.join(" · ") : "identical"}` +
        `${message ? `  (${message})` : ""}`,
    );
  }

  const unlisted = MATRIX.filter((entry) => !manifestIds.has(entry.id));
  if (unlisted.length > 0) {
    log(
      `[visual] ${unlisted.length} matrix entr${unlisted.length === 1 ? "y" : "ies"} missing from manifest: ` +
        `${unlisted.map((e) => e.id).join(", ")} (run qa:baseline --update)`,
    );
  }

  const totalMs = performance.now() - startedAt;
  const ok = failures === 0;
  log(
    `[visual] ${ok ? "PASS" : "FAIL"}: ${results.length - failures}/${results.length} entries match ` +
      `(renderer ${RENDERER_VERSION}, sha256 primary + 0.15% pixel tolerance, ${(totalMs / 1000).toFixed(1)}s)`,
  );
  return {
    ok,
    skipped: false,
    rendererVersion: RENDERER_VERSION,
    baselineRendererVersion: manifest.rendererVersion,
    entries: results,
    totalMs,
  };
}
