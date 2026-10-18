/**
 * Marching-squares contour extraction + hand-drawn polyline utilities.
 *
 * The simulation grid is treated as a scalar vertex grid; iso lines are traced
 * with linear interpolation between neighbouring samples, then smoothed
 * (Chaikin) and jittered with seeded 1D noise for the engraved / hand-drawn
 * look. Coordinates are normalized to [0, 1] world space.
 */
import { signedNoise1 } from "./noise";

/** A traced iso line: flat [x0,y0,x1,y1,...] in normalized world space. */
export interface IsoLine {
  points: number[];
  closed: boolean;
  /** 0..1 relative arc length at each point (filled by sampleLine). */
  arc?: number[];
}

interface SegmentPair {
  a: number;
  b: number;
}

/**
 * Trace iso lines of `field` (size*size vertex samples) at `iso`.
 * Returns closed loops and open chains in normalized [0,1] coordinates.
 */
export function traceIsoLines(field: ArrayLike<number>, size: number, iso: number): IsoLine[] {
  if (size < 2) return [];
  const hCount = size * (size - 1);
  const edgeX = new Float32Array(2 * hCount);
  const edgeY = new Float32Array(2 * hCount);
  const edgeReady = new Uint8Array(2 * hCount);

  const edgePoint = (id: number): void => {
    if (edgeReady[id]) return;
    edgeReady[id] = 1;
    if (id < hCount) {
      const y = Math.floor(id / (size - 1));
      const x = id - y * (size - 1);
      const a = field[y * size + x];
      const b = field[y * size + x + 1];
      const denom = b - a;
      const t = Math.abs(denom) < 1e-12 ? 0.5 : (iso - a) / denom;
      edgeX[id] = x + Math.min(1, Math.max(0, t));
      edgeY[id] = y;
    } else {
      const k = id - hCount;
      const y = Math.floor(k / size);
      const x = k - y * size;
      const a = field[y * size + x];
      const b = field[(y + 1) * size + x];
      const denom = b - a;
      const t = Math.abs(denom) < 1e-12 ? 0.5 : (iso - a) / denom;
      edgeX[id] = x;
      edgeY[id] = y + Math.min(1, Math.max(0, t));
    }
  };

  const segments: SegmentPair[] = [];
  const adj = new Map<number, number[]>();
  const link = (a: number, b: number): void => {
    let la = adj.get(a);
    if (!la) {
      la = [];
      adj.set(a, la);
    }
    la.push(b);
    let lb = adj.get(b);
    if (!lb) {
      lb = [];
      adj.set(b, lb);
    }
    lb.push(a);
    segments.push({ a, b });
  };

  const corners = new Float32Array(4);
  const crossings = new Int32Array(4);
  for (let y = 0; y < size - 1; y += 1) {
    const row = y * size;
    const rowNext = row + size;
    for (let x = 0; x < size - 1; x += 1) {
      const a = field[row + x];
      const b = field[row + x + 1];
      const c = field[rowNext + x];
      const d = field[rowNext + x + 1];
      const aboveA = a >= iso;
      const aboveB = b >= iso;
      const aboveC = c >= iso;
      const aboveD = d >= iso;
      if (aboveA === aboveB && aboveB === aboveC && aboveC === aboveD) continue;
      let nc = 0;
      // Crossings in geometric order: top, right, bottom, left.
      if (aboveA !== aboveB) crossings[nc++] = y * (size - 1) + x;
      if (aboveB !== aboveD) crossings[nc++] = hCount + y * size + (x + 1);
      if (aboveC !== aboveD) crossings[nc++] = (y + 1) * (size - 1) + x;
      if (aboveA !== aboveC) crossings[nc++] = hCount + y * size + x;
      if (nc === 2) {
        link(crossings[0], crossings[1]);
      } else if (nc === 4) {
        // Saddle: isolate the two corners on the minority side.
        corners[0] = a;
        corners[1] = b;
        corners[2] = d;
        corners[3] = c;
        const centerAbove = (a + b + c + d) * 0.25 >= iso;
        // Corner adjacency in crossing order [top, right, bottom, left].
        const adjacent: Array<[number, number]> = [
          [0, 3], // top-left corner: top + left
          [0, 1], // top-right: top + right
          [1, 2], // bottom-right: right + bottom
          [2, 3], // bottom-left: bottom + left
        ];
        let pairsDone = 0;
        for (let k = 0; k < 4; k += 1) {
          const above = corners[k] >= iso;
          if (above !== centerAbove) {
            const pair = adjacent[k];
            link(crossings[pair[0]], crossings[pair[1]]);
            pairsDone += 1;
          }
        }
        if (pairsDone !== 2) {
          // Numerical safety: fall back to the two pairing.
          link(crossings[0], crossings[1]);
          link(crossings[2], crossings[3]);
        }
      }
    }
  }

  const lines: IsoLine[] = [];
  const visited = new Set<number>();
  const toPoints = (chain: number[], closed: boolean): number[] => {
    const pts: number[] = [];
    for (let i = 0; i < chain.length; i += 1) {
      const id = chain[i];
      edgePoint(id);
      pts.push(edgeX[id] / (size - 1), edgeY[id] / (size - 1));
    }
    if (closed && chain.length > 2) {
      edgePoint(chain[0]);
      pts.push(edgeX[chain[0]] / (size - 1), edgeY[chain[0]] / (size - 1));
    }
    return pts;
  };

  for (const start of adj.keys()) {
    if (visited.has(start)) continue;
    visited.add(start);
    const chain: number[] = [start];
    let cur = start;
    let prev = -1;
    let closed = false;
    for (;;) {
      const nb = adj.get(cur);
      if (!nb || nb.length === 0) break;
      let next = -1;
      for (let i = 0; i < nb.length; i += 1) {
        if (nb[i] !== prev) {
          next = nb[i];
          break;
        }
      }
      if (next === -1) break;
      if (next === start) {
        closed = true;
        break;
      }
      if (visited.has(next)) break;
      visited.add(next);
      chain.push(next);
      prev = cur;
      cur = next;
    }
    // If we started mid-chain, walk the other direction and prepend.
    if (!closed && chain.length >= 1) {
      const nb = adj.get(start);
      if (nb && nb.length === 2) {
        const used = chain.length > 1 ? chain[1] : -1;
        const other = nb[0] === used ? nb[1] : nb[0];
        if (other !== undefined && !visited.has(other)) {
          const back: number[] = [];
          let p = start;
          let c = other;
          for (;;) {
            if (c === start || visited.has(c)) break;
            visited.add(c);
            back.push(c);
            const cnb = adj.get(c);
            if (!cnb) break;
            let nx = -1;
            for (let i = 0; i < cnb.length; i += 1) {
              if (cnb[i] !== p) {
                nx = cnb[i];
                break;
              }
            }
            if (nx === -1) break;
            p = c;
            c = nx;
          }
          chain.unshift(...back.reverse());
        }
      }
    }
    if (chain.length < 2) continue;
    lines.push({ points: toPoints(chain, closed), closed });
  }

  // Drop degenerate traces (tiny specks cause visual noise at low sim sizes).
  return lines.filter((line) => line.points.length >= 8 || line.closed);
}

/** Chaikin corner cutting. Closed polylines (first == last) stay closed. */
export function chaikin(points: number[], closed: boolean, iterations = 1): number[] {
  let pts = points;
  for (let it = 0; it < iterations; it += 1) {
    const count = pts.length / 2;
    if (count < (closed ? 4 : 3)) return pts.slice();
    const out: number[] = [];
    const unique = closed && pts[0] === pts[pts.length - 2] && pts[1] === pts[pts.length - 1] ? count - 1 : count;
    if (closed) {
      for (let i = 0; i < unique; i += 1) {
        const j = (i + 1) % unique;
        const x0 = pts[i * 2];
        const y0 = pts[i * 2 + 1];
        const x1 = pts[j * 2];
        const y1 = pts[j * 2 + 1];
        out.push(x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25);
        out.push(x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75);
      }
      out.push(out[0], out[1]);
    } else {
      out.push(pts[0], pts[1]);
      for (let i = 0; i < count - 1; i += 1) {
        const x0 = pts[i * 2];
        const y0 = pts[i * 2 + 1];
        const x1 = pts[(i + 1) * 2];
        const y1 = pts[(i + 1) * 2 + 1];
        out.push(x0 * 0.75 + x1 * 0.25, y0 * 0.75 + y1 * 0.25);
        out.push(x0 * 0.25 + x1 * 0.75, y0 * 0.25 + y1 * 0.75);
      }
      out.push(pts[pts.length - 2], pts[pts.length - 1]);
    }
    pts = out;
  }
  return pts;
}

/** Per-point cumulative normalized arc length (0..1). Closed arrays carry a duplicated last point. */
export function arcLengths(points: number[], closed: boolean): number[] {
  const count = points.length / 2;
  const unique = isDuplicated(points, closed) ? count - 1 : count;
  const lens: number[] = [0];
  let total = 0;
  for (let i = 1; i < unique; i += 1) {
    const dx = points[i * 2] - points[(i - 1) * 2];
    const dy = points[i * 2 + 1] - points[(i - 1) * 2 + 1];
    total += Math.hypot(dx, dy);
    lens.push(total);
  }
  if (closed && unique > 1) {
    total += Math.hypot(points[0] - points[(unique - 1) * 2], points[1] - points[(unique - 1) * 2 + 1]);
  }
  const norm = total > 1e-12 ? total : 1;
  for (let i = 0; i < lens.length; i += 1) lens[i] /= norm;
  if (isDuplicated(points, closed)) lens.push(1);
  return lens;
}

function isDuplicated(points: number[], closed: boolean): boolean {
  const count = points.length / 2;
  return (
    closed &&
    count > 1 &&
    points[0] === points[points.length - 2] &&
    points[1] === points[points.length - 1]
  );
}

/**
 * Hand-drawn jitter: displaces points along their normals using smooth seeded
 * 1D noise, with amplitude expressed in normalized map units so 1024 and 4096
 * renders share the same visual character.
 */
export function jitterPolyline(
  points: number[],
  closed: boolean,
  amplitude: number,
  frequency: number,
  seed: number,
): number[] {
  const count = points.length / 2;
  if (count < 2 || amplitude <= 0) return points.slice();
  const lens = arcLengths(points, closed);
  const out = new Array<number>(points.length);
  const unique = isDuplicated(points, closed) ? count - 1 : count;
  for (let i = 0; i < unique; i += 1) {
    const prev = i > 0 ? i - 1 : closed ? unique - 1 : 0;
    const next = i < unique - 1 ? i + 1 : closed ? 0 : unique - 1;
    let tx = points[next * 2] - points[prev * 2];
    let ty = points[next * 2 + 1] - points[prev * 2 + 1];
    if (closed && i === 0) {
      tx = points[2] - points[(unique - 1) * 2];
      ty = points[3] - points[(unique - 1) * 2 + 1];
    }
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    const wobble = signedNoise1(lens[i] * frequency, seed) * amplitude;
    out[i * 2] = points[i * 2] - ty * wobble;
    out[i * 2 + 1] = points[i * 2 + 1] + tx * wobble;
  }
  if (isDuplicated(points, closed)) {
    out[count * 2 - 2] = out[0];
    out[count * 2 - 1] = out[1];
  }
  return out;
}

/** Signed area of a closed polyline (positive = clockwise in screen space). */
export function signedArea(points: number[]): number {
  const count = points.length / 2;
  let sum = 0;
  for (let i = 0; i < count - 1; i += 1) {
    sum += points[i * 2] * points[(i + 1) * 2 + 1] - points[(i + 1) * 2] * points[i * 2 + 1];
  }
  return sum;
}

/** True when a closed line has enough area to matter at the given output size. */
export function isMeaningfulLoop(points: number[], minAreaNormalized: number): boolean {
  return Math.abs(signedArea(points)) > minAreaNormalized;
}

/** Bounding box of normalized points: [minX, minY, maxX, maxY]. */
export function bbox(points: number[]): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < points.length; i += 2) {
    const x = points[i];
    const y = points[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}
