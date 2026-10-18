/**
 * View / camera store: pan-zoom state of the interactive map stage.
 *
 * This is deliberately separate from the world document: zooming or panning is
 * pure view state and must never trigger a regeneration or an autosave.
 */
import { create } from "zustand";

import { BASE_RENDER_SIZE, MAX_ZOOM, MIN_ZOOM } from "../lib/constants";
import { clamp } from "../lib/utils";

/** Keep at least this many CSS pixels of the map visible on every axis. */
const EDGE_MARGIN = 48;

export interface ViewState {
  /** CSS pixels per base-render pixel (1 = 1:1). */
  scale: number;
  /** Translation in CSS pixels. */
  offsetX: number;
  offsetY: number;
  viewportW: number;
  viewportH: number;
  baseSize: number;
  /** True after the user panned / zoomed manually; resize stops auto-fitting. */
  userAdjusted: boolean;

  setViewport(width: number, height: number): void;
  fit(): void;
  oneToOne(): void;
  zoomAt(screenX: number, screenY: number, factor: number): void;
  zoomBy(factor: number): void;
  setOffset(x: number, y: number): void;
  panBy(dx: number, dy: number): void;
}

function fitScale(viewportW: number, viewportH: number, baseSize: number): number {
  const padding = 14;
  const available = Math.max(60, Math.min(viewportW, viewportH) - padding * 2);
  return clamp(available / baseSize, MIN_ZOOM, MAX_ZOOM);
}

function clampScale(scale: number, viewportW: number, viewportH: number, baseSize: number): number {
  const min = Math.max(MIN_ZOOM, fitScale(viewportW, viewportH, baseSize) * 0.5);
  return clamp(scale, min, MAX_ZOOM);
}

function clampOffset(
  offsetX: number,
  offsetY: number,
  scale: number,
  viewportW: number,
  viewportH: number,
  baseSize: number,
): { x: number; y: number } {
  const mapPx = baseSize * scale;
  const minX = EDGE_MARGIN - mapPx;
  const maxX = viewportW - EDGE_MARGIN;
  const minY = EDGE_MARGIN - mapPx;
  const maxY = viewportH - EDGE_MARGIN;
  return {
    x: clamp(offsetX, minX, maxX),
    y: clamp(offsetY, minY, maxY),
  };
}

function centeredOffset(scale: number, viewportW: number, viewportH: number, baseSize: number) {
  const mapPx = baseSize * scale;
  return {
    x: (viewportW - mapPx) / 2,
    y: (viewportH - mapPx) / 2,
  };
}

export const useViewStore = create<ViewState>()((set, get) => ({
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  viewportW: 0,
  viewportH: 0,
  baseSize: BASE_RENDER_SIZE,
  userAdjusted: false,

  setViewport(width, height) {
    const state = get();
    if (state.viewportW === width && state.viewportH === height) return;
    const baseSize = state.baseSize;
    if (state.viewportW === 0 || state.viewportH === 0) {
      const scale = fitScale(width, height, baseSize);
      const offset = centeredOffset(scale, width, height, baseSize);
      set({ viewportW: width, viewportH: height, scale, offsetX: offset.x, offsetY: offset.y });
      return;
    }
    if (!state.userAdjusted) {
      const scale = fitScale(width, height, baseSize);
      const offset = centeredOffset(scale, width, height, baseSize);
      set({ viewportW: width, viewportH: height, scale, offsetX: offset.x, offsetY: offset.y });
      return;
    }
    const scale = clampScale(state.scale, width, height, baseSize);
    const offset = clampOffset(state.offsetX, state.offsetY, scale, width, height, baseSize);
    set({
      viewportW: width,
      viewportH: height,
      scale,
      offsetX: offset.x,
      offsetY: offset.y,
    });
  },

  fit() {
    const { viewportW, viewportH, baseSize } = get();
    const scale = fitScale(viewportW, viewportH, baseSize);
    const offset = centeredOffset(scale, viewportW, viewportH, baseSize);
    set({
      scale,
      offsetX: offset.x,
      offsetY: offset.y,
      userAdjusted: false,
    });
  },

  oneToOne() {
    const { viewportW, viewportH, baseSize, scale, offsetX, offsetY } = get();
    // Keep the world point currently at the viewport centre fixed.
    const centerX = viewportW / 2;
    const centerY = viewportH / 2;
    const worldX = (centerX - offsetX) / (scale * baseSize);
    const worldY = (centerY - offsetY) / (scale * baseSize);
    const nextScale = 1;
    const nextOffset = clampOffset(
      centerX - worldX * nextScale * baseSize,
      centerY - worldY * nextScale * baseSize,
      nextScale,
      viewportW,
      viewportH,
      baseSize,
    );
    set({
      scale: nextScale,
      offsetX: nextOffset.x,
      offsetY: nextOffset.y,
      userAdjusted: true,
    });
  },

  zoomAt(screenX, screenY, factor) {
    const { scale, offsetX, offsetY, viewportW, viewportH, baseSize } = get();
    if (viewportW === 0 || viewportH === 0) return;
    const nextScale = clampScale(scale * factor, viewportW, viewportH, baseSize);
    if (Math.abs(nextScale - scale) < 1e-6) return;
    const mapX = (screenX - offsetX) / scale;
    const mapY = (screenY - offsetY) / scale;
    const nextOffset = clampOffset(
      screenX - mapX * nextScale,
      screenY - mapY * nextScale,
      nextScale,
      viewportW,
      viewportH,
      baseSize,
    );
    set({
      scale: nextScale,
      offsetX: nextOffset.x,
      offsetY: nextOffset.y,
      userAdjusted: true,
    });
  },

  zoomBy(factor) {
    const { viewportW, viewportH } = get();
    get().zoomAt(viewportW / 2, viewportH / 2, factor);
  },

  setOffset(x, y) {
    const { scale, viewportW, viewportH, baseSize } = get();
    const offset = clampOffset(x, y, scale, viewportW, viewportH, baseSize);
    set({ offsetX: offset.x, offsetY: offset.y, userAdjusted: true });
  },

  panBy(dx, dy) {
    const { offsetX, offsetY } = get();
    get().setOffset(offsetX + dx, offsetY + dy);
  },
}));

/** Convert normalized world coordinates → CSS pixel coordinates. */
export function worldToScreen(
  x: number,
  y: number,
  scale: number,
  offsetX: number,
  offsetY: number,
  baseSize: number,
): { x: number; y: number } {
  return { x: offsetX + x * baseSize * scale, y: offsetY + y * baseSize * scale };
}

/** Convert CSS pixel coordinates → normalized world coordinates. */
export function screenToWorld(
  x: number,
  y: number,
  scale: number,
  offsetX: number,
  offsetY: number,
  baseSize: number,
): { x: number; y: number } {
  const size = scale * baseSize;
  return { x: (x - offsetX) / size, y: (y - offsetY) / size };
}
