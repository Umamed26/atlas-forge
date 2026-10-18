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
import { clamp, clamp01, hash2 } from "./rng";

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
  /**
   * Optional hydrology sub-seed. When present (stageSeeds.hydrology), the stage
   * applies a deterministic tie-break rotation + river-threshold jitter so the
   * river network can be re-rolled without changing the terrain. When absent
   * the implementation is exactly the legacy one (bit-for-bit compatible).
   */
  seed?: number;
  /**
   * v0.5 semantics: add river topology (Strahler order, normalized width) and
   * bounded delta branches at river mouths. Absent/false = legacy output.
   */
  modern?: boolean;
  /**
   * Minimum lake size as a fraction of the grid (default 0.000025 = legacy).
   * The plate model passes a larger value so erosion pits do not turn the map
   * into a patchwork of ponds; the legacy value keeps fbm worlds bit-identical.
   */
  lakeMinFraction?: number;
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
  /** Strahler stream order (0 = not a river). Modern semantics only. */
  riverOrder?: Uint8Array;
  /** Normalized river width 0..1 (renderer hint). Modern semantics only. */
  riverWidth?: Float32Array;
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
  const lakeMinCells = Math.max(4, Math.round(cells * (input.lakeMinFraction ?? 0.000025)));
  // A single inland basin larger than this is a terrain artefact, not a lake:
  // keep it as low land instead of flooding a sixth of the continent. Only the
  // modern policy opts in — legacy fbm worlds must stay bit-identical.
  const enforceLakeMax = input.lakeMinFraction !== undefined;
  const lakeMaxCells = Math.max(lakeMinCells, Math.round(cells * 0.006));
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
    if (queueTail >= lakeMinCells && (!enforceLakeMax || queueTail <= lakeMaxCells)) {
      lakeCount += 1;
      for (let m = 0; m < queueTail; m += 1) lake[scratch[m]] = 1;
    } else {
      // Mark rejected depressions as *visited* (3), never reset to 0: a reset
      // lets the outer loop start a new flood from the same cells again, which
      // is quadratic when erosion leaves thousands of small pits (observed as
      // 3.4s hydrology on some seeds). The classification result is unchanged.
      for (let m = 0; m < queueTail; m += 1) lake[scratch[m]] = 3;
    }
  }
  // Rejected depressions were tagged 3 ("visited, not water"); consumers treat
  // the mask as 0/1, so clear them before classification output.
  for (let i = 0; i < cells; i += 1) {
    if (lake[i] === 3) lake[i] = 0;
  }

  // Invariant guardrail (legacy policy): any non-ocean cell below sea level must
  // be water, even if its depression is too small to be a named lake. The plate
  // model clamps its land before this stage and passes a stricter lake policy,
  // so it is skipped there.
  if (input.lakeMinFraction === undefined) {
    for (let i = 0; i < cells; i += 1) {
      if (!ocean[i] && height[i] < seaLevel) lake[i] = 1;
    }
  }

  // ── D8 routing on the filled surface ───────────────────────────────────
  // Ocean cells are sinks; land cells route to their steepest lower neighbour.
  // With an optional stage seed, exact-slope tie-breaks are rotated by a
  // deterministic offset (tie-only: slopes/coastline are unchanged).
  const downstream = new Int32Array(cells);
  downstream.fill(-1);
  const tieOffset =
    input.seed === undefined ? 0 : hash2(input.seed, 0x7e, 0xd8) % 8;
  const useRotatedTies = input.seed !== undefined;
  for (let y = 1; y < size - 1; y += 1) {
    const row = y * size;
    for (let x = 1; x < size - 1; x += 1) {
      const cell = row + x;
      if (ocean[cell]) continue;
      const h = filled[cell];
      if (useRotatedTies) {
        // Seed mode: rotate exact-slope tie-breaks and apply a tiny (±2%)
        // deterministic slope bias, so re-rolling the hydrology seed actually
        // re-routes flow (still strictly downhill: every candidate drops).
        let best = -1;
        let bestScore = 0;
        for (let kk = 0; kk < 8; kk += 1) {
          const k = (kk + tieOffset) & 7;
          const nIndex = (y + NEIGHBOR_DY[k]) * size + (x + NEIGHBOR_DX[k]);
          const drop = h - filled[nIndex];
          if (drop <= 0) continue;
          const slope = drop / (k < 4 ? 1 : Math.SQRT2);
          const bias =
            1 + (hash2(input.seed as number, cell, k * 0x9e37 + 17) / 4294967296 - 0.5) * 0.04;
          const score = slope * bias;
          if (score > bestScore) {
            bestScore = score;
            best = nIndex;
          }
        }
        downstream[cell] = best;
        continue;
      }
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
  const baseThreshold = Math.max(
    4,
    Math.round(cells * 6e-5 * Math.exp((0.5 - density) * 2.0)),
  );
  // Optional stage seed: jitter the flow-area threshold so re-rolling the
  // hydrology seed visibly changes the river network (no legacy effect).
  let threshold = baseThreshold;
  if (input.seed !== undefined) {
    const seedHash = hash2(input.seed, 0, 0x5eed);
    threshold = Math.max(
      2,
      Math.round(baseThreshold * (0.75 + 0.5 * (seedHash / 4294967296))),
    );
    if (threshold === baseThreshold) {
      // Guarantee a change even on tiny grids where rounding/flooring would
      // otherwise collapse the jitter (e.g. baseThreshold = 4).
      threshold = baseThreshold >= 3
        ? (seedHash & 1) === 0 ? baseThreshold + 1 : baseThreshold - 1
        : baseThreshold + 1;
      if (threshold < 2) threshold = baseThreshold + 1;
    }
  }
  const river = new Uint8Array(cells);
  for (let i = 0; i < cells; i += 1) {
    if (ocean[i] || lake[i]) continue;
    if (flow[i] >= threshold) river[i] = 1;
    else if (channel !== undefined && channel[i]) river[i] = 1;
  }
  // ── v0.5 river topology: deltas, Strahler order, normalized width ──────
  let riverOrder: Uint8Array | undefined;
  let riverWidth: Float32Array | undefined;
  if (input.modern) {
    // Bounded delta branches at major river mouths (deterministic per cell).
    const deltaSalt = input.seed === undefined ? 0 : Math.imul(input.seed, 0x9e3779b1);
    for (let i = 0; i < cells; i += 1) {
      if (river[i] === 0 || ocean[i] === 1 || lake[i] === 1) continue;
      if (flow[i] < threshold * 3) continue;
      const x = i % size;
      const y = (i / size) | 0;
      let touchesOcean = false;
      for (let k = 0; k < 8; k += 1) {
        const nx = x + NEIGHBOR_DX[k];
        const ny = y + NEIGHBOR_DY[k];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        if (ocean[ny * size + nx] === 1) {
          touchesOcean = true;
          break;
        }
      }
      if (!touchesOcean) continue;
      const branches = hash2(x, y, deltaSalt ^ 0x0d3a) & 1;
      let added = 0;
      for (let k = 0; k < 8 && added <= branches; k += 1) {
        const nx = x + NEIGHBOR_DX[k];
        const ny = y + NEIGHBOR_DY[k];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const nIndex = ny * size + nx;
        if (river[nIndex] === 1 || ocean[nIndex] === 1 || lake[nIndex] === 1) continue;
        // Only branch into a cell that itself touches the sea (a delta lobe).
        let nTouchesOcean = false;
        const nnx = nx;
        const nny = ny;
        for (let kk = 0; kk < 8; kk += 1) {
          const mx = nnx + NEIGHBOR_DX[kk];
          const my = nny + NEIGHBOR_DY[kk];
          if (mx < 0 || my < 0 || mx >= size || my >= size) continue;
          if (ocean[my * size + mx] === 1) {
            nTouchesOcean = true;
            break;
          }
        }
        if (!nTouchesOcean) continue;
        river[nIndex] = 1;
        added += 1;
      }
    }

    // Strahler order: process the flow graph in topological order (scratch
    // currently holds the Kahn processing order, sources first).
    riverOrder = new Uint8Array(cells);
    const upstreamMax = new Uint8Array(cells);
    const upstreamMaxCount = new Uint8Array(cells);
    const topoCount = queueTail;
    for (let t = 0; t < topoCount; t += 1) {
      const cell = scratch[t];
      if (river[cell] === 0) continue;
      const best = upstreamMax[cell];
      if (best === 0) {
        riverOrder[cell] = 1;
      } else {
        riverOrder[cell] = upstreamMaxCount[cell] >= 2 ? best + 1 : best;
      }
      const order = riverOrder[cell];
      const d = downstream[cell];
      if (d >= 0 && river[d] === 1) {
        if (order > upstreamMax[d]) {
          upstreamMax[d] = order;
          upstreamMaxCount[d] = 1;
        } else if (order === upstreamMax[d]) {
          upstreamMaxCount[d] = Math.min(255, upstreamMaxCount[d] + 1);
        }
      }
    }

    // Normalized width: sqrt(flow) scaled, with a Strahler-order floor so
    // tributaries stay visible next to the main stem.
    let maxFlow = 0;
    let maxOrder = 0;
    for (let i = 0; i < cells; i += 1) {
      if (river[i] === 0) continue;
      if (flow[i] > maxFlow) maxFlow = flow[i];
      if (riverOrder[i] > maxOrder) maxOrder = riverOrder[i];
    }
    const invSqrtMax = maxFlow > 0 ? 1 / Math.sqrt(maxFlow) : 0;
    const invMaxOrder = maxOrder > 0 ? 1 / maxOrder : 0;
    riverWidth = new Float32Array(cells);
    for (let i = 0; i < cells; i += 1) {
      if (river[i] === 0) continue;
      const flowRatio = Math.sqrt(flow[i]) * invSqrtMax;
      const orderRatio = riverOrder[i] * invMaxOrder;
      riverWidth[i] = Math.min(1, 0.1 + 0.65 * flowRatio + 0.3 * orderRatio);
    }
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
    ...(riverOrder === undefined ? {} : { riverOrder }),
    ...(riverWidth === undefined ? {} : { riverWidth }),
  };
}

// ── Drainage helper (used by terrain stream-power erosion) ────────────────

export interface Drainage {
  filled: Float32Array;
  downstream: Int32Array;
  /** Upstream cell count including the cell itself. */
  accumulation: Float32Array;
  /** Topological order (sources first). */
  order: Int32Array;
}

/**
 * Coarse depression fill + D8 routing + flow accumulation, for erosion.
 * Treats the map border as the outlet (all border cells are sinks) and does not
 * know about sea level; the official hydrology stage recomputes everything.
 */
export function computeDrainage(size: number, height: Float32Array): Drainage {
  const cells = size * size;
  const filled = new Float32Array(cells);
  filled.fill(NaN);
  priorityFlood(size, height, filled);
  const downstream = new Int32Array(cells);
  downstream.fill(-1);
  for (let y = 1; y < size - 1; y += 1) {
    const row = y * size;
    for (let x = 1; x < size - 1; x += 1) {
      const cell = row + x;
      const h = filled[cell];
      let best = -1;
      let bestSlope = 0;
      for (let k = 0; k < 8; k += 1) {
        const nIndex = (y + NEIGHBOR_DY[k]) * size + (x + NEIGHBOR_DX[k]);
        const drop = h - filled[nIndex];
        if (drop <= 0) continue;
        const slope = drop / (k < 4 ? 1 : Math.SQRT2);
        if (slope > bestSlope) {
          bestSlope = slope;
          best = nIndex;
        }
      }
      downstream[cell] = best;
    }
  }
  const accumulation = new Float32Array(cells);
  accumulation.fill(1);
  const indegree = new Int32Array(cells);
  for (let i = 0; i < cells; i += 1) {
    const d = downstream[i];
    if (d >= 0) indegree[d] += 1;
  }
  const order = new Int32Array(cells);
  let head = 0;
  let tail = 0;
  for (let i = 0; i < cells; i += 1) {
    if (indegree[i] === 0) order[tail++] = i;
  }
  while (head < tail) {
    const cell = order[head++];
    const d = downstream[cell];
    if (d < 0) continue;
    accumulation[d] += accumulation[cell];
    indegree[d] -= 1;
    if (indegree[d] === 0) order[tail++] = d;
  }
  return { filled, downstream, accumulation, order };
}
