import { describe, expect, it } from "vitest";
import { DEFAULT_PARAMS, DEFAULT_STYLE } from "../src/defaults";
import {
  normalizeWorldDocument,
  parseWorldDocumentJson,
  type NormalizedDocument,
} from "../src/document";
import { createDefaultDocument } from "../src/index";
import { Biome } from "../src/types";
import type { MapLabel, Settlement, WorldDocument } from "../src/types";

function validDocument(): WorldDocument {
  const document = createDefaultDocument({
    name: "Aetheris",
    seed: 20261018,
    params: { gridSize: 1024, seaLevel: 0.42, namingLanguage: "auto" },
    overrides: {
      elevation: [{ x: 0.5, y: 0.5, radius: 0.1, value: 0.8, mode: "lock" }],
      riverForce: [{ id: "river-1", points: [[0.1, 0.2], [0.3, 0.4]], width: 0.01 }],
      biome: [{ x: 0.2, y: 0.2, radius: 0.05, biome: Biome.Desert }],
      hiddenIds: ["sea-1-2"],
    },
    settlements: [
      { id: "user-s-1", name: "青岚港", kind: "custom", x: 0.3, y: 0.4, population: 100, pinned: true },
    ],
    labels: [
      { id: "user-l-1", text: "古战场", kind: "custom", x: 0.6, y: 0.5, rotation: 0.3, size: 18, pinned: true },
    ],
  });
  // Round-trip through JSON, exactly like an imported file.
  return JSON.parse(JSON.stringify(document)) as WorldDocument;
}

function errorsOf(result: NormalizedDocument): string[] {
  return result.issues.filter((issue) => issue.severity === "error").map((issue) => issue.path);
}

function jsonOf(document: WorldDocument): string {
  return JSON.stringify(document);
}

function bigDocument(labelCount: number, settlementCount: number): WorldDocument {
  const base = validDocument();
  const labels: MapLabel[] = Array.from({ length: labelCount }, (_, index) => ({
    id: `user-l-${index}`,
    text: `地名${index}`,
    kind: "custom",
    x: ((index * 13) % 100) / 100,
    y: ((index * 7) % 100) / 100,
    pinned: index % 2 === 0,
  }));
  const settlements: Settlement[] = Array.from({ length: settlementCount }, (_, index) => ({
    id: `user-s-${index}`,
    name: `地点${index}`,
    kind: "town",
    x: ((index * 17) % 100) / 100,
    y: ((index * 11) % 100) / 100,
  }));
  return { ...base, labels, settlements };
}

describe("world document normalization", () => {
  it("passes a valid v0.2.0 document through unchanged with zero issues", () => {
    const document = validDocument();
    const result = normalizeWorldDocument(document);
    expect(result.issues).toEqual([]);
    expect(result.document).toEqual(document);
    expect(jsonOf(result.document)).toBe(jsonOf(document));
  });

  it("accepts legacy documents with missing namingLanguage/hiddenIds/labels and merges defaults", () => {
    const document = validDocument() as unknown as Record<string, unknown>;
    const params = document.params as Record<string, unknown>;
    delete params.namingLanguage;
    const overrides = document.overrides as Record<string, unknown>;
    delete overrides.hiddenIds;
    delete document.labels;
    delete document.settlements;
    // Unknown fields (old/future/foreign tools) are ignored silently.
    document.legacyExtra = { foo: 1 };
    params.someAncientParam = 42;
    (document.style as Record<string, unknown>).unknownStyleKey = true;

    const result = normalizeWorldDocument(document);
    expect(errorsOf(result)).toEqual([]);
    expect(result.issues).toEqual([]); // missing legacy fields are not problems
    const out = result.document;
    expect(out.params.namingLanguage).toBe("auto");
    expect(out.overrides.hiddenIds).toEqual([]);
    expect(out.labels).toEqual([]);
    expect(out.settlements).toEqual([]);
    expect(out.name).toBe("Aetheris");
    expect(out.seed).toBe(20261018);
    for (const key of Object.keys(DEFAULT_PARAMS) as (keyof typeof DEFAULT_PARAMS)[]) {
      expect(out.params[key]).toBe(DEFAULT_PARAMS[key]);
    }
    expect(out.style.preset).toBe("parchment-classic");
    const asRecord = out as unknown as Record<string, unknown>;
    expect(asRecord.legacyExtra).toBeUndefined();
    expect((out.params as unknown as Record<string, unknown>).someAncientParam).toBeUndefined();
    expect((out.style as unknown as Record<string, unknown>).unknownStyleKey).toBeUndefined();
  });

  it("reports errors for fatal input but still returns a usable fallback document", () => {
    const fatalInputs: unknown[] = [null, undefined, 42, "hello", [], [validDocument()], true];
    for (const input of fatalInputs) {
      const result = normalizeWorldDocument(input);
      expect(errorsOf(result).length, `input ${String(input)}`).toBeGreaterThan(0);
      expect(result.document.version).toBe(1);
      expect(Number.isFinite(result.document.seed)).toBe(true);
      expect(Array.isArray(result.document.settlements)).toBe(true);
      expect(Array.isArray(result.document.labels)).toBe(true);
      expect(Array.isArray(result.document.overrides.hiddenIds)).toBe(true);
      expect(typeof result.document.createdAt).toBe("string");
    }

    for (const input of [
      { ...validDocument(), version: 2 },
      { ...validDocument(), version: "1" },
      { ...validDocument(), seed: Number.NaN },
      { ...validDocument(), seed: Number.POSITIVE_INFINITY },
      { ...validDocument(), seed: "123" },
    ]) {
      const result = normalizeWorldDocument(input);
      expect(errorsOf(result).length).toBeGreaterThan(0);
      expect(result.document.version).toBe(1);
      expect(Number.isFinite(result.document.seed)).toBe(true);
      // Salvageable fields are still kept where possible.
      expect(result.document.name).toBe("Aetheris");
    }
  });

  it("sanitizes settlements/labels: coordinates, names, kinds, ids and booleans", () => {
    const raw = {
      ...validDocument(),
      settlements: [
        { id: "user-s-x", name: `  ${"很".repeat(200)}  `, kind: "castle", x: 5, y: -3, population: -9, pinned: 1 },
        { id: "", name: "   ", kind: "city", x: 0.5, y: 0.5 },
        { id: 42, name: "无 id 城", kind: "custom", x: 0.1, y: 0.2, pinned: "true" },
        "not-an-object",
      ],
      labels: [
        { id: "user-l-x", text: `  ${"字".repeat(200)}  `, kind: "wrong", x: 2, y: -1, rotation: "north", size: 500 },
        { id: "user-l-y", text: "好地名", kind: "custom", x: 0.4, y: 0.6, pinned: 0 },
      ],
    };
    const result = normalizeWorldDocument(raw);
    expect(errorsOf(result)).toEqual([]);
    const out = result.document;
    expect(out.settlements.length).toBe(2); // empty name dropped, non-object dropped
    const [longName, noId] = out.settlements;
    expect(longName.name.length).toBe(120);
    expect(longName.name.startsWith("很")).toBe(true);
    expect(longName.kind).toBe("custom");
    expect(longName.x).toBe(1);
    expect(longName.y).toBe(0);
    expect(longName.population).toBe(0);
    expect(longName.pinned).toBe(true);
    expect(noId.id.length).toBeGreaterThan(0);
    expect(noId.pinned).toBe(true);

    expect(out.labels.length).toBe(2);
    const [longLabel, shortLabel] = out.labels;
    expect(longLabel.text.length).toBe(120);
    expect(longLabel.kind).toBe("custom");
    expect(longLabel.x).toBe(1);
    expect(longLabel.y).toBe(0);
    expect(longLabel.rotation).toBeUndefined();
    expect(longLabel.size).toBe(96);
    expect(shortLabel.pinned).toBe(false);
  });

  it("deduplicates hiddenIds, drops empty/non-string ids and reports it once", () => {
    const raw = {
      ...validDocument(),
      overrides: {
        ...validDocument().overrides,
        hiddenIds: ["a", "a", "", "b", 3, null, "a", "c"],
      },
    };
    const result = normalizeWorldDocument(raw);
    expect(errorsOf(result)).toEqual([]);
    expect(result.document.overrides.hiddenIds).toEqual(["a", "b", "c"]);
    expect(result.issues.some((issue) => issue.path === "overrides.hiddenIds")).toBe(true);
  });

  it("drops dirty override entries and keeps the valid parts", () => {
    const raw = {
      ...validDocument(),
      overrides: {
        elevation: [
          { x: 0.5, y: 0.5, radius: 0.1, value: 0.8, mode: "lock" },
          { x: -2, y: 3, radius: 9, value: 2, mode: "raise" },
          { x: 0.5, y: 0.5, radius: 0.1, value: 0.1, mode: "paint" },
          "junk",
        ],
        riverForce: [
          { id: "ok", points: [[0.1, 0.2], [0.3, 0.4], "bad", [0.5, Number.NaN]], width: 5 },
          { id: "too-short", points: [[0.1, 0.2]], width: 0.01 },
          { points: [[0.2, 0.2], [0.4, 0.4]] },
        ],
        biome: [
          { x: 0.2, y: 0.2, radius: 0.05, biome: Biome.Desert },
          { x: 0.2, y: 0.2, radius: 0.05, biome: 99 },
          { x: 0.2, y: 0.2, radius: 0.05, biome: 1.5 },
        ],
        hiddenIds: ["keep"],
      },
    };
    const result = normalizeWorldDocument(raw);
    expect(errorsOf(result)).toEqual([]);
    const overrides = result.document.overrides;
    expect(overrides.elevation.length).toBe(2);
    expect(overrides.elevation[1].x).toBe(0);
    expect(overrides.elevation[1].y).toBe(1);
    expect(overrides.elevation[1].radius).toBe(0.35);
    expect(overrides.elevation[1].value).toBe(0.4);
    expect(overrides.riverForce.length).toBe(2);
    expect(overrides.riverForce[0].width).toBe(0.2);
    expect(overrides.riverForce[0].points.length).toBe(2);
    expect(overrides.riverForce[1].id.length).toBeGreaterThan(0);
    expect(overrides.biome.length).toBe(1);
    expect(overrides.biome[0].biome).toBe(Biome.Desert);
    expect(overrides.hiddenIds).toEqual(["keep"]);
  });

  it("is idempotent: normalizing the output again adds no errors and changes nothing", () => {
    const dirty = {
      ...validDocument(),
      name: " x ",
      params: {
        ...validDocument().params,
        seaLevel: 9,
        namingLanguage: "klingon",
        windBands: "yes",
        windAngle: 725,
      },
      style: { ...validDocument().style, preset: "neon", labelDensity: 9 },
      settlements: [{ id: "s", name: " 城 ", kind: "nope", x: 3, y: -3, pinned: "maybe" }],
      overrides: {
        elevation: [{ x: 2, y: -1, radius: 9, value: 9, mode: "lower" }],
        riverForce: [],
        biome: [{ x: 0.5, y: 0.5, radius: 0.1, biome: 99 }],
        hiddenIds: ["x", "x"],
      },
      createdAt: 123,
    };
    const first = normalizeWorldDocument(dirty);
    expect(first.issues.length).toBeGreaterThan(0);

    const second = normalizeWorldDocument(first.document);
    expect(errorsOf(second)).toEqual([]);
    expect(second.issues).toEqual([]);
    expect(jsonOf(second.document)).toBe(jsonOf(first.document));

    const third = normalizeWorldDocument(second.document);
    expect(jsonOf(third.document)).toBe(jsonOf(first.document));
  });

  it("keeps valid timestamps and fills missing ones", () => {
    const document = validDocument();
    document.createdAt = "2020-01-02T03:04:05.000Z";
    document.updatedAt = "2021-02-03T04:05:06.000Z";
    const kept = normalizeWorldDocument(document);
    expect(kept.document.createdAt).toBe("2020-01-02T03:04:05.000Z");
    expect(kept.document.updatedAt).toBe("2021-02-03T04:05:06.000Z");

    const missing = { ...validDocument(), createdAt: undefined, updatedAt: null };
    const filled = normalizeWorldDocument(missing);
    expect(Number.isFinite(Date.parse(filled.document.createdAt))).toBe(true);
    expect(Number.isFinite(Date.parse(filled.document.updatedAt))).toBe(true);
  });

  it("normalizes style enums/booleans/numbers and warns instead of failing", () => {
    const raw = {
      ...validDocument(),
      style: {
        preset: "neon",
        title: 123,
        showLabels: "yes",
        labelDensity: 5,
        paperTexture: -2,
      },
    };
    const result = normalizeWorldDocument(raw);
    expect(errorsOf(result)).toEqual([]);
    expect(result.document.style.preset).toBe(DEFAULT_STYLE.preset);
    expect(result.document.style.title).toBe("Aetheris");
    expect(result.document.style.showLabels).toBe(DEFAULT_STYLE.showLabels);
    expect(result.document.style.labelDensity).toBe(1);
    expect(result.document.style.paperTexture).toBe(0);
    expect(result.issues.some((issue) => issue.path === "style.preset")).toBe(true);
  });

  it("parses JSON text and never throws on malformed input", () => {
    const document = validDocument();
    const text = JSON.stringify(document);
    const parsed = parseWorldDocumentJson(text);
    expect(parsed.issues).toEqual([]);
    expect(parsed.document).toEqual(document);

    const broken = parseWorldDocumentJson("{ this is not json ");
    expect(errorsOf(broken).length).toBeGreaterThan(0);
    expect(broken.issues[0].path).toBe("$");
    expect(broken.document.version).toBe(1);
    expect(Number.isFinite(broken.document.seed)).toBe(true);

    const notObject = parseWorldDocumentJson("null");
    expect(errorsOf(notObject).length).toBeGreaterThan(0);
    expect(notObject.document.version).toBe(1);

    const nonString = parseWorldDocumentJson(42 as unknown as string);
    expect(errorsOf(nonString).length).toBeGreaterThan(0);
  });

  it("normalizes a large document quickly (< 50ms)", () => {
    const document = bigDocument(3000, 1500);
    const startedAt = performance.now();
    const result = normalizeWorldDocument(document);
    const elapsed = performance.now() - startedAt;
    console.log(
      `[document] normalized 3000 labels + 1500 settlements in ${elapsed.toFixed(2)}ms`,
    );
    expect(errorsOf(result)).toEqual([]);
    expect(result.issues).toEqual([]);
    expect(result.document.labels.length).toBe(3000);
    expect(result.document.settlements.length).toBe(1500);
    expect(elapsed).toBeLessThan(50);
  });
});
