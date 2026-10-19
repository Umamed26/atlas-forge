/**
 * Vector SVG export — layered, print-ready version of the parchment map.
 *
 * Geometry is extracted from the same sources as the canvas renderer
 * (`buildCoastData`, `extractRivers`, marching-squares biome masks, the label
 * layout pass) and then simplified with Douglas–Peucker before being written as
 * SVG paths. No canvas context is used here: the output is a standalone SVG
 * document with paper/ocean/land/biome/lake/river/coast/graticule/label/decor
 * groups, `<text>` labels with a paper-coloured halo (`paint-order`), and
 * optional physical page dimensions (e.g. A3 @ 300 dpi).
 *
 * Budgets: a 1024² export must stay under ~2MB and be generated in under 1.5s.
 */
import type { WorldDocument, WorldLayers } from "@atlas/core";
import { buildCoastData } from "./coast";
import { chaikin, signedArea, traceIsoLines, type IsoLine } from "./contour";
import { textFont } from "./fonts";
import { extractRivers, type RiverPath } from "./hydro";
import { layoutMapLabels, type LaidItem, type LaidMarker, type LaidText, type MeasuredLabel } from "./labels";
import { sampleScalar } from "./sampling";
import { cssRgb, resolveTheme, type Quality, type RenderTheme, type RGB } from "./style";
import { computeChromeLayout } from "./chrome";
import { RENDERER_VERSION } from "./version";

export type SvgPage = "A4" | "A3" | "A2" | "LETTER";

export interface SvgPhysicalSize {
  dpi?: number;
  page?: SvgPage;
  orientation?: "portrait" | "landscape";
  /** Explicit physical size in millimetres (wins over `page`). */
  widthMm?: number;
  heightMm?: number;
}

export interface RenderSvgInput {
  document: WorldDocument;
  layers: WorldLayers;
  width: number;
  height: number;
  quality?: Quality;
  theme?: RenderTheme;
  /** Optional print dimensions (A3 @ 300dpi etc.). */
  physical?: SvgPhysicalSize;
}

export interface SvgStats {
  bytes: number;
  elements: number;
  coastLines: number;
  riverPaths: number;
  biomePolygons: number;
  labels: number;
  settlements: number;
  mountainGlyphs: number;
  forestGlyphs: number;
  generateMs: number;
}

export interface RenderedSvg {
  svg: string;
  stats: SvgStats;
}

const PAGE_MM: Record<SvgPage, [number, number]> = {
  A4: [210, 297],
  A3: [297, 420],
  A2: [420, 594],
  LETTER: [215.9, 279.4],
};

// ── small helpers ─────────────────────────────────────────────────────────
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function fmt(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : `${rounded}`;
}

function rgb(color: RGB, alpha = 1): string {
  return cssRgb(color, alpha);
}

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 0;
}

function hash01(x: number, y: number, seed: number): number {
  return hash(x, y, seed) / 4294967296;
}

/** Douglas–Peucker on a flat [x0,y0,x1,y1,...] list. */
export function simplifyPolyline(points: number[], tolerance: number): number[] {
  const count = points.length / 2;
  if (count < 3 || tolerance <= 0) return points.slice();
  const keep = new Uint8Array(count);
  keep[0] = 1;
  keep[count - 1] = 1;
  const tolerance2 = tolerance * tolerance;
  const stack: Array<[number, number]> = [[0, count - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    const ax = points[first * 2];
    const ay = points[first * 2 + 1];
    const bx = points[last * 2];
    const by = points[last * 2 + 1];
    const abx = bx - ax;
    const aby = by - ay;
    const ab2 = abx * abx + aby * aby;
    let maxDist = -1;
    let maxIndex = -1;
    for (let i = first + 1; i < last; i += 1) {
      const px = points[i * 2];
      const py = points[i * 2 + 1];
      let dist: number;
      if (ab2 <= 1e-12) {
        dist = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        let t = ((px - ax) * abx + (py - ay) * aby) / ab2;
        t = Math.max(0, Math.min(1, t));
        dist = (px - (ax + abx * t)) ** 2 + (py - (ay + aby * t)) ** 2;
      }
      if (dist > maxDist) {
        maxDist = dist;
        maxIndex = i;
      }
    }
    if (maxDist > tolerance2 && maxIndex > 0) {
      keep[maxIndex] = 1;
      stack.push([first, maxIndex], [maxIndex, last]);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    if (keep[i]) out.push(points[i * 2], points[i * 2 + 1]);
  }
  return out;
}

/** SVG path data for a normalized polyline (0..1) scaled to image pixels. */
function polylinePath(points: number[], width: number, height: number, tolerance: number, closed = false): string {
  if (points.length < 4) return "";
  const px: number[] = new Array(points.length);
  for (let i = 0; i < points.length; i += 2) {
    px[i] = points[i] * width;
    px[i + 1] = points[i + 1] * height;
  }
  const simplified = simplifyPolyline(px, tolerance);
  if (simplified.length < 4) return "";
  let d = `M${fmt(simplified[0])} ${fmt(simplified[1])}`;
  for (let i = 2; i < simplified.length; i += 2) {
    d += `L${fmt(simplified[i])} ${fmt(simplified[i + 1])}`;
  }
  if (closed) d += "Z";
  return d;
}

function loopArea(points: number[]): number {
  return Math.abs(signedArea(points));
}

function meaningfulLoops(lines: IsoLine[], minArea: number): IsoLine[] {
  return lines.filter((line) => !line.closed || loopArea(line.points) >= minArea);
}

/** Approximate serif text width for layout without a canvas context. */
function estimateTextWidth(text: string, font: string): number {
  const sizeMatch = /([\d.]+)px/.exec(font);
  const size = sizeMatch ? Number.parseFloat(sizeMatch[1]) : 12;
  let em = 0;
  for (const ch of Array.from(text)) {
    const code = ch.codePointAt(0) ?? 32;
    if (code >= 0x2e80) em += 1;
    else if ("iljtfr.,:;'!|()[]{}".includes(ch)) em += 0.3;
    else if ("MWmw".includes(ch)) em += 0.86;
    else if ("ABCDEFGHIJKLMNOPQRSTUVWXYZ".includes(ch)) em += 0.66;
    else if ("0123456789".includes(ch)) em += 0.52;
    else em += 0.51;
  }
  return em * size;
}

/** Minimal fake context that satisfies the label layout's measurement use. */
function measurementContext(): import("./canvas-types").Ctx2D {
  let font = "";
  return {
    get font(): string {
      return font;
    },
    set font(value: string) {
      font = value;
    },
    measureText(text: string): { width: number } {
      return { width: estimateTextWidth(text, font) };
    },
  } as unknown as import("./canvas-types").Ctx2D;
}

// ── geometry extraction ───────────────────────────────────────────────────
function biomeMask(layers: WorldLayers, biomeId: number, size: number): Uint8Array {
  const mask = new Uint8Array(size * size);
  const src = layers.size;
  for (let y = 0; y < size; y += 1) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      const cell = Math.round(sampleScalar(layers.biome, src, u, v));
      mask[y * size + x] = cell === biomeId ? 1 : 0;
    }
  }
  return mask;
}

function landMask(layers: WorldLayers, size: number): Uint8Array {
  const mask = new Uint8Array(size * size);
  const src = layers.size;
  for (let y = 0; y < size; y += 1) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x += 1) {
      const u = (x + 0.5) / size;
      mask[y * size + x] = sampleScalar(layers.ocean, src, u, v) > 0.5 ? 0 : 1;
    }
  }
  return mask;
}

interface SvgBiome {
  id: number;
  color: RGB;
  loops: IsoLine[];
}

function extractBiomes(layers: WorldLayers, theme: RenderTheme, traceSize: number): SvgBiome[] {
  const present = new Set<number>();
  for (let i = 0; i < layers.biome.length; i += 1) {
    const id = layers.biome[i];
    if (id >= 2) present.add(id);
  }
  const minArea = 1.4 / (traceSize * traceSize);
  const out: SvgBiome[] = [];
  for (const id of [...present].sort((a, b) => a - b)) {
    const lines = meaningfulLoops(traceIsoLines(biomeMask(layers, id, traceSize), traceSize, 0.5), minArea);
    if (lines.length === 0) continue;
    out.push({
      id,
      color: theme.biomeTints[id] ?? theme.biomeTints[0],
      loops: lines.map((line) => ({ points: chaikin(line.points, line.closed, 1), closed: line.closed })),
    });
  }
  return out;
}

interface ElevationBand {
  color: RGB;
  loops: IsoLine[];
}

/** Height bands under the biome wash: gives the flat vector map relief. */
function extractElevationBands(
  layers: WorldLayers,
  theme: RenderTheme,
  seaLevel: number,
  traceSize: number,
): ElevationBand[] {
  const stops: RGB[] = [
    theme.land.low,
    theme.land.olive,
    theme.land.mid,
    theme.land.high,
    theme.land.rock,
    theme.land.peak,
  ];
  const thresholds = [0.004, 0.018, 0.04, 0.075, 0.12, 0.19, 0.3, 0.44];
  const colors: RGB[] = [];
  for (let i = 0; i < thresholds.length; i += 1) {
    const t = i / (thresholds.length - 1);
    const scaled = t * (stops.length - 1);
    const lo = Math.min(stops.length - 2, Math.floor(scaled));
    const f = scaled - lo;
    const a = stops[lo];
    const b = stops[lo + 1];
    colors.push([
      Math.round(a[0] + (b[0] - a[0]) * f),
      Math.round(a[1] + (b[1] - a[1]) * f),
      Math.round(a[2] + (b[2] - a[2]) * f),
    ]);
  }
  const src = layers.size;
  const size = traceSize;
  const minArea = 1.4 / (size * size);
  const out: ElevationBand[] = [];
  for (let i = 0; i < thresholds.length; i += 1) {
    const lo = seaLevel + thresholds[i] - 0.004;
    const hi = i + 1 < thresholds.length ? seaLevel + thresholds[i + 1] - 0.004 : 2;
    const mask = new Uint8Array(size * size);
    for (let y = 0; y < size; y += 1) {
      const v = (y + 0.5) / size;
      for (let x = 0; x < size; x += 1) {
        const u = (x + 0.5) / size;
        const h = sampleScalar(layers.height, src, u, v);
        const ocean = sampleScalar(layers.ocean, src, u, v) > 0.5;
        const lake = sampleScalar(layers.lake, src, u, v) > 0.5;
        mask[y * size + x] = !ocean && !lake && h >= lo && h < hi ? 1 : 0;
      }
    }
    const lines = meaningfulLoops(traceIsoLines(mask, size, 0.5), minArea);
    if (lines.length === 0) continue;
    out.push({
      color: colors[i],
      loops: lines.map((line) => ({ points: chaikin(line.points, line.closed, 1), closed: line.closed })),
    });
  }
  return out;
}

function riverStrokeWidth(
  path: RiverPath,
  layers: WorldLayers,
  theme: RenderTheme,
  scale: number,
): number {
  const n = layers.size;
  let order = 0;
  const orders = layers.riverOrder;
  if (orders) {
    for (let i = 0; i < path.points.length; i += 2) {
      const x = Math.min(n - 1, Math.max(0, Math.floor(path.points[i] * n)));
      const y = Math.min(n - 1, Math.max(0, Math.floor(path.points[i + 1] * n)));
      const cell = y * n + x;
      if (orders[cell] > order) order = orders[cell];
    }
  }
  let t: number;
  if (order > 0) {
    t = Math.min(1, (order - 1) / 4);
    // main stems (order >= 4) get the largest widths
    t = 0.35 + t * 0.65;
  } else {
    let peak = 0;
    for (const f of path.flow) if (f > peak) peak = f;
    t = Math.min(1, Math.sqrt(Math.max(0, peak)));
  }
  const width = theme.river.minWidth + (theme.river.maxWidth - theme.river.minWidth) * t;
  return Math.max(0.45, width * scale * 0.55);
}

// ── decorations (geometry mirrors src/decor.ts) ──────────────────────────
interface SvgDecorPlan {
  m1: number;
  m2: number;
  m3: number;
  cartouche: { x: number; y: number; w: number; h: number };
  compass: { cx: number; cy: number; r: number } | null;
  scaleBar: { x: number; y: number; w: number; h: number } | null;
  legend: { x: number; y: number; w: number; h: number } | null;
  title: string;
  subtitle: string;
  footer: string;
  titleSize: number;
  subtitleSize: number;
  titleTracking: number;
  avoid: Array<{ x: number; y: number; w: number; h: number }>;
  border: boolean;
  graticule: boolean;
  titleVisible: boolean;
  credits: { rect: { x: number; y: number; w: number; h: number }; text: string; size: number } | null;
}

function planSvgDecor(
  document: WorldDocument,
  width: number,
  height: number,
  scale: number,
  theme: RenderTheme,
): SvgDecorPlan {
  const chrome = computeChromeLayout({
    document,
    width,
    height,
    scale,
    theme,
    // SVG has no canvas: estimate with the same EB Garamond metrics the
    // rasteriser uses. Anchored/centred elements still agree because both
    // renderers place them from this identical layout object.
    measure: (text, font, tracking) =>
      estimateTextWidth(text, font) + Math.max(0, Array.from(text).length - 1) * tracking,
  });
  return {
    m1: chrome.m1,
    m2: chrome.m2,
    m3: chrome.m3,
    cartouche: chrome.title.rect,
    compass: chrome.compass,
    scaleBar: chrome.scaleBar,
    legend: chrome.legend,
    title: chrome.title.text,
    subtitle: chrome.title.subtitle,
    footer: chrome.title.footer,
    titleSize: chrome.title.size,
    subtitleSize: chrome.title.subtitleSize,
    titleTracking: chrome.title.tracking,
    avoid: chrome.avoid,
    border: chrome.border,
    graticule: chrome.graticule,
    titleVisible: chrome.title.visible,
    credits: chrome.credits,
  };
}

function starPath(cx: number, cy: number, outer: number, inner: number, points: number): string {
  let d = "";
  for (let i = 0; i < points * 2; i += 1) {
    const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2;
    const r = i % 2 === 0 ? outer : inner;
    d += `${i === 0 ? "M" : "L"}${fmt(cx + Math.cos(angle) * r)} ${fmt(cy + Math.sin(angle) * r)}`;
  }
  return d + "Z";
}

function diamondPath(cx: number, cy: number, r: number): string {
  return `M${fmt(cx)} ${fmt(cy - r)}L${fmt(cx + r)} ${fmt(cy)}L${fmt(cx)} ${fmt(cy + r)}L${fmt(cx - r)} ${fmt(cy)}Z`;
}

function svgDecor(plan: SvgDecorPlan, width: number, height: number, scale: number, theme: RenderTheme): string {
  const parts: string[] = [];
  const border = rgb(theme.ink.border);
  const ink = rgb(theme.ink.main);
  // Frame rules + corner diamonds.
  if (plan.border) {
    parts.push(
      `<rect x="${fmt(plan.m1)}" y="${fmt(plan.m1)}" width="${fmt(width - plan.m1 * 2)}" height="${fmt(height - plan.m1 * 2)}" fill="none" stroke="${border}" stroke-opacity="0.92" stroke-width="${fmt(theme.decor.frameThickness * scale)}"/>`,
    );
    for (const [inset, opacity, sw] of [
      [plan.m2, 0.75, 0.95],
      [plan.m3, 0.45, 0.55],
    ] as Array<[number, number, number]>) {
      parts.push(
        `<rect x="${fmt(inset)}" y="${fmt(inset)}" width="${fmt(width - inset * 2)}" height="${fmt(height - inset * 2)}" fill="none" stroke="${rgb(theme.ink.border, opacity)}" stroke-width="${fmt(sw * scale)}"/>`,
      );
    }
    const r = 2.6 * scale;
    const corners: Array<[number, number]> = [
      [plan.m2, plan.m2],
      [width - plan.m2, plan.m2],
      [width - plan.m2, height - plan.m2],
      [plan.m2, height - plan.m2],
    ];
    for (const [x, y] of corners) {
      parts.push(`<path d="${diamondPath(x, y, r)}" fill="${rgb(theme.paper.light, 0.95)}" stroke="${border}" stroke-width="${fmt(0.7 * scale)}"/>`);
    }
    // Corner flourishes (simplified L-curves).
    const L = Math.min(width, height) * 0.034;
    const inset = plan.m3 + 2 * scale;
    for (const [sx, sy] of [
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ] as Array<[number, number]>) {
      const x = sx > 0 ? width - inset : inset;
      const y = sy > 0 ? height - inset : inset;
      parts.push(
        `<path d="M${fmt(x + sx * L)} ${fmt(y)}H${fmt(x + sx * L * 0.28)}Q${fmt(x)} ${fmt(y)} ${fmt(x)} ${fmt(y + sy * L * 0.28)}V${fmt(y + sy * L)}" fill="none" stroke="${rgb(theme.ink.border, 0.55)}" stroke-width="${fmt(0.8 * scale)}"/>`,
      );
    }
  }
  // Cartouche.
  if (plan.titleVisible) {
  parts.push(`<g id="cartouche" data-decor="title">`);
  const c = plan.cartouche;
  const pad = 12 * scale;
  parts.push(
    `<rect x="${fmt(c.x)}" y="${fmt(c.y)}" width="${fmt(c.w)}" height="${fmt(c.h)}" rx="${fmt(5 * scale)}" fill="${rgb(theme.paper.light, Math.min(1, theme.decor.cartoucheAlpha + 0.06))}" stroke="${rgb(theme.ink.border, 0.85)}" stroke-width="${fmt(1.35 * scale)}"/>`,
  );
  parts.push(
    `<rect x="${fmt(c.x + 4.5 * scale)}" y="${fmt(c.y + 4.5 * scale)}" width="${fmt(c.w - 9 * scale)}" height="${fmt(c.h - 9 * scale)}" rx="${fmt(3 * scale)}" fill="none" stroke="${rgb(theme.ink.border, 0.55)}" stroke-width="${fmt(0.6 * scale)}"/>`,
  );
  parts.push(`<path d="${diamondPath(width / 2, c.y + 9 * scale, 2.4 * scale)}" fill="${rgb(theme.ink.border, 0.8)}"/>`);
  const titleFont = textFont(plan.title, plan.titleSize, false);
  parts.push(
    `<text x="${fmt(width / 2)}" y="${fmt(c.y + c.h * 0.4)}" font-family="EB Garamond, serif" font-size="${fmt(plan.titleSize)}" letter-spacing="${fmt(plan.titleTracking)}" text-anchor="middle" fill="${ink}">${escapeXml(plan.title)}</text>`,
  );
  void titleFont;
  parts.push(
    `<text x="${fmt(width / 2)}" y="${fmt(c.y + c.h * 0.7)}" font-family="EB Garamond, serif" font-size="${fmt(plan.subtitleSize)}" letter-spacing="${fmt(plan.subtitleSize * 0.12)}" text-anchor="middle" fill="${rgb(theme.ink.main, 0.85)}">${escapeXml(plan.subtitle)}</text>`,
  );
  parts.push(
    `<text x="${fmt(width / 2)}" y="${fmt(c.y + c.h * 0.87)}" font-family="EB Garamond, serif" font-size="${fmt(plan.subtitleSize * 0.78)}" letter-spacing="${fmt(plan.subtitleSize * 0.08)}" text-anchor="middle" fill="${rgb(theme.ink.soft, 0.9)}">${escapeXml(plan.footer)}</text>`,
  );
  parts.push(`</g>`);
  }
  // Compass rose.
  if (plan.compass) {
    const { cx, cy, r } = plan.compass;
    parts.push(`<g id="compass" data-decor="compass">`);
    parts.push(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}" fill="none" stroke="${rgb(theme.ink.soft, 0.6)}" stroke-width="${fmt(1 * scale)}"/>`);
    parts.push(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r * 0.72)}" fill="none" stroke="${rgb(theme.ink.soft, 0.4)}" stroke-width="${fmt(0.6 * scale)}"/>`);
    parts.push(`<path d="${starPath(cx, cy, r * 0.9, r * 0.22, 4)}" fill="${rgb(theme.ink.main, 0.72)}"/>`);
    parts.push(`<path d="${starPath(cx, cy, r * 0.52, r * 0.13, 4)}" fill="${rgb(theme.paper.light, 0.92)}"/>`);
    parts.push(`<circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r * 0.29)}" fill="${rgb(theme.paper.light, 0.95)}" stroke="${rgb(theme.ink.main, 0.8)}" stroke-width="${fmt(0.8 * scale)}"/>`);
    parts.push(`<path d="${diamondPath(cx, cy, r * 0.2)}" fill="${rgb(theme.ink.main, 0.85)}"/>`);
    parts.push(
      `<text x="${fmt(cx)}" y="${fmt(cy - r - 6 * scale)}" font-family="EB Garamond, serif" font-size="${fmt(12 * scale)}" text-anchor="middle" fill="${rgb(theme.ink.accent, 0.9)}">N</text>`,
    );
    parts.push(`</g>`);
  }
  // Legend.
  if (plan.legend) {
    const lg = plan.legend;
    const rowH = 18 * scale;
    parts.push(`<g id="legend" data-decor="legend">`);
    parts.push(
      `<rect x="${fmt(lg.x)}" y="${fmt(lg.y)}" width="${fmt(lg.w)}" height="${fmt(lg.h)}" fill="${rgb(theme.paper.light, 0.72)}" stroke="${rgb(theme.ink.border, 0.7)}" stroke-width="${fmt(0.9 * scale)}"/>`,
    );
    parts.push(
      `<text x="${fmt(lg.x + lg.w / 2)}" y="${fmt(lg.y + 13 * scale)}" font-family="EB Garamond, serif" font-size="${fmt(11 * scale)}" letter-spacing="${fmt(2.5 * scale)}" text-anchor="middle" fill="${rgb(theme.ink.soft, 0.95)}">LEGEND</text>`,
    );
    const rowLabels = ["CITY", "RIVER", "MOUNTAINS", "OCEAN"];
    for (let i = 0; i < rowLabels.length; i += 1) {
      const cy = lg.y + (32 + i * 18) * scale;
      const prefix = i === 0
        ? `<circle cx="${fmt(lg.x + 16 * scale)}" cy="${fmt(cy)}" r="${fmt(3.2 * scale)}" fill="none" stroke="${ink}" stroke-width="${fmt(1 * scale)}"/><circle cx="${fmt(lg.x + 16 * scale)}" cy="${fmt(cy)}" r="${fmt(1.6 * scale)}" fill="${ink}"/>`
        : i === 1
          ? `<path d="M${fmt(lg.x + 10 * scale)} ${fmt(cy)}Q${fmt(lg.x + 16 * scale)} ${fmt(cy - 5 * scale)} ${fmt(lg.x + 22 * scale)} ${fmt(cy)}" fill="none" stroke="${rgb(theme.ink.river, 0.9)}" stroke-width="${fmt(1.4 * scale)}"/>`
          : i === 2
            ? `<path d="M${fmt(lg.x + 10 * scale)} ${fmt(cy + 4 * scale)}L${fmt(lg.x + 14 * scale)} ${fmt(cy - 4 * scale)}L${fmt(lg.x + 18 * scale)} ${fmt(cy + 4 * scale)}ZM${fmt(lg.x + 16 * scale)} ${fmt(cy + 4 * scale)}L${fmt(lg.x + 20 * scale)} ${fmt(cy - 2 * scale)}L${fmt(lg.x + 24 * scale)} ${fmt(cy + 4 * scale)}" fill="none" stroke="${rgb(theme.ink.main, 0.8)}" stroke-width="${fmt(0.9 * scale)}"/>`
            : `<line x1="${fmt(lg.x + 10 * scale)}" y1="${fmt(cy - 2 * scale)}" x2="${fmt(lg.x + 24 * scale)}" y2="${fmt(cy - 2 * scale)}" stroke="${rgb(theme.ink.hatch, 0.55)}" stroke-width="${fmt(0.8 * scale)}"/><line x1="${fmt(lg.x + 10 * scale)}" y1="${fmt(cy + 2 * scale)}" x2="${fmt(lg.x + 24 * scale)}" y2="${fmt(cy + 2 * scale)}" stroke="${rgb(theme.ink.hatch, 0.55)}" stroke-width="${fmt(0.8 * scale)}"/>`;
      parts.push(prefix);
      parts.push(
        `<text x="${fmt(lg.x + 30 * scale)}" y="${fmt(cy + 3 * scale)}" font-family="EB Garamond, serif" font-size="${fmt(9.5 * scale)}" letter-spacing="${fmt(1.2 * scale)}" fill="${rgb(theme.ink.soft, 0.95)}">${rowLabels[i]}</text>`,
      );
    }
    parts.push(`</g>`);
  }
  // Scale bar.
  if (plan.scaleBar) {
    const sb = plan.scaleBar;
    parts.push(`<g id="scale" data-decor="scaleBar">`);
    const segments = 4;
    for (let i = 0; i < segments; i += 1) {
      const x = sb.x + (sb.w * i) / segments;
      const fill = i % 2 === 0 ? rgb(theme.ink.main, 0.85) : rgb(theme.paper.light, 0.95);
      parts.push(`<rect x="${fmt(x)}" y="${fmt(sb.y)}" width="${fmt(sb.w / segments)}" height="${fmt(sb.h)}" fill="${fill}" stroke="${rgb(theme.ink.border, 0.8)}" stroke-width="${fmt(0.6 * scale)}"/>`);
    }
    const labels = ["0", "750", "1500 km"];
    labels.forEach((label, i) => {
      parts.push(
        `<text x="${fmt(sb.x + (sb.w * i) / 2)}" y="${fmt(sb.y + sb.h + 9 * scale)}" font-family="EB Garamond, serif" font-size="${fmt(8.5 * scale)}" text-anchor="middle" fill="${rgb(theme.ink.soft, 0.9)}">${label}</text>`,
      );
    });
    parts.push(`</g>`);
  }
  // Credits line (configurable, bottom-centre by default).
  if (plan.credits && plan.credits.text.trim().length > 0) {
    const cr = plan.credits.rect;
    parts.push(
      `<g id="credits" data-decor="credits"><text x="${fmt(cr.x + cr.w / 2)}" y="${fmt(cr.y + cr.h / 2 + plan.credits.size * 0.35)}" font-family="EB Garamond, serif" font-size="${fmt(plan.credits.size)}" text-anchor="middle" fill="${rgb(theme.ink.soft, 0.8)}">${escapeXml(plan.credits.text)}</text></g>`,
    );
  }
  return parts.join("");
}

// ── labels ────────────────────────────────────────────────────────────────
function labelSvg(items: LaidItem[], theme: RenderTheme, scale: number, width: number, height: number): { svg: string; labels: number; settlements: number; measured: MeasuredLabel[] } {
  const parts: string[] = [];
  let labels = 0;
  let settlements = 0;
  const halo = rgb(theme.ink.halo, theme.label.haloAlpha);
  const haloWidth = Math.max(1.2, theme.label.haloWidth * 12 * scale);
  for (const item of items) {
    if (item.type === "marker") {
      parts.push(settlementMarkerSvg(item, theme, scale));
      settlements += 1;
      continue;
    }
    labels += 1;
    const text = item as LaidText;
    const fontSize = text.sizePx;
    const style = text.font.includes("italic") ? "italic" : "normal";
    const fill = text.sea ? rgb(theme.ink.labelWater, 0.95) : rgb(theme.ink.label, 0.95);
    const tracking = text.tracking;
    const y = text.textY;
    const attrs = [
      `x="${fmt(text.textX)}"`,
      `y="${fmt(y)}"`,
      `font-family="EB Garamond, serif"`,
      `font-size="${fmt(fontSize)}"`,
      `font-style="${style}"`,
      `letter-spacing="${fmt(tracking)}"`,
      `text-anchor="middle"`,
      `dominant-baseline="middle"`,
      `paint-order="stroke"`,
      `stroke="${halo}"`,
      `stroke-width="${fmt(haloWidth)}"`,
      `stroke-linejoin="round"`,
      `fill="${fill}"`,
    ];
    if (text.rotation) attrs.push(`transform="rotate(${fmt((text.rotation * 180) / Math.PI)} ${fmt(text.textX)} ${fmt(y)})"`);
    parts.push(`<text ${attrs.join(" ")}>${escapeXml(text.text)}</text>`);
  }
  return { svg: parts.join(""), labels, settlements, measured: [] };
}

function settlementMarkerSvg(item: LaidMarker, theme: RenderTheme, scale: number): string {
  const kind = item.drawable.settlement?.kind ?? "town";
  const r = (kind === "city" ? 3.4 : 2.6) * scale;
  const ink = rgb(theme.ink.main, 0.92);
  const halo = rgb(theme.ink.halo, 0.95);
  const cx = item.cx;
  const cy = item.cy;
  if (kind === "city") {
    return `<g><circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}" fill="${halo}"/><circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r * 0.62)}" fill="${ink}"/><circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}" fill="none" stroke="${ink}" stroke-width="${fmt(Math.max(0.7, 0.9 * scale))}"/></g>`;
  }
  if (kind === "port") {
    return `<g stroke="${ink}" stroke-width="${fmt(Math.max(0.8, 1.05 * scale))}" fill="none"><path d="M${fmt(cx)} ${fmt(cy - r * 1.35)}V${fmt(cy + r)}M${fmt(cx - r * 0.85)} ${fmt(cy - r * 0.5)}H${fmt(cx + r * 0.85)}"/><path d="M${fmt(cx - r * 0.95)} ${fmt(cy + r * 0.95)}a${fmt(r * 0.95)} ${fmt(r * 0.95)} 0 0 0 ${fmt(r * 1.9)} 0"/></g>`;
  }
  if (kind === "fortress") {
    return `<rect x="${fmt(cx - r * 0.85)}" y="${fmt(cy - r * 0.85)}" width="${fmt(r * 1.7)}" height="${fmt(r * 1.7)}" fill="${ink}"/>`;
  }
  if (kind === "ruin") {
    return `<path d="M${fmt(cx - r * 0.8)} ${fmt(cy - r * 0.8)}L${fmt(cx + r * 0.8)} ${fmt(cy + r * 0.8)}M${fmt(cx + r * 0.8)} ${fmt(cy - r * 0.8)}L${fmt(cx - r * 0.8)} ${fmt(cy + r * 0.8)}" stroke="${ink}" stroke-width="${fmt(Math.max(0.9, 1.15 * scale))}" fill="none"/>`;
  }
  return `<g><circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r * 0.55)}" fill="${ink}"/><circle cx="${fmt(cx)}" cy="${fmt(cy)}" r="${fmt(r)}" fill="none" stroke="${ink}" stroke-width="${fmt(Math.max(0.7, 0.85 * scale))}"/></g>`;
}

// ── mountain / forest glyphs ─────────────────────────────────────────────
function mountainGlyphs(layers: WorldLayers, seaLevel: number, theme: RenderTheme, scale: number, width: number, height: number, quality: Quality): { svg: string; count: number } {
  const n = layers.size;
  const step = quality === "export" ? 3 : 5;
  const parts: string[] = [];
  let count = 0;
  const max = quality === "export" ? 320 : 170;
  for (let y = step; y < n - step && count < max; y += step) {
    for (let x = step; x < n - step && count < max; x += step) {
      const cell = y * n + x;
      if (layers.ocean[cell] || layers.lake[cell]) continue;
      const h = layers.height[cell];
      if (h < seaLevel + 0.27) continue;
      let isMax = true;
      const hh = h;
      for (const [dx, dy] of [
        [step, 0],
        [-step, 0],
        [0, step],
        [0, -step],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
        if (layers.height[ny * n + nx] > hh) {
          isMax = false;
          break;
        }
      }
      if (!isMax) continue;
      if (hash01(x, y, 991) > 0.8) continue;
      const px = ((x + 0.5) / n) * width;
      const py = ((y + 0.5) / n) * height;
      const size = (5 + Math.min(6, (h - seaLevel) * 20)) * scale;
      parts.push(
        `<path d="M${fmt(px - size)} ${fmt(py + size * 0.55)}L${fmt(px)} ${fmt(py - size)}L${fmt(px + size)} ${fmt(py + size * 0.55)}" fill="none" stroke="${rgb(theme.ink.main, 0.78)}" stroke-width="${fmt(Math.max(0.55, 0.8 * scale))}"/>`,
      );
      count += 1;
    }
  }
  return { svg: parts.join(""), count };
}

function forestGlyphs(layers: WorldLayers, theme: RenderTheme, scale: number, width: number, height: number, quality: Quality): { svg: string; count: number } {
  const n = layers.size;
  const step = quality === "export" ? 4 : 6;
  const parts: string[] = [];
  let count = 0;
  const max = quality === "export" ? 260 : 150;
  for (let y = step; y < n - step && count < max; y += step) {
    for (let x = step; x < n - step && count < max; x += step) {
      const cell = y * n + x;
      if (layers.ocean[cell] || layers.lake[cell]) continue;
      const b = layers.biome[cell];
      if (b !== 4 && b !== 5 && b !== 10) continue;
      if (hash01(x, y, 733) > 0.5) continue;
      const px = ((x + 0.5) / n) * width;
      const py = ((y + 0.5) / n) * height;
      const size = (2.4 + hash01(x, y, 37) * 1.6) * scale;
      parts.push(
        `<path d="M${fmt(px)} ${fmt(py - size)}L${fmt(px + size * 0.7)} ${fmt(py + size * 0.55)}H${fmt(px - size * 0.7)}Z" fill="${rgb(theme.ink.main, 0.55)}"/>`,
      );
      count += 1;
    }
  }
  return { svg: parts.join(""), count };
}

// ── physical size ─────────────────────────────────────────────────────────
function physicalAttributes(width: number, height: number, physical?: SvgPhysicalSize): string {
  if (!physical) return `width="${fmt(width)}" height="${fmt(height)}"`;
  let mmW: number;
  let mmH: number;
  if (physical.widthMm && physical.heightMm) {
    mmW = physical.widthMm;
    mmH = physical.heightMm;
  } else {
    const page = physical.page ?? "A3";
    const [pw, ph] = PAGE_MM[page] ?? PAGE_MM.A3;
    mmW = pw;
    mmH = ph;
    if (physical.orientation === "landscape") [mmW, mmH] = [mmH, mmW];
  }
  const dpi = physical.dpi ?? 300;
  const pxW = Math.round((mmW / 25.4) * dpi);
  const pxH = Math.round((mmH / 25.4) * dpi);
  const page = physical.page ?? "custom";
  return `width="${pxW}" height="${pxH}" data-physical-mm="${fmt(mmW)}x${fmt(mmH)}" data-dpi="${dpi}" data-page="${page}" preserveAspectRatio="xMidYMid meet"`;
}

// ── public API ────────────────────────────────────────────────────────────
/** Render a standalone layered SVG map (see module docs for layer groups). */
export function renderSvgDetailed(input: RenderSvgInput): RenderedSvg {
  const startedAt = performance.now();
  const width = Math.max(64, Math.round(input.width));
  const height = Math.max(64, Math.round(input.height));
  const quality: Quality = input.quality ?? (Math.min(width, height) >= 2048 ? "export" : "preview");
  const document = input.document;
  const layers = input.layers;
  const theme = input.theme ?? resolveTheme(document.style, quality);
  const scale = Math.min(width, height) / 1024;
  const seed = (document.seed | 0) || 1;
  const seaLevel = Math.min(0.95, Math.max(0.05, document.params.seaLevel));
  const tolerance = Math.max(0.55, 1.35 * Math.max(1, Math.min(width, height) / 1024));

  // Geometry (same extraction path as the canvas renderer).
  const traceSize = quality === "export" ? Math.min(layers.size, 512) : Math.min(layers.size, 384);
  const coast = buildCoastData(layers, seaLevel, traceSize);
  const rivers = document.style.showRivers
    ? extractRivers(layers, {
        maxRivers: quality === "export" ? 190 : 46,
        minFlowRatio: quality === "export" ? 0.0025 : 0.006,
        smoothing: 3,
      })
    : [];
  const biomes = extractBiomes(layers, theme, traceSize);
  const elevationBands = extractElevationBands(layers, theme, seaLevel, traceSize);
  const land = meaningfulLoops(traceIsoLines(landMask(layers, traceSize), traceSize, 0.5), 1.5 / (traceSize * traceSize)).map(
    (line) => ({ points: chaikin(line.points, line.closed, 1), closed: line.closed }),
  );

  const decor = planSvgDecor(document, width, height, scale, theme);
  const measurer = measurementContext();
  const labelLayout = document.style.showLabels
    ? layoutMapLabels(measurer, {
        width,
        height,
        scale,
        theme,
        seed,
        quality,
        document,
        layers,
        avoid: decor.avoid,
      })
    : null;
  const labelBits = labelLayout ? labelSvg(labelLayout.items, theme, scale, width, height) : { svg: "", labels: 0, settlements: 0, measured: [] };
  const mountains = mountainGlyphs(layers, seaLevel, theme, scale, width, height, quality);
  const forests = forestGlyphs(layers, theme, scale, width, height, quality);

  const defs: string[] = [];
  defs.push(
    `<radialGradient id="paperVignette" cx="50%" cy="46%" r="72%"><stop offset="0%" stop-color="${rgb(theme.paper.light, 0)}"/><stop offset="72%" stop-color="${rgb(theme.paper.shade, 0)}"/><stop offset="100%" stop-color="${rgb(theme.paper.shade, theme.paper.vignette)}"/></radialGradient>`,
  );
  defs.push(
    `<linearGradient id="oceanGradient" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${rgb(theme.ocean.shallow)}"/><stop offset="52%" stop-color="${rgb(theme.ocean.mid)}"/><stop offset="100%" stop-color="${rgb(theme.ocean.deep)}"/></linearGradient>`,
    `<pattern id="seaRuling" width="${fmt(theme.ocean.rulingSpacing * scale * 2.6)}" height="${fmt(theme.ocean.rulingSpacing * scale * 2.6)}" patternUnits="userSpaceOnUse"><line x1="0" y1="${fmt(theme.ocean.rulingSpacing * scale * 1.3)}" x2="${fmt(theme.ocean.rulingSpacing * scale * 2.6)}" y2="${fmt(theme.ocean.rulingSpacing * scale * 1.3)}" stroke="${rgb(theme.ocean.ruling)}" stroke-opacity="${fmt(theme.ocean.rulingAlpha * 0.45)}" stroke-width="${fmt(theme.ocean.rulingWidth * scale * 0.7)}"/></pattern>`,
  );
  defs.push(
    `<clipPath id="frameClip"><rect x="${fmt(decor.m3)}" y="${fmt(decor.m3)}" width="${fmt(width - decor.m3 * 2)}" height="${fmt(height - decor.m3 * 2)}"/></clipPath>`,
  );

  const groups: string[] = [];
  // Paper + ocean.
  groups.push(
    `<rect id="paper" x="0" y="0" width="${fmt(width)}" height="${fmt(height)}" fill="${rgb(theme.paper.base)}"/>`,
  );
  groups.push(
    `<rect id="ocean" x="0" y="0" width="${fmt(width)}" height="${fmt(height)}" fill="url(#oceanGradient)"/>`,
  );
  groups.push(
    `<rect x="0" y="0" width="${fmt(width)}" height="${fmt(height)}" fill="url(#seaRuling)" clip-path="url(#frameClip)"/>`,
  );
  // Land base + relief bands.
  const landPaths = land
    .map((loop) => polylinePath(loop.points, width, height, tolerance, loop.closed))
    .filter(Boolean)
    .join("");
  groups.push(`<g id="land"><path d="${landPaths}" fill-rule="evenodd" fill="${rgb(theme.land.low)}" stroke="none"/></g>`);
  const terrainParts: string[] = [];
  for (const band of elevationBands) {
    const d = band.loops
      .map((loop) => polylinePath(loop.points, width, height, tolerance, loop.closed))
      .filter(Boolean)
      .join("");
    if (!d) continue;
    terrainParts.push(`<path d="${d}" fill-rule="evenodd" fill="${rgb(band.color)}" stroke="none"/>`);
  }
  groups.push(`<g id="terrain">${terrainParts.join("")}</g>`);
  // Biome washes (low opacity over the relief bands, like the canvas tint pass).
  const biomeParts: string[] = [];
  for (const biome of biomes) {
    const d = biome.loops
      .map((loop) => polylinePath(loop.points, width, height, tolerance, loop.closed))
      .filter(Boolean)
      .join("");
    if (!d) continue;
    biomeParts.push(
      `<path d="${d}" fill-rule="evenodd" fill="${rgb(biome.color, Math.min(0.42, theme.biomeMix * 0.62))}" stroke="none"/>`,
    );
  }
  groups.push(`<g id="biomes">${biomeParts.join("")}</g>`);
  // Mountain + forest glyphs.
  groups.push(`<g id="forests">${forests.svg}</g>`);
  groups.push(`<g id="mountains">${mountains.svg}</g>`);
  // Lakes.
  const lakeParts: string[] = [];
  for (const lake of coast.lakes) {
    const d = polylinePath(lake.points, width, height, tolerance * 0.7, lake.closed);
    if (!d) continue;
    lakeParts.push(
      `<path d="${d}" fill="${rgb(theme.lake.deep, theme.lake.fillAlpha)}" stroke="${rgb(theme.ink.lake, 0.85)}" stroke-width="${fmt(theme.lake.lineWidth * scale)}" fill-rule="evenodd"/>`,
    );
  }
  groups.push(`<g id="lakes">${lakeParts.join("")}</g>`);
  // Rivers.
  const riverParts: string[] = [];
  for (const river of rivers) {
    const d = polylinePath(river.points, width, height, tolerance * 0.55, false);
    if (!d) continue;
    const sw = riverStrokeWidth(river, layers, theme, scale);
    riverParts.push(
      `<path d="${d}" fill="none" stroke="${rgb(theme.ink.river, theme.river.bankAlpha)}" stroke-width="${fmt(sw * theme.river.bankWidth * 2.2)}" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
    riverParts.push(
      `<path d="${d}" fill="none" stroke="${rgb(theme.ink.river, theme.river.alpha)}" stroke-width="${fmt(sw)}" stroke-linecap="round" stroke-linejoin="round"/>`,
    );
  }
  groups.push(`<g id="rivers">${riverParts.join("")}</g>`);
  // Coastlines (double line + soft wash).
  const coastParts: string[] = [];
  for (const line of coast.coast) {
    const d = polylinePath(line.points, width, height, tolerance, line.closed);
    if (!d) continue;
    coastParts.push(
      `<path d="${d}" fill="none" stroke="${rgb(theme.ink.coast, 0.12)}" stroke-width="${fmt(theme.coast.washWidth * scale)}" stroke-linejoin="round"/>`,
    );
    coastParts.push(
      `<path d="${d}" fill="none" stroke="${rgb(theme.ink.coast, 0.92)}" stroke-width="${fmt(theme.coast.lineWidth * scale)}" stroke-linejoin="round"/>`,
    );
  }
  groups.push(`<g id="coastlines">${coastParts.join("")}</g>`);
  // Graticule.
  const grat: string[] = [];
  {
    const left = decor.m3;
    const top = decor.m3;
    const right = width - decor.m3;
    const bottom = height - decor.m3;
    const alpha = theme.decor.graticuleAlpha;
    const dash = theme.decor.graticuleDash * scale;
    for (let i = 1; i < 12; i += 1) {
      if (i === 6) continue;
      const x = left + ((right - left) * i) / 12;
      grat.push(`<line x1="${fmt(x)}" y1="${fmt(top)}" x2="${fmt(x)}" y2="${fmt(bottom)}" stroke="${rgb(theme.ink.soft, alpha)}" stroke-width="${fmt(0.7 * scale)}" stroke-dasharray="${fmt(dash)} ${fmt(dash * 1.4)}"/>`);
      const y = top + ((bottom - top) * i) / 12;
      grat.push(`<line x1="${fmt(left)}" y1="${fmt(y)}" x2="${fmt(right)}" y2="${fmt(y)}" stroke="${rgb(theme.ink.soft, alpha)}" stroke-width="${fmt(0.7 * scale)}" stroke-dasharray="${fmt(dash)} ${fmt(dash * 1.4)}"/>`);
      if (quality === "export" || width >= 900) {
        const lon = Math.round((i / 12 - 0.5) * 360);
        const lonLabel = `${Math.abs(lon)}${lon === 0 ? "" : lon < 0 ? "°W" : "°E"}`;
        grat.push(`<text x="${fmt(x)}" y="${fmt(top + 12 * scale)}" font-family="EB Garamond, serif" font-size="${fmt(11 * scale)}" text-anchor="middle" fill="${rgb(theme.ink.soft, alpha * 3.1)}">${lonLabel}</text>`);
        const lat = Math.round((0.5 - i / 12) * 180);
        const latLabel = `${Math.abs(lat)}${lat === 0 ? "°" : lat < 0 ? "°S" : "°N"}`;
        grat.push(`<text x="${fmt(left + 10 * scale)}" y="${fmt(y)}" font-family="EB Garamond, serif" font-size="${fmt(11 * scale)}" fill="${rgb(theme.ink.soft, alpha * 3.1)}">${latLabel}</text>`);
      }
    }
    grat.push(`<line x1="${fmt((left + right) / 2)}" y1="${fmt(top)}" x2="${fmt((left + right) / 2)}" y2="${fmt(bottom)}" stroke="${rgb(theme.ink.soft, alpha * 1.55)}" stroke-width="${fmt(1.05 * scale)}"/>`);
    grat.push(`<line x1="${fmt(left)}" y1="${fmt((top + bottom) / 2)}" x2="${fmt(right)}" y2="${fmt((top + bottom) / 2)}" stroke="${rgb(theme.ink.soft, alpha * 1.55)}" stroke-width="${fmt(1.05 * scale)}"/>`);
  }
  groups.push(`<g id="graticule" clip-path="url(#frameClip)">${grat.join("")}</g>`);
  // Labels + settlements.
  groups.push(`<g id="labels">${labelBits.svg}</g>`);
  // Decorations.
  const decorSvg = svgDecor(decor, width, height, scale, theme);
  groups.push(`<g id="decor">${decorSvg}</g>`);
  // Paper vignette + ageing wash (over everything, clipped to paper).
  groups.push(
    `<rect x="0" y="0" width="${fmt(width)}" height="${fmt(height)}" fill="url(#paperVignette)" pointer-events="none"/>`,
  );

  const rootAttrs = physicalAttributes(width, height, input.physical);
  const svg = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${width} ${height}" ${rootAttrs} role="img" aria-label="${escapeXml(document.name || "World map")}">`,
    `<title>${escapeXml(document.name || "World map")}</title>`,
    `<desc>Atlas Forge ${RENDERER_VERSION} vector export · fixture-independent layered SVG</desc>`,
    `<defs>${defs.join("")}</defs>`,
    `<g id="map" data-renderer="${RENDERER_VERSION}">${groups.join("")}</g>`,
    `</svg>`,
  ].join("\n");

  const stats: SvgStats = {
    bytes: new TextEncoder().encode(svg).length,
    elements: (svg.match(/<(?!\/)[a-zA-Z]/g) ?? []).length,
    coastLines: coast.coast.length,
    riverPaths: rivers.length,
    biomePolygons: biomes.length,
    labels: labelBits.labels,
    settlements: labelBits.settlements,
    mountainGlyphs: mountains.count,
    forestGlyphs: forests.count,
    generateMs: performance.now() - startedAt,
  };
  void labelLayout;
  return { svg, stats };
}

/** Render a standalone layered SVG map string (see module docs). */
export function renderSvg(input: RenderSvgInput): string {
  return renderSvgDetailed(input).svg;
}
