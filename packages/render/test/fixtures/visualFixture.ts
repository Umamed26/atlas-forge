/**
 * Deterministic visual-regression fixture.
 *
 * The fixture is the ONLY input to the committed visual baselines. It builds a
 * fully populated `WorldLayers` without ever calling `createPipeline`, so
 * terrain/hydrology/climate algorithm upgrades cannot invalidate the visual
 * gate. Content on purpose: a main continent plus archipelagos, a mountain
 * spine, a branching river network, two lakes, towns/labels, latin-only names.
 *
 * Pure functions, fixed seed, no Date/Math.random. Versioned with
 * `VISUAL_FIXTURE_VERSION`; bump it whenever the fixture data changes so the
 * manifest makes the intended baseline update explicit.
 */
import {
  Biome,
  createDefaultDocument,
  DEFAULT_PARAMS,
  DEFAULT_STYLE,
  type MapLabel,
  type Settlement,
  type WorldDocument,
  type WorldLayers,
} from "@atlas/core";
import { createSyntheticWorld } from "../../src/testing";
import { fbm2, hash01 } from "../../src/noise";

export const VISUAL_FIXTURE_VERSION = 1;
export const VISUAL_FIXTURE_ID = "continent-archipelago";
export const VISUAL_FIXTURE_TITLE = "Synthetic Continent";
export const VISUAL_FIXTURE_SEED = 20261018;

export interface VisualFixture {
  id: string;
  version: number;
  title: string;
  document: WorldDocument;
  layers: WorldLayers;
}

const SIZE = 256;

function classifyBiome(height: number, temperature: number, moisture: number, seaLevel: number): Biome {
  const h = height - seaLevel;
  if (h > 0.4) return Biome.SnowPeak;
  if (h > 0.26) return Biome.Mountain;
  if (temperature < 0.2) return Biome.Tundra;
  if (temperature < 0.42) return moisture > 0.55 ? Biome.BorealForest : Biome.Grassland;
  if (temperature < 0.72) return moisture > 0.6 ? Biome.TemperateForest : moisture > 0.3 ? Biome.Grassland : Biome.Shrubland;
  return moisture > 0.58 ? Biome.TropicalForest : moisture > 0.34 ? Biome.Savanna : Biome.Desert;
}

/** Stamp a small organic island into currently-oceanic cells. */
function stampIsland(layers: WorldLayers, cu: number, cv: number, radius: number, seed: number): void {
  const n = layers.size;
  const { height, filled, ocean, lake, river, flow, temperature, moisture, biome } = layers;
  const seaLevel = 0.42;
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const i = y * n + x;
      if (!ocean[i]) continue;
      const u = (x + 0.5) / n;
      const v = (y + 0.5) / n;
      const wobble = (fbm2(u * 18 + 2.1, v * 18 + 5.3, seed, 2) - 0.5) * radius * 0.5;
      const dist = Math.hypot(u - cu, v - cv) + wobble;
      if (dist > radius) continue;
      const falloff = 1 - dist / radius;
      height[i] = Math.min(0.9, seaLevel + 0.018 + falloff * (0.05 + hash01(x, y, seed) * 0.09));
      filled[i] = height[i];
      ocean[i] = 0;
      lake[i] = 0;
      river[i] = 0;
      flow[i] = 0;
      temperature[i] = 0.62 - Math.abs(v - 0.5) * 0.5 - falloff * 0.08;
      moisture[i] = Math.min(1, 0.45 + fbm2(u * 5.3, v * 5.3, seed + 7, 3) * 0.5);
      biome[i] = classifyBiome(height[i], temperature[i], moisture[i], seaLevel);
    }
  }
}

/** Stamp a small inland lake on existing land. */
function stampLake(layers: WorldLayers, cu: number, cv: number, radius: number, seed: number): void {
  const n = layers.size;
  const { height, filled, ocean, lake, river, flow, biome } = layers;
  const seaLevel = 0.42;
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const i = y * n + x;
      if (ocean[i] || lake[i]) continue;
      const u = (x + 0.5) / n;
      const v = (y + 0.5) / n;
      const wobble = (fbm2(u * 22 + 4.7, v * 22 + 1.3, seed, 2) - 0.5) * radius * 0.4;
      const dist = Math.hypot((u - cu) * 1.15, (v - cv) * 0.9) + wobble;
      if (dist > radius) continue;
      lake[i] = 1;
      ocean[i] = 0;
      river[i] = 0;
      flow[i] = 0;
      height[i] = seaLevel - 0.006;
      filled[i] = height[i];
      biome[i] = Biome.Lake;
    }
  }
}

/** Carve a tributary from high ground toward a lake / sea (strictly downhill). */
function carveRiver(
  layers: WorldLayers,
  points: Array<[number, number]>,
  startFlow: number,
  endFlow: number,
): void {
  const n = layers.size;
  const { height, filled, ocean, lake, river, flow, biome, temperature, moisture } = layers;
  const seaLevel = 0.42;
  const cells: number[] = [];
  const steps = points.length;
  for (let s = 0; s < steps; s += 1) {
    const [u, v] = points[s];
    const x = Math.min(n - 1, Math.max(0, Math.round(u * n)));
    const y = Math.min(n - 1, Math.max(0, Math.round(v * n)));
    let last = -1;
    // Interpolate between control points for a continuous thread.
    if (s > 0) {
      const [pu, pv] = points[s - 1];
      const px = Math.min(n - 1, Math.max(0, Math.round(pu * n)));
      const py = Math.min(n - 1, Math.max(0, Math.round(pv * n)));
      const dx = x - px;
      const dy = y - py;
      const stepsBetween = Math.max(1, Math.max(Math.abs(dx), Math.abs(dy)));
      for (let k = 1; k <= stepsBetween; k += 1) {
        const cx = Math.min(n - 1, Math.max(0, px + Math.round((dx * k) / stepsBetween)));
        const cy = Math.min(n - 1, Math.max(0, py + Math.round((dy * k) / stepsBetween)));
        const ci = cy * n + cx;
        if (ci !== last && !ocean[ci] && !lake[ci]) {
          cells.push(ci);
          last = ci;
        }
      }
    }
  }
  const total = cells.length;
  for (let k = 0; k < total; k += 1) {
    const i = cells[k];
    const t = total > 1 ? k / (total - 1) : 0;
    river[i] = 1;
    flow[i] = Math.max(flow[i], startFlow + (endFlow - startFlow) * t * t);
    height[i] = Math.max(seaLevel + 0.008, height[i] * (1 - 0.06 * (1 - t * 0.4)));
    const x = i % n;
    const y = (i / n) | 0;
    temperature[i] = Math.min(1, Math.max(0, 0.66 - Math.abs((y + 0.5) / n - 0.5)));
    moisture[i] = 0.55;
    biome[i] = classifyBiome(height[i], temperature[i], moisture[i], seaLevel);
  }
  // Enforce a strictly downhill filled channel so extractRivers can trace it.
  for (let k = total - 1; k >= 0; k -= 1) {
    const i = cells[k];
    const next = k + 1 < total ? cells[k + 1] : -1;
    if (next >= 0) {
      filled[i] = Math.max(filled[i], filled[next] + 0.0009);
    } else {
      filled[i] = Math.max(height[i], seaLevel + 0.01);
    }
  }
}

/** Strahler order + normalized width hints for the fixture river network. */
function riverOrders(layers: WorldLayers): { order: Uint8Array; width: Float32Array } {
  const n = layers.size;
  const cells = n * n;
  const { river, ocean, lake, filled, flow } = layers;
  const isRiver = (i: number): boolean => river[i] === 1 && !ocean[i] && !lake[i];
  const riverCells: number[] = [];
  for (let i = 0; i < cells; i += 1) if (isRiver(i)) riverCells.push(i);
  const down = new Int32Array(cells).fill(-2);
  const dx = [1, 1, 0, -1, -1, -1, 0, 1];
  const dy = [0, 1, 1, 1, 0, -1, -1, -1];
  for (const i of riverCells) {
    const y = (i / n) | 0;
    const x = i - y * n;
    let best = -1;
    let drop = 0;
    for (let k = 0; k < 8; k += 1) {
      const nx = x + dx[k];
      const ny = y + dy[k];
      if (nx < 0 || ny < 0 || nx >= n || ny >= n) continue;
      const j = ny * n + nx;
      const d = filled[i] - filled[j];
      if (d > drop) {
        drop = d;
        best = j;
      }
    }
    down[i] = best;
  }
  const children: number[][] = Array.from({ length: cells }, () => []);
  for (const i of riverCells) {
    const d = down[i];
    if (d >= 0) children[d].push(i);
  }
  const riverSet = new Uint8Array(cells);
  for (const i of riverCells) riverSet[i] = 1;
  const sorted = riverCells.slice().sort((a, b) => filled[b] - filled[a]);
  const order = new Uint8Array(cells);
  for (const i of sorted) {
    let maxOrder = 0;
    let maxCount = 0;
    for (const child of children[i]) {
      if (!riverSet[child]) continue;
      const o = order[child];
      if (o > maxOrder) {
        maxOrder = o;
        maxCount = 1;
      } else if (o === maxOrder && o > 0) {
        maxCount += 1;
      }
    }
    order[i] = maxOrder === 0 ? 1 : maxCount >= 2 ? maxOrder + 1 : maxOrder;
  }
  let maxFlow = 1e-9;
  for (const i of riverCells) if (flow[i] > maxFlow) maxFlow = flow[i];
  const width = new Float32Array(cells);
  for (const i of riverCells) width[i] = Math.sqrt(Math.max(0.02, flow[i] / maxFlow));
  return { order, width };
}

/** Build the deterministic fixture; cheap enough to run once per process. */
export function createVisualFixture(): VisualFixture {
  const base = createSyntheticWorld({
    size: SIZE,
    seed: VISUAL_FIXTURE_SEED,
    name: VISUAL_FIXTURE_TITLE,
    seaLevel: 0.42,
    preset: "parchment-classic",
  });
  const layers = base.layers;

  // Archipelago around the main continent.
  const islands: Array<[number, number, number, number]> = [
    [0.15, 0.2, 0.042, 101],
    [0.24, 0.33, 0.028, 103],
    [0.8, 0.24, 0.036, 107],
    [0.66, 0.83, 0.04, 109],
    [0.16, 0.62, 0.026, 113],
  ];
  for (const [u, v, r, seed] of islands) stampIsland(layers, u, v, r, seed);

  // Second lake + two tributaries, so the network branches (not a single line).
  stampLake(layers, 0.7, 0.68, 0.028, 211);
  carveRiver(
    layers,
    [
      [0.6, 0.47],
      [0.64, 0.53],
      [0.67, 0.6],
      [0.7, 0.68],
    ],
    3,
    16,
  );
  carveRiver(
    layers,
    [
      [0.52, 0.6],
      [0.5, 0.68],
      [0.48, 0.77],
      [0.47, 0.85],
    ],
    4,
    22,
  );

  const orders = riverOrders(layers);

  const settlements: Settlement[] = [
    ...layers.settlements,
    { id: "s-town-2", name: "Marrow", kind: "town", x: 0.36, y: 0.72, population: 5200 },
    { id: "s-port-2", name: "Highport", kind: "port", x: 0.17, y: 0.22, population: 12000 },
    { id: "s-fort-2", name: "Stonewatch", kind: "fortress", x: 0.68, y: 0.42, population: 2400 },
    { id: "s-ruin-2", name: "Dunmoor", kind: "ruin", x: 0.78, y: 0.58, population: 0 },
  ];
  const autoLabels: MapLabel[] = [
    ...layers.autoLabels,
    { id: "l-water-3", text: "Isles of Dawn", kind: "water", x: 0.14, y: 0.12, size: 0.72 },
    { id: "l-water-4", text: "Lake Vey", kind: "water", x: 0.7, y: 0.68, size: 0.5 },
    { id: "l-region-2", text: "Grey Reach", kind: "region", x: 0.66, y: 0.8, size: 0.9 },
    { id: "l-mtn-2", text: "Stormgate", kind: "mountain", x: 0.72, y: 0.5, size: 0.78, rotation: -0.18 },
    { id: "l-water-5", text: "The Narrow Sea", kind: "water", x: 0.86, y: 0.7, size: 0.68, rotation: -0.6 },
  ];

  let landCells = 0;
  for (let i = 0; i < layers.size * layers.size; i += 1) {
    if (!layers.ocean[i] && !layers.lake[i]) landCells += 1;
  }
  layers.stats = { ...layers.stats, landFraction: landCells / (layers.size * layers.size) };
  layers.settlements = settlements;
  layers.autoLabels = autoLabels;
  layers.riverOrder = orders.order;
  layers.riverWidth = orders.width;

  const document = createDefaultDocument({
    name: VISUAL_FIXTURE_TITLE,
    seed: VISUAL_FIXTURE_SEED,
    params: {
      ...DEFAULT_PARAMS,
      ...base.document.params,
      namingLanguage: "latin",
      gridSize: SIZE,
    },
    style: {
      ...DEFAULT_STYLE,
      ...base.document.style,
      preset: "parchment-classic",
      title: VISUAL_FIXTURE_TITLE,
      labelDensity: 0.9,
      paperTexture: 0.62,
      hillshadeStrength: 0.6,
      coastHatching: 0.7,
    },
    settlements,
    labels: [
      { id: "u-label-1", text: "The Sundered Shore", kind: "custom", x: 0.74, y: 0.78, size: 1 },
      { id: "u-label-2", text: "Aurelian Reach", kind: "custom", x: 0.55, y: 0.3, size: 0.85 },
    ],
  });
  document.createdAt = "2026-01-01T00:00:00.000Z";
  document.updatedAt = document.createdAt;

  return {
    id: VISUAL_FIXTURE_ID,
    version: VISUAL_FIXTURE_VERSION,
    title: VISUAL_FIXTURE_TITLE,
    document,
    layers,
  };
}
