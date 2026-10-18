import { describe, expect, it } from "vitest";
import { createDefaultDocument, generateWorld } from "../src/index";

describe("pipeline contract (M0 stub)", () => {
  it("is deterministic for identical document + size", () => {
    const doc = createDefaultDocument({ seed: 1234, params: { gridSize: 64 } });
    const a = generateWorld({ document: doc, size: 64 });
    const b = generateWorld({ document: doc, size: 64 });
    expect(a.height).toEqual(b.height);
    expect(a.biome).toEqual(b.biome);
  });

  it("returns typed arrays of the requested grid size", () => {
    const doc = createDefaultDocument({ seed: 7 });
    const layers = generateWorld({ document: doc, size: 64 });
    expect(layers.size).toBe(64);
    expect(layers.height.length).toBe(64 * 64);
    expect(layers.stats.landFraction).toBeGreaterThan(0);
    expect(layers.stats.landFraction).toBeLessThan(1);
  });
});
