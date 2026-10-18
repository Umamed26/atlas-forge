/**
 * Atlas Forge renderer — M0 STUB.
 *
 * render-dev replaces this with the parchment rasterizer + vector overlays.
 * Contract:
 *  - pure function of (document, layers, output size)
 *  - must run both in browser (CanvasRenderingContext2D) and Node
 *    (@napi-rs/canvas), so only use members of Ctx2D.
 *  - pixel work goes through ImageData; vector overlays through path APIs.
 */
import type { WorldDocument, WorldLayers } from "@atlas/core";
import type { Ctx2D } from "./canvas-types";

export interface RenderWorldInput {
  ctx: Ctx2D;
  /** Output width in pixels. */
  width: number;
  /** Output height in pixels. */
  height: number;
  document: WorldDocument;
  layers: WorldLayers;
  quality?: "preview" | "export";
}

export type { Ctx2D } from "./canvas-types";
export type { Gradient2D, ImageDataLike } from "./canvas-types";

function sample(layers: WorldLayers, u: number, v: number): number {
  const x = Math.min(layers.size - 1, Math.max(0, Math.round(u * (layers.size - 1))));
  const y = Math.min(layers.size - 1, Math.max(0, Math.round(v * (layers.size - 1))));
  return y * layers.size + x;
}

const OCEAN_DEEP: [number, number, number] = [74, 92, 88];
const OCEAN_SHALLOW: [number, number, number] = [104, 124, 116];
const LAND_LOW: [number, number, number] = [214, 200, 156];
const LAND_MID: [number, number, number] = [176, 158, 108];
const LAND_HIGH: [number, number, number] = [150, 132, 96];
const LAND_PEAK: [number, number, number] = [232, 226, 210];

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** M0 stub renderer: hypsometric tint + simple water. */
export function renderWorld(input: RenderWorldInput): void {
  const { ctx, width, height, layers, document } = input;
  const image = ctx.createImageData(width, height);
  const data = image.data;
  const seaLevel = document.params.seaLevel;
  const span = Math.max(0.0001, 1 - seaLevel);
  const paper = 0.55 * document.style.paperTexture;

  for (let y = 0; y < height; y += 1) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x += 1) {
      const u = (x + 0.5) / width;
      const i = sample(layers, u, v);
      const h = layers.height[i];
      let rgb: [number, number, number];
      if (layers.ocean[i] || layers.lake[i]) {
        const depth = Math.min(1, Math.max(0, (seaLevel - h) / Math.max(1e-4, seaLevel)));
        rgb = mix(OCEAN_SHALLOW, OCEAN_DEEP, depth);
      } else {
        const t = Math.min(1, Math.max(0, (h - seaLevel) / span));
        rgb = t < 0.45 ? mix(LAND_LOW, LAND_MID, t / 0.45) : t < 0.8 ? mix(LAND_MID, LAND_HIGH, (t - 0.45) / 0.35) : mix(LAND_HIGH, LAND_PEAK, (t - 0.8) / 0.2);
      }
      const grain = (Math.sin((x * 12.9898 + y * 78.233) * 0.1) * 43758.5453) % 1;
      const noise = (grain - Math.floor(grain) - 0.5) * 10 * paper;
      const o = (y * width + x) * 4;
      data[o] = Math.max(0, Math.min(255, rgb[0] + noise));
      data[o + 1] = Math.max(0, Math.min(255, rgb[1] + noise));
      data[o + 2] = Math.max(0, Math.min(255, rgb[2] + noise));
      data[o + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}
