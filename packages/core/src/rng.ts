/**
 * Deterministic RNG + noise primitives.
 *
 * Everything here is pure and seed-driven: the pipeline must be byte-for-byte
 * reproducible for a given (document, size), including across process restarts
 * and across browser/Node. No Math.random, no Date.now, no Map iteration order.
 */

const UINT32 = 4294967296;
const INV_UINT32 = 1 / UINT32;

/** 2D integer hash -> uint32. Stable across JS engines (only Math.imul). */
export function hash2(x: number, y: number, seed: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(seed | 0, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** FNV-1a over a string, reduced to uint32. Used for content fingerprints. */
export function hashString(text: string, seed = 2166136261): number {
  let h = seed >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, deterministic PRNG returning floats in [0,1). */
export function makeRng(seed: number): () => number {
  let a = (seed | 0) >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) * INV_UINT32;
  };
}

export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** Smoothstep between two edges. */
export function smoothBetween(edge0: number, edge1: number, x: number): number {
  const t = clamp((x - edge0) / (edge1 - edge0 || 1e-12), 0, 1);
  return t * t * (3 - 2 * t);
}

/**
 * Classic value noise in "noise space" (integer lattice). ~20ns/eval: cheap
 * enough to call a few million times while building the low-res noise fields.
 */
export function valueNoise(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash2(xi, yi, seed) * INV_UINT32;
  const b = hash2(xi + 1, yi, seed) * INV_UINT32;
  const c = hash2(xi, yi + 1, seed) * INV_UINT32;
  const d = hash2(xi + 1, yi + 1, seed) * INV_UINT32;
  const top = a + (b - a) * u;
  const bottom = c + (d - c) * u;
  return top + (bottom - top) * v;
}

/** Fractal Brownian motion in noise space. */
export function fbm(
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
    sum += amp * valueNoise(x * freq, y * freq, seed + o * 1013);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

/**
 * Ridged multifractal: classic mountain-ridge generator. Returns 0..1 where 1 is
 * a crest. The gain is weighted by the previous octave so crests stay sharp
 * while slopes stay smooth.
 */
export function ridgedMultifractal(
  x: number,
  y: number,
  seed: number,
  octaves = 4,
  lacunarity = 2,
  gain = 0.5,
): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let weight = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o += 1) {
    let n = valueNoise(x * freq, y * freq, seed + o * 7919);
    n = 1 - Math.abs(2 * n - 1);
    n *= n;
    n *= weight;
    weight = clamp01(n * gain * 2);
    sum += n * amp;
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}

/**
 * Bilinear sample of a square field stored row-major at `fieldSize` resolution.
 * `u`/`v` are normalized coordinates; out-of-range values clamp to the border.
 */
export function sampleField(
  field: Float32Array,
  fieldSize: number,
  u: number,
  v: number,
): number {
  const max = fieldSize - 1;
  let fx = u * max;
  let fy = v * max;
  fx = fx < 0 ? 0 : fx > max ? max : fx;
  fy = fy < 0 ? 0 : fy > max ? max : fy;
  const x0 = fx | 0;
  const y0 = fy | 0;
  const x1 = x0 < max ? x0 + 1 : max;
  const y1 = y0 < max ? y0 + 1 : max;
  const tx = fx - x0;
  const ty = fy - y0;
  const a = field[y0 * fieldSize + x0];
  const b = field[y0 * fieldSize + x1];
  const c = field[y1 * fieldSize + x0];
  const d = field[y1 * fieldSize + x1];
  const top = a + (b - a) * tx;
  const bottom = c + (d - c) * tx;
  return top + (bottom - top) * ty;
}

/**
 * Build a square Float32Array field of normalized noise samples. `evaluate`
 * receives normalized coordinates in [0,1].
 */
export function buildField(
  fieldSize: number,
  evaluate: (u: number, v: number) => number,
): Float32Array {
  const field = new Float32Array(fieldSize * fieldSize);
  const inv = 1 / (fieldSize - 1);
  for (let y = 0; y < fieldSize; y += 1) {
    const v = y * inv;
    const row = y * fieldSize;
    for (let x = 0; x < fieldSize; x += 1) {
      field[row + x] = evaluate(x * inv, v);
    }
  }
  return field;
}
