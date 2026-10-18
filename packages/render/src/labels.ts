/**
 * Place names and settlement markers.
 *
 * Generated `layers.autoLabels` and user `document.labels` are merged by id
 * first (user / pinned entries win, so an id is only ever drawn once), and
 * settlements are merged the same way while honouring `hiddenIds`. The result
 * is drawn with a serif cartographic style: uppercase letterspaced region
 * names, italic water names, paper-coloured halos and simple hand-drawn
 * settlement glyphs. Placement is collision-checked with `measureText`, so
 * labels never overflow the frame or stamp over the cartouche/compass/legend.
 */
import type { MapLabel, Settlement, WorldDocument, WorldLayers } from "@atlas/core";
import type { Ctx2D } from "./canvas-types";
import { textFont, getRenderFonts } from "./fonts";
import { hash01, hashSigned } from "./noise";
import type { Rect } from "./layout";
import { hitsAny } from "./layout";
import { sampleMask } from "./sampling";
import { cssRgb, resolveTheme, type RenderTheme } from "./style";

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
  /** Settlement markers drawn. */
  settlements: number;
  /** Settlement name labels drawn (subset of `drawn`). */
  settlementNames: number;
  skipped: number;
  fontFamily: string;
}

/**
 * A label / settlement layout box in image pixels (top-left origin). This is
 * produced by the exact same layout pass that `renderWorld` paints, so screen
 * space hit-testing can use it without duplicating cartographic rules.
 */
export interface MeasuredLabel {
  /** Label id or settlement id, matching the WorldDocument / layers content. */
  id: string;
  entity: "label" | "settlement";
  /** Text as drawn (region / mountain / settlement names are upper-cased). */
  text: string;
  /** Bounding box in image pixels. For a settlement this covers glyph + name. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Convenience = x + width/2. */
  centerX: number;
  /** Convenience = y + height/2. */
  centerY: number;
  /** Paint order: larger = drawn later = visually on top. */
  drawOrder: number;
  /** Layout priority (lower value = more important = painted earlier). */
  priority: number;
  pinned: boolean;
}

interface PrecomputedWidths {
  chars: string[];
  widths: number[];
  total: number;
}

interface LaidText {
  type: "text";
  entity: "label" | "settlement";
  id: string;
  kind: Drawable["kind"];
  text: string;
  font: string;
  tracking: number;
  precomputed?: PrecomputedWidths;
  sizePx: number;
  /** Text centre in image pixels. */
  textX: number;
  textY: number;
  rotation: number;
  /** Tracked text width / layout height in px. */
  tw: number;
  th: number;
  sea: boolean;
  /** Normalized source coordinates (used for ink grain / diagnostics). */
  sourceX: number;
  sourceY: number;
  priority: number;
  pinned: boolean;
}

interface LaidMarker {
  type: "marker";
  id: string;
  drawable: Drawable;
  /** Marker anchor in image pixels. */
  cx: number;
  cy: number;
}

export type LaidItem = LaidText | LaidMarker;

export interface LabelLayout {
  /** Paint sequence: markers and text in the exact order they are drawn. */
  items: LaidItem[];
  measured: MeasuredLabel[];
  drawn: number;
  settlements: number;
  settlementNames: number;
  skipped: number;
}

export interface Drawable {
  /** Stable content id (label id or settlement id). */
  id: string;
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

/**
 * Ids hidden by the editor: `document.overrides.hiddenIds` plus the optional
 * `layers.hidden` list produced by newer core versions. Older layers may not
 * carry `hidden` at all, so the field is read structurally and treated as
 * optional. Entries may be plain ids or objects carrying an `id`.
 */
function collectHiddenIds(document: WorldDocument, layers: WorldLayers): string[] {
  const hidden = new Set<string>();
  const collect = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (typeof entry === "string") {
        hidden.add(entry);
      } else if (entry && typeof entry === "object") {
        const id = (entry as { id?: unknown }).id;
        if (typeof id === "string") hidden.add(id);
      }
    }
  };
  collect(document.overrides?.hiddenIds);
  collect((layers as WorldLayers & { hidden?: unknown }).hidden);
  return [...hidden];
}

export interface MergedMapContent {
  /** Auto + user labels merged by id, user / pinned entries win. */
  labels: MapLabel[];
  /** Layer + user settlements merged by id, user / pinned entries win. */
  settlements: Settlement[];
  /** Union of `document.overrides.hiddenIds` and optional `layers.hidden`. */
  hiddenIds: string[];
}

/**
 * Merge generated and user-edited map content by id.
 *
 * - A label id present in both `layers.autoLabels` and `document.labels` is
 *   returned exactly once, with the user document's version winning.
 * - Settlements follow the same rule; hidden ids are removed from *both*
 *   sources, so a hidden id accidentally re-appearing in `document.settlements`
 *   cannot resurrect it on the map.
 * - Missing / blank ids are kept distinct (they cannot be merged safely).
 */
export function mergeMapContent(document: WorldDocument, layers: WorldLayers): MergedMapContent {
  const hiddenIds = collectHiddenIds(document, layers);
  const hidden = new Set(hiddenIds);

  const labels: MapLabel[] = [];
  const labelIndex = new Map<string, number>();
  const upsertLabel = (label: MapLabel | undefined, fallbackKey: string): void => {
    if (!label) return;
    const key = typeof label.id === "string" && label.id.length > 0 ? label.id : fallbackKey;
    if (hidden.has(key)) return;
    const existing = labelIndex.get(key);
    if (existing === undefined) {
      labelIndex.set(key, labels.length);
      labels.push({ ...label, id: key });
    } else {
      // User / pinned entries replace the generated entry entirely.
      labels[existing] = { ...label, id: key };
    }
  };
  const autoLabels = layers.autoLabels ?? [];
  for (let i = 0; i < autoLabels.length; i += 1) {
    upsertLabel(autoLabels[i], `__auto_label_${i}`);
  }
  const userLabels = document.labels ?? [];
  for (let i = 0; i < userLabels.length; i += 1) {
    upsertLabel(userLabels[i], `__user_label_${i}`);
  }

  const settlements: Settlement[] = [];
  const settlementIndex = new Map<string, number>();
  const upsertSettlement = (settlement: Settlement | undefined, fallbackKey: string): void => {
    if (!settlement) return;
    const key =
      typeof settlement.id === "string" && settlement.id.length > 0 ? settlement.id : fallbackKey;
    if (hidden.has(key)) return;
    const existing = settlementIndex.get(key);
    if (existing === undefined) {
      settlementIndex.set(key, settlements.length);
      settlements.push({ ...settlement, id: key });
    } else {
      settlements[existing] = { ...settlement, id: key };
    }
  };
  const layerSettlements = layers.settlements ?? [];
  for (let i = 0; i < layerSettlements.length; i += 1) {
    upsertSettlement(layerSettlements[i], `__layer_settlement_${i}`);
  }
  const userSettlements = document.settlements ?? [];
  for (let i = 0; i < userSettlements.length; i += 1) {
    upsertSettlement(userSettlements[i], `__user_settlement_${i}`);
  }

  return { labels, settlements, hiddenIds };
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
  const merged = mergeMapContent(document, layers);
  const userLabelKeys = new Set<string>();
  const userLabels = document.labels ?? [];
  for (let i = 0; i < userLabels.length; i += 1) {
    const label = userLabels[i];
    if (!label) continue;
    userLabelKeys.add(
      typeof label.id === "string" && label.id.length > 0 ? label.id : `__user_label_${i}`,
    );
  }
  const drawn: Drawable[] = [];
  const density = Math.min(1, Math.max(0, style.labelDensity));
  const scale = opts.scale;

  const mapLabelToDrawable = (label: MapLabel, index: number, generated: boolean): Drawable | null => {
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
      id: label.id,
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

  // mergeMapContent already deduped by id (user / pinned entries win) and
  // removed hidden ids from both generated and user sources.
  for (let i = 0; i < merged.labels.length; i += 1) {
    const label = merged.labels[i];
    const drawable = mapLabelToDrawable(label, i, !userLabelKeys.has(label.id));
    if (drawable) drawn.push(drawable);
  }

  const ordered = merged.settlements.slice();
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
      id: settlement.id,
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

/**
 * Resolve the drawable label list without touching a canvas. Exposed for tests
 * and tooling that need to assert de-duplication / hidden filters without
 * decoding a PNG.
 */
export function collectLabelDrawables(
  document: WorldDocument,
  layers: WorldLayers,
  quality: "preview" | "export" = "preview",
  scale = 1,
): Drawable[] {
  const theme = resolveTheme(document.style, quality);
  return collectDrawables({
    width: 1024,
    height: 1024,
    scale,
    theme,
    seed: (document.seed | 0) || 1,
    quality,
    document,
    layers,
    avoid: [],
  });
}

/** Marker half-extent in px, used for the measured settlement bbox. */
function markerExtent(kind: Settlement["kind"] | undefined, scale: number): number {
  switch (kind) {
    case "city":
      return 3.4 * scale;
    case "port":
      return 5 * scale;
    case "fortress":
      return 2.5 * scale;
    case "ruin":
      return 2.2 * scale;
    default:
      return 2.6 * scale;
  }
}

/** Axis-aligned layout box of a (possibly rotated) text item. */
function textBBox(item: LaidText): { x: number; y: number; width: number; height: number } {
  let width = item.tw;
  let height = item.th;
  if (Math.abs(item.rotation) > 1e-4) {
    const cos = Math.abs(Math.cos(item.rotation));
    const sin = Math.abs(Math.sin(item.rotation));
    width = item.tw * cos + item.th * sin;
    height = item.tw * sin + item.th * cos;
  }
  return {
    x: item.textX - width / 2,
    y: item.textY - height / 2,
    width,
    height,
  };
}

/** Turn the paint sequence into the public hit-test boxes. */
function buildMeasured(items: LaidItem[], scale: number): MeasuredLabel[] {
  const measured: MeasuredLabel[] = [];
  const settlementIndex = new Map<string, number>();
  for (const item of items) {
    if (item.type === "marker") {
      const drawable = item.drawable;
      const extent = markerExtent(drawable.settlement?.kind, scale);
      const text =
        drawable.uppercase || drawable.sea ? drawable.text.toUpperCase() : drawable.text;
      settlementIndex.set(item.id, measured.length);
      measured.push({
        id: item.id,
        entity: "settlement",
        text,
        x: item.cx - extent,
        y: item.cy - extent,
        width: extent * 2,
        height: extent * 2,
        centerX: item.cx,
        centerY: item.cy,
        drawOrder: measured.length,
        priority: drawable.priority,
        pinned: drawable.pinned,
      });
      continue;
    }
    const box = textBBox(item);
    if (item.entity === "settlement") {
      const index = settlementIndex.get(item.id);
      const existing = index === undefined ? undefined : measured[index];
      if (existing) {
        // Merge the name box into the settlement marker box.
        const maxX = Math.max(existing.x + existing.width, box.x + box.width);
        const maxY = Math.max(existing.y + existing.height, box.y + box.height);
        existing.x = Math.min(existing.x, box.x);
        existing.y = Math.min(existing.y, box.y);
        existing.width = maxX - existing.x;
        existing.height = maxY - existing.y;
        existing.centerX = existing.x + existing.width / 2;
        existing.centerY = existing.y + existing.height / 2;
        existing.text = item.text;
        continue;
      }
    }
    measured.push({
      id: item.id,
      entity: item.entity,
      text: item.text,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      centerX: box.x + box.width / 2,
      centerY: box.y + box.height / 2,
      drawOrder: measured.length,
      priority: item.priority,
      pinned: item.pinned,
    });
  }
  return measured;
}

/**
 * Layout pass: font metrics, tracking, collision avoidance, sea-label search,
 * frame / decoration avoid rects and paint order. No painting happens here, so
 * `measureMapContent` can reuse the exact same boxes that `renderWorld` draws.
 */
export function layoutMapLabels(ctx: Ctx2D, opts: LabelOptions): LabelLayout {
  const { width, height, scale, theme } = opts;
  const style = opts.document.style;
  const drawables = collectDrawables(opts);
  const blockers: Rect[] = opts.avoid.slice();
  const frameInset = Math.min(width, height) * 0.034;
  let drawnCount = 0;
  let settlementCount = 0;
  let settlementNames = 0;
  let skipped = 0;
  const density = Math.min(1, Math.max(0, style.labelDensity));
  const maxLabels = Math.round((opts.quality === "export" ? 46 : 24) * (0.45 + 0.55 * density));
  const items: LaidItem[] = [];

  for (const item of drawables) {
    const text = item.uppercase || item.sea ? item.text.toUpperCase() : item.text;
    const font = textFont(text, item.sizePx, item.italic);
    const tracking = item.sea ? item.tracking * 1.7 : item.tracking;
    let precomputed: PrecomputedWidths | undefined;
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
      items.push({ type: "marker", id: item.settlement?.id ?? item.id, drawable: item, cx, cy });
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
              if (
                overWater(
                  opts,
                  px / width + ((f - 0.5) * boxW) / width,
                  py / height,
                  item.kind === "water",
                )
              ) {
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
    if (isSettlement) settlementNames += 1;
    items.push({
      type: "text",
      entity: isSettlement ? "settlement" : "label",
      id: isSettlement ? item.settlement?.id ?? item.id : item.id,
      kind: item.kind,
      text,
      font,
      tracking,
      precomputed,
      sizePx: item.sizePx,
      textX,
      textY,
      rotation: item.rotation,
      tw,
      th,
      sea: item.sea,
      sourceX: item.x,
      sourceY: item.y,
      priority: item.priority,
      pinned: item.pinned,
    });
  }

  return {
    items,
    measured: buildMeasured(items, opts.scale),
    drawn: drawnCount,
    settlements: settlementCount,
    settlementNames,
    skipped,
  };
}

/** Paint a layout produced by `layoutMapLabels`. */
function paintLabelLayout(ctx: Ctx2D, opts: LabelOptions, layout: LabelLayout): void {
  const { theme, scale } = opts;
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  const haloWidth = theme.label.haloWidth;
  const haloColor = cssRgb(theme.ink.halo, theme.label.haloAlpha);

  for (const item of layout.items) {
    if (item.type === "marker") {
      drawSettlementMarker(ctx, item.cx, item.cy, item.drawable, theme, scale);
      continue;
    }
    ctx.save();
    ctx.translate(item.textX, item.textY);
    if (item.rotation !== 0) ctx.rotate(item.rotation);
    const drawAt = (offsetX: number, offsetY: number): void => {
      ctx.save();
      ctx.translate(offsetX, offsetY);
      if (haloWidth > 0) {
        ctx.strokeStyle = haloColor;
        ctx.lineWidth = Math.max(1, item.sizePx * haloWidth);
        ctx.font = item.font;
        if (item.tracking === 0) {
          ctx.strokeText(item.text, 0, 0);
        } else {
          strokeTracked(ctx, item.text, item.tracking, item.font, item.sizePx, item.precomputed);
        }
      }
      ctx.font = item.font;
      ctx.fillStyle = cssRgb(
        item.kind === "water" ? theme.ink.labelWater : theme.ink.label,
        item.sea ? 0.78 : item.kind === "custom" ? 0.94 : 0.9,
      );
      if (item.tracking === 0) {
        ctx.fillText(item.text, 0, 0);
      } else {
        drawTrackedText(
          ctx,
          item.text,
          0,
          0,
          item.sizePx,
          item.tracking,
          item.font,
          "center",
          item.precomputed,
        );
      }
      ctx.restore();
    };
    // Faint double-printed ink for hand-pressed character (export only: the
    // preview frame budget is tight and the effect is invisible at small sizes).
    if (opts.quality === "export") {
      inkedText(ctx, drawAt, item.sizePx * 0.018, hash01(item.sourceX * 1000, item.sourceY * 1000, opts.seed));
    } else {
      drawAt(0, 0);
    }
    // Region names get a small decorative rule beneath the text.
    if (item.kind === "region") {
      const ruleY = item.sizePx * 0.72;
      const half = item.tw * 0.52;
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
}

/** Draw all labels and settlement markers. */
export function drawLabels(ctx: Ctx2D, opts: LabelOptions): LabelStats {
  const layout = layoutMapLabels(ctx, opts);
  paintLabelLayout(ctx, opts, layout);
  return {
    drawn: layout.drawn,
    settlements: layout.settlements,
    settlementNames: layout.settlementNames,
    skipped: layout.skipped,
    fontFamily: getRenderFonts().resolvedFamily,
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
