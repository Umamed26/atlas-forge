/**
 * Hydrology stage — real, strict flow routing.
 *
 *  1. Priority-Flood + epsilon depression filling (bucket/radix queue over a
 *     16-bit height quantisation, O(n) and allocation-light). Every non-border
 *     cell was reached from a strictly lower neighbour, so the filled surface
 *     structurally guarantees a downhill path to the map border.
 *  2. Ocean = border-connected water below sea level; lakes = connected
 *     depressions raised by the fill whose surface is above sea level.
 *  3. D8 steepest-descent routing on the filled surface + Kahn/leaf-first flow
 *     accumulation (the strict descent makes the D8 graph a forest, so no sort
 *     is needed).
 *  4. Rivers = land cells above a flow-area threshold derived from
 *     riverDensity, plus user-forced channel cells.
 */
import { clamp, clamp01 } from "./rng";

/** Fill epsilon: keeps every non-border cell strictly above its downstream. */
export const FILL_EPSILON = 2e-6;
/** Quantisation used by the priority-flood bucket queue. */
const LEVELS = 65536;

export interface HydrologyInput {
  size: number;
  /** Terrain height after erosion + brush overrides (carving included). */
  height: Float32Array;
  /** Forced river centreline from riverForce overrides (may be undefined). */
  channel?: Uint8Array;
  seaLevel: number;
  riverDensity: number;
}

export interface HydrologyResult {
  filled: Float32Array;
  ocean: Uint8Array;
  lake: Uint8Array;
  river: Uint8Array;
  flow: Float32Array;
  /** Internal D8 downstream cell index, -1 for sinks. Used by invariant tests. */
  downstream: Int32Array;
  oceanCount: number;
  landCells: number;
  riverThreshold: number;
  lakeCount: number;
}

const NEIGHBOR_DX = [-1, 1, 0, 0, -1, 1, -1, 1] as const;
const NEIGHBOR_DY = [0, 0, -1, 1, -1, -1, 1, 1] as const;

function levelOf(value: number): number {
  const level = (value * (LEVELS - 1)) | 0;
  return level < 0 ? 0 : level >= LEVELS ? LEVELS - 1 : level;
}

/**
 * Priority-Flood + epsilon using a bucket queue keyed by quantised height.
 * Pushes never target a lower bucket than the currently processed one, so a
 * single ascending scan suffices (no binary heap).
 */
function priorityFlood(size: number, height: Float32Array, filled: Float32Array): number {
  const cells = size * size;
  const closed = new Uint8Array(cells);
  const nextLink = new Int32Array(cells);
  const head = new Int32Array(LEVELS).fill(-1);
  let visited = 0;

  const push = (index: number, level: number): void => {
    nextLink[index] = head[level];
    head[level] = index;
  };

  // All border cells are outlets: they keep their own height and seed the fill.
  for (let x = 0; x < size; x += 1) {
    const top = x;
    if (!closed[top]) {
      closed[top] = 1;
      filled[top] = height[top];
      visited += 1;
      push(top, levelOf(filled[top]));
    }
    const bottom = (size - 1) * size + x;
    if (!closed[bottom]) {
      closed[bottom] = 1;
      filled[bottom] = height[bottom];
      visited += 1;
      push(bottom, levelOf(filled[bottom]));
    }
  }
  for (let y = 1; y < size - 1; y += 1) {
    const left = y * size;
    if (!closed[left]) {
      closed[left] = 1;
      filled[left] = height[left];
      visited += 1;
      push(left, levelOf(filled[left]));
    }
    const right = y * size + size - 1;
    if (!closed[right]) {
      closed[right] = 1;
      filled[right] = height[right];
      visited += 1;
      push(right, levelOf(filled[right]));
    }
  }

  for (let level = 0; level < LEVELS; level += 1) {
    let cell = head[level];
    while (cell !== -1) {
      head[level] = nextLink[cell];
      const cx = cell % size;
      const cy = (cell / size) | 0;
      const spill = filled[cell] + FILL_EPSILON;
      if (cx > 0 && cx < size - 1 && cy > 0 && cy < size - 1) {
        // Interior fast path: all eight neighbours are in bounds.
        let nIndex = cell - 1;
        if (!closed[nIndex]) {
          closed[nIndex] = 1;
          const nHeight = height[nIndex];
          const nFilled = nHeight > spill ? nHeight : spill;
          filled[nIndex] = nFilled;
          visited += 1;
          push(nIndex, levelOf(nFilled));
        }
        nIndex = cell + 1;
        if (!closed[nIndex]) {
          closed[nIndex] = 1;
          const nHeight = height[nIndex];
          const nFilled = nHeight > spill ? nHeight : spill;
          filled[nIndex] = nFilled;
          visited += 1;
          push(nIndex, levelOf(nFilled));
        }
        nIndex = cell - size;
        if (!closed[nIndex]) {
          closed[nIndex] = 1;
          const nHeight = height[nIndex];
          const nFilled = nHeight > spill ? nHeight : spill;
          filled[nIndex] = nFilled;
          visited += 1;
          push(nIndex, levelOf(nFilled));
        }
        nIndex = cell + size;
        if (!closed[nIndex]) {
          closed[nIndex] = 1;
          const nHeight = height[nIndex];
          const nFilled = nHeight > spill ? nHeight : spill;
          filled[nIndex] = nFilled;
          visited += 1;
          push(nIndex, levelOf(nFilled));
        }
        nIndex = cell - size - 1;
        if (!closed[nIndex]) {
          closed[nIndex] = 1;
          const nHeight = height[nIndex];
          const nFilled = nHeight > spill ? nHeight : spill;
          filled[nIndex] = nFilled;
          visited += 1;
          push(nIndex, levelOf(nFilled));
        }
        nIndex = cell - size + 1;
        if (!closed[nIndex]) {
          closed[nIndex] = 1;
          const nHeight = height[nIndex];
          const nFilled = nHeight > spill ? nHeight : spill;
          filled[nIndex] = nFilled;
          visited += 1;
          push(nIndex, levelOf(nFilled));
        }
        nIndex = cell + size - 1;
        if (!closed[nIndex]) {
          closed[nIndex] = 1;
          const nHeight = height[nIndex];
          const nFilled = nHeight > spill ? nHeight : spill;
          filled[nIndex] = nFilled;
          visited += 1;
          push(nIndex, levelOf(nFilled));
        }
        nIndex = cell + size + 1;
        if (!closed[nIndex]) {
          closed[nIndex] = 1;
          const nHeight = height[nIndex];
          const nFilled = nHeight > spill ? nHeight : spill;
          filled[nIndex] = nFilled;
          visited += 1;
          push(nIndex, levelOf(nFilled));
        }
      } else {
        for (let k = 0; k < 8; k += 1) {
          const nx = cx + NEIGHBOR_DX[k];
          const ny = cy + NEIGHBOR_DY[k];
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const nIndex = ny * size + nx;
          if (closed[nIndex]) continue;
          closed[nIndex] = 1;
          const nHeight = height[nIndex];
          const nFilled = nHeight > spill ? nHeight : spill;
          filled[nIndex] = nFilled;
          visited += 1;
          push(nIndex, levelOf(nFilled));
        }
      }
      cell = head[level];
    }
  }
  // The grid is connected, so every cell must have been reached.
  return visited;
}

/**
 * Compute all hydrology layers. Inputs are read-only; every output array is
 * freshly allocated and fully written.
 */
export function computeHydrology(input: HydrologyInput): HydrologyResult {
  const size = input.size;
  const cells = size * size;
  const height = input.height;
  const seaLevel = clamp(input.seaLevel, 0.02, 0.95);
  const channel = input.channel;

  const filled = new Float32Array(cells);
  filled.fill(NaN);
  const visited = priorityFlood(size, height, filled);
  if (visited !== cells) {
    // Should never happen on a connected grid; keep the contract explicit.
    for (let i = 0; i < cells; i += 1) {
      if (!Number.isFinite(filled[i])) filled[i] = height[i];
    }
  }

  // ── Ocean: every cell whose filled surface is below sea level ──────────
  // Priority-Flood property: if filled[i] < seaLevel then the whole flood
  // parent chain down to the border is also below sea level, i.e. the cell is
  // ocean-connected. No extra flood fill is needed.
  const ocean = new Uint8Array(cells);
  for (let i = 0; i < cells; i += 1) {
    if (filled[i] < seaLevel) ocean[i] = 1;
  }

  let oceanCount = 0;
  for (let i = 0; i < cells; i += 1) if (ocean[i]) oceanCount += 1;
  const landCells = cells - oceanCount;
  const scratch = new Int32Array(cells);
  let queueHead = 0;
  let queueTail = 0;

  // ── Lakes: connected fill-depressions with a real water surface ────────
  const lake = new Uint8Array(cells);
  const lakeMinCells = Math.max(4, Math.round(cells * 0.000025));
  const depthThreshold = 0.0015;
  const raised = new Uint8Array(cells);
  for (let i = 0; i < cells; i += 1) {
    if (ocean[i]) continue;
    if (filled[i] - height[i] > depthThreshold) raised[i] = 1;
  }
  let lakeCount = 0;
  for (let start = 0; start < cells; start += 1) {
    if (!raised[start] || lake[start]) continue;
    queueHead = 0;
    queueTail = 0;
    scratch[queueTail++] = start;
    lake[start] = 2; // temporary candidate marker
    while (queueHead < queueTail) {
      const cell = scratch[queueHead++];
      const cx = cell % size;
      const cy = (cell / size) | 0;
      for (let k = 0; k < 8; k += 1) {
        const nx = cx + NEIGHBOR_DX[k];
        const ny = cy + NEIGHBOR_DY[k];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const nIndex = ny * size + nx;
        if (!raised[nIndex] || lake[nIndex]) continue;
        lake[nIndex] = 2;
        scratch[queueTail++] = nIndex;
      }
    }
    // `scratch[0..queueTail)` are exactly this component's members.
    if (queueTail >= lakeMinCells) {
      lakeCount += 1;
      for (let m = 0; m < queueTail; m += 1) lake[scratch[m]] = 1;
    } else {
      for (let m = 0; m < queueTail; m += 1) lake[scratch[m]] = 0;
    }
  }
  // Invariant guardrail: any non-ocean cell below sea level must be water,
  // even if its depression is too small to be a named lake.
  for (let i = 0; i < cells; i += 1) {
    if (!ocean[i] && height[i] < seaLevel) lake[i] = 1;
  }

  // ── D8 routing on the filled surface ───────────────────────────────────
  // Ocean cells are sinks; land cells route to their steepest lower neighbour.
  const downstream = new Int32Array(cells);
  downstream.fill(-1);
  for (let y = 1; y < size - 1; y += 1) {
    const row = y * size;
    for (let x = 1; x < size - 1; x += 1) {
      const cell = row + x;
      if (ocean[cell]) continue;
      const h = filled[cell];
      let best = -1;
      let bestSlope = 0;
      let drop = h - filled[cell - 1];
      if (drop > 0) {
        bestSlope = drop;
        best = cell - 1;
      }
      drop = h - filled[cell + 1];
      if (drop > 0 && drop > bestSlope) {
        bestSlope = drop;
        best = cell + 1;
      }
      drop = h - filled[cell - size];
      if (drop > 0 && drop > bestSlope) {
        bestSlope = drop;
        best = cell - size;
      }
      drop = h - filled[cell + size];
      if (drop > 0 && drop > bestSlope) {
        bestSlope = drop;
        best = cell + size;
      }
      drop = (h - filled[cell - size - 1]) / Math.SQRT2;
      if (drop > 0 && drop > bestSlope) {
        bestSlope = drop;
        best = cell - size - 1;
      }
      drop = (h - filled[cell - size + 1]) / Math.SQRT2;
      if (drop > 0 && drop > bestSlope) {
        bestSlope = drop;
        best = cell - size + 1;
      }
      drop = (h - filled[cell + size - 1]) / Math.SQRT2;
      if (drop > 0 && drop > bestSlope) {
        bestSlope = drop;
        best = cell + size - 1;
      }
      drop = (h - filled[cell + size + 1]) / Math.SQRT2;
      if (drop > 0 && drop > bestSlope) {
        bestSlope = drop;
        best = cell + size + 1;
      }
      downstream[cell] = best;
    }
  }

  // ── Flow accumulation: leaf-first Kahn pass (the D8 graph is a forest) ──
  const flow = new Float32Array(cells);
  flow.fill(1);
  const indegree = new Int32Array(cells);
  for (let i = 0; i < cells; i += 1) {
    const d = downstream[i];
    if (d >= 0) indegree[d] += 1;
  }
  queueHead = 0;
  queueTail = 0;
  for (let i = 0; i < cells; i += 1) {
    if (indegree[i] === 0) scratch[queueTail++] = i;
  }
  while (queueHead < queueTail) {
    const cell = scratch[queueHead++];
    const d = downstream[cell];
    if (d < 0) continue;
    flow[d] += flow[cell];
    indegree[d] -= 1;
    if (indegree[d] === 0) scratch[queueTail++] = d;
  }

  // ── Rivers ─────────────────────────────────────────────────────────────
  const density = clamp01(input.riverDensity);
  const threshold = Math.max(
    4,
    Math.round(cells * 6e-5 * Math.exp((0.5 - density) * 2.0)),
  );
  const river = new Uint8Array(cells);
  for (let i = 0; i < cells; i += 1) {
    if (ocean[i] || lake[i]) continue;
    if (flow[i] >= threshold) river[i] = 1;
    else if (channel !== undefined && channel[i]) river[i] = 1;
  }
  // Forced channels that happen to sit in a lake still count as river only if
  // they are dry land; lakes keep their own layer.
  for (let i = 0; i < cells; i += 1) {
    if (ocean[i]) flow[i] = 0;
  }

  return {
    filled,
    ocean,
    lake,
    river,
    flow,
    downstream,
    oceanCount,
    landCells,
    riverThreshold: threshold,
    lakeCount,
  };
}
