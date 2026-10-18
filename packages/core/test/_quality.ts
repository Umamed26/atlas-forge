import { createDefaultDocument, createPipeline } from "../src/index";

const NX = [-1, 1, 0, 0, -1, 1, -1, 1], NY = [0, 0, -1, 1, -1, -1, 1, 1];

function coastMask(layers: any): Uint8Array {
  const size = layers.size, ocean = layers.ocean, n = size * size;
  const mask = new Uint8Array(n);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    if (ocean[i]) continue;
    for (let k = 0; k < 8; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      if (ocean[ny * size + nx]) { mask[i] = 1; break; }
    }
  }
  return mask;
}
function boxCount(mask: Uint8Array, size: number, box: number): number {
  const bx = Math.ceil(size / box), by = Math.ceil(size / box);
  const seen = new Uint8Array(bx * by);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (mask[y * size + x]) seen[Math.floor(y / box) * bx + Math.floor(x / box)] = 1;
  }
  let count = 0; for (let i = 0; i < seen.length; i++) count += seen[i];
  return count;
}
function fractalDim(mask: Uint8Array, size: number): number {
  const n8 = boxCount(mask, size, 8), n32 = boxCount(mask, size, 32);
  if (n8 <= 0 || n32 <= 0) return 0;
  return Math.log(n8 / n32) / Math.log(4);
}
const COAST_DIRS: [number, number][] = [[1,0],[-1,0],[0,1],[0,-1],[1,1],[1,-1],[-1,1],[-1,-1]];
function straightCoastFraction(mask: Uint8Array, size: number): number {
  const coast: number[] = [];
  for (let i = 0; i < mask.length; i++) if (mask[i]) coast.push(i);
  if (coast.length === 0) return 0;
  const coastSet = new Set(coast);
  let windows = 0, straight = 0;
  const step = Math.max(1, Math.floor(coast.length / 400));
  for (let s = 0; s < coast.length; s += step) {
    let cx = coast[s] % size, cy = (coast[s] / size) | 0;
    let dirX = 0, dirY = 0;
    let startDirX = 0, startDirY = 0;
    let ok = false;
    for (let k = 0; k < 24; k++) {
      let bestX = 0, bestY = 0, bestScore = -2;
      for (const [dx, dy] of COAST_DIRS) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        if (!coastSet.has(ny * size + nx)) continue;
        const len = Math.hypot(dx, dy);
        const normX = dx / len, normY = dy / len;
        const score = dirX * normX + dirY * normY;
        if (score > bestScore) { bestScore = score; bestX = nx; bestY = ny; }
      }
      if (bestX === 0 && bestY === 0) break;
      const ndx = bestX - cx, ndy = bestY - cy;
      const len = Math.hypot(ndx, ndy);
      dirX = ndx / len; dirY = ndy / len;
      if (k === 0) { startDirX = dirX; startDirY = dirY; }
      cx = bestX; cy = bestY; ok = true;
    }
    if (!ok) continue;
    windows++;
    const dot = Math.min(1, Math.max(-1, startDirX * dirX + startDirY * dirY));
    const turn = Math.acos(dot) * 180 / Math.PI;
    if (turn < 2) straight++;
  }
  return windows > 0 ? straight / windows : 0;
}
function landSlopeFraction(layers: any): { snowLand: number; highlandSteep: number } {
  const size = layers.size, sl = layers.seaLevel ?? 0.42;
  const ocean = layers.ocean, height = layers.height, biome = layers.biome;
  let land = 0, snow = 0, high = 0, highSteep = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    if (ocean[i]) continue;
    land++;
    if (biome[i] === 14) snow++;
    const alt = height[i];
    if (alt < 0.25) continue;
    high++;
    const left = x > 0 ? height[i - 1] : height[i];
    const right = x < size - 1 ? height[i + 1] : height[i];
    const up = y > 0 ? height[i - size] : height[i];
    const down = y < size - 1 ? height[i + size] : height[i];
    const slope = Math.sqrt(((right - left) * 0.5) ** 2 + ((down - up) * 0.5) ** 2);
    if (slope > 0.02) highSteep++;
  }
  return { snowLand: land ? snow / land : 0, highlandSteep: high ? highSteep / high : 0 };
}
function stripeRatio(layers: any): number {
  const size = layers.size, m = layers.moisture;
  let vert = 0, vn = 0, hor = 0, hn = 0;
  for (let y = 1; y < size; y++) for (let x = 1; x < size; x++) {
    const i = y * size + x;
    if (layers.ocean[i]) continue;
    vert += Math.abs(m[i] - m[i - size]); vn++;
    hor += Math.abs(m[i] - m[i - 1]); hn++;
  }
  return hor > 0 ? vert / hor : 1;
}
function ridgeVariance(layers: any): number {
  const size = layers.size, biome = layers.biome;
  const mask = new Uint8Array(size * size), seen = new Uint8Array(size * size), q = new Int32Array(size * size);
  for (let i = 0; i < mask.length; i++) if (biome[i] === 13 || biome[i] === 14) mask[i] = 1;
  const sizes: number[] = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    let head = 0, tail = 0, count = 0;
    q[tail++] = start; seen[start] = 1;
    while (head < tail) {
      const c = q[head++]; count++;
      const x = c % size, y = (c / size) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + NX[k], ny = y + NY[k];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const j = ny * size + nx;
        if (mask[j] && !seen[j]) { seen[j] = 1; q[tail++] = j; }
      }
    }
    sizes.push(count);
  }
  if (sizes.length < 2) return 0;
  const mean = sizes.reduce((a, b) => a + b, 0) / sizes.length;
  return Math.sqrt(sizes.reduce((a, b) => a + (b - mean) ** 2, 0) / sizes.length);
}
function plateBoundaryShare(layers: any): number {
  const size = layers.size, plates = layers.plates;
  if (!plates) return 0;
  const n = size * size, sl = 0.42, span = 0.58;
  const boundary = new Uint8Array(n);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x, pid = plates.id[i];
    for (let k = 0; k < 8; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      if (plates.id[ny * size + nx] !== pid) { boundary[i] = 1; break; }
    }
  }
  const dist = new Int32Array(n).fill(-1), q = new Int32Array(n);
  let h = 0, t = 0;
  for (let i = 0; i < n; i++) if (boundary[i]) { dist[i] = 0; q[t++] = i; }
  while (h < t) {
    const c = q[h++]; const x = c % size, y = (c / size) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const j = ny * size + nx;
      if (dist[j] === -1) { dist[j] = dist[c] + 1; q[t++] = j; }
    }
  }
  let high = 0, near = 0;
  for (let i = 0; i < n; i++) {
    if (layers.ocean[i] || layers.lake[i]) continue;
    if (layers.height[i] < 0.42 + 0.5 * span) continue;
    high++;
    if (dist[i] <= size * 0.08) near++;
  }
  return high ? near / high : 0;
}

const size = Number(process.argv[2] ?? 1024);
for (const seed of [20261018, 101, 202, 303]) {
  const wall0 = performance.now();
  const layers = createPipeline().generate({ document: createDefaultDocument({ seed, params: { gridSize: size } }), size });
  const wall = performance.now() - wall0;
  const mask = coastMask(layers);
  const { snowLand, highlandSteep } = landSlopeFraction(layers);
  console.log(seed, JSON.stringify({
    wall: Math.round(wall), land: +layers.stats.landFraction.toFixed(3),
    fractal: +fractalDim(mask, size).toFixed(3),
    straight: +(100 * straightCoastFraction(mask, size)).toFixed(1),
    snowLandPct: +(100 * snowLand).toFixed(1),
    highlandSteepPct: +(100 * highlandSteep).toFixed(1),
    ridgeStd: Math.round(ridgeVariance(layers)),
    plateHighNear: +(100 * plateBoundaryShare(layers)).toFixed(1),
    stripe: +stripeRatio(layers).toFixed(2),
    biomeKinds: new Set(Array.from(layers.biome)).size,
  }));
}
