/**
 * River rendering: traces the D8 network encoded in layers.river / layers.flow,
 * smooths each thread and draws it as a tapering ink polygon (width ∝ sqrt(flow),
 * pointed at the river mouth where it meets sea or lake).
 */
import type { WorldLayers } from "@atlas/core";
import type { Ctx2D } from "./canvas-types";
import { arcLengths, chaikin, jitterPolyline } from "./contour";
import { cssRgb, type RenderTheme } from "./style";

export interface RiverPath {
  /** Normalized [x0,y0,...] centerline. */
  points: number[];
  /** Normalized flow (0..1, sqrt-scaled later) at each point. */
  flow: number[];
  cells: number;
}

export interface RiverExtractOptions {
  maxRivers: number;
  /** Ignore threads whose peak flow is below this fraction of the max. */
  minFlowRatio: number;
  /** Chaikin smoothing passes (preview uses fewer points). */
  smoothing?: number;
}

interface TraceStep {
  cells: number[];
  mouth: number;
}

/** Trace the river network into smoothed, flow-weighted centerlines. */
export function extractRivers(layers: WorldLayers, opts: RiverExtractOptions): RiverPath[] {
  const n = layers.size;
  const cells = n * n;
  const river = layers.river;
  const filled = layers.filled;
  const flow = layers.flow;

  const ocean = layers.ocean;
  const lake = layers.lake;
  const isRiver = (i: number): boolean => river[i] === 1 && !ocean[i] && !lake[i];
  // One pass over the grid collects the river cells and peak flow.
  const riverCells: number[] = [];
  let maxFlow = 1e-9;
  for (let i = 0; i < cells; i += 1) {
    if (river[i] === 1 && !ocean[i] && !lake[i]) {
      riverCells.push(i);
      if (flow[i] > maxFlow) maxFlow = flow[i];
    }
  }
  if (riverCells.length === 0) return [];

  // Downstream pointer for every river cell.
  const down = new Int32Array(cells).fill(-2);
  const upstream = new Uint8Array(cells);
  const dx = [1, 1, 0, -1, -1, -1, 0, 1];
  const dy = [0, 1, 1, 1, 0, -1, -1, -1];
  const invDist = [1, 0.70710678, 1, 0.70710678, 1, 0.70710678, 1, 0.70710678];
  for (const i of riverCells) {
    const y = (i / n) | 0;
    const x = i - y * n;
    let best = -1;
    let bestSlope = 0;
    const here = filled[i];
    for (let k = 0; k < 8; k += 1) {
      const nx = x + dx[k];
      const ny = y + dy[k];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      if (filled[j] >= here) continue;
      const slope = (here - filled[j]) * invDist[k];
      if (slope > bestSlope) {
        bestSlope = slope;
        best = j;
      }
    }
    down[i] = best;
    if (best >= 0 && isRiver(best)) upstream[best] = 1;
  }

  // Sources sorted by flow (strongest rivers first).
  const sources: number[] = [];
  for (const i of riverCells) {
    if (!upstream[i]) sources.push(i);
  }
  sources.sort((a, b) => flow[b] - flow[a]);
  const minFlow = maxFlow * opts.minFlowRatio;
  const visited = new Uint8Array(cells);
  const traces: Array<{ steps: number[]; mouth: number; peak: number }> = [];

  for (const source of sources) {
    if (visited[source]) continue;
    const steps: number[] = [];
    let cur = source;
    let mouth = -1;
    for (let guard = 0; guard < 100000; guard += 1) {
      if (cur < 0 || visited[cur] || !isRiver(cur)) break;
      visited[cur] = 1;
      steps.push(cur);
      const d = down[cur];
      if (d < 0) break;
      if (!isRiver(d)) {
        mouth = d;
        break;
      }
      cur = d;
    }
    if (steps.length < 3) continue;
    let peak = 0;
    for (const cell of steps) if (flow[cell] > peak) peak = flow[cell];
    if (peak < minFlow) continue;
    traces.push({ steps, mouth, peak });
    if (traces.length >= opts.maxRivers * 3) break;
  }
  traces.sort((a, b) => b.peak - a.peak);
  const selected = traces.slice(0, opts.maxRivers);

  const result: RiverPath[] = [];
  for (const trace of selected) {
    const pts: number[] = [];
    const flows: number[] = [];
    for (const cell of trace.steps) {
      const x = cell % n;
      const y = (cell / n) | 0;
      pts.push((x + 0.5) / n, (y + 0.5) / n);
      flows.push(Math.min(1, Math.sqrt(Math.max(0, flow[cell]) / maxFlow)));
    }
    if (trace.mouth >= 0) {
      const x = trace.mouth % n;
      const y = (trace.mouth / n) | 0;
      pts.push((x + 0.5) / n, (y + 0.5) / n);
      flows.push(flows[flows.length - 1] ?? 0.05);
    }
    const maxSmoothing = opts.smoothing ?? 3;
    const smooth = chaikin(pts, false, Math.min(maxSmoothing, pts.length > 18 ? 3 : pts.length > 8 ? 2 : 1));
    // A touch of hand-drawn wobble keeps D8 stair-steps from reading as vectors.
    const wobbled = jitterPolyline(smooth, false, 0.5 / 1024, 22, seedFor(pts));
    const resampledFlow = resampleFlow(pts, flows, wobbled);
    result.push({ points: wobbled, flow: resampledFlow, cells: trace.steps.length });
  }
  return result;
}

function seedFor(points: number[]): number {
  let h = 2166136261;
  for (let i = 0; i < Math.min(8, points.length); i += 1) {
    h = Math.imul(h ^ Math.round(points[i] * 100000), 16777619);
  }
  return h | 0;
}

/** Map per-original-point flows onto smoothed points by arc fraction. */
function resampleFlow(original: number[], originalFlow: number[], smooth: number[]): number[] {
  const oa = arcLengths(original, false);
  const sa = arcLengths(smooth, false);
  const out: number[] = [];
  let j = 0;
  for (let i = 0; i < sa.length; i += 1) {
    const t = sa[i];
    while (j < oa.length - 2 && oa[j + 1] < t) j += 1;
    const span = oa[j + 1] - oa[j] || 1;
    const u = Math.min(1, Math.max(0, (t - oa[j]) / span));
    out.push((originalFlow[j] ?? 0) + ((originalFlow[j + 1] ?? originalFlow[j] ?? 0) - (originalFlow[j] ?? 0)) * u);
  }
  return out;
}

export interface RiverDrawOptions {
  width: number;
  height: number;
  scale: number;
  theme: RenderTheme;
  seed: number;
}

/** Draw rivers as filled, variable-width polygons (one path per river). */
export function drawRivers(ctx: Ctx2D, rivers: RiverPath[], opts: RiverDrawOptions & { bankStroke?: boolean }): void {
  const { width, height, scale, theme } = opts;
  if (rivers.length === 0) return;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const river of rivers) {
    const count = river.points.length / 2;
    if (count < 2) continue;
    const xs = new Array<number>(count);
    const ys = new Array<number>(count);
    const ws = new Array<number>(count);
    for (let i = 0; i < count; i += 1) {
      xs[i] = river.points[i * 2] * width;
      ys[i] = river.points[i * 2 + 1] * height;
      const f = river.flow[i] ?? 0.1;
      let w = theme.river.minWidth + (theme.river.maxWidth - theme.river.minWidth) * f;
      // Source taper.
      if (i === 0) w *= 0.4;
      else if (i === 1) w *= 0.72;
      // Mouth taper: the thread comes to a point where it meets the sea.
      if (i >= count - 3) {
        const k = count - 1 - i;
        w *= k === 0 ? 0.12 : k === 1 ? 0.42 : 0.72;
      }
      ws[i] = Math.max(0.35, w * scale);
    }
    const left: number[] = [];
    const right: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const prev = Math.max(0, i - 1);
      const next = Math.min(count - 1, i + 1);
      let tx = xs[next] - xs[prev];
      let ty = ys[next] - ys[prev];
      const len = Math.hypot(tx, ty) || 1;
      tx /= len;
      ty /= len;
      const hw = ws[i] * 0.5;
      left.push(xs[i] - ty * hw, ys[i] + tx * hw);
      right.push(xs[i] + ty * hw, ys[i] - tx * hw);
    }
    ctx.beginPath();
    traceBank(ctx, left, 1);
    traceBank(ctx, right, -1);
    ctx.closePath();
    ctx.fillStyle = cssRgb(theme.ink.river, theme.river.alpha);
    ctx.fill();
    // Engraved banks: a hairline on each side gives the thread a drawn edge.
    if (theme.river.bankAlpha > 0.01 && opts.bankStroke !== false) {
      ctx.strokeStyle = cssRgb(theme.ink.river, theme.river.bankAlpha);
      ctx.lineWidth = theme.river.bankWidth * scale;
      ctx.stroke();
    }
  }
}

/** Append a bank polyline with quadratic midpoint smoothing. */
function traceBank(ctx: Ctx2D, bank: number[], direction: number): void {
  const count = bank.length / 2;
  if (count < 2) return;
  const xs = new Array<number>(count);
  const ys = new Array<number>(count);
  for (let i = 0; i < count; i += 1) {
    const src = direction > 0 ? i : count - 1 - i;
    xs[i] = bank[src * 2];
    ys[i] = bank[src * 2 + 1];
  }
  ctx.moveTo(xs[0], ys[0]);
  if (count === 2) {
    ctx.lineTo(xs[1], ys[1]);
    return;
  }
  for (let i = 1; i < count - 1; i += 1) {
    const mx = (xs[i] + xs[i + 1]) * 0.5;
    const my = (ys[i] + ys[i + 1]) * 0.5;
    ctx.quadraticCurveTo(xs[i], ys[i], mx, my);
  }
  ctx.lineTo(xs[count - 1], ys[count - 1]);
}
