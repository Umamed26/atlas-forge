/**
 * Renderer-sourced place hit boxes.
 *
 * When @atlas/render exports `measureMapContent` (additive API) the layout is
 * measured with the exact same code that paints the map; otherwise a marker
 * bbox approximation is synthesized from the layer positions. Boxes are cached
 * per layers/style render in the world store, so pointer moves never trigger a
 * layout measurement or a generation.
 */
import type { WorldDocument, WorldLayers } from "@atlas/core";
import * as renderModule from "@atlas/render";

import { BASE_RENDER_SIZE } from "./constants";
import { type PlaceEntry } from "./places";

export type PlaceEntity = "settlement" | "label";

export interface PlaceHitBox {
  id: string;
  entity: PlaceEntity;
  /** Image-space box for a BASE_RENDER_SIZE layout. */
  x: number;
  y: number;
  width: number;
  height: number;
  drawOrder: number;
}

interface MeasureContentInput {
  ctx: unknown;
  document: WorldDocument;
  layers: WorldLayers;
  width: number;
  height: number;
  quality?: "preview" | "export";
}

interface RenderMeasureApi {
  measureMapContent?: (input: MeasureContentInput) => unknown;
}

const measureApi = renderModule as unknown as RenderMeasureApi;

export function hasMeasureMapContent(): boolean {
  return typeof measureApi.measureMapContent === "function";
}

function createMeasureContext(size: number): CanvasRenderingContext2D | null {
  try {
    if (typeof OffscreenCanvas !== "undefined") {
      const canvas = new OffscreenCanvas(size, size);
      return canvas.getContext("2d") as unknown as CanvasRenderingContext2D;
    }
    if (typeof document !== "undefined") {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      return canvas.getContext("2d");
    }
  } catch {
    // fall through
  }
  return null;
}

function asFinite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const SETTLEMENT_KINDS = new Set(["city", "town", "port", "fortress", "ruin", "custom"]);
const LABEL_KINDS = new Set(["region", "water", "mountain", "label"]);

function resolveEntity(record: Record<string, unknown>): PlaceEntity {
  const explicit = record.entity ?? record.elementKind;
  if (explicit === "settlement" || explicit === "label") return explicit;
  const kind = record.kind ?? record.entityType;
  if (kind === "label") return "label";
  if (kind === "settlement") return "settlement";
  const type = record.type;
  if (typeof type === "string") {
    if (LABEL_KINDS.has(type)) return "label";
    if (SETTLEMENT_KINDS.has(type)) return "settlement";
  }
  return "settlement";
}

function coerceBox(raw: unknown, value: unknown): PlaceHitBox | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  const bbox = (record.bbox ?? record.box) as Record<string, unknown> | undefined;
  const x = asFinite(record.x) ?? asFinite(bbox?.x);
  const y = asFinite(record.y) ?? asFinite(bbox?.y);
  const width = asFinite(record.width) ?? asFinite(record.w) ?? asFinite(bbox?.width) ?? asFinite(bbox?.w);
  const height = asFinite(record.height) ?? asFinite(record.h) ?? asFinite(bbox?.height) ?? asFinite(bbox?.h);
  if (x === null || y === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;
  const drawOrder =
    asFinite(record.drawOrder) ??
    asFinite(record.order) ??
    asFinite(record.z) ??
    asFinite(record.index) ??
    (typeof raw === "number" ? raw : 0);
  return {
    id: record.id,
    entity: resolveEntity(record),
    x,
    y,
    width,
    height,
    drawOrder,
  };
}

function normalizeMeasureResult(raw: unknown): PlaceHitBox[] | null {
  if (!raw) return null;
  const boxes: PlaceHitBox[] = [];
  const pushArray = (array: unknown, orderBase: number, entity?: PlaceEntity) => {
    if (!Array.isArray(array)) return;
    array.forEach((value, index) => {
      const box = coerceBox(orderBase + index, value);
      if (box) boxes.push(entity ? { ...box, entity } : box);
    });
  };
  if (Array.isArray(raw)) {
    pushArray(raw, 0);
  } else if (typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    for (const key of ["boxes", "places", "items", "hitBoxes", "content"]) {
      pushArray(record[key], 0);
    }
    pushArray(record.settlements, 0, "settlement");
    pushArray(record.labels, 1000, "label");
  }
  if (boxes.length === 0) return null;
  return boxes;
}

/**
 * Measure the current render layout. Returns null when the renderer API is not
 * available yet (the caller falls back to approximated marker boxes).
 */
export function measureRenderPlaceBoxes(
  document: WorldDocument,
  layers: WorldLayers,
  size = BASE_RENDER_SIZE,
): PlaceHitBox[] | null {
  if (!hasMeasureMapContent()) return null;
  const ctx = createMeasureContext(size);
  if (!ctx) return null;
  try {
    const raw = measureApi.measureMapContent!({
      ctx,
      document,
      layers,
      width: size,
      height: size,
      quality: "preview",
    });
    return normalizeMeasureResult(raw);
  } catch {
    return null;
  }
}

/** Marker/label approximation used before/without the renderer measurement. */
export function synthesizeMarkerBoxes(
  entries: PlaceEntry[],
  size = BASE_RENDER_SIZE,
): PlaceHitBox[] {
  const boxes: PlaceHitBox[] = [];
  entries.forEach((entry, index) => {
    const centerX = entry.x * size;
    const centerY = entry.y * size;
    if (entry.entity === "settlement") {
      boxes.push({
        id: entry.id,
        entity: "settlement",
        x: centerX - 13,
        y: centerY - 13,
        width: 26,
        height: 26,
        drawOrder: index,
      });
      return;
    }
    const charWidth = 14;
    const width = Math.max(32, entry.name.length * charWidth + 14);
    const height = 22;
    boxes.push({
      id: entry.id,
      entity: "label",
      x: centerX - width / 2,
      y: centerY - height * 0.8,
      width,
      height,
      drawOrder: 1000 + index,
    });
  });
  return boxes;
}

// ── Hit testing ───────────────────────────────────────────────────────────

export interface PlaceHitViewport {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface PlaceHitTestInput {
  entries: PlaceEntry[];
  boxes: PlaceHitBox[] | null;
  /** Click position in BASE layout image space (px). */
  imagePoint: { x: number; y: number };
  viewportWorld: PlaceHitViewport;
  /** Extra padding around a box in image px (screen 4px converted by caller). */
  padding: number;
  fallbackThresholdWorld: number;
  imageSize?: number;
}

export interface PlaceHitTestResult {
  hit: PlaceEntry | null;
  ms: number;
  usedBoxes: boolean;
  candidates: number;
  /** Index of the winning box in the (drawOrder-sorted) boxes array. */
  boxIndex: number | null;
}

interface BoxGrid {
  cellSize: number;
  buckets: Map<string, PlaceHitBox[]>;
}

const GRID_THRESHOLD = 200;
const gridCache = new WeakMap<PlaceHitBox[], BoxGrid>();
const sortedCache = new WeakMap<PlaceHitBox[], PlaceHitBox[]>();

function sortedByDrawOrder(boxes: PlaceHitBox[]): PlaceHitBox[] {
  const cached = sortedCache.get(boxes);
  if (cached) return cached;
  const sorted = [...boxes].sort((a, b) => b.drawOrder - a.drawOrder);
  sortedCache.set(boxes, sorted);
  return sorted;
}

function cellKey(cx: number, cy: number): string {
  return `${cx}:${cy}`;
}

function buildBoxGrid(boxes: PlaceHitBox[]): BoxGrid {
  const cached = gridCache.get(boxes);
  if (cached) return cached;
  const cellSize = 64;
  const buckets = new Map<string, PlaceHitBox[]>();
  for (const box of boxes) {
    const cx = Math.floor(box.x / cellSize);
    const cy = Math.floor(box.y / cellSize);
    const key = cellKey(cx, cy);
    const list = buckets.get(key);
    if (list) list.push(box);
    else buckets.set(key, [box]);
  }
  const grid = { cellSize, buckets };
  gridCache.set(boxes, grid);
  return grid;
}

/**
 * Bbox + drawOrder hit test, viewport culled; falls back to nearest marker
 * distance when no renderer boxes are available. O(1) bucketed for large maps.
 */
export function hitTestPlaces(input: PlaceHitTestInput): PlaceHitTestResult {
  const startedAt =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  const imageSize = input.imageSize ?? BASE_RENDER_SIZE;
  const keyOf = (entry: PlaceEntry) => `${entry.entity}:${entry.id}`;
  const entryMap = new Map<string, PlaceEntry>();
  for (const entry of input.entries) entryMap.set(keyOf(entry), entry);

  let hit: PlaceEntry | null = null;
  let candidates = 0;
  let boxIndex: number | null = null;

  const boxes = input.boxes;
  if (boxes && boxes.length > 0) {
    const sorted = sortedByDrawOrder(boxes);
    const grid = boxes.length >= GRID_THRESHOLD ? buildBoxGrid(boxes) : null;
    const point = input.imagePoint;
    const search = (box: PlaceHitBox): boolean => {
      const worldX = box.x / imageSize;
      const worldY = box.y / imageSize;
      const worldW = box.width / imageSize;
      const worldH = box.height / imageSize;
      if (
        worldX + worldW < input.viewportWorld.minX ||
        worldX > input.viewportWorld.maxX ||
        worldY + worldH < input.viewportWorld.minY ||
        worldY > input.viewportWorld.maxY
      ) {
        return false;
      }
      candidates += 1;
      const pad = input.padding;
      if (
        point.x >= box.x - pad &&
        point.x <= box.x + box.width + pad &&
        point.y >= box.y - pad &&
        point.y <= box.y + box.height + pad
      ) {
        hit = entryMap.get(`${box.entity}:${box.id}`) ?? null;
        boxIndex = sorted.indexOf(box);
        return hit !== null;
      }
      return false;
    };
    if (grid) {
      const cx = Math.floor(point.x / grid.cellSize);
      const cy = Math.floor(point.y / grid.cellSize);
      const nearby: PlaceHitBox[] = [];
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const list = grid.buckets.get(cellKey(cx + dx, cy + dy));
          if (list) nearby.push(...list);
        }
      }
      nearby.sort((a, b) => b.drawOrder - a.drawOrder);
      for (const box of nearby) {
        if (search(box)) break;
      }
    } else {
      for (const box of sorted) {
        if (search(box)) break;
      }
    }
    if (hit) {
      const elapsed =
        (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt;
      return { hit, ms: elapsed, usedBoxes: true, candidates, boxIndex };
    }
  }

  // Fallback: nearest marker anchor within the screen-space threshold.
  let best: PlaceEntry | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const entry of input.entries) {
    if (
      entry.x < input.viewportWorld.minX ||
      entry.x > input.viewportWorld.maxX ||
      entry.y < input.viewportWorld.minY ||
      entry.y > input.viewportWorld.maxY
    ) {
      continue;
    }
    candidates += 1;
    const distance = Math.hypot(
      entry.x - input.imagePoint.x / imageSize,
      entry.y - input.imagePoint.y / imageSize,
    );
    if (distance <= input.fallbackThresholdWorld && distance < bestDistance) {
      best = entry;
      bestDistance = distance;
    }
  }
  const elapsed =
    (typeof performance !== "undefined" ? performance.now() : Date.now()) - startedAt;
  return { hit: best, ms: elapsed, usedBoxes: false, candidates, boxIndex: null };
}

// ── Debug helpers ─────────────────────────────────────────────────────────

export interface PlaceHitBoxDebugInfo {
  id: string;
  entity: PlaceEntity;
  drawOrder: number;
  image: { x: number; y: number; width: number; height: number };
  world: { x: number; y: number; width: number; height: number };
  screen: { x: number; y: number; width: number; height: number };
}

export function placeHitBoxesForDebug(
  boxes: PlaceHitBox[],
  view: { scale: number; offsetX: number; offsetY: number },
  imageSize = BASE_RENDER_SIZE,
): PlaceHitBoxDebugInfo[] {
  return boxes.map((box) => ({
    id: box.id,
    entity: box.entity,
    drawOrder: box.drawOrder,
    image: { x: box.x, y: box.y, width: box.width, height: box.height },
    world: {
      x: box.x / imageSize,
      y: box.y / imageSize,
      width: box.width / imageSize,
      height: box.height / imageSize,
    },
    screen: {
      x: view.offsetX + box.x * view.scale,
      y: view.offsetY + box.y * view.scale,
      width: box.width * view.scale,
      height: box.height * view.scale,
    },
  }));
}
