import { describe, expect, it } from "vitest";
import { createDefaultDocument, createPipeline } from "../src/index";
import type { MapLabel, Settlement, WorldDocument, WorldLayers } from "../src/types";

const SIZE = 256;
const SEED = 20261018;

function baseDocument(): WorldDocument {
  return createDefaultDocument({ seed: SEED, params: { gridSize: SIZE } });
}

function generate(document: WorldDocument, pipeline = createPipeline()): WorldLayers {
  return pipeline.generate({ document, size: SIZE });
}

function hiddenOf(layers: WorldLayers): NonNullable<WorldLayers["hidden"]> {
  return layers.hidden ?? { settlements: [], labels: [] };
}

/** Deterministic JSON view of the human layer (stats contain real timings). */
function placesSnapshot(layers: WorldLayers): string {
  return JSON.stringify({
    settlements: layers.settlements,
    autoLabels: layers.autoLabels,
    hidden: hiddenOf(layers),
  });
}

function userSettlement(id: string, name: string, pinned = true): Settlement {
  return { id, name, kind: "custom", x: 0.42, y: 0.63, population: 0, pinned };
}

function userLabel(id: string, text: string, pinned = true): MapLabel {
  return { id, text, kind: "custom", x: 0.31, y: 0.38, pinned };
}

describe("place editing merge semantics", () => {
  it("pinned settlement rename/move overrides the generated entry with the same id", () => {
    const document = baseDocument();
    const base = generate(document);
    const target = base.settlements[0];
    expect(target).toBeDefined();

    const edited: WorldDocument = {
      ...document,
      settlements: [
        {
          ...target,
          name: "苍澜新城",
          x: 0.25,
          y: 0.7,
          population: 12345,
          pinned: true,
        },
      ],
    };
    const layers = generate(edited);
    expect(layers.settlements.length).toBe(base.settlements.length);
    const matches = layers.settlements.filter((settlement) => settlement.id === target.id);
    expect(matches.length).toBe(1);
    expect(matches[0].name).toBe("苍澜新城");
    expect(matches[0].x).toBeCloseTo(0.25, 6);
    expect(matches[0].y).toBeCloseTo(0.7, 6);
    expect(matches[0].population).toBe(12345);
    expect(matches[0].pinned).toBe(true);
    // Pinned override is not a hidden entry.
    expect(hiddenOf(layers).settlements.some((settlement) => settlement.id === target.id)).toBe(false);
  });

  it("includes user-added settlements/labels, keeps pinned, and is reproducible", () => {
    const document = baseDocument();
    const settlement = userSettlement("user-s-1", "青岚港");
    const label = userLabel("user-l-1", "古战场");
    const edited: WorldDocument = { ...document, settlements: [settlement], labels: [label] };

    const first = generate(edited);
    const second = generate(edited);
    const fromCache = generate(edited, createPipeline());

    for (const layers of [first, fromCache]) {
      const foundSettlement = layers.settlements.filter((entry) => entry.id === "user-s-1");
      expect(foundSettlement.length).toBe(1);
      expect(foundSettlement[0].name).toBe("青岚港");
      expect(foundSettlement[0].kind).toBe("custom");
      expect(foundSettlement[0].x).toBeCloseTo(0.42, 6);
      expect(foundSettlement[0].y).toBeCloseTo(0.63, 6);
      expect(foundSettlement[0].pinned).toBe(true);

      const foundLabel = layers.autoLabels.filter((entry) => entry.id === "user-l-1");
      expect(foundLabel.length).toBe(1);
      expect(foundLabel[0].text).toBe("古战场");
      expect(foundLabel[0].kind).toBe("custom");
      expect(foundLabel[0].x).toBeCloseTo(0.31, 6);
      expect(foundLabel[0].y).toBeCloseTo(0.38, 6);
      expect(foundLabel[0].pinned).toBe(true);
    }
    // Full reproducibility including the new hidden field / user entries.
    expect(placesSnapshot(second)).toBe(placesSnapshot(first));
  });

  it("hiddenIds suppresses generated and pinned entries alike and reports them in layers.hidden", () => {
    const document = baseDocument();
    const base = generate(document);
    const generatedSettlement = base.settlements[0];
    const generatedLabel = base.autoLabels[0];

    const pinnedSettlement: Settlement = {
      ...generatedSettlement,
      name: "被隐藏的钉住城",
      pinned: true,
    };
    const pinnedLabel: MapLabel = { ...generatedLabel, text: "被隐藏的钉住地名", pinned: true };
    const edited: WorldDocument = {
      ...document,
      settlements: [pinnedSettlement, userSettlement("user-s-hidden", "隐藏新城")],
      labels: [pinnedLabel, userLabel("user-l-hidden", "隐藏地名")],
      overrides: {
        ...document.overrides,
        hiddenIds: [generatedSettlement.id, generatedLabel.id, "user-s-hidden", "user-l-hidden"],
      },
    };
    const layers = generate(edited);
    const hidden = hiddenOf(layers);

    // Nothing hidden leaks into the visible layers.
    for (const id of edited.overrides.hiddenIds) {
      expect(layers.settlements.some((entry) => entry.id === id), `visible settlement ${id}`).toBe(false);
      expect(layers.autoLabels.some((entry) => entry.id === id), `visible label ${id}`).toBe(false);
    }

    // Generated-but-pinned entries come back through layers.hidden as the
    // effective (pinned) version, so restoring is lossless.
    const hiddenGeneratedSettlement = hidden.settlements.find(
      (entry) => entry.id === generatedSettlement.id,
    );
    expect(hiddenGeneratedSettlement?.name).toBe("被隐藏的钉住城");
    expect(hiddenGeneratedSettlement?.pinned).toBe(true);
    const hiddenGeneratedLabel = hidden.labels.find((entry) => entry.id === generatedLabel.id);
    expect(hiddenGeneratedLabel?.text).toBe("被隐藏的钉住地名");
    expect(hiddenGeneratedLabel?.pinned).toBe(true);

    // User-added hidden entries are reported as well.
    expect(hidden.settlements.some((entry) => entry.id === "user-s-hidden")).toBe(true);
    expect(hidden.labels.some((entry) => entry.id === "user-l-hidden")).toBe(true);
  });

  it("restores entries when their ids are removed from hiddenIds", () => {
    const document = baseDocument();
    const base = generate(document);
    const generatedSettlement = base.settlements[0];
    const generatedLabel = base.autoLabels[0];
    const pinnedSettlement: Settlement = { ...generatedSettlement, name: "可恢复城", pinned: true };
    const pinnedLabel: MapLabel = { ...generatedLabel, text: "可恢复地名", pinned: true };
    const curated: WorldDocument = {
      ...document,
      settlements: [pinnedSettlement, userSettlement("user-s-restore", "恢复新城")],
      labels: [pinnedLabel, userLabel("user-l-restore", "恢复地名")],
    };

    const hiddenDoc: WorldDocument = {
      ...curated,
      overrides: {
        ...curated.overrides,
        hiddenIds: [generatedSettlement.id, generatedLabel.id, "user-s-restore", "user-l-restore"],
      },
    };
    const hidden = generate(hiddenDoc);
    expect(hiddenOf(hidden).settlements.length).toBe(2);
    expect(hiddenOf(hidden).labels.length).toBe(2);

    // Remove the ids from hiddenIds: everything comes back in the visible lists.
    const restored = generate(curated);
    expect(restored.settlements.find((entry) => entry.id === generatedSettlement.id)?.name).toBe("可恢复城");
    expect(restored.autoLabels.find((entry) => entry.id === generatedLabel.id)?.text).toBe("可恢复地名");
    expect(restored.settlements.some((entry) => entry.id === "user-s-restore")).toBe(true);
    expect(restored.autoLabels.some((entry) => entry.id === "user-l-restore")).toBe(true);
    expect(hiddenOf(restored).settlements).toEqual([]);
    expect(hiddenOf(restored).labels).toEqual([]);
  });

  it("is deterministic for the same document, including settlements/labels/hidden", () => {
    const document = baseDocument();
    const base = generate(document);
    const generatedSettlement = base.settlements[0];
    const generatedLabel = base.autoLabels[0];
    const edited: WorldDocument = {
      ...document,
      settlements: [
        { ...generatedSettlement, name: "确定城", pinned: true },
        userSettlement("user-s-det", "确定新城"),
        { ...base.settlements[1], pinned: true },
      ],
      labels: [{ ...generatedLabel, text: "确定地名", pinned: true }, userLabel("user-l-det", "确定新地名")],
      overrides: {
        ...document.overrides,
        hiddenIds: [base.settlements[1].id, "user-l-det", base.autoLabels[1].id],
      },
    };

    const pipeline = createPipeline();
    const first = generate(edited, pipeline);
    const second = generate(edited, pipeline);
    const fresh = generate(edited);

    expect(placesSnapshot(second)).toBe(placesSnapshot(first));
    expect(placesSnapshot(fresh)).toBe(placesSnapshot(first));
    expect(second.stats.humanMs).toBe(0); // same document => human stage cache hit
  });

  it("layers.hidden contains only hidden entries, deduplicated, with stable generated-before-user order", () => {
    const document = baseDocument();
    const base = generate(document);
    const generatedSettlement = base.settlements[0];
    const generatedLabel = base.autoLabels[0];
    const generatedOnlySettlement = base.settlements[2];
    const generatedOnlyLabel = base.autoLabels[2];

    const edited: WorldDocument = {
      ...document,
      settlements: [userSettlement("user-s-order", "用户新城")],
      labels: [userLabel("user-l-order", "用户新地名")],
      overrides: {
        ...document.overrides,
        // Deliberately duplicates + a non-existent id + mixed generated/user ids.
        hiddenIds: [
          generatedSettlement.id,
          "user-s-order",
          generatedOnlySettlement.id,
          "ghost-id",
          generatedSettlement.id,
          generatedLabel.id,
          "user-l-order",
          generatedOnlyLabel.id,
        ],
      },
    };
    const layers = generate(edited);
    const hidden = hiddenOf(layers);
    const hiddenIds = new Set(edited.overrides.hiddenIds);

    const allHiddenIds = [...hidden.settlements.map((entry) => entry.id), ...hidden.labels.map((entry) => entry.id)];
    for (const id of allHiddenIds) expect(hiddenIds.has(id), `unexpected hidden id ${id}`).toBe(true);
    expect(allHiddenIds).not.toContain("ghost-id");

    // No duplicates.
    const settlementIds = hidden.settlements.map((entry) => entry.id);
    const labelIds = hidden.labels.map((entry) => entry.id);
    expect(new Set(settlementIds).size).toBe(settlementIds.length);
    expect(new Set(labelIds).size).toBe(labelIds.length);

    // No overlap with the visible layers.
    const visibleSettlementIds = new Set(layers.settlements.map((entry) => entry.id));
    const visibleLabelIds = new Set(layers.autoLabels.map((entry) => entry.id));
    for (const id of settlementIds) expect(visibleSettlementIds.has(id)).toBe(false);
    for (const id of labelIds) expect(visibleLabelIds.has(id)).toBe(false);

    // Stable order: generated-order entries first, then user-added hidden ids.
    const order = (ids: string[], generatedIds: string[], userId: string): void => {
      const generatedPositions = ids
        .map((id, index) => (generatedIds.includes(id) ? index : -1))
        .filter((index) => index >= 0);
      const userIndex = ids.indexOf(userId);
      expect(userIndex).toBeGreaterThanOrEqual(0);
      for (const position of generatedPositions) expect(position).toBeLessThan(userIndex);
    };
    order(
      settlementIds,
      [generatedSettlement.id, generatedOnlySettlement.id],
      "user-s-order",
    );
    order(labelIds, [generatedLabel.id, generatedOnlyLabel.id], "user-l-order");
  });
});
