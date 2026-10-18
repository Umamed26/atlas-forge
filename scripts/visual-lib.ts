/**
 * Shared helpers for the visual regression harness (scripts/visual-*.ts) and
 * the qa:render append hook.
 *
 * The matrix is a fixed set of scenario-preset × seed combinations. Baseline
 * plates are rendered at 512² and stored together with 256² thumbnails, keeping
 * the committed baseline set around ~5MB. First-screen preset cards are
 * rendered at 1024² and downscaled to 256² for the web welcome screen.
 *
 * Comparison is deliberately tolerant of environment-level anti-aliasing /
 * font-fallback differences (local Skia vs GitHub runner) while still catching
 * real regressions:
 *   1) per-pixel: a pixel counts as different only when a channel delta is > 16;
 *      structural diff must stay <= 0.15% of pixels;
 *   2) structural: both images are box-downsampled to 64×64 and the max channel
 *      mean delta must stay <= 3.0 (catches global brightness / shifts);
 *   3) sha256 is kept as a diagnostic reference, never a failure condition.
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
/** Tolerant comparison thresholds (anti-aliasing / font-fallback safe). */
export const CHANNEL_DELTA_TOLERANCE = 16;
export const STRUCTURAL_DIFF_THRESHOLD = 0.0015; // 0.15% of pixels
export const DOWNSAMPLED_DELTA_THRESHOLD = 3.0;
export const DOWNSAMPLE_SIZE = 64;

export interface VisualDiffMetrics {
  totalPixels: number;
  /** Pixels where any RGB channel delta exceeds CHANNEL_DELTA_TOLERANCE. */
  diffPixels: number;
  /** diffPixels / totalPixels — must be <= STRUCTURAL_DIFF_THRESHOLD. */
  structuralDiff: number;
  /** Largest single-channel delta found (diagnostic; AA noise is usually < 16). */
  maxChannelDelta: number;
  /** Max channel mean delta after box-downsampling both images to 64×64. */
  downsampledMaxDelta: number;
}

function canvasImageData(canvas: ReturnType<typeof createCanvas>): Uint8ClampedArray {
  const ctx = canvas.getContext("2d") as unknown as {
    getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
  };
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

async function decodePng(png: Buffer): Promise<{ width: number; height: number; data: Uint8ClampedArray }> {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  return { width: image.width, height: image.height, data: canvasImageData(canvas) };
}

/** True when tolerances pass (used by runVisualCompare and the self-test). */
export function metricsPass(metrics: VisualDiffMetrics): boolean {
  // Tiny epsilon so an exactly-+3 global brightness is still within the 3.0
  // threshold despite floating-point mean rounding.
  return (
    metrics.structuralDiff <= STRUCTURAL_DIFF_THRESHOLD + 1e-9 &&
    metrics.downsampledMaxDelta <= DOWNSAMPLED_DELTA_THRESHOLD + 1e-6
  );
}

/**
 * Tolerant visual comparison:
 *  - per-pixel structural diff with a 16-level channel tolerance;
 *  - 64×64 downsample mean-delta for global brightness / large displacement.
 * sha256 equality is not required: AA differences between Skia versions and
 * missing CJK fallback fonts produce <16 channel noise and cancel out in means.
 */
export async function comparePngStructural(
  baselinePng: Buffer,
  candidatePng: Buffer,
): Promise<VisualDiffMetrics> {
  const [baseline, candidate] = await Promise.all([decodePng(baselinePng), decodePng(candidatePng)]);
  if (baseline.width !== candidate.width || baseline.height !== candidate.height) {
    return {
      totalPixels: baseline.width * baseline.height,
      diffPixels: baseline.width * baseline.height,
      structuralDiff: 1,
      maxChannelDelta: 255,
      downsampledMaxDelta: 255,
    };
  }
  const width = baseline.width;
  const height = candidate.height;
  const totalPixels = width * height;
  const a = baseline.data;
  const b = candidate.data;

  const cells = DOWNSAMPLE_SIZE * DOWNSAMPLE_SIZE;
  const sumsA = new Float64Array(cells * 3);
  const sumsB = new Float64Array(cells * 3);
  const counts = new Uint32Array(cells);
  const xCell = new Int32Array(width);
  for (let x = 0; x < width; x += 1) {
    xCell[x] = Math.min(DOWNSAMPLE_SIZE - 1, Math.floor((x * DOWNSAMPLE_SIZE) / width));
  }
  const yCells = new Int32Array(height);
  for (let y = 0; y < height; y += 1) {
    yCells[y] = Math.min(DOWNSAMPLE_SIZE - 1, Math.floor((y * DOWNSAMPLE_SIZE) / height));
  }

  let diffPixels = 0;
  let maxChannelDelta = 0;
  for (let y = 0; y < height; y += 1) {
    const cellRow = yCells[y] * DOWNSAMPLE_SIZE;
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const dr = Math.abs(a[i] - b[i]);
      const dg = Math.abs(a[i + 1] - b[i + 1]);
      const db = Math.abs(a[i + 2] - b[i + 2]);
      const pixelDelta = dr > dg ? (dr > db ? dr : db) : dg > db ? dg : db;
      if (pixelDelta > maxChannelDelta) maxChannelDelta = pixelDelta;
      if (pixelDelta > CHANNEL_DELTA_TOLERANCE) diffPixels += 1;

      const cell = cellRow + xCell[x];
      counts[cell] += 1;
      sumsA[cell * 3] += a[i];
      sumsA[cell * 3 + 1] += a[i + 1];
      sumsA[cell * 3 + 2] += a[i + 2];
      sumsB[cell * 3] += b[i];
      sumsB[cell * 3 + 1] += b[i + 1];
      sumsB[cell * 3 + 2] += b[i + 2];
    }
  }

  // Mean of the 64×64 block means per channel (empty blocks ignored).
  const meanA = [0, 0, 0];
  const meanB = [0, 0, 0];
  let used = 0;
  for (let cell = 0; cell < cells; cell += 1) {
    const count = counts[cell];
    if (count === 0) continue;
    used += 1;
    for (let c = 0; c < 3; c += 1) {
      meanA[c] += sumsA[cell * 3 + c] / count;
      meanB[c] += sumsB[cell * 3 + c] / count;
    }
  }
  let downsampledMaxDelta = 0;
  if (used > 0) {
    for (let c = 0; c < 3; c += 1) {
      const delta = Math.abs(meanA[c] / used - meanB[c] / used);
      if (delta > downsampledMaxDelta) downsampledMaxDelta = delta;
    }
  }

  return {
    totalPixels,
    diffPixels,
    structuralDiff: diffPixels / totalPixels,
    maxChannelDelta,
    downsampledMaxDelta,
  };
}

export interface CompareEntryResult {
  id: string;
  status: "ok" | "diff" | "missing-baseline" | "missing-entry";
  /** Diagnostic reference only — never a failure condition (AA differences). */
  shaMatch: boolean;
  structuralDiff?: number;
  maxChannelDelta?: number;
  downsampledMaxDelta?: number;
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

/**
 * Re-render the matrix and compare against the committed baseline manifest.
 * Pass/fail is based on tolerant structural metrics (16-level per-channel
 * tolerance + 64×64 mean delta); sha256 equality is reported only as a
 * diagnostic so CI font/AA differences between environments do not fail.
 */
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
      results.push({ id: expected.id, status: "missing-entry", shaMatch: false, message: "matrix entry not found" });
      failures += 1;
      continue;
    }
    const rendered = renderEntry(matrixEntry, pipeline);
    const sha = sha256(rendered.png);
    // sha256 is recorded as a diagnostic reference only: anti-aliasing and font
    // fallback differences across environments change hashes without changing
    // the map. Failure is decided by the tolerant structural comparison below.
    const shaMatch = sha === expected.sha256;
    const thumbShaMatch = sha256(rendered.thumbPng) === expected.thumbSha256;
    let structuralDiff: number | undefined;
    let maxChannelDelta: number | undefined;
    let downsampledMaxDelta: number | undefined;
    let message: string | undefined;
    let status: CompareEntryResult["status"] = "ok";

    if (shaMatch) {
      // Identical bytes → no AA noise. Report zero metrics for a consistent
      // per-entry diagnostic line in local and CI runs.
      structuralDiff = 0;
      maxChannelDelta = 0;
      downsampledMaxDelta = 0;
    } else {
      const baselineFile = join(BASELINE_DIR, `${expected.id}.png`);
      if (!existsSync(baselineFile)) {
        status = "missing-baseline";
        message = "baseline image missing on disk";
      } else {
        const diff = await comparePngStructural(readFileSync(baselineFile), rendered.png);
        structuralDiff = diff.structuralDiff;
        maxChannelDelta = diff.maxChannelDelta;
        downsampledMaxDelta = diff.downsampledMaxDelta;
        if (metricsPass(diff)) {
          message =
            `environmental AA noise within tolerance (sha differs; struct ${(diff.structuralDiff * 100).toFixed(4)}%, ` +
            `ds ${diff.downsampledMaxDelta.toFixed(2)})`;
        } else {
          status = "diff";
          const reasons: string[] = [];
          if (diff.structuralDiff > STRUCTURAL_DIFF_THRESHOLD) {
            reasons.push(
              `structural diff ${(diff.structuralDiff * 100).toFixed(3)}% > 0.15% (>${CHANNEL_DELTA_TOLERANCE} channel levels)`,
            );
          }
          if (diff.downsampledMaxDelta > DOWNSAMPLED_DELTA_THRESHOLD) {
            reasons.push(
              `downsampled mean delta ${diff.downsampledMaxDelta.toFixed(2)} > ${DOWNSAMPLED_DELTA_THRESHOLD} (global brightness/shift)`,
            );
          }
          message = reasons.join("; ");
        }
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
      structuralDiff,
      maxChannelDelta,
      downsampledMaxDelta,
      thumbShaMatch,
      metricsDelta: Object.keys(delta).length > 0 ? delta : undefined,
      message,
    });

    const mark = status === "ok" ? "✓" : "✗";
    const detail: string[] = [];
    detail.push(
      `struct ${((structuralDiff ?? 0) * 100).toFixed(3)}% · maxΔ ${maxChannelDelta ?? 0} · dsΔ ${(downsampledMaxDelta ?? 0).toFixed(2)}`,
    );
    if (shaMatch) detail.push("sha identical");
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
      `(renderer ${RENDERER_VERSION}, structural ≤0.15% @Δ>${CHANNEL_DELTA_TOLERANCE} + 64² mean Δ≤${DOWNSAMPLED_DELTA_THRESHOLD}, ${(totalMs / 1000).toFixed(1)}s)`,
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
