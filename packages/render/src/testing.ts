/**
 * Synthetic world fixture used by renderer tests and visual QA.
 *
 * It builds a small, fully-populated `WorldLayers` (continent + inland lake +
 * mountain chain + river that reaches a bay + settlements + labels) without
 * touching the real generator, so renderer correctness/robustness can be
 * verified independently of the pipeline implementation.
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
import { fbm2, hash01, smoothstep } from "./noise";

export interface SyntheticWorldOptions {
  size?: number;
  seed?: number;
  name?: string;
  seaLevel?: number;
  preset?: "parchment-classic" | "aged-ink";
}

export interface SyntheticWorld {
  document: WorldDocument;
  layers: WorldLayers;
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby || 1)));
  const cx = ax + abx * t;
  const cy = ay + aby * t;
  return Math.hypot(px - cx, py - cy);
}

/** Build a deterministic synthetic world for render tests / visual QA. */
export function createSyntheticWorld(options: SyntheticWorldOptions = {}): SyntheticWorld {
  const size = Math.max(8, Math.floor(options.size ?? 96));
  const seed = (options.seed ?? 424242) | 0;
  const seaLevel = options.seaLevel ?? 0.42;
  const cells = size * size;
  const height = new Float32Array(cells);
  const filled = new Float32Array(cells);
  const ocean = new Uint8Array(cells);
  const lake = new Uint8Array(cells);
  const river = new Uint8Array(cells);
  const flow = new Float32Array(cells);
  const temperature = new Float32Array(cells);
  const moisture = new Float32Array(cells);
  const biome = new Uint8Array(cells);

  // A curved mountain spine across the continent.
  const spine: Array<[number, number]> = [
    [0.24, 0.6],
    [0.4, 0.66],
    [0.56, 0.6],
    [0.7, 0.47],
    [0.8, 0.34],
  ];
  const spineDistance = (u: number, v: number): number => {
    let best = Infinity;
    for (let i = 0; i < spine.length - 1; i += 1) {
      const d = distanceToSegment(u, v, spine[i][0], spine[i][1], spine[i + 1][0], spine[i + 1][1]);
      if (d < best) best = d;
    }
    return best;
  };

  const cx = 0.47;
  const cy = 0.48;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      // Organic continent outline.
      const warp = (fbm2(u * 3.2 + 4.7, v * 3.2 + 9.3, seed + 13, 3) - 0.5) * 0.3;
      const dx = (u - cx) * 2 + warp;
      const dy = (v - cy) * 2 - warp * 0.5;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const coast = 1 - smoothstep(0.56, 1.04, dist);
      // Ridge along the spine, modulated with ridged noise.
      const sd = spineDistance(u, v);
      const ridgeNoise = 1 - Math.abs(fbm2(u * 9.2 + 3.1, v * 9.2 + 7.7, seed + 61, 4) * 2 - 1);
      const ridge = Math.exp(-((sd / 0.058) ** 2)) * (0.26 + 0.26 * ridgeNoise) * coast;
      // A handful of summits.
      let peaks = 0;
      const peakSpots: Array<[number, number, number]> = [
        [0.33, 0.62, 0.11],
        [0.46, 0.64, 0.14],
        [0.6, 0.57, 0.12],
        [0.72, 0.44, 0.13],
        [0.78, 0.35, 0.09],
      ];
      for (const [pu, pv, pr] of peakSpots) {
        peaks += Math.exp(-(((u - pu) ** 2 + (v - pv) ** 2) / (pr * pr))) * 0.13 * coast;
      }
      const rough = (fbm2(u * 16.5, v * 16.5, seed + 71, 3) - 0.5) * 0.09 * coast;
      let h = Math.max(0, Math.min(1, coast * 0.3 + ridge + peaks + rough - 0.02));
      // North-east bay so the main river can reach the sea.
      const bay = smoothstep(0.62, 1.0, u + (1 - v) * 0.12);
      h = Math.min(h, h * (1 - bay * 0.9));
      height[i] = h;
      const lat = Math.abs(v - 0.5) * 2;
      temperature[i] = Math.min(1, Math.max(0, 1 - lat * 0.85 - h * 0.5));
      moisture[i] = Math.min(
        1,
        Math.max(0.05, fbm2(u * 4.1 + 2.3, v * 4.1 + 8.1, seed + 33, 3) * 0.9 - h * 0.2 + 0.15),
      );
    }
  }
  // Inland lake.
  const lakeU = 0.33;
  const lakeV = 0.52;
  const lakeR = 0.062;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = y * size + x;
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const wobble = (fbm2(u * 12 + 3, v * 12 + 7, seed + 17, 2) - 0.5) * 0.024;
      const d = Math.hypot(u - lakeU, v - lakeV) + wobble;
      if (d < lakeR && height[i] > seaLevel + 0.02) {
        lake[i] = 1;
        height[i] = Math.max(0.05, seaLevel - 0.01);
      }
    }
  }
  // Main river: from the high spine down to the north-east bay.
  const riverPoints: Array<[number, number]> = [];
  const steps = Math.max(16, Math.round(size * 0.5));
  for (let s = 0; s <= steps; s += 1) {
    const t = s / steps;
    const u = 0.5 + t * 0.42 + Math.sin(t * 5.4 + 0.6) * 0.035;
    const v = 0.63 - t * 0.32 + Math.cos(t * 4.4 + 1.1) * 0.045;
    riverPoints.push([u, v]);
  }
  for (let s = 0; s < riverPoints.length; s += 1) {
    const [u, v] = riverPoints[s];
    const x = Math.min(size - 1, Math.max(0, Math.round(u * size)));
    const y = Math.min(size - 1, Math.max(0, Math.round(v * size)));
    const i = y * size + x;
    if (ocean[i] || lake[i]) continue;
    const t = s / (riverPoints.length - 1);
    river[i] = 1;
    flow[i] = 5 + t * t * 120;
    // Carve a shallow valley and flatten the channel.
    height[i] = Math.max(seaLevel + 0.015, height[i] * (1 - 0.12 * (1 - t * 0.5)));
  }
  // Tributary from the lake outlet.
  for (let s = 0; s < 14; s += 1) {
    const t = s / 13;
    const u = lakeU + 0.02 + t * 0.1;
    const v = lakeV + 0.005 + t * 0.02;
    const x = Math.min(size - 1, Math.max(0, Math.round(u * size)));
    const y = Math.min(size - 1, Math.max(0, Math.round(v * size)));
    const i = y * size + x;
    if (ocean[i]) continue;
    river[i] = 1;
    flow[i] = 4 + t * 18;
  }
  // Water masks + filled field.
  let landCells = 0;
  for (let i = 0; i < cells; i += 1) {
    if (height[i] < seaLevel && !lake[i]) ocean[i] = 1;
    if (ocean[i] || lake[i]) {
      filled[i] = height[i];
      // Rivers only exist on land.
      river[i] = 0;
      flow[i] = 0;
    } else {
      filled[i] = height[i];
      landCells += 1;
    }
  }
  // Make the river flow strictly downhill on the filled field.
  for (let y = 1; y < size - 1; y += 1) {
    for (let x = 1; x < size - 1; x += 1) {
      const i = y * size + x;
      if (!river[i]) continue;
      let lowest = filled[i];
      for (let k = 0; k < 8; k += 1) {
        const nx = x + [1, 1, 0, -1, -1, -1, 0, 1][k];
        const ny = y + [0, 1, 1, 1, 0, -1, -1, -1][k];
        const j = ny * size + nx;
        if (filled[j] < lowest) lowest = filled[j];
      }
      filled[i] = Math.min(filled[i], lowest + 0.0005);
    }
  }
  // Biome classification (simple but plausible banding).
  for (let i = 0; i < cells; i += 1) {
    if (ocean[i]) {
      biome[i] = Biome.Ocean;
      continue;
    }
    if (lake[i]) {
      biome[i] = Biome.Lake;
      continue;
    }
    const t = temperature[i];
    const m = moisture[i];
    const h = height[i] - seaLevel;
    if (h > 0.4) biome[i] = Biome.SnowPeak;
    else if (h > 0.26) biome[i] = Biome.Mountain;
    else if (t < 0.2) biome[i] = Biome.Tundra;
    else if (t < 0.42) biome[i] = m > 0.55 ? Biome.BorealForest : Biome.Grassland;
    else if (t < 0.72) biome[i] = m > 0.6 ? Biome.TemperateForest : m > 0.3 ? Biome.Grassland : Biome.Shrubland;
    else biome[i] = m > 0.58 ? Biome.TropicalForest : m > 0.34 ? Biome.Savanna : Biome.Desert;
  }

  const settlements: Settlement[] = [
    { id: "s-city-1", name: "Aurelian", kind: "city", x: 0.57, y: 0.35, population: 34000 },
    { id: "s-town-1", name: "Brackwater", kind: "town", x: 0.46, y: 0.47, population: 8000 },
    { id: "s-port-1", name: "Greyhaven", kind: "port", x: 0.73, y: 0.29, population: 21000 },
    { id: "s-fort-1", name: "Castle Vane", kind: "fortress", x: 0.3, y: 0.38, population: 2000 },
    { id: "s-ruin-1", name: "Old Run", kind: "ruin", x: 0.44, y: 0.7, population: 0 },
  ];
  const autoLabels: MapLabel[] = [
    { id: "l-region-1", text: "Aetheris", kind: "region", x: 0.45, y: 0.22, size: 1.1 },
    { id: "l-mtn-1", text: "The Cinder Peaks", kind: "mountain", x: 0.56, y: 0.61, size: 0.9, rotation: -0.22 },
    { id: "l-water-1", text: "Sea of Glass", kind: "water", x: 0.16, y: 0.78, size: 1.05 },
    { id: "l-water-2", text: "Mirrormere", kind: "water", x: lakeU, y: lakeV + 0.005, size: 0.55 },
  ];

  const document = createDefaultDocument({
    name: options.name ?? "Aetheris",
    seed,
    params: { ...DEFAULT_PARAMS, seaLevel, gridSize: size },
    style: {
      ...DEFAULT_STYLE,
      preset: options.preset ?? "parchment-classic",
      title: options.name ?? "Aetheris",
      labelDensity: 0.8,
      paperTexture: 0.6,
      hillshadeStrength: 0.62,
      coastHatching: 0.68,
    },
    settlements,
    labels: [
      { id: "u-label-1", text: "The Sundered Shore", kind: "custom", x: 0.74, y: 0.78, size: 1 },
    ],
  });
  document.createdAt = "2026-10-18T00:00:00.000Z";

  const layers: WorldLayers = {
    size,
    seed,
    height,
    filled,
    ocean,
    lake,
    river,
    flow,
    temperature,
    moisture,
    biome,
    settlements,
    autoLabels,
    stats: {
      terrainMs: 0,
      hydrologyMs: 0,
      climateMs: 0,
      biomeMs: 0,
      humanMs: 0,
      totalMs: 0,
      landFraction: landCells / cells,
    },
  };
  return { document, layers };
}

/** Convenience wrapper for tests: a synthetic world at the requested grid size. */
export function defaultDocumentForRenderTests(size = 64): SyntheticWorld {
  return createSyntheticWorld({ size, seed: 777 });
}

export { hash01 };
