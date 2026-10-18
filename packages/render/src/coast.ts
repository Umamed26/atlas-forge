/**
 * Coastline, coastal hatching and sea engraving.
 *
 * Coastlines are marching-squares traces of the height field, softened with
 * Chaikin smoothing and seeded jitter to look hand-inked. The sea gets a pale
 * ink wash, concentric hachure bands perpendicular to the shore and engraved
 * horizontal ruling lines, all clipped to the ocean.
 */
import type { WorldLayers } from "@atlas/core";
import type { Ctx2D } from "./canvas-types";
import {
  chaikin,
  traceIsoLines,
  isMeaningfulLoop,
  jitterPolyline,
  signedArea,
  type IsoLine,
} from "./contour";
import { hash01, hashSigned, signedNoise1 } from "./noise";
import { sampleMask, sampleScalar } from "./sampling";
import { cssRgb, type RenderTheme } from "./style";

export interface CoastData {
  coast: IsoLine[];
  /** Closed land loops used to clip the sea (windings normalized for holes). */
  oceanHoles: number[][];
  lakes: IsoLine[];
}

export interface CoastOptions {
  width: number;
  height: number;
  /** Design scale: pixels per 1024 reference pixel. */
  scale: number;
  theme: RenderTheme;
  seed: number;
  quality: "preview" | "export";
  layers: WorldLayers;
  seaLevel: number;
}

function traceCoast(height: Float32Array, size: number, seaLevel: number): IsoLine[] {
  const raw = traceIsoLines(height, size, seaLevel);
  return raw.map((line) => ({
    points: chaikin(line.points, line.closed, 1),
    closed: line.closed,
  }));
}

/** Downsample the height/ocean/lake grids for a cheaper coastline trace. */
function sampleGrids(
  layers: WorldLayers,
  size: number,
): { height: Float32Array; ocean: Uint8Array; lake: Uint8Array } {
  const src = layers.size;
  const cells = size * size;
  const height = new Float32Array(cells);
  const ocean = new Uint8Array(cells);
  const lake = new Uint8Array(cells);
  for (let y = 0; y < size; y += 1) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const i = y * size + x;
      height[i] = sampleScalar(layers.height, src, u, v);
      ocean[i] = sampleScalar(layers.ocean, src, u, v) > 0.5 ? 1 : 0;
      lake[i] = sampleScalar(layers.lake, src, u, v) > 0.5 ? 1 : 0;
    }
  }
  return { height, ocean, lake };
}

function traceLakes(mask: Uint8Array, size: number): IsoLine[] {
  if (!mask) return [];
  let hasLake = false;
  for (let i = 0; i < mask.length; i += 1) {
    if (mask[i]) {
      hasLake = true;
      break;
    }
  }
  if (!hasLake) return [];
  const raw = traceIsoLines(mask, size, 0.5);
  const minArea = 1.2 / (size * size);
  return raw
    .filter((line) => (line.closed ? isMeaningfulLoop(line.points, minArea) : true))
    .map((line) => ({
      points: chaikin(line.points, line.closed, line.closed ? 2 : 1),
      closed: line.closed,
    }));
}

/** Build all coastline geometry once per render. */
export function buildCoastData(layers: WorldLayers, seaLevel: number, traceSize?: number): CoastData {
  const srcSize = layers.size;
  const size = Math.max(16, Math.min(srcSize, Math.floor(traceSize ?? srcSize)));
  let height = layers.height;
  let ocean = layers.ocean;
  let lake = layers.lake;
  if (size !== srcSize) {
    const sampled = sampleGrids(layers, size);
    height = sampled.height;
    ocean = sampled.ocean;
    lake = sampled.lake;
  }
  const coast = traceCoast(height, size, seaLevel);
  const lakes = traceLakes(lake, size);
  const oceanHoles: number[][] = [];
  for (const line of coast) {
    if (!line.closed) continue;
    if (!isMeaningfulLoop(line.points, 1.5 / (size * size))) continue;
    // Determine whether the loop encloses land (a hole in the sea clip) by
    // probing one side of the first edge.
    const pts = line.points;
    const count = pts.length / 2;
    if (count < 4) continue;
    const i0 = Math.min(count - 1, Math.floor(count * 0.25));
    const i1 = (i0 + 1) % (count - 1);
    const px = pts[i0 * 2];
    const py = pts[i0 * 2 + 1];
    const tx = pts[i1 * 2] - px;
    const ty = pts[i1 * 2 + 1] - py;
    const len = Math.hypot(tx, ty) || 1;
    const nx = -ty / len;
    const ny = tx / len;
    const off = 1.2 / size;
    const area = signedArea(pts);
    // Interior side: CW (area > 0) => right of tangent (-ny, nx).
    const inx = area > 0 ? nx : -nx;
    const iny = area > 0 ? ny : -ny;
    const interiorLand = sampleMask(ocean, size, px + inx * off, py + iny * off) === 0;
    if (!interiorLand) continue;
    // Holes must wind opposite to the outer rectangle (screen-space CW positive).
    oceanHoles.push(area > 0 ? reversePairs(pts) : pts.slice());
  }
  return { coast, oceanHoles, lakes };
}

function reversePairs(points: number[]): number[] {
  const out: number[] = [];
  for (let i = points.length - 2; i >= 0; i -= 2) out.push(points[i], points[i + 1]);
  return out;
}

function toPixels(normalized: number[], width: number, height: number): number[] {
  const out = new Array<number>(normalized.length);
  for (let i = 0; i < normalized.length; i += 2) {
    out[i] = normalized[i] * width;
    out[i + 1] = normalized[i + 1] * height;
  }
  return out;
}

function countPoints(points: number[]): number {
  return points.length / 2;
}

/** Add polyline points to the current canvas path. */
export function addPolylinePath(
  ctx: Ctx2D,
  points: number[],
  width: number,
  height: number,
  closed: boolean,
): void {
  const count = points.length / 2;
  if (count < 2) return;
  ctx.moveTo(points[0] * width, points[1] * height);
  for (let i = 1; i < count; i += 1) ctx.lineTo(points[i * 2] * width, points[i * 2 + 1] * height);
  if (closed) ctx.closePath();
}

function clipToOcean(ctx: Ctx2D, coast: CoastData, width: number, height: number): void {
  ctx.beginPath();
  ctx.rect(0, 0, width, height);
  for (const loop of coast.oceanHoles) {
    const count = loop.length / 2;
    if (count < 3) continue;
    ctx.moveTo(loop[0] * width, loop[1] * height);
    for (let i = 1; i < count; i += 1) ctx.lineTo(loop[i * 2] * width, loop[i * 2 + 1] * height);
    ctx.closePath();
  }
  ctx.clip();
}

/** Wide pale wash strokes that fade the ink out into the sea. */
function drawCoastWash(ctx: Ctx2D, opts: CoastOptions, coast: CoastData): void {
  const { width, height, scale, theme } = opts;
  if (theme.coast.washAlpha <= 0.001) return;
  const layers: Array<{ width: number; alpha: number }> = [
    { width: 2.4, alpha: 0.2 },
    { width: 1.5, alpha: 0.28 },
    { width: 0.85, alpha: 0.36 },
  ];
  for (const layer of layers) {
    ctx.beginPath();
    for (const line of coast.coast) addPolylinePath(ctx, line.points, width, height, line.closed);
    ctx.strokeStyle = cssRgb(theme.ink.hatch, theme.coast.washAlpha * layer.alpha);
    ctx.lineWidth = theme.coast.washWidth * scale * layer.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
  }
}

interface SampledCoast {
  xs: number[];
  ys: number[];
  nx: number[];
  ny: number[];
  tx: number[];
  ty: number[];
  /** +1 when normal points to the sea. */
  seaSign: number[];
  count: number;
}

function sampleCoast(
  line: IsoLine,
  opts: CoastOptions,
  spacingPx: number,
): SampledCoast | null {
  const pts = toPixels(line.points, opts.width, opts.height);
  const count = countPoints(pts);
  if (count < 3) return null;
  const lens: number[] = [0];
  let total = 0;
  for (let i = 1; i < count; i += 1) {
    total += Math.hypot(pts[i * 2] - pts[(i - 1) * 2], pts[i * 2 + 1] - pts[(i - 1) * 2 + 1]);
    lens.push(total);
  }
  if (total < spacingPx * 1.6) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  const nx: number[] = [];
  const ny: number[] = [];
  const tx: number[] = [];
  const ty: number[] = [];
  const seaSign: number[] = [];
  const size = opts.layers.size;
  const off = 2.2 / size;
  let seg = 0;
  for (let s = spacingPx * 0.5; s < total; s += spacingPx) {
    while (seg < count - 2 && lens[seg + 1] < s) seg += 1;
    const segLen = lens[seg + 1] - lens[seg] || 1;
    const t = (s - lens[seg]) / segLen;
    const x = pts[seg * 2] + (pts[(seg + 1) * 2] - pts[seg * 2]) * t;
    const y = pts[seg * 2 + 1] + (pts[(seg + 1) * 2 + 1] - pts[seg * 2 + 1]) * t;
    let dirX = pts[(seg + 1) * 2] - pts[seg * 2];
    let dirY = pts[(seg + 1) * 2 + 1] - pts[seg * 2 + 1];
    const len = Math.hypot(dirX, dirY) || 1;
    dirX /= len;
    dirY /= len;
    const u = x / opts.width;
    const v = y / opts.height;
    let sign = 1;
    if (sampleMask(opts.layers.ocean, size, u - dirY * off, v + dirX * off) === 1) sign = 1;
    else if (sampleMask(opts.layers.ocean, size, u + dirY * off, v - dirX * off) === 1) sign = -1;
    else continue;
    xs.push(x);
    ys.push(y);
    nx.push(-dirY * sign);
    ny.push(dirX * sign);
    tx.push(dirX);
    ty.push(dirY);
    seaSign.push(sign);
  }
  if (xs.length === 0) return null;
  return { xs, ys, nx, ny, tx, ty, seaSign, count: xs.length };
}

/** Concentric hachure bands perpendicular to the shore. */
function drawHatching(ctx: Ctx2D, opts: CoastOptions, coast: CoastData): void {
  const { theme, scale, seed, quality } = opts;
  if (theme.coast.hatchAlpha <= 0.001) return;
  const spacing = Math.max(2.6, theme.coast.hatchSpacing * scale);
  const bands = theme.coast.hatchBands;
  const bandGap = Math.max(2.2, (theme.coast.hatchLength + 1.6) * scale);
  const paths: number[][] = [];
  for (let b = 0; b < bands; b += 1) paths.push([]);
  for (const line of coast.coast) {
    const sampled = sampleCoast(line, opts, spacing);
    if (!sampled) continue;
    for (let i = 0; i < sampled.count; i += 1) {
      const jitter = hashSigned(i, sampled.count, seed + 971);
      const angleJitter = jitter * 0.09;
      const cos = Math.cos(angleJitter);
      const sin = Math.sin(angleJitter);
      const baseNx = sampled.nx[i] * cos - sampled.ny[i] * sin;
      const baseNy = sampled.nx[i] * sin + sampled.ny[i] * cos;
      const baseTx = sampled.tx[i];
      const baseTy = sampled.ty[i];
      for (let b = 0; b < bands; b += 1) {
        // Alternate bands are shifted half a step so the ticks interlock like
        // an engraver's graded coastal shading.
        const along = b % 2 === 1 ? spacing * 0.5 : 0;
        const x = sampled.xs[i] + baseTx * along;
        const y = sampled.ys[i] + baseTy * along;
        const startOff = (0.7 + b * bandGap + hashSigned(i, b, seed + 977) * scale * 0.5);
        const taper = 1 - b * (quality === "export" ? 0.14 : 0.16);
        const len =
          theme.coast.hatchLength * scale * taper * (0.72 + 0.5 * Math.abs(jitter));
        const sx = x + baseNx * startOff;
        const sy = y + baseNy * startOff;
        const ex = sx + baseNx * len;
        const ey = sy + baseNy * len;
        paths[b].push(sx, sy, ex, ey);
      }
    }
  }
  ctx.lineCap = "round";
  for (let b = 0; b < bands; b += 1) {
    const path = paths[b];
    if (path.length === 0) continue;
    ctx.beginPath();
    for (let i = 0; i < path.length; i += 4) {
      ctx.moveTo(path[i], path[i + 1]);
      ctx.lineTo(path[i + 2], path[i + 3]);
    }
    const fade = 1 - b * (quality === "export" ? 0.16 : 0.2);
    ctx.strokeStyle = cssRgb(theme.ink.hatch, theme.coast.hatchAlpha * fade);
    ctx.lineWidth = theme.coast.hatchWidth * scale * Math.max(0.6, 1 - b * 0.12);
    ctx.stroke();
  }
}

/** Engraved horizontal ruling lines across the open sea. */
function drawSeaRuling(ctx: Ctx2D, opts: CoastOptions): void {
  const { width, height, scale, theme, seed, quality } = opts;
  if (theme.ocean.rulingAlpha <= 0.001) return;
  const spacing = Math.max(6, theme.ocean.rulingSpacing * scale * (quality === "preview" ? 1.25 : 1));
  const step = Math.max(8, (quality === "preview" ? 15 : 11) * scale);
  const amp = theme.ocean.rulingWave * scale;
  const wobbleFreq = 2.6;
  const lineCount = Math.floor(height / spacing) + 1;
  // Draw every other line separately so alternating lines can differ slightly
  // in weight, like an engraver re-inking the ruler.
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let pass = 0; pass < 2; pass += 1) {
    ctx.beginPath();
    for (let k = pass; k < lineCount; k += 2) {
      const y = (k + 0.9) * spacing;
      if (y > height + spacing) continue;
      const rowPhase = hashSigned(0, k, seed + 313) * 4;
      for (let x = -step; x <= width + step; x += step) {
        const u = x / width;
        const wob =
          signedNoise1(u * wobbleFreq + rowPhase, seed + 701) * amp +
          Math.sin(u * Math.PI * 4 + rowPhase) * amp * 0.28;
        const yy = y + wob;
        if (x === -step) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
    }
    ctx.strokeStyle = cssRgb(theme.ocean.ruling, theme.ocean.rulingAlpha * (pass === 0 ? 1 : 0.72));
    ctx.lineWidth = theme.ocean.rulingWidth * scale * (pass === 0 ? 1 : 0.8);
    ctx.stroke();
  }
  // A few hand-drawn wave fleurons in open water.
  {
    ctx.beginPath();
    const glyphCount = quality === "export" ? 130 : 60;
    for (let g = 0; g < glyphCount; g += 1) {
      const gu = hashSigned(g, 1, seed + 1709) * 0.5 + 0.5;
      const gv = hashSigned(g, 2, seed + 1717) * 0.5 + 0.5;
      const gx = gu * width;
      const gy = gv * height;
      const gw = 5.5 * scale;
      const gh = 1.4 * scale;
      ctx.moveTo(gx - gw, gy);
      ctx.quadraticCurveTo(gx - gw * 0.5, gy - gh, gx, gy);
      ctx.quadraticCurveTo(gx + gw * 0.5, gy - gh, gx + gw, gy);
    }
    ctx.strokeStyle = cssRgb(theme.ocean.ruling, theme.ocean.rulingAlpha * 0.85);
    ctx.lineWidth = 0.85 * scale;
    ctx.stroke();
  }
}

/**
 * Layered pale ink bands hugging the coast: old charts fade the sea out in
 * several concentric washes, which keeps large oceans from reading as a flat
 * slab of colour. Everything is clipped to the ocean by the caller.
 */
function drawCoastalFade(ctx: Ctx2D, opts: CoastOptions, coast: CoastData): void {
  const { width, height, scale, theme } = opts;
  if (theme.coast.washAlpha <= 0.001) return;
  const allBands: Array<{ width: number; alpha: number }> = [
    { width: 3.2, alpha: 0.16 },
    { width: 6.4, alpha: 0.12 },
    { width: 11, alpha: 0.09 },
    { width: 18, alpha: 0.06 },
    { width: 28, alpha: 0.035 },
  ];
  const bands = opts.quality === "export" ? allBands : allBands.slice(0, 3);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (const band of bands) {
    ctx.beginPath();
    for (const line of coast.coast) addPolylinePath(ctx, line.points, width, height, line.closed);
    ctx.strokeStyle = cssRgb(theme.ink.hatch, theme.coast.washAlpha * band.alpha * 6);
    ctx.lineWidth = band.width * scale;
    ctx.stroke();
  }
}

/**
 * Faint portolan rhumb lines radiating from the compass (and one secondary
 * node) fill big empty seas with the navigation web old charts are famous for.
 * Everything is clipped to the ocean by the caller.
 */
function drawRhumbLines(ctx: Ctx2D, opts: CoastOptions): void {
  const { width, height, scale, theme, seed, quality } = opts;
  const baseAlpha = theme.ocean.rulingAlpha * 0.34;
  if (baseAlpha <= 0.005) return;
  const nodes: Array<[number, number, number, number]> = [
    // x, y, rays, alpha multiplier
    [width * 0.9, height * 0.13, quality === "export" ? 16 : 12, 1],
    [width * 0.5, height * 0.95, quality === "export" ? 10 : 8, 0.8],
  ];
  ctx.save();
  ctx.lineWidth = Math.max(0.5, 0.6 * scale);
  for (const [nx, ny, rays, mult] of nodes) {
    const radius = Math.hypot(width, height) * 1.15;
    ctx.strokeStyle = cssRgb(theme.ocean.ruling, baseAlpha * mult);
    for (let i = 0; i < rays; i += 1) {
      const angle = (i / rays) * Math.PI * 2 + (hashSigned(i, 0, seed + 4409) * 0.03);
      ctx.beginPath();
      ctx.moveTo(nx, ny);
      ctx.lineTo(nx + Math.cos(angle) * radius, ny + Math.sin(angle) * radius);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/**
 * A handful of long wavy "current" strokes with small arrow heads, spread over
 * the open sea. Very low contrast, purely decorative: they give empty water
 * some hand-drawn direction without competing with the map symbols.
 */
function drawSeaCurrents(ctx: Ctx2D, opts: CoastOptions): void {
  const { width, height, scale, theme, seed, quality } = opts;
  const alpha = theme.ocean.rulingAlpha * 0.9;
  const count = quality === "export" ? 9 : 5;
  ctx.save();
  ctx.strokeStyle = cssRgb(theme.ocean.ruling, alpha);
  ctx.lineWidth = Math.max(0.5, 0.75 * scale);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let i = 0; i < count; i += 1) {
    const sx = (0.08 + hash01(i, 3, seed + 5501) * 0.84) * width;
    const sy = (0.08 + hash01(i, 5, seed + 5503) * 0.84) * height;
    const angle = hash01(i, 7, seed + 5507) * Math.PI * 2;
    const len = (0.06 + hash01(i, 11, seed + 5509) * 0.08) * Math.min(width, height);
    const bow = (hash01(i, 13, seed + 5511) - 0.5) * 0.5;
    const ex = sx + Math.cos(angle) * len;
    const ey = sy + Math.sin(angle) * len;
    const mx = (sx + ex) / 2 - Math.sin(angle) * len * bow;
    const my = (sy + ey) / 2 + Math.cos(angle) * len * bow;
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(mx, my, ex, ey);
    // Arrow head at the downstream end.
    const tx = ex - mx;
    const ty = ey - my;
    const tl = Math.hypot(tx, ty) || 1;
    const ux = tx / tl;
    const uy = ty / tl;
    const hw = 2.2 * scale;
    ctx.moveTo(ex - ux * hw * 1.8 - uy * hw, ey - uy * hw * 1.8 + ux * hw);
    ctx.lineTo(ex, ey);
    ctx.lineTo(ex - ux * hw * 1.8 + uy * hw, ey - uy * hw * 1.8 - ux * hw);
    ctx.stroke();
  }
  ctx.restore();
}

/** Main sea pass: wash, ruling, hachures (clipped to the ocean). */
export function drawSea(ctx: Ctx2D, opts: CoastOptions, coast: CoastData): void {
  ctx.save();
  clipToOcean(ctx, coast, opts.width, opts.height);
  drawCoastalFade(ctx, opts, coast);
  drawCoastWash(ctx, opts, coast);
  drawRhumbLines(ctx, opts);
  drawSeaRuling(ctx, opts);
  drawSeaCurrents(ctx, opts);
  drawHatching(ctx, opts, coast);
  ctx.restore();
}

/** Dark double coastline with seeded hand-drawn wobble. */
export function drawCoastline(ctx: Ctx2D, opts: CoastOptions, coast: CoastData): void {
  const { width, height, scale, theme, seed } = opts;
  const size = Math.min(width, height);
  const jitterAmp = (theme.coast.jitter * scale) / size;
  const jitterBump = (theme.coast.doubleOffset * scale) / size;
  for (const line of coast.coast) {
    const wobbled = jitterPolyline(line.points, line.closed, jitterAmp, 34, seed + 41);
    const offset = offsetPolyline(wobbled, line.closed, jitterBump, opts);
    ctx.beginPath();
    addPolylinePath(ctx, wobbled, width, height, line.closed);
    ctx.strokeStyle = cssRgb(theme.ink.coast, 0.9);
    ctx.lineWidth = theme.coast.lineWidth * scale;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.beginPath();
    addPolylinePath(ctx, offset, width, height, line.closed);
    ctx.strokeStyle = cssRgb(theme.ink.coast, 0.5);
    ctx.lineWidth = theme.coast.lineWidth * scale * 0.55;
    ctx.stroke();
  }
}

/** Offset a polyline toward the sea side by `offsetNorm` normalized units. */
function offsetPolyline(
  points: number[],
  closed: boolean,
  offsetNorm: number,
  opts: CoastOptions,
): number[] {
  const count = points.length / 2;
  if (offsetNorm <= 1e-9 || count < 2) return points.slice();
  const size = opts.layers.size;
  const out = new Array<number>(points.length);
  for (let i = 0; i < count; i += 1) {
    const prev = i > 0 ? i - 1 : closed ? count - 2 : 0;
    const next = i < count - 1 ? i + 1 : closed ? 1 : count - 1;
    const tx = points[next * 2] - points[prev * 2];
    const ty = points[next * 2 + 1] - points[prev * 2 + 1];
    const len = Math.hypot(tx, ty) || 1;
    let nx = -ty / len;
    let ny = tx / len;
    const u = points[i * 2];
    const v = points[i * 2 + 1];
    if (sampleMask(opts.layers.ocean, size, u - nx * 2.5 / size, v - ny * 2.5 / size) === 1) {
      nx = -nx;
      ny = -ny;
    }
    out[i * 2] = points[i * 2] + nx * offsetNorm;
    out[i * 2 + 1] = points[i * 2 + 1] + ny * offsetNorm;
  }
  return out;
}

/** Lake outlines: double line like the coast, no hatching (kept clean). */
export function drawLakes(ctx: Ctx2D, opts: CoastOptions, coast: CoastData): void {
  const { width, height, scale, theme, seed } = opts;
  const size = Math.min(width, height);
  const amp = (0.55 * scale) / size;
  const offNorm = (theme.lake.innerOffset * scale) / size;
  for (const line of coast.lakes) {
    const wobbled = jitterPolyline(line.points, line.closed, amp, 26, seed + 59);
    if (line.closed && theme.lake.fillAlpha > 0.01) {
      ctx.beginPath();
      addPolylinePath(ctx, wobbled, width, height, true);
      ctx.fillStyle = cssRgb(theme.lake.shallow, theme.lake.fillAlpha);
      ctx.fill();
    }
    ctx.beginPath();
    addPolylinePath(ctx, wobbled, width, height, line.closed);
    ctx.strokeStyle = cssRgb(theme.ink.lake, 0.9);
    ctx.lineWidth = theme.lake.lineWidth * scale;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    if (theme.lake.innerOffset > 0 && line.closed) {
      const inner: number[] = [];
      const count = wobbled.length / 2;
      for (let i = 0; i < count; i += 1) {
        const prev = i > 0 ? i - 1 : count - 2;
        const next = i < count - 1 ? i + 1 : 1;
        const tx = wobbled[next * 2] - wobbled[prev * 2];
        const ty = wobbled[next * 2 + 1] - wobbled[prev * 2 + 1];
        const len = Math.hypot(tx, ty) || 1;
        let nx = -ty / len;
        let ny = tx / len;
        const u = wobbled[i * 2];
        const v = wobbled[i * 2 + 1];
        // Keep the inner line inside the lake.
        if (sampleMask(opts.layers.lake, size, u - nx * 2.5 / size, v - ny * 2.5 / size) === 1) {
          nx = -nx;
          ny = -ny;
        }
        inner.push(u + nx * offNorm, v + ny * offNorm);
      }
      ctx.beginPath();
      addPolylinePath(ctx, inner, width, height, true);
      ctx.strokeStyle = cssRgb(theme.ink.lake, 0.45);
      ctx.lineWidth = theme.lake.lineWidth * scale * 0.55;
      ctx.stroke();
    }
  }
}
