import { describe, expect, it } from "vitest";
import { createDefaultDocument, createPipeline, normalizeWorldDocument } from "../src/index";
import type { WorldDocument, WorldLayers, WorldParams } from "../src/types";

const SIZE = 192;
const SEED = 20261018;

// ── Hashing helpers (baseline was recorded with the v0.3.0 implementation) ──
function fnvUpdate(h: number, byte: number): number {
  return Math.imul(h ^ byte, 16777619) >>> 0;
}
function hashBytes(array: Float32Array | Uint8Array): string {
  let h = 2166136261 >>> 0;
  const bytes =
    array instanceof Uint8Array
      ? array
      : new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  for (let i = 0; i < bytes.length; i += 1) h = fnvUpdate(h, bytes[i]);
  return h.toString(16).padStart(8, "0");
}
function hashString(text: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h = fnvUpdate(h, text.charCodeAt(i) & 0xff);
    h = fnvUpdate(h, text.charCodeAt(i) >>> 8);
  }
  return h.toString(16).padStart(8, "0");
}
function snapshot(layers: WorldLayers) {
  return {
    height: hashBytes(layers.height),
    filled: hashBytes(layers.filled),
    ocean: hashBytes(layers.ocean),
    lake: hashBytes(layers.lake),
    river: hashBytes(layers.river),
    flow: hashBytes(layers.flow),
    temperature: hashBytes(layers.temperature),
    moisture: hashBytes(layers.moisture),
    biome: hashBytes(layers.biome),
    settlements: hashString(JSON.stringify(layers.settlements)),
    autoLabels: hashString(JSON.stringify(layers.autoLabels)),
    hidden: hashString(JSON.stringify(layers.hidden ?? { settlements: [], labels: [] })),
    landFraction: layers.stats.landFraction,
  };
}

/** Recorded from the v0.3.0 release (HEAD d1e254b) before adding stageSeeds. */
const V030_BASELINE: Record<string, ReturnType<typeof snapshot>> = {
  A: {
    height: "a59a3952",
    filled: "8e461388",
    ocean: "d0e2aa61",
    lake: "24cc1549",
    river: "8688d732",
    flow: "778fe080",
    temperature: "ca8dd41a",
    moisture: "15c98079",
    biome: "834b866a",
    settlements: "df482252",
    autoLabels: "860c96fd",
    hidden: "2e772204",
    landFraction: 0.405364990234375,
  },
  B: {
    height: "f23c96cd",
    filled: "c4e0c0f3",
    ocean: "64308986",
    lake: "30f98023",
    river: "238d2400",
    flow: "1302848b",
    temperature: "8d3a1338",
    moisture: "00161159",
    biome: "ac871a15",
    settlements: "cc54f029",
    autoLabels: "717231f5",
    hidden: "2e772204",
    landFraction: 0.5909559461805556,
  },
  C: {
    height: "7a2c47d6",
    filled: "9fbd7b8b",
    ocean: "08cd6652",
    lake: "f2d19dc5",
    river: "172210fa",
    flow: "5c10360e",
    temperature: "3e8a03fc",
    moisture: "4d53330e",
    biome: "79023a99",
    settlements: "b0d9acd6",
    autoLabels: "c1456aa1",
    hidden: "2e772204",
    landFraction: 0.0829196506076389,
  },
};

function baselineDocuments(): { name: string; doc: WorldDocument; size: number }[] {
  return [
    {
      name: "A",
      doc: createDefaultDocument({ name: "Aetheris", seed: 20261018, params: { gridSize: 256 } }),
      size: 256,
    },
    {
      name: "B",
      doc: createDefaultDocument({
        name: "Legacy Overrides",
        seed: 101,
        params: { gridSize: 192, namingLanguage: "latin", seaLevel: 0.3, erosionIterations: 0 },
        overrides: {
          elevation: [{ x: 0.5, y: 0.5, radius: 0.1, value: 0.9, mode: "lock" }],
          riverForce: [{ id: "r1", width: 0.012, points: [[0.2, 0.2], [0.5, 0.5], [0.8, 0.6]] }],
          biome: [{ x: 0.3, y: 0.3, radius: 0.05, biome: 9 }],
          hiddenIds: ["sea-1-2"],
        },
        settlements: [
          { id: "user-s-1", name: "测试港", kind: "custom", x: 0.4, y: 0.5, pinned: true },
        ],
        labels: [
          { id: "user-l-1", text: "测试地名", kind: "custom", x: 0.6, y: 0.4, pinned: true },
        ],
      }),
      size: 192,
    },
    {
      name: "C",
      doc: createDefaultDocument({
        seed: 777,
        params: { gridSize: 384, seaLevel: 0.6, continentScale: 1.7 },
      }),
      size: 384,
    },
  ];
}

function doc(stageSeeds?: WorldParams["stageSeeds"], seed = SEED): WorldDocument {
  return createDefaultDocument({
    name: "Stage Seeds",
    seed,
    params: { gridSize: SIZE, ...(stageSeeds ? { stageSeeds } : {}) },
  });
}

function generate(document: WorldDocument, pipeline = createPipeline()): WorldLayers {
  return pipeline.generate({ document, size: SIZE });
}

function sameBytes(a: Float32Array | Uint8Array, b: Float32Array | Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

describe("stage seeds: backward compatibility", () => {
  it("produces byte-identical output to v0.3.0 when stageSeeds is absent", () => {
    const pipeline = createPipeline();
    for (const { name, doc: document, size } of baselineDocuments()) {
      const layers = pipeline.generate({ document, size });
      expect(snapshot(layers), `case ${name}`).toEqual(V030_BASELINE[name]);
    }
  });

  it("treats an empty stageSeeds object exactly like an absent field", () => {
    const absent = generate(doc());
    const empty = generate(doc({}));
    expect(snapshot(empty)).toEqual(snapshot(absent));
  });
});

describe("stage seeds: per-stage isolation", () => {
  it("re-rolling hydrologySeed keeps terrain/coast identical and changes rivers/flow", () => {
    const base = generate(doc());
    const rerolled = generate(doc({ hydrology: SEED + 991 }));
    expect(sameBytes(base.height, rerolled.height)).toBe(true);
    expect(sameBytes(base.ocean, rerolled.ocean)).toBe(true);
    expect(sameBytes(base.lake, rerolled.lake)).toBe(true);
    expect(sameBytes(base.temperature, rerolled.temperature)).toBe(true);
    expect(sameBytes(base.biome, rerolled.biome)).toBe(true);
    expect(sameBytes(base.river, rerolled.river)).toBe(false);
    expect(sameBytes(base.flow, rerolled.flow)).toBe(false);
  });

  it("re-rolling humanSeed only changes settlements/labels (naming + siting)", () => {
    const base = generate(doc());
    const rerolled = generate(doc({ human: SEED + 991 }));
    for (const layer of ["height", "filled", "ocean", "lake", "river", "flow", "temperature", "moisture", "biome"] as const) {
      expect(sameBytes(base[layer], rerolled[layer]), layer).toBe(true);
    }
    expect(JSON.stringify(rerolled.settlements)).not.toBe(JSON.stringify(base.settlements));
    expect(JSON.stringify(rerolled.autoLabels)).not.toBe(JSON.stringify(base.autoLabels));
    expect(rerolled.settlements.length).toBeGreaterThan(0);
    expect(rerolled.autoLabels.length).toBeGreaterThan(0);
  });

  it("re-rolling climateSeed keeps terrain/hydrology identical and changes climate/biome", () => {
    const base = generate(doc());
    const rerolled = generate(doc({ climate: SEED + 991 }));
    for (const layer of ["height", "filled", "ocean", "lake", "river", "flow"] as const) {
      expect(sameBytes(base[layer], rerolled[layer]), layer).toBe(true);
    }
    expect(sameBytes(base.temperature, rerolled.temperature)).toBe(false);
    expect(sameBytes(base.moisture, rerolled.moisture)).toBe(false);
    expect(sameBytes(base.biome, rerolled.biome)).toBe(false);
  });

  it("re-rolling terrainSeed changes the whole world", () => {
    const base = generate(doc());
    const rerolled = generate(doc({ terrain: SEED + 991 }));
    expect(sameBytes(base.height, rerolled.height)).toBe(false);
    expect(sameBytes(base.ocean, rerolled.ocean)).toBe(false);
    expect(sameBytes(base.river, rerolled.river)).toBe(false);
  });

  it("is deterministic for identical stageSeeds", () => {
    const stageSeeds = { terrain: 11, hydrology: 22, climate: 33, human: 44 };
    const first = generate(doc(stageSeeds));
    const second = generate(doc(stageSeeds));
    expect(snapshot(second)).toEqual(snapshot(first));
    expect(second.settlements).toEqual(first.settlements);
    expect(second.autoLabels).toEqual(first.autoLabels);
  });
});

describe("stage seeds: document round-trip", () => {
  it("preserves valid stageSeeds through normalizeWorldDocument and cleans invalid ones", () => {
    const stageSeeds = { terrain: 11, hydrology: 22, climate: 33, human: 44 };
    const document = createDefaultDocument({
      seed: SEED,
      params: { gridSize: 256, stageSeeds },
    });
    const normalized = normalizeWorldDocument(document);
    expect(normalized.issues).toEqual([]);
    expect(normalized.document.params.stageSeeds).toEqual(stageSeeds);
    // Preserved seeds keep producing the same world after the JSON round-trip.
    const fromNormalized = generate(normalized.document);
    expect(snapshot(fromNormalized)).toEqual(snapshot(generate(document)));

    const dirty = JSON.parse(JSON.stringify(document)) as {
      params: { stageSeeds: Record<string, unknown> };
    };
    dirty.params.stageSeeds.hydrology = "not-a-number";
    dirty.params.stageSeeds.climate = 1.5;
    dirty.params.stageSeeds.terrain = Number.POSITIVE_INFINITY;
    const cleaned = normalizeWorldDocument(dirty);
    expect(cleaned.issues.filter((issue) => issue.severity === "error")).toEqual([]);
    expect(cleaned.document.params.stageSeeds).toEqual({ climate: 2, human: 44 });
  });
});

describe("stage seeds: cache invalidation", () => {
  function hitStats(document: WorldDocument) {
    const pipeline = createPipeline();
    pipeline.generate({ document: doc(), size: SIZE }); // populate all caches
    const layers = pipeline.generate({ document, size: SIZE });
    return layers.stats;
  }

  it("only invalidates hydrology and downstream when hydrologySeed changes", () => {
    const stats = hitStats(doc({ hydrology: SEED + 5 }));
    expect(stats.terrainMs).toBe(0);
    expect(stats.hydrologyMs).toBeGreaterThan(0);
    expect(stats.climateMs).toBe(0);
    expect(stats.biomeMs).toBe(0);
    expect(stats.humanMs).toBeGreaterThan(0);
  });

  it("only invalidates human when humanSeed changes", () => {
    const stats = hitStats(doc({ human: SEED + 5 }));
    expect(stats.terrainMs).toBe(0);
    expect(stats.hydrologyMs).toBe(0);
    expect(stats.climateMs).toBe(0);
    expect(stats.biomeMs).toBe(0);
    expect(stats.humanMs).toBeGreaterThan(0);
  });

  it("invalidates climate, biome and human when climateSeed changes", () => {
    const stats = hitStats(doc({ climate: SEED + 5 }));
    expect(stats.terrainMs).toBe(0);
    expect(stats.hydrologyMs).toBe(0);
    expect(stats.climateMs).toBeGreaterThan(0);
    expect(stats.biomeMs).toBeGreaterThan(0);
    expect(stats.humanMs).toBeGreaterThan(0);
  });

  it("invalidates everything when terrainSeed changes", () => {
    const stats = hitStats(doc({ terrain: SEED + 5 }));
    expect(stats.terrainMs).toBeGreaterThan(0);
    expect(stats.hydrologyMs).toBeGreaterThan(0);
    expect(stats.climateMs).toBeGreaterThan(0);
    expect(stats.biomeMs).toBeGreaterThan(0);
  });

  it("activates the hydrology perturbation even when the sub-seed equals the document seed", () => {
    const base = generate(doc());
    const explicit = generate(doc({ hydrology: SEED }));
    expect(sameBytes(base.height, explicit.height)).toBe(true);
    expect(sameBytes(base.river, explicit.river)).toBe(false);
  });
});
