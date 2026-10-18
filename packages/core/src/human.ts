/**
 * Human stage: habitability scoring, settlement siting, procedural naming
 * (Latin + CJK syllables) and automatic map labels.
 *
 * Determinism: all naming RNGs are derived from hash(seed, cellX, cellY), so a
 * name sticks to a place even when downstream parameters change. The stage is a
 * pure function of its inputs; pinned user entries are overlaid at the very end
 * and hiddenIds are filtered at assembly time only.
 */
import { clamp, clamp01, hash2, makeRng } from "./rng";
import {
  Biome,
  type BiomeId,
  type MapLabel,
  type Settlement,
  type SettlementKind,
  type WorldOverrides,
  type WorldParams,
} from "./types";

export interface HumanInput {
  size: number;
  seed: number;
  params: WorldParams;
  height: Float32Array;
  filled: Float32Array;
  ocean: Uint8Array;
  lake: Uint8Array;
  river: Uint8Array;
  flow: Float32Array;
  temperature: Float32Array;
  moisture: Float32Array;
  biome: Uint8Array;
  riverThreshold?: number;
  overrides: WorldOverrides;
  settlements?: readonly Settlement[];
  labels?: readonly MapLabel[];
}

export interface HumanResult {
  settlements: Settlement[];
  autoLabels: MapLabel[];
}

const NEIGHBOR_DX = [-1, 1, 0, 0, -1, 1, -1, 1] as const;
const NEIGHBOR_DY = [0, 0, -1, 1, -1, -1, 1, 1] as const;

/** Habitability adjustment by biome. */
const BIOME_HABITABILITY: Record<BiomeId, number> = {
  [Biome.Ocean]: 0,
  [Biome.Lake]: 0,
  [Biome.Ice]: -0.85,
  [Biome.Tundra]: -0.35,
  [Biome.BorealForest]: -0.08,
  [Biome.TemperateForest]: 0.04,
  [Biome.Grassland]: 0.08,
  [Biome.Shrubland]: -0.04,
  [Biome.Savanna]: 0.03,
  [Biome.Desert]: -0.5,
  [Biome.TropicalForest]: 0.03,
  [Biome.Wetland]: -0.12,
  [Biome.Beach]: 0.1,
  [Biome.Mountain]: -0.45,
  [Biome.SnowPeak]: -0.9,
};

// ── Naming ────────────────────────────────────────────────────────────────

const LATIN_ONSETS = [
  "b", "br", "c", "ch", "d", "dr", "f", "g", "gr", "h", "l", "m", "n", "p",
  "r", "s", "sh", "st", "t", "th", "v", "w", "y", "z",
];
const LATIN_VOWELS = ["a", "e", "i", "o", "u", "ae", "ia", "io", "au", "ei"];
const LATIN_CODAS = ["", "", "", "n", "r", "l", "s", "th", "m", "nd", "rn", "st", "x"];

// Curated naming morphemes.
//
// CJK names are built as [stem][type suffix]:
//  - water stem = qualifier + neutral noun (银湾 + 河, 苍石 + 溪);
//    stems never contain water characters, so suffixes never repeat a character.
//  - region = qualifier + landform (雾野, 长风原), 2-3 chars.
//  - mountain = qualifier(+noun stem) + 山脉/岭/峰群.
//  - settlement = qualifier + place noun + 城/港/堡/津/镇 (by settlement kind).
// Latin names follow the same stem + suffix construction.
const CJK_QUALIFIER = "苍白青碧赤玄金银铁长永新古远高深天星云风月霜雪雾露寒暖清幽黛绯墨湛岚春秋晨暮遥孤明澄";
const CJK_WATER_NOUN = "湾石林鹿鹰狼龙凤花叶崖岩洲滩屿";
const CJK_MOUNTAIN_NOUN = "岩崖壑石谷岫岑";
const CJK_REGION_MODIFIER = ["长风", "青霜", "白露", "苍云", "玄冰", "赤霞", "金月", "银霜", "碧云", "寒星"];
const CJK_REGION_NOUN = "原野林谷岭州陆域疆漠洲";
const CJK_SETTLEMENT_NOUN = "川湾石林原岗丘洲滩浦坡";
const CJK_WATER_SUFFIX = ["河", "溪", "川", "湖", "海", "泽"];
const CJK_RIVER_SUFFIX = ["河", "溪", "川"];
const CJK_LAKE_SUFFIX = ["湖", "泽"];
const CJK_MOUNTAIN_SUFFIX = ["山脉", "岭", "峰群"];
const CJK_SETTLEMENT_SUFFIX: Record<string, string> = {
  city: "城",
  town: "镇",
  port: "港",
  fortress: "堡",
  ruin: "墟",
  custom: "",
};

const LATIN_PREFIX = [
  "Ael", "Ar", "Bel", "Cael", "Dun", "El", "Fen", "Gal", "Hal", "Ith", "Kel",
  "Lor", "Mor", "Nim", "Or", "Pel", "Quel", "Rav", "Sel", "Tar", "Umb", "Val",
  "Wyn", "Yor", "Zel",
];
const LATIN_REGION_SUFFIX = ["vale", "wood", "moor", "wold", "reach", "march", "land"];
const LATIN_MOUNTAIN_SUFFIX = [" Mountains", " Peaks", " Range", " Heights"];
const LATIN_RIVER_SUFFIX = [" River", " Stream", " Water"];
const LATIN_LAKE_SUFFIX = [" Lake"];
const LATIN_SEA_SUFFIX = [" Sea", " Ocean"];
const LATIN_SETTLEMENT_SUFFIX: Record<string, string[]> = {
  city: ["ton", "burg", "holm"],
  town: ["ford", "wick", "stead"],
  port: ["port", "haven", "mouth"],
  fortress: ["hold", "gate", "keep"],
  ruin: ["rest", "fell"],
  custom: [""],
};
const WATER_CHARS = "海湖河溪川泉泽";

type PlaceKind = "settlement" | "sea" | "lake" | "river" | "mountain" | "region";

function pick<T>(rng: () => number, values: readonly T[]): T {
  return values[Math.floor(rng() * values.length) % values.length];
}

function pickChar(rng: () => number, pool: string, exclude?: string): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const char = pool.charAt(Math.floor(rng() * pool.length) % pool.length);
    if (!exclude || !exclude.includes(char)) return char;
  }
  return pool.charAt(0);
}

/** 1-2 character CJK stem: qualifier + neutral noun, no duplicate characters. */
function cjkStem(rng: () => number, nounPool: string, exclude: string): string {
  const first = pickChar(rng, CJK_QUALIFIER, exclude);
  const second = pickChar(rng, nounPool, exclude + first);
  return first + second;
}

function cjkWaterStem(rng: () => number, suffix: string): string {
  return cjkStem(rng, CJK_WATER_NOUN, suffix + WATER_CHARS + "山脉");
}

function latinStem(rng: () => number, suffixHint: string): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const prefix = pick(rng, LATIN_PREFIX);
    const syllable = prefix.toLowerCase().replace(/[^aeiouy]/g, "");
    if (!suffixHint || !syllable.includes(suffixHint.toLowerCase().slice(0, 1))) return prefix;
  }
  return pick(rng, LATIN_PREFIX);
}

function latinSettlementSuffix(rng: () => number, kind: string): string {
  const options = LATIN_SETTLEMENT_SUFFIX[kind] ?? [""];
  return pick(rng, options);
}

function cjkRegionWord(rng: () => number): string {
  const noun = pickChar(rng, CJK_REGION_NOUN, WATER_CHARS);
  if (rng() < 0.34) {
    const modifier = pick(rng, CJK_REGION_MODIFIER);
    for (const char of modifier) if (WATER_CHARS.includes(char)) return noun;
    return modifier + noun;
  }
  return pickChar(rng, CJK_QUALIFIER) + noun;
}

function cjkMountainWord(rng: () => number): string {
  const first = pickChar(rng, CJK_QUALIFIER, WATER_CHARS + "山脉岭峰");
  const second = pickChar(rng, CJK_MOUNTAIN_NOUN, WATER_CHARS + "山脉岭峰" + first);
  return first + second;
}

function cjkSettlementWord(rng: () => number, kind: string): string {
  const stem = cjkStem(rng, CJK_SETTLEMENT_NOUN, "城港堡津镇墟");
  return stem + (CJK_SETTLEMENT_SUFFIX[kind] ?? "");
}

function latinRegionWord(rng: () => number): string {
  return latinStem(rng, "") + pick(rng, LATIN_REGION_SUFFIX);
}

class Namer {
  private readonly cjk: boolean;
  private readonly seed: number;
  private readonly used = new Set<string>();

  constructor(seed: number, language: "auto" | "cjk" | "latin" = "auto") {
    this.seed = seed;
    // Explicit params.namingLanguage wins; "auto" keeps the historical
    // seed-hash choice so old documents and seeds render exactly as before.
    this.cjk =
      language === "cjk" ? true : language === "latin" ? false : (hash2(seed, 0x5eed, 0x1234) & 1) === 1;
  }

  private rngFor(qx: number, qy: number, salt: number, kindSaltValue: number): () => number {
    return makeRng(hash2(qx, qy, (this.seed ^ 0x51ed270b ^ (salt * 0x9e3779b1) ^ kindSaltValue) | 0));
  }

  private unique(make: (rng: () => number) => string, qx: number, qy: number, kind: number): string {
    for (let salt = 0; salt < 48; salt += 1) {
      const candidate = make(this.rngFor(qx, qy, salt, kind));
      if (!this.used.has(candidate)) {
        this.used.add(candidate);
        return candidate;
      }
    }
    // Practically unreachable: disambiguate with a stable extra syllable.
    const base = make(this.rngFor(qx, qy, 97, kind));
    const extra = this.cjk ? pickChar(makeRng(hash2(qx, qy, this.seed ^ this.used.size) | 0), CJK_QUALIFIER) : "a";
    const fallback = base + extra;
    this.used.add(fallback);
    return fallback;
  }

  settlement(kind: string, qx: number, qy: number): string {
    return this.unique(
      (rng) => (this.cjk ? cjkSettlementWord(rng, kind) : latinStem(rng, "") + latinSettlementSuffix(rng, kind)),
      qx,
      qy,
      kindSalt("settlement"),
    );
  }

  label(kind: Exclude<PlaceKind, "settlement">, qx: number, qy: number): string {
    return this.unique(
      (rng) => {
        if (this.cjk) {
          switch (kind) {
            case "sea":
              return cjkWaterStem(rng, "海") + "海";
            case "lake":
              return cjkWaterStem(rng, "湖") + pick(rng, CJK_LAKE_SUFFIX);
            case "river":
              return cjkWaterStem(rng, "河") + pick(rng, CJK_RIVER_SUFFIX);
            case "mountain":
              return cjkMountainWord(rng) + pick(rng, CJK_MOUNTAIN_SUFFIX);
            default:
              return cjkRegionWord(rng);
          }
        }
        switch (kind) {
          case "sea":
            return latinStem(rng, "") + pick(rng, LATIN_SEA_SUFFIX);
          case "lake":
            return "Lake " + latinStem(rng, "");
          case "river":
            return latinStem(rng, "") + pick(rng, LATIN_RIVER_SUFFIX);
          case "mountain":
            return latinStem(rng, "") + pick(rng, LATIN_MOUNTAIN_SUFFIX);
          default:
            return latinRegionWord(rng);
        }
      },
      qx,
      qy,
      kindSalt(kind),
    );
  }
}

function kindSalt(kind: PlaceKind): number {
  switch (kind) {
    case "settlement":
      return 0;
    case "sea":
      return 2147483647;
    case "lake":
      return 1073741789;
    case "river":
      return 536870909;
    case "mountain":
      return 268435399;
    default:
      return 134217689;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function quantize(value: number): number {
  return Math.round(value * 4096);
}

// ── Stage entry ───────────────────────────────────────────────────────────

export function generateHuman(input: HumanInput): HumanResult {
  const size = input.size;
  const cells = size * size;
  const {
    height,
    filled,
    ocean,
    lake,
    river,
    flow,
    temperature,
    moisture,
    biome,
  } = input;
  const seaLevel = clamp(input.params.seaLevel, 0.02, 0.95);
  const seaSpan = Math.max(0.05, 1 - seaLevel);
  const namer = new Namer(input.seed, input.params.namingLanguage ?? "auto");
  const overrides = input.overrides ?? { elevation: [], riverForce: [], biome: [], hiddenIds: [] };

  // ── Land fraction ──────────────────────────────────────────────────────
  let oceanCount = 0;
  for (let i = 0; i < cells; i += 1) if (ocean[i]) oceanCount += 1;
  const landFraction = (cells - oceanCount) / cells;

  // ── Settlement candidates ──────────────────────────────────────────────
  const stride = Math.max(1, Math.floor(size / 256));
  const maxCandidates = Math.ceil(cells / (stride * stride));
  const candidateIndex = new Int32Array(maxCandidates);
  const candidateScore = new Float32Array(maxCandidates);
  let candidateCount = 0;
  const seedJitter = input.seed ^ 0x1234567;

  for (let y = 0; y < size; y += stride) {
    const row = y * size;
    for (let x = 0; x < size; x += stride) {
      const i = row + x;
      if (ocean[i] || lake[i]) continue;
      const b = biome[i] as BiomeId;
      const bonus = BIOME_HABITABILITY[b] ?? 0;
      if (bonus < -0.6) continue;
      const t = temperature[i];
      const m = moisture[i];
      const altitude = clamp01((height[i] - seaLevel) / seaSpan);
      let score =
        0.4 * (1 - Math.min(1, Math.abs(t - 0.56) / 0.3)) +
        0.24 * (1 - Math.min(1, Math.abs(m - 0.52) / 0.38)) +
        bonus;
      if (altitude > 0.32) score -= (altitude - 0.32) * 1.4;
      // Water access (very cheap: only evaluated for candidates).
      let flags = 0;
      for (let k = 0; k < 8; k += 1) {
        const nx = x + NEIGHBOR_DX[k];
        const ny = y + NEIGHBOR_DY[k];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const nIndex = ny * size + nx;
        if (ocean[nIndex]) flags |= 1;
        else if (river[nIndex]) flags |= 2;
      }
      if ((flags & 1) !== 0) score += 0.22;
      if ((flags & 2) !== 0) score += 0.14;
      score += (hash2(x, y, seedJitter) / 4294967296 - 0.5) * 0.14;
      score = clamp01(score);
      candidateIndex[candidateCount] = i;
      candidateScore[candidateCount] = score;
      candidateCount += 1;
    }
  }

  // Bucket-sort candidates by score (deterministic, no comparator sort).
  const buckets = 128;
  const bucketCounts = new Int32Array(buckets);
  for (let c = 0; c < candidateCount; c += 1) {
    const bucket = Math.min(buckets - 1, Math.floor(candidateScore[c] * buckets));
    bucketCounts[bucket] += 1;
  }
  const bucketStart = new Int32Array(buckets);
  let running = 0;
  for (let b = 0; b < buckets; b += 1) {
    bucketStart[b] = running;
    running += bucketCounts[b];
  }
  const sortedCandidates = new Int32Array(candidateCount);
  const cursor = new Int32Array(buckets);
  for (let b = 0; b < buckets; b += 1) cursor[b] = bucketStart[b];
  for (let c = 0; c < candidateCount; c += 1) {
    const bucket = Math.min(buckets - 1, Math.floor(candidateScore[c] * buckets));
    sortedCandidates[cursor[bucket]++] = c;
  }

  // Greedy selection with minimum spacing.
  const targetCount = clamp(Math.round(6 + landFraction * 50), 6, 48);
  const minSpacing = Math.max(4, size * 0.055);
  const minSpacing2 = minSpacing * minSpacing;
  const selectedIdx: number[] = [];
  const selectedX: number[] = [];
  const selectedY: number[] = [];
  const selectedScores: number[] = [];
  outer: for (let b = buckets - 1; b >= 0; b -= 1) {
    const end = bucketStart[b] + bucketCounts[b];
    for (let c = bucketStart[b]; c < end; c += 1) {
      const candidate = sortedCandidates[c];
      if (candidateScore[candidate] < 0.42) continue;
      const cell = candidateIndex[candidate];
      const x = cell % size;
      const y = (cell / size) | 0;
      let blocked = false;
      for (let s = 0; s < selectedIdx.length; s += 1) {
        const dx = x - selectedX[s];
        const dy = y - selectedY[s];
        if (dx * dx + dy * dy < minSpacing2) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      selectedIdx.push(cell);
      selectedX.push(x);
      selectedY.push(y);
      selectedScores.push(candidateScore[candidate]);
      if (selectedIdx.length >= targetCount) break outer;
    }
  }

  // ── Build settlements ──────────────────────────────────────────────────
  const generatedSettlements: Settlement[] = [];
  for (let s = 0; s < selectedIdx.length; s += 1) {
    const cell = selectedIdx[s];
    const x = selectedX[s];
    const y = selectedY[s];
    const b = biome[cell] as BiomeId;
    const altitude = clamp01((height[cell] - seaLevel) / seaSpan);
    const coastal = (() => {
      for (let k = 0; k < 8; k += 1) {
        const nx = x + NEIGHBOR_DX[k];
        const ny = y + NEIGHBOR_DY[k];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        if (ocean[ny * size + nx]) return true;
      }
      return false;
    })();
    const riverBank = (() => {
      for (let k = 0; k < 8; k += 1) {
        const nx = x + NEIGHBOR_DX[k];
        const ny = y + NEIGHBOR_DY[k];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        if (river[ny * size + nx]) return true;
      }
      return false;
    })();
    const score = selectedScores[s];
    const rng = makeRng(hash2(x, y, (input.seed ^ 0x0ddba11) | 0));
    let kind: SettlementKind;
    if (coastal && score > 0.55) kind = "port";
    else if (score > 0.7 || s < 2) kind = "city";
    else if (altitude > 0.26 && (b === Biome.Mountain || b === Biome.SnowPeak)) kind = "fortress";
    else if (rng() < 0.05) kind = "ruin";
    else if (riverBank && rng() < 0.2) kind = "fortress";
    else kind = "town";
    const population =
      kind === "city"
        ? Math.round(18000 + rng() * 120000)
        : kind === "port"
          ? Math.round(8000 + rng() * 70000)
          : kind === "town"
            ? Math.round(700 + rng() * 14000)
            : kind === "fortress"
              ? Math.round(60 + rng() * 500)
              : 0;
    const nX = (x + 0.5) / size;
    const nY = (y + 0.5) / size;
    const name = namer.settlement(kind, x, y);
    generatedSettlements.push({
      id: `st-${quantize(nX)}-${quantize(nY)}`,
      name,
      kind,
      x: nX,
      y: nY,
      population,
    });
  }

  // ── Sea / ocean labels: open water = far from any shore ───────────────
  // Distance transform runs on a coarse grid (<=192²) and is refined to the
  // nearest full-res ocean cell, so label placement costs ~2ms at any size.
  const autoLabels: MapLabel[] = [];
  const labelPriorities: number[] = [];
  const addLabel = (label: MapLabel, priority: number): void => {
    autoLabels.push(label);
    labelPriorities.push(priority);
  };
  const coarse = Math.max(8, Math.min(size, 192));
  const coarseStep = size / coarse;
  const coarseOcean = new Uint8Array(coarse * coarse);
  for (let cy = 0; cy < coarse; cy += 1) {
    const sy = Math.min(size - 1, Math.floor((cy + 0.5) * coarseStep));
    for (let cx = 0; cx < coarse; cx += 1) {
      const sx = Math.min(size - 1, Math.floor((cx + 0.5) * coarseStep));
      coarseOcean[cy * coarse + cx] = ocean[sy * size + sx];
    }
  }
  const BIG = 1e9;
  const cdist = new Float32Array(coarse * coarse);
  for (let i = 0; i < coarse * coarse; i += 1) cdist[i] = coarseOcean[i] ? BIG : 0;
  const DIAG = 1.41421356;
  for (let cy = 0; cy < coarse; cy += 1) {
    const row = cy * coarse;
    for (let cx = 0; cx < coarse; cx += 1) {
      const i = row + cx;
      let d = cdist[i];
      if (d === 0) continue;
      if (cx > 0) {
        const c = cdist[i - 1] + 1;
        if (c < d) d = c;
      }
      if (cy > 0) {
        const c = cdist[i - coarse] + 1;
        if (c < d) d = c;
        if (cx > 0) {
          const c2 = cdist[i - coarse - 1] + DIAG;
          if (c2 < d) d = c2;
        }
        if (cx < coarse - 1) {
          const c2 = cdist[i - coarse + 1] + DIAG;
          if (c2 < d) d = c2;
        }
      }
      cdist[i] = d;
    }
  }
  for (let cy = coarse - 1; cy >= 0; cy -= 1) {
    const row = cy * coarse;
    for (let cx = coarse - 1; cx >= 0; cx -= 1) {
      const i = row + cx;
      let d = cdist[i];
      if (d === 0) continue;
      if (cx < coarse - 1) {
        const c = cdist[i + 1] + 1;
        if (c < d) d = c;
      }
      if (cy < coarse - 1) {
        const c = cdist[i + coarse] + 1;
        if (c < d) d = c;
        if (cx < coarse - 1) {
          const c2 = cdist[i + coarse + 1] + DIAG;
          if (c2 < d) d = c2;
        }
        if (cx > 0) {
          const c2 = cdist[i + coarse - 1] + DIAG;
          if (c2 < d) d = c2;
        }
      }
      cdist[i] = d;
    }
  }
  /** Refine a coarse open-water cell to a full-res ocean cell near its centre. */
  const refineSea = (ccx: number, ccy: number): { x: number; y: number } | null => {
    const bx = Math.min(size - 1, Math.floor((ccx + 0.5) * coarseStep));
    const by = Math.min(size - 1, Math.floor((ccy + 0.5) * coarseStep));
    for (let ring = 0; ring < Math.ceil(coarseStep * 2) + 2; ring += 1) {
      for (let dy = -ring; dy <= ring; dy += 1) {
        for (let dx = -ring; dx <= ring; dx += 1) {
          if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
          const x = bx + dx;
          const y = by + dy;
          if (x < 0 || y < 0 || x >= size || y >= size) continue;
          if (ocean[y * size + x]) return { x, y };
        }
      }
    }
    return null;
  };
  let bestCoarse = -1;
  let bestCoarseD = -1;
  for (let i = 0; i < coarse * coarse; i += 1) {
    if (!coarseOcean[i]) continue;
    if (cdist[i] > bestCoarseD) {
      bestCoarseD = cdist[i];
      bestCoarse = i;
    }
  }
  if (bestCoarse >= 0 && bestCoarseD >= 1) {
    const fq = refineSea(bestCoarse % coarse, (bestCoarse / coarse) | 0);
    if (fq) {
      addLabel(
        {
          id: `sea-${quantize((fq.x + 0.5) / size)}-${quantize((fq.y + 0.5) / size)}`,
          text: namer.label("sea", fq.x, fq.y),
          kind: "water",
          x: (fq.x + 0.5) / size,
          y: (fq.y + 0.5) / size,
        },
        5,
      );
      const farCoarse = Math.max(3, Math.round((size * 0.3) / coarseStep));
      let secondCoarse = -1;
      let secondD = -1;
      const fqCX = bestCoarse % coarse;
      const fqCY = (bestCoarse / coarse) | 0;
      for (let i = 0; i < coarse * coarse; i += 1) {
        if (!coarseOcean[i]) continue;
        const cx = i % coarse;
        const cy = (i / coarse) | 0;
        if (Math.abs(cx - fqCX) + Math.abs(cy - fqCY) < farCoarse) continue;
        if (cdist[i] > secondD) {
          secondD = cdist[i];
          secondCoarse = i;
        }
      }
      if (secondCoarse >= 0 && secondD > 0 && secondD >= bestCoarseD * 0.4) {
        const sq = refineSea(secondCoarse % coarse, (secondCoarse / coarse) | 0);
        if (sq) {
          addLabel(
            {
              id: `sea-${quantize((sq.x + 0.5) / size)}-${quantize((sq.y + 0.5) / size)}`,
              text: namer.label("sea", sq.x, sq.y),
              kind: "water",
              x: (sq.x + 0.5) / size,
              y: (sq.y + 0.5) / size,
            },
            5,
          );
        }
      }
    }
  }

  // ── Lake labels ────────────────────────────────────────────────────────
  const queue = new Int32Array(cells);
  let queueHead = 0;
  let queueTail = 0;
  const lakeSeen = new Uint8Array(cells);
  const lakeComponents: { size: number; x: number; y: number }[] = [];
  for (let start = 0; start < cells; start += 1) {
    if (!lake[start] || lakeSeen[start]) continue;
    queueHead = 0;
    queueTail = 0;
    queue[queueTail++] = start;
    lakeSeen[start] = 1;
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    while (queueHead < queueTail) {
      const cell = queue[queueHead++];
      const cx = cell % size;
      const cy = (cell / size) | 0;
      count += 1;
      sumX += cx;
      sumY += cy;
      for (let k = 0; k < 8; k += 1) {
        const nx = cx + NEIGHBOR_DX[k];
        const ny = cy + NEIGHBOR_DY[k];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const nIndex = ny * size + nx;
        if (!lake[nIndex] || lakeSeen[nIndex]) continue;
        lakeSeen[nIndex] = 1;
        queue[queueTail++] = nIndex;
      }
    }
    if (count >= Math.max(8, Math.round(cells * 0.00002))) {
      lakeComponents.push({ size: count, x: Math.round(sumX / count), y: Math.round(sumY / count) });
    }
  }
  lakeComponents.sort((a, b) => b.size - a.size || a.y - b.y || a.x - b.x);
  for (let l = 0; l < Math.min(6, lakeComponents.length); l += 1) {
    const comp = lakeComponents[l];
    addLabel(
      {
        id: `lake-${quantize((comp.x + 0.5) / size)}-${quantize((comp.y + 0.5) / size)}`,
        text: namer.label("lake", comp.x, comp.y),
        kind: "water",
        x: (comp.x + 0.5) / size,
        y: (comp.y + 0.5) / size,
      },
      2,
    );
  }

  // ── River labels: follow the largest rivers downhill ───────────────────
  const threshold = input.riverThreshold ?? 32;
  const midRivers: number[] = [];
  for (let i = 0; i < cells; i += 1) {
    if (!river[i]) continue;
    // Mid-reaches keep the traced line long; mouths would trace for 2-3 cells.
    if (flow[i] > threshold && flow[i] < threshold * 12) midRivers.push(i);
  }
  midRivers.sort((a, b) => flow[b] - flow[a] || a - b);
  const riverStarters = midRivers.length > 64 ? midRivers.slice(0, 64) : midRivers;
  const riverLabelSpots: { x: number; y: number }[] = [];
  for (const start of riverStarters) {
    if (riverLabelSpots.length >= 8) break;
    const path: number[] = [];
    let cell = start;
    let guard = 0;
    const maxSteps = size * 2;
    while (guard < maxSteps) {
      guard += 1;
      path.push(cell);
      if (ocean[cell] || lake[cell]) break;
      const cx = cell % size;
      const cy = (cell / size) | 0;
      let best = -1;
      let bestFilled = filled[cell];
      for (let k = 0; k < 8; k += 1) {
        const nx = cx + NEIGHBOR_DX[k];
        const ny = cy + NEIGHBOR_DY[k];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const nIndex = ny * size + nx;
        if (filled[nIndex] < bestFilled) {
          bestFilled = filled[nIndex];
          best = nIndex;
        }
      }
      if (best < 0) break;
      cell = best;
    }
    if (path.length < Math.max(8, size * 0.06)) continue;
    const mid = path[Math.floor(path.length / 2)];
    const mx = mid % size;
    const my = (mid / size) | 0;
    let tooClose = false;
    for (const spot of riverLabelSpots) {
      const dx = mx - spot.x;
      const dy = my - spot.y;
      if (Math.sqrt(dx * dx + dy * dy) < size * 0.13) {
        tooClose = true;
        break;
      }
    }
    if (tooClose) continue;
    riverLabelSpots.push({ x: mx, y: my });
    addLabel(
      {
        id: `river-${quantize((mx + 0.5) / size)}-${quantize((my + 0.5) / size)}`,
        text: namer.label("river", mx, my),
        kind: "water",
        x: (mx + 0.5) / size,
        y: (my + 0.5) / size,
      },
      1,
    );
  }

  // ── Mountain range labels (from high-altitude components) ─────────────
  const highMask = new Uint8Array(cells);
  const highThreshold = seaLevel + 0.42 * seaSpan;
  for (let i = 0; i < cells; i += 1) {
    if (ocean[i] || lake[i]) continue;
    const b = biome[i];
    if (b === Biome.Mountain || b === Biome.SnowPeak || height[i] > highThreshold) highMask[i] = 1;
  }
  const highSeen = new Uint8Array(cells);
  const mountainComponents: { size: number; x: number; y: number; peak: number }[] = [];
  for (let start = 0; start < cells; start += 1) {
    if (!highMask[start] || highSeen[start]) continue;
    queueHead = 0;
    queueTail = 0;
    queue[queueTail++] = start;
    highSeen[start] = 1;
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    let peak = start;
    while (queueHead < queueTail) {
      const cell = queue[queueHead++];
      const cx = cell % size;
      const cy = (cell / size) | 0;
      count += 1;
      sumX += cx;
      sumY += cy;
      if (height[cell] > height[peak]) peak = cell;
      for (let k = 0; k < 8; k += 1) {
        const nx = cx + NEIGHBOR_DX[k];
        const ny = cy + NEIGHBOR_DY[k];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const nIndex = ny * size + nx;
        if (!highMask[nIndex] || highSeen[nIndex]) continue;
        highSeen[nIndex] = 1;
        queue[queueTail++] = nIndex;
      }
    }
    if (count >= Math.max(10, Math.round(cells * 0.00006))) {
      mountainComponents.push({
        size: count,
        x: Math.round(sumX / count),
        y: Math.round(sumY / count),
        peak,
      });
    }
  }
  mountainComponents.sort((a, b) => b.size - a.size || a.y - b.y || a.x - b.x);
  for (let m = 0; m < Math.min(4, mountainComponents.length); m += 1) {
    const comp = mountainComponents[m];
    // Put the label on the component's peak: it reads better than the centroid.
    const peakX = comp.peak % size;
    const peakY = (comp.peak / size) | 0;
    const spotX = comp.size > 0 ? Math.round((comp.x + peakX) / 2) : peakX;
    const spotY = comp.size > 0 ? Math.round((comp.y + peakY) / 2) : peakY;
    addLabel(
      {
        id: `mtn-${quantize((spotX + 0.5) / size)}-${quantize((spotY + 0.5) / size)}`,
        text: namer.label("mountain", spotX, spotY),
        kind: "mountain",
        x: (spotX + 0.5) / size,
        y: (spotY + 0.5) / size,
      },
      4,
    );
  }
  // Fallback for worlds whose highlands are too fragmented to form components.
  if (mountainComponents.length === 0) {
    let best = -1;
    for (let i = 0; i < cells; i += 1) {
      if (ocean[i] || lake[i]) continue;
      if (best < 0 || height[i] > height[best]) best = i;
    }
    if (best >= 0) {
      const bx = best % size;
      const by = (best / size) | 0;
      addLabel(
        {
          id: `mtn-${quantize((bx + 0.5) / size)}-${quantize((by + 0.5) / size)}`,
          text: namer.label("mountain", bx, by),
          kind: "mountain",
          x: (bx + 0.5) / size,
          y: (by + 0.5) / size,
        },
        4,
      );
    }
  }

  // ── Region labels: big landmasses first, then biome patches ────────────
  const regionLabels: { x: number; y: number }[] = [];
  const findLandSpot = (cx: number, cy: number, radius: number): { x: number; y: number } | null => {
    for (let ring = 0; ring <= radius; ring += Math.max(1, Math.floor(radius / 6))) {
      for (let dy = -ring; dy <= ring; dy += Math.max(1, Math.floor(radius / 10))) {
        for (let dx = -ring; dx <= ring; dx += Math.max(1, Math.floor(radius / 10))) {
          if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
          const x = clamp(cx + dx, 0, size - 1);
          const y = clamp(cy + dy, 0, size - 1);
          const i = y * size + x;
          if (ocean[i] || lake[i]) continue;
          const b = biome[i];
          if (b === Biome.Mountain || b === Biome.SnowPeak) continue;
          return { x, y };
        }
      }
    }
    // Last resort: any land cell in the search box.
    for (let dy = -radius; dy <= radius; dy += Math.max(1, Math.floor(radius / 10))) {
      for (let dx = -radius; dx <= radius; dx += Math.max(1, Math.floor(radius / 10))) {
        const x = clamp(cx + dx, 0, size - 1);
        const y = clamp(cy + dy, 0, size - 1);
        const i = y * size + x;
        if (!ocean[i]) return { x, y };
      }
    }
    return null;
  };
  const addRegionLabel = (x: number, y: number, id: string): void => {
    for (const spot of regionLabels) {
      const dx = x - spot.x;
      const dy = y - spot.y;
      if (dx * dx + dy * dy < (size * 0.16) ** 2) return;
    }
    regionLabels.push({ x, y });
    addLabel(
      {
        id,
        text: namer.label("region", x, y),
        kind: "region",
        x: (x + 0.5) / size,
        y: (y + 0.5) / size,
      },
      3,
    );
  };

  // 1) Connected landmasses (lakes count as part of the continent).
  const landSeen = new Uint8Array(cells);
  const landmasses: { size: number; x: number; y: number }[] = [];
  for (let start = 0; start < cells; start += 1) {
    if (ocean[start] || landSeen[start]) continue;
    queueHead = 0;
    queueTail = 0;
    queue[queueTail++] = start;
    landSeen[start] = 1;
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    while (queueHead < queueTail) {
      const cell = queue[queueHead++];
      const cx = cell % size;
      const cy = (cell / size) | 0;
      count += 1;
      sumX += cx;
      sumY += cy;
      for (let k = 0; k < 8; k += 1) {
        const nx = cx + NEIGHBOR_DX[k];
        const ny = cy + NEIGHBOR_DY[k];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const nIndex = ny * size + nx;
        if (ocean[nIndex] || landSeen[nIndex]) continue;
        landSeen[nIndex] = 1;
        queue[queueTail++] = nIndex;
      }
    }
    if (count >= Math.max(40, Math.round(cells * 0.001))) {
      landmasses.push({ size: count, x: Math.round(sumX / count), y: Math.round(sumY / count) });
    }
  }
  landmasses.sort((a, b) => b.size - a.size || a.y - b.y || a.x - b.x);
  for (const mass of landmasses.slice(0, 4)) {
    const radius = Math.max(4, Math.round(Math.sqrt(mass.size) * 0.7));
    const spot = findLandSpot(mass.x, mass.y, radius);
    if (!spot) continue;
    addRegionLabel(
      spot.x,
      spot.y,
      `region-${quantize((spot.x + 0.5) / size)}-${quantize((spot.y + 0.5) / size)}`,
    );
  }

  // 2) Fill up to six region labels with biome patches from a tile grid.
  const regionTarget = 6;
  const tiles = 4;
  const tileSize = size / tiles;
  const landedTiles: { tx: number; ty: number; landFraction: number }[] = [];
  for (let ty = 0; ty < tiles; ty += 1) {
    for (let tx = 0; tx < tiles; tx += 1) {
      let land = 0;
      let total = 0;
      const stepSample = Math.max(1, Math.floor(tileSize / 24));
      for (let y = Math.floor(ty * tileSize); y < Math.floor((ty + 1) * tileSize); y += stepSample) {
        for (let x = Math.floor(tx * tileSize); x < Math.floor((tx + 1) * tileSize); x += stepSample) {
          total += 1;
          if (!ocean[y * size + x]) land += 1;
        }
      }
      if (total > 0 && land / total > 0.35) {
        landedTiles.push({ tx, ty, landFraction: land / total });
      }
    }
  }
  landedTiles.sort((a, b) => b.landFraction - a.landFraction || a.ty - b.ty || a.tx - b.tx);
  for (const tile of landedTiles) {
    if (regionLabels.length >= regionTarget) break;
    const centerX = Math.floor((tile.tx + 0.5) * tileSize);
    const centerY = Math.floor((tile.ty + 0.5) * tileSize);
    const spot = findLandSpot(centerX, centerY, Math.floor(tileSize * 0.45));
    if (!spot) continue;
    addRegionLabel(spot.x, spot.y, `region-t${tile.tx}-${tile.ty}`);
  }

  // Importance ordering for the renderer: big geographic features first.
  const order = autoLabels.map((_, index) => index);
  order.sort((a, b) => labelPriorities[b] - labelPriorities[a] || a - b);
  const orderedLabels = order.map((index) => autoLabels[index]);

  // ── Overlay pinned user entries, filter hidden ids ─────────────────────
  const hidden = new Set(overrides.hiddenIds ?? []);
  const settlementMap = new Map<string, Settlement>();
  for (const settlement of generatedSettlements) {
    if (hidden.has(settlement.id)) continue;
    settlementMap.set(settlement.id, settlement);
  }
  for (const user of input.settlements ?? []) {
    if (!user || typeof user.id !== "string") continue;
    settlementMap.set(user.id, { ...user });
  }
  const labelMap = new Map<string, MapLabel>();
  for (const label of orderedLabels) {
    if (hidden.has(label.id)) continue;
    labelMap.set(label.id, label);
  }
  for (const user of input.labels ?? []) {
    if (!user || typeof user.id !== "string") continue;
    labelMap.set(user.id, { ...user });
  }

  return {
    settlements: Array.from(settlementMap.values()),
    autoLabels: Array.from(labelMap.values()),
  };
}

export type { SettlementKind };
