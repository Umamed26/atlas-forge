import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS } from "../src/defaults";
import { createDefaultDocument, createPipeline } from "../src/index";
import { hash2 } from "../src/rng";
import type { WorldDocument, WorldLayers } from "../src/types";

const SIZE = 256;
const SEED = 20261018;
const CJK_ONLY = /^[\u4e00-\u9fff]+$/;
const LATIN_WORD = /^[A-Za-z]+$/;
const LATIN_LABEL = /^[A-Za-z][A-Za-z ]+$/;

function autoCulture(seed: number): "cjk" | "latin" {
  return (hash2(seed, 0x5eed, 0x1234) & 1) === 1 ? "cjk" : "latin";
}

function generate(document: WorldDocument, size = SIZE): WorldLayers {
  return createPipeline().generate({ document, size });
}

function docFor(seed: number, namingLanguage?: "auto" | "cjk" | "latin"): WorldDocument {
  return createDefaultDocument({
    seed,
    params: namingLanguage ? { gridSize: SIZE, namingLanguage } : { gridSize: SIZE },
  });
}

function expectSameSimulation(a: WorldLayers, b: WorldLayers): void {
  for (const layer of ["height", "filled", "flow", "temperature", "moisture"] as const) {
    expect(Array.from(a[layer])).toEqual(Array.from(b[layer]));
  }
  for (const layer of ["ocean", "lake", "river", "biome"] as const) {
    expect(Array.from(a[layer])).toEqual(Array.from(b[layer]));
  }
}

describe("namingLanguage parameter", () => {
  it("defaults to auto (historical seed-hash behaviour) in DEFAULT_PARAMS", () => {
    expect(DEFAULT_PARAMS.namingLanguage).toBe("auto");
  });

  it("forces CJK or Latin names for settlements and autoLabels with the same seed", () => {
    const cjk = generate(docFor(SEED, "cjk"));
    const latin = generate(docFor(SEED, "latin"));
    expect(cjk.settlements.length).toBeGreaterThan(3);
    expect(latin.settlements.length).toBeGreaterThan(3);
    expect(cjk.autoLabels.length).toBeGreaterThan(10);
    expect(latin.autoLabels.length).toBeGreaterThan(10);

    for (const settlement of cjk.settlements) {
      expect(settlement.name, settlement.name).toMatch(CJK_ONLY);
    }
    for (const label of cjk.autoLabels) {
      expect(label.text, label.text).toMatch(CJK_ONLY);
    }
    for (const settlement of latin.settlements) {
      expect(settlement.name, settlement.name).toMatch(LATIN_WORD);
    }
    for (const label of latin.autoLabels) {
      expect(label.text, label.text).toMatch(LATIN_LABEL);
      expect(label.text, label.text).not.toMatch(/[\u4e00-\u9fff]/);
    }

    // The language switch must not perturb the simulation itself.
    expectSameSimulation(cjk, latin);
    expect(cjk.settlements.map((s) => s.name)).not.toEqual(latin.settlements.map((s) => s.name));
    expect(cjk.autoLabels.map((l) => l.text)).not.toEqual(latin.autoLabels.map((l) => l.text));
  });

  it("auto keeps byte-identical output to a pre-field (old JSON) document", () => {
    const autoDoc = docFor(SEED);
    const auto = generate(autoDoc);

    // Old persisted documents simply do not have the field at all.
    const legacyDoc: WorldDocument = {
      ...autoDoc,
      params: { ...autoDoc.params } as WorldDocument["params"],
    };
    delete (legacyDoc.params as Partial<WorldDocument["params"]>).namingLanguage;
    const legacy = generate(legacyDoc);

    expectSameSimulation(auto, legacy);
    expect(legacy.settlements).toEqual(auto.settlements);
    expect(legacy.autoLabels).toEqual(auto.autoLabels);

    // "auto" resolves through the historical seed hash.
    const expected = autoCulture(SEED);
    const cjkPattern = expected === "cjk" ? CJK_ONLY : LATIN_WORD;
    for (const settlement of auto.settlements) {
      expect(settlement.name, settlement.name).toMatch(cjkPattern);
    }
  });

  it("only invalidates the human stage in the cache fingerprint", () => {
    const pipeline = createPipeline();
    const autoDoc = docFor(SEED);
    const auto = pipeline.generate({ document: autoDoc, size: SIZE });
    const autoIsCjk = CJK_ONLY.test(auto.settlements[0]?.name ?? "");
    expect(autoIsCjk).toBe(autoCulture(SEED) === "cjk");
    const target: "cjk" | "latin" = autoIsCjk ? "latin" : "cjk";
    const switchedDoc = {
      ...autoDoc,
      params: { ...autoDoc.params, namingLanguage: target },
    };
    const switched = pipeline.generate({ document: switchedDoc, size: SIZE });

    expect(switched.stats.terrainMs).toBe(0);
    expect(switched.stats.hydrologyMs).toBe(0);
    expect(switched.stats.climateMs).toBe(0);
    expect(switched.stats.biomeMs).toBe(0);
    expect(switched.stats.humanMs).toBeGreaterThan(0);
    expectSameSimulation(auto, switched);

    const pattern = target === "cjk" ? CJK_ONLY : LATIN_WORD;
    for (const settlement of switched.settlements) {
      expect(settlement.name, settlement.name).toMatch(pattern);
    }
    // sanity: explicit language is distinguishable from the resolved auto one.
    expect(switched.settlements[0].name).not.toBe(auto.settlements[0].name);
    pipeline.dispose();
  });

  it("is deterministic for an explicit language", () => {
    const first = generate(docFor(SEED, "latin"));
    const second = generate(docFor(SEED, "latin"));
    expect(second.settlements).toEqual(first.settlements);
    expect(second.autoLabels).toEqual(first.autoLabels);
  });
});
