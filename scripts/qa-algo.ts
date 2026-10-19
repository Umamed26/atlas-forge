/**
 * Algorithm quality gate (`pnpm qa:algo`).
 *
 * Runs the generator over many seeds and checks *distributions*, not just that
 * it does not crash: a batch of seeds that all produce one megacontinent, no
 * rivers or 60% lakes is a regression the visual baselines cannot catch.
 *
 *   pnpm qa:algo            # 24 seeds, 512² (fast, CI friendly)
 *   pnpm qa:algo --full     # 120 seeds, 1024²
 *   pnpm qa:algo --json out/qa-algo.json
 *
 * Exits non-zero when any threshold is violated.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createDefaultDocument,
  createPipeline,
  assessWorldMetrics,
  type WorldLayers,
} from "@atlas/core";

interface SeedReport {
  seed: number;
  ms: number;
  landFraction: number;
  components: number;
  largestShare: number;
  coastDimension: number;
  riverCells: number;
  riverSystems: number;
  hangingRivers: number;
  deltas: number;
  lakes: number;
  maxLakeShare: number;
  maxStrahler: number;
  biomeKinds: number;
  altRange: number;
}

const args = process.argv.slice(2);
const FULL = args.includes("--full");
const JSON_FLAG = args.indexOf("--json");
const jsonPath = JSON_FLAG >= 0 ? args[JSON_FLAG + 1] : join("out", "qa-algo.json");
const SEED_COUNT = FULL ? 120 : 24;
const SIZE = FULL ? 1024 : 512;

const NX = [-1, 1, 0, 0, -1, 1, -1, 1];
const NY = [0, 0, -1, 1, -1, -1, 1, 1];

/** 4-neighbour land components + largest share. */
function landComponents(layers: WorldLayers): { components: number; largestShare: number } {
  const size = layers.size;
  const cells = size * size;
  const seen = new Uint8Array(cells);
  let components = 0;
  let land = 0;
  let largest = 0;
  for (let start = 0; start < cells; start += 1) {
    if (layers.ocean[start] || seen[start]) continue;
    components += 1;
    let count = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const cell = stack.pop()!;
      count += 1;
      const x = cell % size;
      const y = (cell / size) | 0;
      if (x > 0 && !seen[cell - 1] && !layers.ocean[cell - 1]) { seen[cell - 1] = 1; stack.push(cell - 1); }
      if (x < size - 1 && !seen[cell + 1] && !layers.ocean[cell + 1]) { seen[cell + 1] = 1; stack.push(cell + 1); }
      if (y > 0 && !seen[cell - size] && !layers.ocean[cell - size]) { seen[cell - size] = 1; stack.push(cell - size); }
      if (y < size - 1 && !seen[cell + size] && !layers.ocean[cell + size]) { seen[cell + size] = 1; stack.push(cell + size); }
    }
    land += count;
    if (count > largest) largest = count;
  }
  return { components, largestShare: land > 0 ? largest / land : 0 };
}

/** Box-counting dimension of the land/ocean boundary (8..32 px boxes). */
function coastDimension(layers: WorldLayers): number {
  const size = layers.size;
  const points: number[] = [];
  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      const i = y * size + x;
      const land = layers.ocean[i] === 0;
      if (land !== (layers.ocean[i - 1] === 0) || land !== (layers.ocean[i + 1] === 0) ||
          land !== (layers.ocean[i - size] === 0) || land !== (layers.ocean[i + size] === 0)) {
        points.push(i);
      }
    }
  }
  if (points.length === 0) return 0;
  // Log-log regression over six box scales (standard box-counting estimator).
  const sizes = [2, 4, 8, 16, 32, 64];
  const xs: number[] = [];
  const ys: number[] = [];
  for (const box of sizes) {
    const set = new Set<string>();
    for (const point of points) {
      const x = point % size;
      const y = (point / size) | 0;
      set.add(`${Math.floor(x / box)}:${Math.floor(y / box)}`);
    }
    if (set.size < 2) continue;
    xs.push(Math.log(1 / box));
    ys.push(Math.log(set.size));
  }
  if (xs.length < 3) return 0;
  const meanX = xs.reduce((a, b) => a + b, 0) / xs.length;
  const meanY = ys.reduce((a, b) => a + b, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i += 1) {
    num += (xs[i] - meanX) * (ys[i] - meanY);
    den += (xs[i] - meanX) ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/** Descend on the filled surface; report whether water/lake is reached. */
function reachesWater(layers: WorldLayers, start: number): boolean {
  const size = layers.size;
  const maxSteps = size * 4 + 16;
  let cell = start;
  for (let step = 0; step < maxSteps; step += 1) {
    if (layers.ocean[cell] || layers.lake[cell]) return true;
    const x = cell % size;
    const y = (cell / size) | 0;
    if (x === 0 || y === 0 || x === size - 1 || y === size - 1) return false;
    const h = layers.filled[cell];
    let best = -1;
    let bestHeight = h;
    for (let k = 0; k < 8; k += 1) {
      const n = (y + NY[k]) * size + (x + NX[k]);
      if (layers.filled[n] < bestHeight) { bestHeight = layers.filled[n]; best = n; }
    }
    if (best < 0) return false;
    cell = best;
  }
  return false;
}

/** River mouths that split into several branches (deltas) and hanging rivers. */
function riverTopology(layers: WorldLayers): { hanging: number; deltas: number; maxOrder: number } {
  const size = layers.size;
  const cells = size * size;
  const river = layers.river;
  let hanging = 0;
  let checked = 0;
  for (let i = 0; i < cells; i += 1) {
    if (!river[i]) continue;
    checked += 1;
    if (!reachesWater(layers, i)) hanging += 1;
  }
  // A mouth cell is a river cell adjacent to ocean/lake; count how many such
  // cells each mouth cluster has (>=3 branches ~ delta).
  let deltas = 0;
  const mouthRiverNeighbours = new Uint8Array(cells);
  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      const i = y * size + x;
      if (layers.ocean[i] || layers.lake[i]) continue;
      if (!river[i]) continue;
      let adjacent = 0;
      for (let k = 0; k < 8; k += 1) {
        const n = (y + NY[k]) * size + (x + NX[k]);
        if (layers.ocean[n] || layers.lake[n]) adjacent += 1;
      }
      if (adjacent >= 2) {
        mouthRiverNeighbours[i] = 1;
        deltas += 1;
      }
    }
  }
  void mouthRiverNeighbours;
  let maxOrder = 0;
  if (layers.riverOrder) {
    for (let i = 0; i < cells; i += 1) {
      if (layers.riverOrder[i] > maxOrder) maxOrder = layers.riverOrder[i];
    }
  }
  return { hanging: checked > 0 ? hanging / checked : 0, deltas, maxOrder };
}

/** Largest connected lake as a share of the map. */
function lakeStats(layers: WorldLayers): { count: number; maxShare: number } {
  const size = layers.size;
  const cells = size * size;
  const seen = new Uint8Array(cells);
  let count = 0;
  let largest = 0;
  for (let start = 0; start < cells; start += 1) {
    if (!layers.lake[start] || seen[start]) continue;
    count += 1;
    let sizeCells = 0;
    const stack = [start];
    seen[start] = 1;
    while (stack.length > 0) {
      const cell = stack.pop()!;
      sizeCells += 1;
      const x = cell % size;
      const y = (cell / size) | 0;
      if (x > 0 && !seen[cell - 1] && layers.lake[cell - 1]) { seen[cell - 1] = 1; stack.push(cell - 1); }
      if (x < size - 1 && !seen[cell + 1] && layers.lake[cell + 1]) { seen[cell + 1] = 1; stack.push(cell + 1); }
      if (y > 0 && !seen[cell - size] && layers.lake[cell - size]) { seen[cell - size] = 1; stack.push(cell - size); }
      if (y < size - 1 && !seen[cell + size] && layers.lake[cell + size]) { seen[cell + size] = 1; stack.push(cell + size); }
    }
    if (sizeCells > largest) largest = sizeCells;
  }
  return { count, maxShare: largest / cells };
}

const pipeline = createPipeline();
// Warm-up: the first generation pays V8 JIT + typed-array allocation, which
// would otherwise show up as a 1.5s "p95" outlier.
pipeline.generate({ document: createDefaultDocument({ seed: 424242, params: { gridSize: SIZE } }), size: SIZE });
const reports: SeedReport[] = [];
const startedAt = performance.now();

for (let index = 0; index < SEED_COUNT; index += 1) {
  const seed = 1000 + index * 7919;
  const document = createDefaultDocument({ seed, params: { gridSize: SIZE } });
  // Cold-run latency: a FRESH pipeline each time (no stage cache) so we measure
  // real generation cost. Two independent runs, keep the faster one so a single
  // GC pause on a shared machine is not reported as a generation regression.
  const runCold = (): { layers: WorldLayers; ms: number } => {
    const perSeedPipeline = createPipeline();
    const started = performance.now();
    const generated = perSeedPipeline.generate({ document, size: SIZE });
    return { layers: generated, ms: performance.now() - started };
  };
  const first = runCold();
  const second = runCold();
  const layers = first.layers;
  const ms = Math.min(first.ms, second.ms);
  const metrics = assessWorldMetrics(layers);
  const components = landComponents(layers);
  const lakes = lakeStats(layers);
  const topology = riverTopology(layers);
  let minH = 1;
  let maxH = 0;
  for (let i = 0; i < layers.height.length; i += 1) {
    if (layers.ocean[i]) continue;
    const h = layers.height[i];
    if (h < minH) minH = h;
    if (h > maxH) maxH = h;
  }
  reports.push({
    seed,
    ms,
    landFraction: metrics.landFraction,
    components: components.components,
    largestShare: components.largestShare,
    coastDimension: coastDimension(layers),
    riverCells: metrics.riverCells,
    riverSystems: metrics.riverCount,
    hangingRivers: topology.hanging,
    deltas: topology.deltas,
    lakes: lakes.count,
    maxLakeShare: lakes.maxShare,
    maxStrahler: topology.maxOrder,
    biomeKinds: metrics.biomeKinds,
    altRange: maxH - minH,
  });
  if ((index + 1) % 6 === 0 || index === SEED_COUNT - 1) {
    console.log(`  … ${index + 1}/${SEED_COUNT} seeds`);
  }
}

function percentile(values: number[], p: number): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
  return sorted[index];
}

const land = reports.map((r) => r.landFraction);
const timings = reports.map((r) => r.ms);
const hanging = Math.max(...reports.map((r) => r.hangingRivers));
const minCoast = Math.min(...reports.map((r) => r.coastDimension));
const maxLake = Math.max(...reports.map((r) => r.maxLakeShare));
const minBiomes = Math.min(...reports.map((r) => r.biomeKinds));
const minStrahler = Math.min(...reports.map((r) => r.maxStrahler));
const minAltRange = Math.min(...reports.map((r) => r.altRange));
const p95 = percentile(timings, 0.95);
const slowBudget = SIZE >= 1024 ? 2000 : 900;

const checks: { name: string; ok: boolean; detail: string }[] = [
  {
    name: "land fraction distribution",
    ok: percentile(land, 0.1) >= 0.18 && percentile(land, 0.9) <= 0.78,
    detail: `p10=${(percentile(land, 0.1) * 100).toFixed(1)}% p50=${(percentile(land, 0.5) * 100).toFixed(1)}% p90=${(percentile(land, 0.9) * 100).toFixed(1)}%`,
  },
  {
    name: "every seed has land and water",
    ok: land.every((value) => value > 0.02 && value < 0.98),
    detail: `min=${(Math.min(...land) * 100).toFixed(1)}% max=${(Math.max(...land) * 100).toFixed(1)}%`,
  },
  {
    name: "coastline is fractal (box dimension)",
    // A smooth/polygonal coast measures ~1.00. v0.6 targets real-world coastal
    // roughness (domain-warped multi-octave detail after erosion).
    ok: minCoast >= 1.12 && percentile(reports.map((r) => r.coastDimension), 0.5) >= 1.18,
    detail: `min=${minCoast.toFixed(2)} p50=${percentile(reports.map((r) => r.coastDimension), 0.5).toFixed(2)}`,
  },
  {
    name: "rivers never hang (terminal at sea/lake)",
    ok: hanging < 0.01,
    detail: `worst hanging rate=${(hanging * 100).toFixed(2)}% (limit 1%)`,
  },
  {
    name: "river topology has Strahler depth",
    ok: minStrahler >= 3,
    detail: `min max-order=${minStrahler}`,
  },
  {
    name: "lakes stay plausible in size",
    ok: maxLake <= 0.02,
    detail: `largest lake=${(maxLake * 100).toFixed(2)}% of map (limit 2%)`,
  },
  {
    name: "biome diversity",
    ok: minBiomes >= 6,
    detail: `min kinds=${minBiomes}`,
  },
  {
    name: "relief range",
    // Land height span (max-min). Erosion on flat seeds can land near 0.22;
    // anything below this reads as a pancake world.
    ok: minAltRange >= 0.20,
    detail: `min alt range=${minAltRange.toFixed(2)}`,
  },
  {
    name: `generation latency p95 @${SIZE}²`,
    ok: p95 <= slowBudget,
    detail: `p50=${Math.round(percentile(timings, 0.5))}ms p95=${Math.round(p95)}ms (budget ${slowBudget}ms)`,
  },
];

const failed = checks.filter((check) => !check.ok);
console.log(`\n[qa:algo] ${SEED_COUNT} seeds @ ${SIZE}² in ${((performance.now() - startedAt) / 1000).toFixed(1)}s`);
for (const check of checks) {
  console.log(`  ${check.ok ? "✓" : "✗"} ${check.name} — ${check.detail}`);
}

mkdirSync(dirname(jsonPath), { recursive: true });
writeFileSync(
  jsonPath,
  JSON.stringify(
    {
      when: new Date().toISOString(),
      size: SIZE,
      seeds: SEED_COUNT,
      checks,
      summary: {
        landP50: percentile(land, 0.5),
        coastDimP50: percentile(reports.map((r) => r.coastDimension), 0.5),
        timingP50: percentile(timings, 0.5),
        timingP95: p95,
      },
      reports,
    },
    null,
    2,
  ),
);
console.log(`[qa:algo] report written to ${jsonPath}`);
if (failed.length > 0) {
  console.error(`[qa:algo] FAIL: ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`[qa:algo] PASS: ${checks.length}/${checks.length} checks`);
