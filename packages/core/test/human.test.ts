import { describe, expect, it } from "vitest";
import { createDefaultDocument, createPipeline } from "../src/index";
import { hash2 } from "../src/rng";
import type { MapLabel, WorldLayers } from "../src/types";

const CJK = /^[\u4e00-\u9fff]+$/;
const LATIN = /^[A-Za-z][a-zA-Z ]+$/;
const WATER_CHARS = "海湖河溪川泉泽";
const WATER_SUFFIXES = ["河", "溪", "川", "湖", "海", "泽"];
const MOUNTAIN_SUFFIXES = ["山脉", "岭", "峰群"];
const SETTLEMENT_SUFFIX: Record<string, string[]> = {
  city: ["城"],
  town: ["镇"],
  port: ["港"],
  fortress: ["堡"],
  ruin: ["墟"],
  custom: [],
};
const LATIN_SETTLEMENT_SUFFIX: Record<string, string[]> = {
  city: ["ton", "burg", "holm"],
  town: ["ford", "wick", "stead"],
  port: ["port", "haven", "mouth"],
  fortress: ["hold", "gate", "keep"],
  ruin: ["rest", "fell"],
  custom: [""],
};

function cultureSeeds(): { latin: number; cjk: number } {
  let latin = -1;
  let cjk = -1;
  for (let seed = 1; seed < 300 && (latin < 0 || cjk < 0); seed += 1) {
    const isCjk = (hash2(seed, 0x5eed, 0x1234) & 1) === 1;
    if (isCjk && cjk < 0) cjk = seed;
    if (!isCjk && latin < 0) latin = seed;
  }
  return { latin, cjk };
}

function generate(seed: number, size: number): WorldLayers {
  const document = createDefaultDocument({ seed, params: { gridSize: size } });
  return createPipeline().generate({ document, size });
}

function countSyllables(word: string): number {
  return (word.toLowerCase().match(/[aeiouy]+/g) ?? []).length;
}

/** Importance order the renderer relies on: sea > mountain > region > lake > river. */
function importanceOf(label: MapLabel): number {
  if (label.kind === "mountain") return 4;
  if (label.kind === "region") return 3;
  const text = label.text;
  if (text.endsWith(" Sea") || text.endsWith(" Ocean") || text.endsWith("海")) return 5;
  if (text.endsWith(" Lake") || text.endsWith("湖") || text.endsWith("泽")) return 2;
  return 1;
}

describe("human stage: naming and labels", () => {
  const seeds = cultureSeeds();

  it("generates CJK names as stem + type suffix with no repeated or water characters", () => {
    const size = 512;
    const layers = generate(seeds.cjk, size);
    expect(layers.settlements.length).toBeGreaterThan(5);
    for (const settlement of layers.settlements) {
      expect(settlement.name, settlement.name).toMatch(CJK);
      const suffixes = SETTLEMENT_SUFFIX[settlement.kind] ?? [];
      if (suffixes.length > 0) {
        expect(suffixes.some((suffix) => settlement.name.endsWith(suffix)), settlement.name).toBe(true);
        const stem = settlement.name.slice(0, -1);
        expect([...stem].length).toBeGreaterThanOrEqual(1);
        expect([...stem].length).toBeLessThanOrEqual(2);
        expect(new Set([...stem]).size).toBe([...stem].length);
      }
    }
    for (const label of layers.autoLabels) {
      if (label.kind === "region") {
        expect(label.text, label.text).toMatch(CJK);
        const chars = [...label.text];
        expect(chars.length).toBeGreaterThanOrEqual(2);
        expect(chars.length).toBeLessThanOrEqual(3);
        expect(new Set(chars).size).toBe(chars.length);
        for (const char of chars) expect(WATER_CHARS.includes(char)).toBe(false);
        continue;
      }
      if (label.kind === "mountain") {
        const suffix = MOUNTAIN_SUFFIXES.find((candidate) => label.text.endsWith(candidate));
        expect(suffix, label.text).toBeDefined();
        const stem = label.text.slice(0, -suffix!.length);
        expect(stem, label.text).toMatch(CJK);
        expect([...stem].length).toBeGreaterThanOrEqual(1);
        expect([...stem].length).toBeLessThanOrEqual(2);
        expect(new Set([...stem]).size).toBe([...stem].length);
        for (const char of stem) {
          expect(WATER_CHARS.includes(char)).toBe(false);
          expect("山脉岭峰".includes(char)).toBe(false);
        }
        continue;
      }
      // water labels: [stem][河/溪/川/湖/海/泽]; stem has no water chars.
      const suffix = WATER_SUFFIXES.find((candidate) => label.text.endsWith(candidate));
      expect(suffix, label.text).toBeDefined();
      const stem = label.text.slice(0, -suffix!.length);
      expect(stem, label.text).toMatch(CJK);
      expect([...stem].length).toBeGreaterThanOrEqual(1);
      expect([...stem].length).toBeLessThanOrEqual(2);
      expect(new Set([...stem]).size).toBe([...stem].length);
      for (const char of stem) expect(WATER_CHARS.includes(char)).toBe(false);
    }
  });

  it("generates Latin stem + suffix names with 2-4 syllables when the world uses that culture", () => {
    const size = 512;
    const layers = generate(seeds.latin, size);
    expect(layers.settlements.length).toBeGreaterThan(5);
    for (const settlement of layers.settlements) {
      expect(settlement.name, settlement.name).toMatch(LATIN);
      const suffixes = LATIN_SETTLEMENT_SUFFIX[settlement.kind] ?? [];
      if (suffixes.length > 0) {
        expect(suffixes.some((suffix) => settlement.name.toLowerCase().endsWith(suffix)), settlement.name).toBe(
          true,
        );
      }
      const syllables = countSyllables(settlement.name);
      expect(syllables, settlement.name).toBeGreaterThanOrEqual(2);
      expect(syllables, settlement.name).toBeLessThanOrEqual(4);
    }
    for (const label of layers.autoLabels) {
      if (label.kind === "region") {
        expect(label.text).toMatch(LATIN);
        const syllables = countSyllables(label.text);
        expect(syllables).toBeGreaterThanOrEqual(2);
        expect(syllables).toBeLessThanOrEqual(4);
      }
    }
  });

  it("keeps generated names unique across settlements and labels", () => {
    const layers = generate(20261018, 512);
    const names = [...layers.settlements.map((s) => s.name), ...layers.autoLabels.map((l) => l.text)];
    expect(new Set(names).size).toBe(names.length);
  });

  it("labels 20-40 features in importance order, including mountain and region labels", () => {
    for (const seed of [20261018, seeds.cjk, seeds.latin]) {
      const layers = generate(seed, 1024);
      const labels = layers.autoLabels;
      expect(labels.length, `seed ${seed} label count`).toBeGreaterThanOrEqual(20);
      expect(labels.length, `seed ${seed} label count`).toBeLessThanOrEqual(40);
      const byKind = new Map<string, number>();
      for (const label of labels) byKind.set(label.kind, (byKind.get(label.kind) ?? 0) + 1);
      expect(byKind.get("mountain") ?? 0, `seed ${seed} mountains`).toBeGreaterThanOrEqual(1);
      expect(byKind.get("mountain") ?? 0, `seed ${seed} mountains`).toBeLessThanOrEqual(4);
      expect(byKind.get("region") ?? 0, `seed ${seed} regions`).toBeGreaterThanOrEqual(3);
      expect(byKind.get("region") ?? 0, `seed ${seed} regions`).toBeLessThanOrEqual(6);
      expect(byKind.get("water") ?? 0).toBeGreaterThanOrEqual(1);
      let previous = Number.POSITIVE_INFINITY;
      for (const label of labels) {
        const importance = importanceOf(label);
        expect(importance, `label ${label.text} order`).toBeLessThanOrEqual(previous);
        previous = importance;
      }
    }
  }, 60_000);

  it("settles on land, prefers water access and places ports on the coast", () => {
    const size = 256;
    const layers = generate(4242, size);
    let ports = 0;
    for (const settlement of layers.settlements) {
      const x = Math.floor(settlement.x * size);
      const y = Math.floor(settlement.y * size);
      const index = y * size + x;
      expect(layers.ocean[index], `settlement ${settlement.name} in ocean`).toBe(0);
      expect(layers.lake[index], `settlement ${settlement.name} in lake`).toBe(0);
      if (settlement.kind === "port") {
        ports += 1;
        let coastal = false;
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
            if (layers.ocean[ny * size + nx]) coastal = true;
          }
        }
        expect(coastal, `port ${settlement.name} is not coastal`).toBe(true);
      }
    }
    expect(ports).toBeGreaterThan(0);
    expect(layers.settlements.length).toBeGreaterThanOrEqual(6);
    expect(layers.settlements.length).toBeLessThanOrEqual(48);
  });

  it("is reproducible: the same seed yields the same names and positions", () => {
    const a = generate(31415, 192);
    const b = generate(31415, 192);
    expect(a.settlements).toEqual(b.settlements);
    expect(a.autoLabels).toEqual(b.autoLabels);
  });
});
