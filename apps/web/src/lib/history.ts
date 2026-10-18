/** Generation history thumbnails + entry helpers. */
import type { WorldDocument } from "@atlas/core";

export interface GenerationHistoryEntry {
  id: string;
  document: WorldDocument;
  scenarioId: string;
  /** data:image/png;base64 thumbnail (small, generated from the preview bitmap). */
  thumbnail: string;
  createdAt: number;
}

export const MAX_GENERATION_HISTORY = 10;
export const THUMBNAIL_SIZE = 192;

/** Downscale a rendered preview canvas into a compact data URL. */
export function createThumbnail(canvas: HTMLCanvasElement | null): string {
  if (!canvas || typeof document === "undefined") return "";
  try {
    const target = document.createElement("canvas");
    target.width = THUMBNAIL_SIZE;
    target.height = THUMBNAIL_SIZE;
    const ctx = target.getContext("2d");
    if (!ctx) return "";
    ctx.drawImage(canvas, 0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
    return target.toDataURL("image/png");
  } catch {
    return "";
  }
}
