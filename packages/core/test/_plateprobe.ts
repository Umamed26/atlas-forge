import { createDefaultDocument, createPipeline } from "../src/index";
for (const size of [512, 1024]) {
  const seed = 20261018;
  const doc = createDefaultDocument({ seed, params: { gridSize: size } });
  const t0 = performance.now();
  const layers = createPipeline().generate({ document: doc, size });
  const wall = performance.now() - t0;
  const n = size * size, sl = doc.params.seaLevel, span = 1 - sl;
  // plate boundary distance BFS
  const plates = layers.plates!;
  const boundary = new Uint8Array(n);
  const NX = [-1, 1, 0, 0, -1, 1, -1, 1], NY = [0, 0, -1, 1, -1, -1, 1, 1];
  let boundaryCells = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x; const pid = plates.id[i];
    let isBoundary = false;
    for (let k = 0; k < 8; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      if (plates.id[ny * size + nx] !== pid) { isBoundary = true; break; }
    }
    if (isBoundary) { boundary[i] = 1; boundaryCells++; }
  }
  const dist = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) if (boundary[i]) { dist[i] = 0; queue[tail++] = i; }
  while (head < tail) {
    const c = queue[head++]; const x = c % size, y = (c / size) | 0;
    for (let k = 0; k < 8; k++) {
      const nx = x + NX[k], ny = y + NY[k];
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const j = ny * size + nx;
      if (dist[j] === -1) { dist[j] = dist[c] + 1; queue[tail++] = j; }
    }
  }
  let high = 0, highNear = 0, highFar = 0;
  const highThreshold = sl + 0.5 * span;
  for (let i = 0; i < n; i++) {
    if (layers.ocean[i] || layers.lake[i]) continue;
    if (layers.height[i] < highThreshold) continue;
    high++;
    if (dist[i] <= size * 0.08) highNear++; else highFar++;
  }
  let orderMax = 0, riverCells = 0, widthSum = 0;
  for (let i = 0; i < n; i++) {
    if (layers.river[i]) { riverCells++; widthSum += layers.riverWidth![i]; if (layers.riverOrder![i] > orderMax) orderMax = layers.riverOrder![i]; }
  }
  console.log(JSON.stringify({
    size, wall: Math.round(wall), total: Math.round(layers.stats.totalMs),
    stages: { t: Math.round(layers.stats.terrainMs), h: Math.round(layers.stats.hydrologyMs), c: Math.round(layers.stats.climateMs), b: Math.round(layers.stats.biomeMs), u: Math.round(layers.stats.humanMs) },
    land: +layers.stats.landFraction.toFixed(3),
    plateCount: plates.count, boundaryCells,
    highCells: high, highNearPct: high ? +(100 * highNear / high).toFixed(1) : 0, highFar,
    riverCells, orderMax, avgWidth: riverCells ? +(widthSum / riverCells).toFixed(3) : 0,
    settlements: layers.settlements.length, labels: layers.autoLabels.length,
  }));
}
