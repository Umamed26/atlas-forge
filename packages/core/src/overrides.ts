/**
 * Brush overrides — the "user intent" layer.
 *
 * Overrides are stored as normalized world-space stamps (x/y/radius in [0,1])
 * so they survive grid-size changes and regeneration. This module is pure:
 * every function takes layers that the caller owns and never touches cached
 * pipeline state. Fingerprint helpers produce stable cache keys from override
 * content, which is what makes "edit -> change seed -> change back" byte-exact.
 */
import { clamp, clamp01, smoothstep01 } from "./rng";
import type {
  BiomeStamp,
  BiomeId,
  ElevationStamp,
  MapLabel,
  RiverForcePath,
  Settlement,
  WorldOverrides,
} from "./types";

// ── Fingerprints ──────────────────────────────────────────────────────────
//
// Number#toString() is a deterministic, round-trip-exact representation of a
// double, so string concatenation is collision-free for our purposes. Keys are
// only ever compared for equality (never persisted), so length is acceptable.

export function elevationStampKey(stamps: readonly ElevationStamp[] | undefined): string {
  if (!stamps || stamps.length === 0) return "e0";
  const parts: string[] = [`e${stamps.length}`];
  for (const stamp of stamps) {
    parts.push(`${stamp.mode}:${stamp.x}:${stamp.y}:${stamp.radius}:${stamp.value}`);
  }
  return parts.join("|");
}

export function riverForceKey(paths: readonly RiverForcePath[] | undefined): string {
  if (!paths || paths.length === 0) return "r0";
  const parts: string[] = [`r${paths.length}`];
  for (const path of paths) {
    const pts = path.points ?? [];
    parts.push(`${path.id}:${path.width}:${pts.length}`);
    for (const point of pts) parts.push(`${point[0]}:${point[1]}`);
  }
  return parts.join("|");
}

export function biomeStampKey(stamps: readonly BiomeStamp[] | undefined): string {
  if (!stamps || stamps.length === 0) return "b0";
  const parts: string[] = [`b${stamps.length}`];
  for (const stamp of stamps) {
    parts.push(`${stamp.biome}:${stamp.x}:${stamp.y}:${stamp.radius}`);
  }
  return parts.join("|");
}

export function userContentKey(
  settlements: readonly Settlement[] | undefined,
  labels: readonly MapLabel[] | undefined,
  overrides: WorldOverrides | undefined,
): string {
  const hidden = overrides?.hiddenIds ?? [];
  const parts: string[] = [`h${hidden.length}`];
  for (const id of hidden) parts.push(id);
  const cuts = settlements ?? [];
  parts.push(`s${cuts.length}`);
  for (const s of cuts) {
    parts.push(`${s.id}:${s.name}:${s.kind}:${s.x}:${s.y}:${s.population ?? ""}:${s.pinned ? 1 : 0}`);
  }
  const userLabels = labels ?? [];
  parts.push(`l${userLabels.length}`);
  for (const l of userLabels) {
    parts.push(`${l.id}:${l.text}:${l.kind}:${l.x}:${l.y}:${l.rotation ?? ""}:${l.size ?? ""}:${l.pinned ? 1 : 0}`);
  }
  return parts.join("|");
}

export function overridesKey(overrides: WorldOverrides | undefined): string {
  if (!overrides) return "o0";
  return [
    elevationStampKey(overrides.elevation),
    riverForceKey(overrides.riverForce),
    biomeStampKey(overrides.biome),
  ].join("§");
}

// ── Elevation stamps (applied in terrain, before depression filling) ──────

/** Normalized stamp falloff: 1 at the center, 0 at the rim. */
function stampFalloff(distance: number, radius: number): number {
  if (radius <= 0) return distance <= 0 ? 1 : 0;
  const t = 1 - distance / radius;
  if (t <= 0) return 0;
  return smoothstep01(t);
}

/**
 * Rasterize elevation stamps onto a mutable height field.
 * - lock: blend toward an absolute height (soft-edged plateau)
 * - raise/lower: add/subtract |value| with a smooth falloff
 */
export function applyElevationStamps(
  height: Float32Array,
  size: number,
  stamps: readonly ElevationStamp[] | undefined,
): void {
  if (!stamps || stamps.length === 0) return;
  const inv = 1 / size;
  for (const stamp of stamps) {
    if (!stamp || !Number.isFinite(stamp.x) || !Number.isFinite(stamp.y)) continue;
    const radius = Math.abs(stamp.radius);
    if (radius <= 0) continue;
    const cx = stamp.x * size - 0.5;
    const cy = stamp.y * size - 0.5;
    const rCells = radius * size;
    const x0 = Math.max(0, Math.floor(cx - rCells));
    const x1 = Math.min(size - 1, Math.ceil(cx + rCells));
    const y0 = Math.max(0, Math.floor(cy - rCells));
    const y1 = Math.min(size - 1, Math.ceil(cy + rCells));
    const mode = stamp.mode;
    const value = Number.isFinite(stamp.value) ? stamp.value : 0;
    for (let y = y0; y <= y1; y += 1) {
      const dy = y - cy;
      const row = y * size;
      for (let x = x0; x <= x1; x += 1) {
        const dx = x - cx;
        const distance = Math.sqrt(dx * dx + dy * dy) * inv;
        const falloff = stampFalloff(distance, radius);
        if (falloff <= 0) continue;
        const i = row + x;
        const h = height[i];
        if (mode === "lock") {
          height[i] = clamp01(h + (clamp01(value) - h) * falloff);
        } else if (mode === "raise") {
          height[i] = clamp01(h + Math.abs(value) * falloff);
        } else if (mode === "lower") {
          height[i] = clamp01(h - Math.abs(value) * falloff);
        }
      }
    }
  }
}

// ── Forced rivers (carved in terrain, before depression filling) ──────────

/**
 * Carve user-drawn river polylines into the height field.
 *
 * The carve bed descends monotonically along each polyline, so D8 routing is
 * guaranteed to follow it, and if the stroke ends inland we extend it (also
 * monotonically descending, below any sea level) to the nearest map border so
 * the forced river is guaranteed to reach open water. The returned mask holds
 * the channel centerline cells so the hydrology stage can force them to be
 * rendered as river even when the forced catchment is tiny.
 */
export function carveRiverForce(
  height: Float32Array,
  size: number,
  paths: readonly RiverForcePath[] | undefined,
): Uint8Array {
  const n = size * size;
  const channel = new Uint8Array(n);
  if (!paths || paths.length === 0 || size < 4) return channel;

  const maxCells = n;
  const prev = new Int32Array(n);
  const queue = new Int32Array(n);

  for (const path of paths) {
    if (!path || !Array.isArray(path.points) || path.points.length === 0) continue;
    // Grid-space points (cell coordinates).
    const px: number[] = [];
    const py: number[] = [];
    for (const point of path.points) {
      if (!Array.isArray(point) || point.length < 2) continue;
      const x = Number(point[0]);
      const y = Number(point[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      px.push(clamp(x, 0, 1) * (size - 1));
      py.push(clamp(y, 0, 1) * (size - 1));
    }
    if (px.length === 0) continue;
    if (px.length === 1) {
      px.push(px[0]);
      py.push(py[0]);
    }

    // Orient the path so it starts on the high side (UI may draw either way).
    const chamberCount = Math.max(1, Math.min(px.length, Math.ceil(px.length * 0.25)));
    let headH = 0;
    let tailH = 0;
    for (let k = 0; k < chamberCount; k += 1) {
      headH += height[Math.round(py[k]) * size + Math.round(px[k])] || 0;
      const j = px.length - 1 - k;
      tailH += height[Math.round(py[j]) * size + Math.round(px[j])] || 0;
    }
    if (tailH > headH) {
      px.reverse();
      py.reverse();
    }

    // Cumulative arc length in cells.
    const count = px.length;
    const cum = new Float64Array(count);
    for (let k = 1; k < count; k += 1) {
      const dx = px[k] - px[k - 1];
      const dy = py[k] - py[k - 1];
      cum[k] = cum[k - 1] + Math.sqrt(dx * dx + dy * dy);
    }
    const total = cum[count - 1];
    if (!(total > 0)) continue;
    const firstCell = Math.round(py[0]) * size + Math.round(px[0]);
    const startBed = clamp(height[firstCell], 0.08, 0.94);
    const mouthBed = 0.02;
    const widthNorm = clamp(Number.isFinite(path.width) ? path.width : 0.012, 0.002, 0.06);
    const radius = Math.max(1, Math.min(Math.round(widthNorm * size * 0.55) + 1, Math.floor(size * 0.06) + 1));
    const edgeRise = 0.02 + widthNorm;

    const carveSample = (cx: number, cy: number, bed: number, markChannel: boolean): void => {
      const bx0 = Math.max(0, Math.floor(cx - radius));
      const bx1 = Math.min(size - 1, Math.ceil(cx + radius));
      const by0 = Math.max(0, Math.floor(cy - radius));
      const by1 = Math.min(size - 1, Math.ceil(cy + radius));
      for (let y = by0; y <= by1; y += 1) {
        const dy = y - cy;
        const row = y * size;
        for (let x = bx0; x <= bx1; x += 1) {
          const dx = x - cx;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance > radius) continue;
          const ratio = distance / radius;
          const target = bed + edgeRise * ratio * ratio;
          const i = row + x;
          if (target < height[i]) height[i] = target;
          if (markChannel && distance <= 0.85) channel[i] = 1;
        }
      }
    };

    // Walk the polyline at ~0.6 cell spacing.
    const step = 0.6;
    const samples = Math.max(2, Math.ceil(total / step) + 1);
    let lastX = px[count - 1];
    let lastY = py[count - 1];
    let seg = 0;
    for (let s = 0; s < samples; s += 1) {
      const targetLen = (s / (samples - 1)) * total;
      while (seg < count - 2 && cum[seg + 1] < targetLen) seg += 1;
      const segLen = cum[seg + 1] - cum[seg];
      const localT = segLen > 1e-9 ? (targetLen - cum[seg]) / segLen : 1;
      const t = clamp01(localT);
      const cx = px[seg] + (px[seg + 1] - px[seg]) * t;
      const cy = py[seg] + (py[seg + 1] - py[seg]) * t;
      const along = total > 1e-9 ? targetLen / total : 0;
      const bed = startBed + (mouthBed - startBed) * along;
      carveSample(cx, cy, bed, true);
      lastX = cx;
      lastY = cy;
    }

    // Guarantee continuity into open water: BFS from the stroke end to the
    // nearest map border, then carve that extension monotonically down.
    let startX = Math.round(lastX);
    let startY = Math.round(lastY);
    startX = clamp(startX, 0, size - 1);
    startY = clamp(startY, 0, size - 1);
    let borderCell = -1;
    if (startX > 0 && startX < size - 1 && startY > 0 && startY < size - 1) {
      prev.fill(-1);
      let head = 0;
      let tail = 0;
      const startCell = startY * size + startX;
      queue[tail++] = startCell;
      prev[startCell] = startCell;
      let found = -1;
      while (head < tail) {
        const cell = queue[head++];
        const cx = cell % size;
        const cy = (cell / size) | 0;
        if (cx === 0 || cy === 0 || cx === size - 1 || cy === size - 1) {
          found = cell;
          break;
        }
        // Deterministic 8-neighbour order.
        const stepCells = [-1, 1, -size, size, -size - 1, -size + 1, size - 1, size + 1];
        for (const delta of stepCells) {
          const next = cell + delta;
          if (next < 0 || next >= maxCells || prev[next] !== -1) continue;
          prev[next] = cell;
          queue[tail++] = next;
        }
      }
      if (found >= 0) {
        borderCell = found;
        // Reconstruct path last -> border.
        const chain: number[] = [];
        let cursor = borderCell;
        while (cursor !== startCell && cursor >= 0) {
          chain.push(cursor);
          const p = prev[cursor];
          if (p === cursor) break;
          cursor = p;
        }
        chain.push(startCell);
        // Carve from the stroke end (chain[0] is adjacent to it ... chain last
        // is startCell) toward the border: bed descends from mouthBed to 0.01.
        const totalChain = chain.length;
        for (let k = 0; k < totalChain; k += 1) {
          const cell = chain[k];
          const cx = cell % size;
          const cy = (cell / size) | 0;
          const along = totalChain > 1 ? k / (totalChain - 1) : 0;
          const bed = mouthBed + (0.01 - mouthBed) * along;
          carveSample(cx, cy, bed, true);
        }
      }
    }
    if (borderCell < 0) {
      // Stroke already touches the map border (or no path found): carve the end
      // straight down to just below any plausible sea level.
      carveSample(lastX, lastY, 0.01, true);
    }
  }

  return channel;
}

// ── Biome stamps (applied after classification) ───────────────────────────

export function applyBiomeStamps(
  biome: Uint8Array,
  size: number,
  stamps: readonly BiomeStamp[] | undefined,
  isWater?: (index: number) => boolean,
): void {
  if (!stamps || stamps.length === 0) return;
  const inv = 1 / size;
  for (const stamp of stamps) {
    if (!stamp || !Number.isFinite(stamp.x) || !Number.isFinite(stamp.y)) continue;
    const radius = Math.abs(stamp.radius);
    if (radius <= 0) continue;
    const cx = stamp.x * size - 0.5;
    const cy = stamp.y * size - 0.5;
    const rCells = radius * size;
    const x0 = Math.max(0, Math.floor(cx - rCells));
    const x1 = Math.min(size - 1, Math.ceil(cx + rCells));
    const y0 = Math.max(0, Math.floor(cy - rCells));
    const y1 = Math.min(size - 1, Math.ceil(cy + rCells));
    const biomeId = stamp.biome as BiomeId;
    for (let y = y0; y <= y1; y += 1) {
      const dy = y - cy;
      const row = y * size;
      for (let x = x0; x <= x1; x += 1) {
        const dx = x - cx;
        const distance = Math.sqrt(dx * dx + dy * dy) * inv;
        const falloff = stampFalloff(distance, radius);
        if (falloff < 0.35) continue;
        const i = row + x;
        if (isWater && isWater(i)) continue;
        biome[i] = biomeId;
      }
    }
  }
}
