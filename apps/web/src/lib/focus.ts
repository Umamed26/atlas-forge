/** Focus helpers: return keyboard focus to the map canvas after panel actions. */

export const MAP_CANVAS_SELECTOR = '[data-testid="map-canvas"]';

/** Focus the interactive map canvas (next frame, so React has re-rendered). */
export function focusMapCanvas(): void {
  if (typeof document === "undefined") return;
  const focus = () => {
    const canvas = document.querySelector<HTMLCanvasElement>(MAP_CANVAS_SELECTOR);
    if (!canvas) return;
    if (canvas.tabIndex < 0) canvas.tabIndex = 0;
    try {
      canvas.focus({ preventScroll: true });
    } catch {
      canvas.focus();
    }
  };
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(focus);
  } else {
    focus();
  }
}

/** True when the active element is inside the map canvas (or is the canvas). */
export function isMapFocused(): boolean {
  if (typeof document === "undefined") return false;
  return document.activeElement === document.querySelector(MAP_CANVAS_SELECTOR);
}
