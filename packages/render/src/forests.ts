/**
 * Small engraved tree symbols scattered over forest biomes. They fill the
 * large flat land washes with the kind of tiny hand-drawn marks that make a
 * parchment map read as a drawing rather than a colour field.
 */
import { Biome } from "@atlas/core";
import type { RenderPass } from "./pass";
import { hash01 } from "./noise";
import { cssRgb } from "./style";

const FOREST_BIOMES = new Set<number>([
  Biome.BorealForest,
  Biome.TemperateForest,
  Biome.TropicalForest,
  Biome.Wetland,
]);

/** Draw forest marks. Returns the number of marks drawn. */
export function drawForestGlyphs(pass: RenderPass): number {
  const { ctx, layers, theme, scale, seed, quality } = pass;
  const n = layers.size;
  const height = layers.height;
  const ocean = layers.ocean;
  const lake = layers.lake;
  const biome = layers.biome;
  if (!biome || n < 16) return 0;
  const step = Math.max(3, Math.round(n / (quality === "export" ? 52 : 42)));
  const maxGlyphs = quality === "export" ? 700 : 280;
  const inc = cssRgb(theme.ink.soft, quality === "export" ? 0.34 : 0.4);
  let drawn = 0;
  ctx.save();
  ctx.strokeStyle = inc;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  for (let y = step; y < n - step; y += step) {
    if (drawn >= maxGlyphs) break;
    for (let x = step; x < n - step; x += step) {
      if (drawn >= maxGlyphs) break;
      const i = y * n + x;
      if (ocean[i] || lake[i]) continue;
      const b = biome[i];
      if (!FOREST_BIOMES.has(b)) continue;
      // Keep trees in the wetter part of the tile, not along dry fringes.
      if (hash01(x, y, seed + 3301) > (b === Biome.Wetland ? 0.45 : 0.86)) continue;
      const jx = (hash01(x, y, seed + 3307) - 0.5) * step;
      const jy = (hash01(x, y, seed + 3313) - 0.5) * step;
      const u = (x + jx) / n;
      const v = (y + jy) / n;
      if (u < 0.04 || u > 0.96 || v < 0.04 || v > 0.96) continue;
      const size = (3.1 + hash01(x, y, seed + 3319) * 3) * scale;
      drawTree(ctx, u * pass.width, v * pass.height, size, b, x + y * n, seed);
      drawn += 1;
      void height;
    }
  }
  ctx.restore();
  return drawn;
}

function drawTree(
  ctx: RenderPass["ctx"],
  x: number,
  y: number,
  size: number,
  biome: number,
  glyphSeed: number,
  seed: number,
): void {
  const conifer = biome === Biome.BorealForest || (biome === Biome.TemperateForest && hash01(glyphSeed, 7, seed) > 0.45);
  ctx.beginPath();
  if (conifer) {
    // Two stacked triangles + a trunk.
    const h = size * 2.1;
    const w = size * 0.85;
    ctx.moveTo(x - w, y + h * 0.35);
    ctx.lineTo(x, y - h * 0.45);
    ctx.lineTo(x + w, y + h * 0.35);
    ctx.moveTo(x - w * 0.7, y + h * 0.05);
    ctx.lineTo(x, y - h * 0.9);
    ctx.lineTo(x + w * 0.7, y + h * 0.05);
    ctx.moveTo(x, y + h * 0.35);
    ctx.lineTo(x, y + h * 0.75);
    ctx.lineWidth = Math.max(0.35, size * 0.22);
    ctx.stroke();
  } else {
    // Deciduous: rounded crown with a short trunk.
    const crown = size * 0.8;
    ctx.moveTo(x - crown, y);
    ctx.arc(x, y - crown * 0.5, crown, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.moveTo(x, y + 0.2 * crown);
    ctx.lineTo(x, y + size * 1.1);
    // Faint crown stipple.
    ctx.moveTo(x - crown * 0.4, y - crown * 0.9);
    ctx.lineTo(x - crown * 0.1, y - crown * 1.2);
    ctx.lineWidth = Math.max(0.35, size * 0.2);
    ctx.stroke();
  }
}
