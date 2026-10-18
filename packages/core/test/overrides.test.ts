import { describe, expect, it } from "vitest";
import { createDefaultDocument, createPipeline } from "../src/index";
import { Biome } from "../src/types";
import type { WorldDocument, WorldLayers } from "../src/types";

const SIZE = 160;
const SEED = 424242;

function cellOf(index: number, size: number): { x: number; y: number } {
  return { x: index % size, y: (index / size) | 0 };
}

function findLandCell(layers: WorldLayers, minHeight = 0.5): number {
  for (let i = 0; i < layers.height.length; i += 1) {
    if (!layers.ocean[i] && !layers.lake[i] && layers.height[i] > minHeight) return i;
  }
  return -1;
}

function descendToWater(layers: WorldLayers, start: number): boolean {
  const size = layers.size;
  let cell = start;
  for (let step = 0; step < size * 4; step += 1) {
    if (layers.ocean[cell] || layers.lake[cell]) return true;
    const { x, y } = cellOf(cell, size);
    if (x === 0 || y === 0 || x === size - 1 || y === size - 1) return layers.ocean[cell] === 1;
    let best = -1;
    let bestFilled = layers.filled[cell];
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nIndex = (y + dy) * size + (x + dx);
        if (layers.filled[nIndex] < bestFilled) {
          bestFilled = layers.filled[nIndex];
          best = nIndex;
        }
      }
    }
    if (best < 0) return false;
    cell = best;
  }
  return false;
}

function baseDocument(): WorldDocument {
  return createDefaultDocument({ seed: SEED, params: { gridSize: SIZE } });
}

describe("brush overrides", () => {
  const pipeline = createPipeline();
  const document = baseDocument();
  const base = pipeline.generate({ document, size: SIZE });
  const landCell = findLandCell(base);
  const { x: landX, y: landY } = cellOf(landCell, SIZE);
  const nx = (landX + 0.5) / SIZE;
  const ny = (landY + 0.5) / SIZE;

  it("applies elevation lock/raise/lower stamps and keeps filled >= height", () => {
    const lockDoc: WorldDocument = {
      ...document,
      overrides: {
        ...document.overrides,
        elevation: [{ x: nx, y: ny, radius: 0.04, value: 0.92, mode: "lock" }],
      },
    };
    const locked = pipeline.generate({ document: lockDoc, size: SIZE });
    const center = Math.floor(ny * SIZE) * SIZE + Math.floor(nx * SIZE);
    expect(locked.height[center]).toBeGreaterThan(base.height[center] + 0.2);
    expect(locked.height[center]).toBeGreaterThan(0.85);

    const raiseDoc: WorldDocument = {
      ...document,
      overrides: {
        ...document.overrides,
        elevation: [{ x: nx, y: ny, radius: 0.04, value: 0.15, mode: "raise" }],
      },
    };
    const raised = pipeline.generate({ document: raiseDoc, size: SIZE });
    expect(raised.height[center]).toBeGreaterThan(base.height[center] + 0.05);

    const lowerDoc: WorldDocument = {
      ...document,
      overrides: {
        ...document.overrides,
        elevation: [{ x: nx, y: ny, radius: 0.04, value: 0.3, mode: "lower" }],
      },
    };
    const lowered = pipeline.generate({ document: lowerDoc, size: SIZE });
    expect(lowered.height[center]).toBeLessThan(base.height[center] - 0.1);
  });

  it("applies biome stamps after classification and never paints water", () => {
    const biomeDoc: WorldDocument = {
      ...document,
      overrides: {
        ...document.overrides,
        biome: [{ x: nx, y: ny, radius: 0.05, biome: Biome.Desert }],
      },
    };
    const stamped = pipeline.generate({ document: biomeDoc, size: SIZE });
    const center = Math.floor(ny * SIZE) * SIZE + Math.floor(nx * SIZE);
    expect(stamped.biome[center]).toBe(Biome.Desert);
    // A stamp centred on the middle of the ocean must not turn ocean into land.
    const oceanIndex = base.ocean.indexOf(1);
    expect(oceanIndex).toBeGreaterThanOrEqual(0);
    const ocean = cellOf(oceanIndex, SIZE);
    const oceanDoc: WorldDocument = {
      ...document,
      overrides: {
        ...document.overrides,
        biome: [{ x: (ocean.x + 0.5) / SIZE, y: (ocean.y + 0.5) / SIZE, radius: 0.05, biome: Biome.Desert }],
      },
    };
    const oceanStamped = pipeline.generate({ document: oceanDoc, size: SIZE });
    expect(oceanStamped.biome[oceanIndex]).toBe(Biome.Ocean);
  });

  it("carves a forced river that stays continuous and reaches open water", () => {
    // Draw from high land towards the east; the stage must extend the carve to
    // the map border so the channel is connected to the sea.
    const points: [number, number][] = [
      [nx, ny],
      [Math.min(0.95, nx + 0.08), Math.min(0.95, ny + 0.05)],
      [Math.min(0.95, nx + 0.16), Math.min(0.95, ny + 0.1)],
    ];
    const riverDoc: WorldDocument = {
      ...document,
      overrides: {
        ...document.overrides,
        riverForce: [{ id: "forced", width: 0.016, points }],
      },
    };
    const forced = pipeline.generate({ document: riverDoc, size: SIZE });
    // Carving only lowers terrain.
    for (let i = 0; i < forced.height.length; i += 1) {
      expect(forced.height[i]).toBeLessThanOrEqual(base.height[i] + 1e-6);
    }
    expect(forced.height.some((h, i) => h < base.height[i] - 0.05)).toBe(true);
    // Some river cells appear along the drawn polyline (within a few cells).
    const strokeCells: number[] = [];
    for (let step = 0; step < 24; step += 1) {
      const t = step / 23;
      const px = points[0][0] + (points[2][0] - points[0][0]) * t;
      const py = points[0][1] + (points[2][1] - points[0][1]) * t;
      const cx = Math.floor(px * SIZE);
      const cy = Math.floor(py * SIZE);
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) continue;
          strokeCells.push(y * SIZE + x);
        }
      }
    }
    const riverNearStroke = strokeCells.filter((i) => forced.river[i] === 1).length;
    expect(riverNearStroke).toBeGreaterThan(15);
    expect(descendToWater(forced, landCell)).toBe(true);
  });

  it("filters hiddenIds and overlays pinned user entries", () => {
    const settlement = base.settlements[0];
    const label = base.autoLabels[0];
    expect(settlement).toBeDefined();
    expect(label).toBeDefined();
    const edited: WorldDocument = {
      ...document,
      settlements: [{ ...settlement, name: "PINNED-NAME", pinned: true }],
      labels: [...document.labels, { id: "user-label-1", text: "用户标注", kind: "custom", x: 0.5, y: 0.5, pinned: true }],
      overrides: {
        ...document.overrides,
        hiddenIds: [label.id],
      },
    };
    const layers = pipeline.generate({ document: edited, size: SIZE });
    expect(layers.settlements.find((s) => s.id === settlement.id)?.name).toBe("PINNED-NAME");
    expect(layers.autoLabels.some((l) => l.id === label.id)).toBe(false);
    expect(layers.autoLabels.some((l) => l.id === "user-label-1")).toBe(true);
  });
});
