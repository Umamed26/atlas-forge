/** Shared context object handed to each vector pass. */
import type { WorldDocument, WorldLayers } from "@atlas/core";
import type { Ctx2D } from "./canvas-types";
import type { Quality, RenderTheme } from "./style";

export interface RenderPass {
  ctx: Ctx2D;
  width: number;
  height: number;
  /** Shorter output edge. */
  size: number;
  /** Pixels per 1024-design pixel (min(width,height) / 1024). */
  scale: number;
  theme: RenderTheme;
  seed: number;
  quality: Quality;
  document: WorldDocument;
  layers: WorldLayers;
  seaLevel: number;
}
