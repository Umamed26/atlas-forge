/** Small sampling helpers over normalized [0,1] world coordinates. */

/** Nearest-neighbour mask lookup (0/1 fields). */
export function sampleMask(mask: Uint8Array, size: number, u: number, v: number): number {
  const x = Math.min(size - 1, Math.max(0, Math.floor(u * size)));
  const y = Math.min(size - 1, Math.max(0, Math.floor(v * size)));
  return mask[y * size + x];
}

/** Bilinear scalar-field lookup from normalized coordinates. */
export function sampleScalar(field: ArrayLike<number>, size: number, u: number, v: number): number {
  let sx = u * size - 0.5;
  let sy = v * size - 0.5;
  if (sx < 0) sx = 0;
  else if (sx > size - 1) sx = size - 1;
  if (sy < 0) sy = 0;
  else if (sy > size - 1) sy = size - 1;
  const ix = Math.min(size - 2, sx | 0);
  const iy = Math.min(size - 2, sy | 0);
  const fx = sx - ix;
  const fy = sy - iy;
  const i00 = iy * size + ix;
  const i10 = i00 + 1;
  const i01 = i00 + size;
  const i11 = i01 + 1;
  const a = field[i00];
  const b = field[i10];
  const c = field[i01];
  const d = field[i11];
  return (a + (b - a) * fx) * (1 - fy) + (c + (d - c) * fx) * fy;
}

/** True when any 1-bit cell lies inside the normalized box (coarse probe). */
export function maskAnyInBox(
  mask: Uint8Array,
  size: number,
  minU: number,
  minV: number,
  maxU: number,
  maxV: number,
): boolean {
  const x0 = Math.max(0, Math.floor(minU * size));
  const x1 = Math.min(size - 1, Math.ceil(maxU * size));
  const y0 = Math.max(0, Math.floor(minV * size));
  const y1 = Math.min(size - 1, Math.ceil(maxV * size));
  for (let y = y0; y <= y1; y += 1) {
    const row = y * size;
    for (let x = x0; x <= x1; x += 1) {
      if (mask[row + x]) return true;
    }
  }
  return false;
}
