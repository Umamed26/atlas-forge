/**
 * Place names and settlement markers.
 *
 * Draws generated `layers.autoLabels`, user `document.labels` and settlement
 * labels with a serif cartographic style: uppercase letterspaced region names,
 * italic water names, paper-coloured halos and simple hand-drawn settlement
 * glyphs. Placement is collision-checked with `measureText`, so labels never
 * overflow the frame or stamp over the cartouche/compass/legend.
 */
import type { MapLabel, Settlement, WorldDocument, WorldLayers } from "@atlas/core";
import type { Ctx2D } from "./canvas-types";
import { textFont, getRenderFonts } from "./fonts";
import { hash01, hashSigned } from "./noise";
import type { Rect } from "./layout";
import { hitsAny } from "./layout";
import { sampleMask } from "./sampling";
import { cssRgb, type RenderTheme } from "./style";

export interface LabelOptions {
  width: number;
  height: number;
  scale: number;
  theme: RenderTheme;
  seed: number;
  quality: "preview" | "export";
  document: WorldDocument;
  layers: WorldLayers;
  /** Decoration rectangles labels must not invade. */
  avoid: Rect[];
}

export interface LabelStats {
  drawn: number;
  settlements: number;
  skipped: number;
  fontFamily: string;
}

interface Drawable {
  kind: MapLabel["kind"] | "settlement";
  text: string;
  x: number;
  y: number;
  sizePx: number;
  italic: boolean;
  uppercase: boolean;
  tracking: number;
  rotation: number;
  priority: number;
  settlement?: Settlement;
  pinned: boolean;
  /** Ocean (as opposed to lake/river) water label: placed in open water. */
  sea: boolean;
}

/** True when the normalized point sits on ocean/lake/river (labels avoid these). */
function overWater(opts: LabelOptions, u: number, v: number, allowWater: boolean): boolean {
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;
  const size = opts.layers.size;
  const ocean = sampleMask(opts.layers.ocean, size, u, v);
  const lake = sampleMask(opts.layers.lake, size, u, v);
  const river = sampleMask(opts.layers.river, size, u, v);
  if (allowWater) return false;
  return ocean === 1 || lake === 1 || river === 1;
}

/**
 * True when the whole label box sits in open ocean (checked at the centre, the
 * ends of the text and one line above/below) so sea names never straddle a
 * coastline, island or decoration.
 */
function openSeaAt(
  opts: LabelOptions,
  u: number,
  v: number,
  halfW: number,
  halfH: number,
): boolean {
  const size = opts.layers.size;
  const checks: Array<[number, number]> = [
    [0, 0],
    [-1, 0],
    [1, 0],
    [-0.6, 0],
    [0.6, 0],
    [0, -1],
    [0, 1],
    [0.6, -1],
    [-0.6, 1],
  ];
  for (const [dx, dy] of checks) {
    if (sampleMask(opts.layers.ocean, size, u + dx * halfW, v + dy * halfH) !== 1) return false;
  }
  return true;
}

const KIND_PRIORITY: Record<string, number> = {
  region: 0,
  water: 1,
  custom: 2,
  mountain: 3,
  settlement: 4,
};

const CJK_RE = /[\u2e80-\u9fff\uf900-\ufaff\u3040-\u30ff]/;

/** Interpret MapLabel.size: values <= 4 are multipliers, larger ones are design px. */
function labelSize(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  if (value <= 4) return fallback * value;
  return value;
}

/** Rotation may be radians (|r| <= 2π) or degrees; normalize to radians. */
export function labelRotation(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value === 0) return 0;
  return Math.abs(value) <= Math.PI * 2 ? value : (value * Math.PI) / 180;
}

export function measureWithTracking(ctx: Ctx2D, text: string, font: string, tracking: number): number {
  ctx.font = font;
  const base = ctx.measureText(text).width;
  if (tracking === 0) return base;
  const chars = Array.from(text);
  return base + Math.max(0, chars.length - 1) * tracking;
}

export function drawTrackedText(
  ctx: Ctx2D,
  text: string,
  x: number,
  y: number,
  sizePx: number,
  tracking: number,
  font: string,
  align: "center" | "left",
  precomputed?: { chars: string[]; widths: number[]; total: number },
): void {
  ctx.font = font;
  if (tracking === 0) {
    ctx.fillText(text, x, y);
    return;
  }
  const chars = precomputed?.chars ?? Array.from(text);
  let total = 0;
  const widths: number[] = precomputed?.widths ?? [];
  if (precomputed) {
    total = precomputed.total;
  } else {
    for (const ch of chars) {
      const w = ctx.measureText(ch).width;
      widths.push(w);
      total += w;
    }
    total += Math.max(0, chars.length - 1) * tracking;
  }
  let cx = align === "center" ? x - total / 2 : x;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = "left";
  for (let i = 0; i < chars.length; i += 1) {
    ctx.fillText(chars[i], cx, y);
    cx += widths[i] + tracking;
  }
  ctx.textAlign = prevAlign;
}

/** Slightly imperfect ink: draw text twice with a deterministic sub-pixel offset. */
function inkedText(
  ctx: Ctx2D,
  draw: (offsetX: number, offsetY: number) => void,
  amount: number,
  seedValue: number,
): void {
  draw(0, 0);
  if (amount > 0.01) {
    const dx = hashSigned(seedValue, 1, 4501) * amount;
    const dy = hashSigned(seedValue, 2, 4507) * amount;
    ctx.globalAlpha = 0.35;
    draw(dx, dy);
    ctx.globalAlpha = 1;
  }
}

/** Build the ordered list of drawable labels. */
function collectDrawables(opts: LabelOptions): Drawable[] {
  const { document, layers, theme } = opts;
  const style = document.style;
  const hidden = new Set(document.overrides?.hiddenIds ?? []);
  const drawn: Drawable[] = [];
  const density = Math.min(1, Math.max(0, style.labelDensity));
  const scale = opts.scale;

  const mapLabelToDrawable = (label: MapLabel, index: number, generated: boolean): Drawable | null => {
    if (hidden.has(label.id)) return null;
    const text = (label.text ?? "").trim();
    if (!text) return null;
    if (!style.showLabels && label.kind !== "custom") return null;
    const keepChance =
      label.kind === "region"
        ? 0.5 + 0.5 * density
        : label.kind === "water"
          ? 0.35 + 0.65 * density
          : label.kind === "custom"
            ? 1
            : 0.1 + 0.9 * density;
    if (label.pinned || !generated) {
      // user labels always draw
    } else if (hash01(index, 17, opts.seed + 991) > keepChance) {
      return null;
    }
    const baseSize =
      label.kind === "region"
        ? theme.label.regionSize
        : label.kind === "water"
          ? theme.label.waterSize
          : label.kind === "mountain"
            ? theme.label.mountainSize
            : theme.label.customSize;
    let sizePx = labelSize(label.size, baseSize) * scale;
    if (opts.quality === "preview") {
      const floor = label.kind === "region" ? 20 : label.kind === "water" ? 13 : label.kind === "mountain" ? 11.5 : 12;
      sizePx = Math.max(sizePx, floor * scale);
    }
    const sea =
      label.kind === "water" &&
      sampleMask(layers.ocean, layers.size, label.x, label.y) === 1;
    const cjk = CJK_RE.test(text);
    const uppercase = label.kind === "region" || label.kind === "mountain";
    return {
      kind: label.kind,
      text,
      x: label.x,
      y: label.y,
      sizePx,
      italic: label.kind === "water",
      uppercase,
      tracking:
        (label.kind === "region" ? theme.label.tracking : label.kind === "water" ? theme.label.tracking * 0.55 : theme.label.tracking * 0.75) *
        sizePx *
        (cjk ? 0.5 : 1),
      rotation: labelRotation(label.rotation),
      priority: label.pinned ? -1 : sea ? -2 : KIND_PRIORITY[label.kind] ?? 3,
      pinned: Boolean(label.pinned),
      sea,
    };
  };

  const auto = layers.autoLabels ?? [];
  for (let i = 0; i < auto.length; i += 1) {
    const drawable = mapLabelToDrawable(auto[i], i, true);
    if (drawable) drawn.push(drawable);
  }
  const userLabels = document.labels ?? [];
  for (let i = 0; i < userLabels.length; i += 1) {
    const drawable = mapLabelToDrawable(userLabels[i], i, false);
    if (drawable) drawn.push(drawable);
  }

  // User-pinned settlements override generated entries with the same id.
  const settlements = new Map<string, Settlement>();
  for (const settlement of layers.settlements ?? []) settlements.set(settlement.id, settlement);
  for (const settlement of document.settlements ?? []) settlements.set(settlement.id, settlement);
  const ordered = [...settlements.values()];
  ordered.sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
  const maxMarkers = opts.quality === "export" ? 64 : 40;
  const markerCount = Math.min(maxMarkers, ordered.length);
  for (let i = 0; i < markerCount; i += 1) {
    const settlement = ordered[i];
    const name = (settlement.name ?? "").trim();
    const nameDensity = density > 0.22 || settlement.pinned || i < 6;
    if (!name || !style.showLabels || !nameDensity) continue;
    if (opts.quality === "preview") {
      // On the interactive preview only the meaningful settlements get names
      // (cities / ports / fortresses / pinned / largest few); the rest keep
      // their markers so the map does not turn into unreadable small text.
      const important =
        settlement.kind === "city" ||
        settlement.kind === "port" ||
        settlement.kind === "fortress" ||
        settlement.pinned ||
        i < 5;
      if (!important) continue;
    }
    const kindScale = settlement.kind === "city" ? 1 : settlement.kind === "port" ? 0.95 : 0.88;
    const settlementSize = Math.max(
      theme.label.settlementSize * scale * kindScale,
      opts.quality === "preview" ? 11 * scale : 0,
    );
    drawn.push({
      kind: "settlement",
      text: name,
      x: settlement.x,
      y: settlement.y,
      sizePx: settlementSize,
      italic: false,
      uppercase: true,
      tracking: theme.label.settlementTracking * settlementSize,
      rotation: 0,
      priority: settlement.kind === "city" ? 4 : settlement.kind === "port" ? 5 : 6,
      settlement,
      pinned: Boolean(settlement.pinned),
      sea: false,
    });
  }

  drawn.sort((a, b) => a.priority - b.priority);
  return drawn;
}

/** Draw all labels and settlement markers. */
export function drawLabels(ctx: Ctx2D, opts: LabelOptions): LabelStats {
  const { width, height, scale, theme } = opts;
  const style = opts.document.style;
  const drawables = collectDrawables(opts);
  const blockers: Rect[] = opts.avoid.slice();
  const frameInset = Math.min(width, height) * 0.034;
  let drawnCount = 0;
  let settlementCount = 0;
  let skipped = 0;
  const density = Math.min(1, Math.max(0, style.labelDensity));
  const maxLabels = Math.round((opts.quality === "export" ? 46 : 24) * (0.45 + 0.55 * density));
  const fonts = getRenderFonts();
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const haloWidth = theme.label.haloWidth;
  const haloColor = cssRgb(theme.ink.halo, theme.label.haloAlpha);

  for (const item of drawables) {
    const text = item.uppercase || item.sea ? item.text.toUpperCase() : item.text;
    const font = textFont(text, item.sizePx, item.italic);
    const tracking = item.sea ? item.tracking * 1.7 : item.tracking;
    // Measure once per label; reuse the widths for the halo, fill and double
    // print passes.
    let precomputed: { chars: string[]; widths: number[]; total: number } | undefined;
    let tw: number;
    ctx.font = font;
    if (tracking > 0) {
      const chars = Array.from(text);
      const widths: number[] = [];
      let total = 0;
      for (const ch of chars) {
        const w = ctx.measureText(ch).width;
        widths.push(w);
        total += w;
      }
      const trackedTotal = total + Math.max(0, chars.length - 1) * tracking;
      precomputed = { chars, widths, total: trackedTotal };
      tw = trackedTotal;
    } else {
      tw = ctx.measureText(text).width;
    }
    const th = item.sizePx * 1.25;
    const padX = item.sizePx * 0.25;
    const cx = item.x * width;
    const cy = item.y * height;
    const isSettlement = item.kind === "settlement";
    let textX = cx;
    let textY = cy;
    let rect: Rect = { x: cx - tw / 2 - padX, y: cy - th / 2, w: tw + padX * 2, h: th };

    if (isSettlement) {
      // Keep the glyph at the town position, put the name beside it.
      const markerR = (item.settlement?.kind === "city" ? 3.4 : 2.6) * scale;
      const gap = 4.5 * scale;
      const candidates: Array<{ x: number; y: number; align: "left" | "center" }> = [
        { x: cx + markerR + gap + tw / 2, y: cy, align: "center" },
        { x: cx - markerR - gap - tw / 2, y: cy, align: "center" },
        { x: cx, y: cy + markerR + th * 0.75, align: "center" },
        { x: cx, y: cy - markerR - th * 0.75, align: "center" },
      ];
      let placed = false;
      for (const candidate of candidates) {
        const r: Rect = {
          x: candidate.x - tw / 2 - padX,
          y: candidate.y - th / 2,
          w: tw + padX * 2,
          h: th,
        };
        if (
          r.x < frameInset ||
          r.y < frameInset ||
          r.x + r.w > width - frameInset ||
          r.y + r.h > height - frameInset ||
          hitsAny(r, blockers) ||
          overWater(opts, candidate.x / width, candidate.y / height, false)
        ) {
          continue;
        }
        textX = candidate.x;
        textY = candidate.y;
        rect = r;
        placed = true;
        break;
      }
      if (!placed) {
        skipped += 1;
      }
      // The marker itself always draws, even when a name had to be dropped.
      drawSettlementMarker(ctx, cx, cy, item, theme, scale);
      settlementCount += 1;
      if (!placed) continue;
    } else {
      // Map labels: greedy placement with border clamping. Rotated labels use a
      // conservative square; upright labels may try a nudge up/down to dodge
      // neighbouring names.
      const rotated = Math.abs(item.rotation) > 0.02;
      const boxW = rotated ? Math.max(tw, th) : tw + padX * 2;
      const boxH = rotated ? Math.max(tw, th) : th;
      const minCx = frameInset + boxW / 2;
      const maxCx = width - frameInset - boxW / 2;
      const minCy = frameInset + boxH / 2;
      const maxCy = height - frameInset - boxH / 2;
      let placed = false;
      if (minCx <= maxCx && minCy <= maxCy) {
        const clampCx = (x: number): number => Math.min(maxCx, Math.max(minCx, x));
        const clampCy = (y: number): number => Math.min(maxCy, Math.max(minCy, y));
        const candidates: Array<[number, number]> = [];
        if (item.sea) {
          // Sea names often arrive anchored at an ocean bounding-box corner
          // (e.g. 0.998, 0.998). Spiral outwards from there until a clean patch
          // of open water away from the frame and decorations is found.
          candidates.push([clampCx(cx), clampCy(cy)]);
          for (let ring = 1; ring <= 4; ring += 1) {
            for (let a = 0; a < 8; a += 1) {
              const angle = (a / 8) * Math.PI * 2 + ring * 0.42;
              candidates.push([
                clampCx(cx + Math.cos(angle) * ring * 0.085 * width),
                clampCy(cy + Math.sin(angle) * ring * 0.085 * height),
              ]);
            }
          }
          for (const gy of [0.34, 0.48, 0.62, 0.76, 0.88]) {
            for (const gx of [0.16, 0.32, 0.5, 0.68, 0.84]) {
              candidates.push([clampCx(gx * width), clampCy(gy * height)]);
            }
          }
        } else {
          for (const dyOff of rotated ? [0] : [0, -th * 1.02, th * 1.02]) {
            candidates.push([clampCx(cx), clampCy(cy + dyOff)]);
          }
        }
        const halfW = boxW / 2 / width;
        const halfH = boxH / 2 / height;
        for (const [px, py] of candidates) {
          const r: Rect = { x: px - boxW / 2, y: py - boxH / 2, w: boxW, h: boxH };
          if (hitsAny(r, blockers)) continue;
          if (item.sea) {
            if (!openSeaAt(opts, px / width, py / height, halfW, halfH)) continue;
          } else {
            // Region / mountain / custom labels must not sit on lakes or rivers;
            // water labels are allowed on water but not on dry land.
            let wet = false;
            for (const f of [0.08, 0.38, 0.5, 0.62, 0.92]) {
              if (overWater(opts, px / width + ((f - 0.5) * boxW) / width, py / height, item.kind === "water")) {
                wet = true;
                break;
              }
            }
            if (wet) continue;
          }
          textX = px;
          textY = py;
          rect = r;
          placed = true;
          break;
        }
      }
      if (!placed) {
        skipped += 1;
        continue;
      }
    }

    if (drawnCount >= maxLabels) {
      skipped += 1;
      continue;
    }
    blockers.push(rect);
    drawnCount += 1;
    ctx.save();
    ctx.translate(textX, textY);
    if (item.rotation !== 0) ctx.rotate(item.rotation);
    const drawAt = (offsetX: number, offsetY: number): void => {
      ctx.save();
      ctx.translate(offsetX, offsetY);
      if (haloWidth > 0) {
        ctx.strokeStyle = haloColor;
        ctx.lineWidth = Math.max(1, item.sizePx * haloWidth);
        ctx.font = font;
        if (tracking === 0) {
          ctx.strokeText(text, 0, 0);
        } else {
          strokeTracked(ctx, text, tracking, font, item.sizePx, precomputed);
        }
      }
      ctx.font = font;
      ctx.fillStyle = cssRgb(
        item.kind === "water" ? theme.ink.labelWater : theme.ink.label,
        item.sea ? 0.78 : item.kind === "custom" ? 0.94 : 0.9,
      );
      if (tracking === 0) {
        ctx.fillText(text, 0, 0);
      } else {
        drawTrackedText(ctx, text, 0, 0, item.sizePx, tracking, font, "center", precomputed);
      }
      ctx.restore();
    };
    // Faint double-printed ink for hand-pressed character (export only: the
    // preview frame budget is tight and the effect is invisible at small sizes).
    if (opts.quality === "export") {
      inkedText(ctx, drawAt, item.sizePx * 0.018, hash01(item.x * 1000, item.y * 1000, opts.seed));
    } else {
      drawAt(0, 0);
    }
    // Region names get a small decorative rule beneath the text.
    if (item.kind === "region") {
      const ruleY = item.sizePx * 0.72;
      const half = tw * 0.52;
      ctx.strokeStyle = cssRgb(theme.ink.main, 0.32);
      ctx.lineWidth = Math.max(0.6, 0.75 * scale);
      ctx.beginPath();
      ctx.moveTo(-half - item.sizePx * 0.18, ruleY);
      ctx.lineTo(-item.sizePx * 0.2, ruleY);
      ctx.moveTo(item.sizePx * 0.2, ruleY);
      ctx.lineTo(half + item.sizePx * 0.18, ruleY);
      ctx.stroke();
      ctx.fillStyle = cssRgb(theme.ink.main, 0.5);
      ctx.beginPath();
      const d = Math.max(1.2, 1.5 * scale);
      ctx.moveTo(0, ruleY - d);
      ctx.lineTo(d, ruleY);
      ctx.lineTo(0, ruleY + d);
      ctx.lineTo(-d, ruleY);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
  return {
    drawn: drawnCount,
    settlements: settlementCount,
    skipped,
    fontFamily: fonts.resolvedFamily,
  };
}

function strokeTracked(
  ctx: Ctx2D,
  text: string,
  tracking: number,
  font: string,
  sizePx: number,
  precomputed?: { chars: string[]; widths: number[]; total: number },
): void {
  const chars = precomputed?.chars ?? Array.from(text);
  ctx.font = font;
  let total = -tracking;
  const widths: number[] = precomputed?.widths ?? [];
  if (precomputed) total = precomputed.total;
  if (!precomputed) {
    for (const ch of chars) {
      const w = ctx.measureText(ch).width;
      widths.push(w);
      total += w + tracking;
    }
  }
  let cx = -total / 2;
  const prevAlign = ctx.textAlign;
  ctx.textAlign = "left";
  for (let i = 0; i < chars.length; i += 1) {
    ctx.strokeText(chars[i], cx, 0);
    cx += widths[i] + tracking;
  }
  ctx.textAlign = prevAlign;
  void sizePx;
}

function drawSettlementMarker(
  ctx: Ctx2D,
  cx: number,
  cy: number,
  item: Drawable,
  theme: RenderTheme,
  scale: number,
): void {
  const kind = item.settlement?.kind ?? "town";
  const r = (kind === "city" ? 3.4 : 2.6) * scale;
  const ink = cssRgb(theme.ink.main, 0.92);
  const halo = cssRgb(theme.ink.halo, 0.95);
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (kind === "city") {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = halo;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.62, 0, Math.PI * 2);
    ctx.fillStyle = ink;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(0.7, 0.9 * scale);
    ctx.stroke();
  } else if (kind === "port") {
    // Anchor glyph.
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(0.8, 1.05 * scale);
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 1.35);
    ctx.lineTo(cx, cy + r);
    ctx.moveTo(cx - r * 0.85, cy - r * 0.5);
    ctx.lineTo(cx + r * 0.85, cy - r * 0.5);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy + r * 0.95, r * 0.95, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy - r * 1.35, r * 0.42, 0, Math.PI * 2);
    ctx.strokeStyle = halo;
    ctx.lineWidth = Math.max(1, 1.4 * scale);
    ctx.stroke();
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(0.7, 0.85 * scale);
    ctx.stroke();
  } else if (kind === "fortress") {
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.rect(cx - r * 0.85, cy - r * 0.85, r * 1.7, r * 1.7);
    ctx.fill();
    // Crenellation notches in paper colour.
    ctx.fillStyle = halo;
    for (let i = -1; i <= 1; i += 1) {
      ctx.fillRect(cx + i * r * 0.5 - r * 0.12, cy - r * 0.95, r * 0.24, r * 0.3);
    }
  } else if (kind === "ruin") {
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(0.9, 1.15 * scale);
    ctx.beginPath();
    ctx.moveTo(cx - r * 0.8, cy - r * 0.8);
    ctx.lineTo(cx + r * 0.8, cy + r * 0.8);
    ctx.moveTo(cx + r * 0.8, cy - r * 0.8);
    ctx.lineTo(cx - r * 0.8, cy + r * 0.8);
    ctx.stroke();
  } else {
    // Town / custom: simple ring dot.
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = ink;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = ink;
    ctx.lineWidth = Math.max(0.7, 0.85 * scale);
    ctx.stroke();
  }
  ctx.restore();
  void item;
}
