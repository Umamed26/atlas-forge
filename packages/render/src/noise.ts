/**
 * Deterministic noise / hash utilities shared by the rasterizer and the vector
 * overlays. Everything here is a pure function of its inputs: the renderer must
 * produce identical pixels in the browser and in Node for the same document.
 *
 * No Math.random, no Date, no platform APIs.
 */

/** 32-bit integer hash of a lattice point + seed. */
export function hashU32(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Deterministic value in [0, 1). */
export function hash01(x: number, y: number, seed: number): number {
  return hashU32(x, y, seed) / 4294967296;
}

/** Deterministic value in [-1, 1). */
export function hashSigned(x: number, y: number, seed: number): number {
  return hashU32(x, y, seed) / 2147483648 - 1;
}

function smoothStep(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Smooth 2D value noise in [0, 1). */
export function valueNoise2(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = smoothStep(xf);
  const v = smoothStep(yf);
  const a = hash01(xi, yi, seed);
  const b = hash01(xi + 1, yi, seed);
  const c = hash01(xi, yi + 1, seed);
  const d = hash01(xi + 1, yi + 1, seed);
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/** Multi-octave value noise (fBm) in [0, 1]. */
export function fbm2(
  x: number,
  y: number,
  seed: number,
  octaves = 4,
  lacunarity = 2,
  gain = 0.5,
): number {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o += 1) {
    sum += amp * valueNoise2(x * freq, y * freq, seed + o * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/** Smooth 1D value noise in [0, 1). */
export function valueNoise1(x: number, seed: number): number {
  const xi = Math.floor(x);
  const xf = x - xi;
  const u = smoothStep(xf);
  const a = hash01(xi, 0, seed);
  const b = hash01(xi + 1, 0, seed);
  return a + (b - a) * u;
}

/** Signed smooth 1D noise in [-1, 1), useful for hand-drawn jitter. */
export function signedNoise1(x: number, seed: number): number {
  return valueNoise1(x, seed) * 2 - 1;
}

/** Fast seeded PRNG (mulberry32). Returns values in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded random helper with range utilities. */
export class SeededRandom {
  private readonly rng: () => number;

  constructor(seed: number) {
    this.rng = mulberry32(seed);
  }

  next(): number {
    return this.rng();
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.rng();
  }

  /** Symmetric jitter in [-amount, amount]. */
  jitter(amount: number): number {
    return (this.rng() * 2 - 1) * amount;
  }

  int(maxExclusive: number): number {
    return Math.min(maxExclusive - 1, Math.floor(this.rng() * maxExclusive));
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)];
  }
}

/** Mix two scalar values. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Clamp a scalar. */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Smoothstep clamped to [0, 1]. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1e-6), 0, 1);
  return t * t * (3 - 2 * t);
}
