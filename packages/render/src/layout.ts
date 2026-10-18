/** Small 2D layout helpers shared by labels and decorations. */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function hitsAny(rect: Rect, blockers: Rect[]): boolean {
  for (let i = 0; i < blockers.length; i += 1) {
    if (intersects(rect, blockers[i])) return true;
  }
  return false;
}

/** Bounds of a map canvas after the decorative frame is accounted for. */
export function frameBounds(width: number, height: number, inset: number): Rect {
  return { x: inset, y: inset, w: width - inset * 2, h: height - inset * 2 };
}
