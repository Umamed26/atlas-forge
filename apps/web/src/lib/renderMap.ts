/** Render the parchment map into a detached canvas (main thread). */
import type { WorldDocument, WorldLayers } from "@atlas/core";
import { renderWorld, type Ctx2D } from "@atlas/render";

export function renderMapToCanvas(
  layers: WorldLayers,
  doc: WorldDocument,
  size: number,
  quality: "preview" | "export" = "preview",
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("无法创建 2D 渲染上下文");
  renderWorld({
    ctx: ctx as unknown as Ctx2D,
    width: size,
    height: size,
    document: doc,
    layers,
    quality,
  });
  return canvas;
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("PNG 编码失败（canvas.toBlob 返回空）"));
      }, "image/png");
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
