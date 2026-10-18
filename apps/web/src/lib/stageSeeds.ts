/**
 * Lock/reroll adapter over core's finalized `WorldParams.stageSeeds`.
 *
 * Core semantics (v0.4): terrainSeed = stageSeeds.terrain ?? document.seed,
 * humanSeed = stageSeeds.human ?? document.seed; hydrology/climate
 * perturbations only activate when explicitly seeded. Therefore:
 *  - locked stages keep their existing explicit seed (or stay absent so they
 *    keep falling back to the unchanged document.seed);
 *  - unlocked stages get a fresh explicit seed;
 *  - we never change document.seed during lock-aware rerolls, so absent locked
 *    stages stay bit-for-bit stable.
 */
import type { StageSeeds, WorldDocument, WorldParams } from "@atlas/core";

export type { StageSeeds };

export const STAGE_KEYS = ["terrain", "hydrology", "climate", "human"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

export const LOCK_KEYS = ["coast", "climate", "hydrology", "human", "style"] as const;
export type LockKey = (typeof LOCK_KEYS)[number];
export type LockState = Record<LockKey, boolean>;

export const LOCK_META: Record<
  LockKey,
  { label: string; stage: StageKey | null; hint: string }
> = {
  coast: { label: "海岸", stage: "terrain", hint: "锁定大陆轮廓与海岸线" },
  climate: { label: "生态", stage: "climate", hint: "锁定气候与群系分布" },
  hydrology: { label: "河流", stage: "hydrology", hint: "锁定河流与湖泊" },
  human: { label: "地名", stage: "human", hint: "锁定城镇与地名" },
  style: { label: "风格", stage: null, hint: "锁定渲染风格预设" },
};

export const DEFAULT_LOCKS: LockState = {
  coast: false,
  climate: false,
  hydrology: false,
  human: false,
  style: false,
};

function hashSeed(seed: number, salt: number): number {
  let value = (seed | 0) ^ Math.imul(salt + 1, 0x9e3779b1);
  value = Math.imul(value ^ (value >>> 16), 0x85ebca6b);
  value = Math.imul(value ^ (value >>> 13), 0xc2b2ae35);
  return (value ^ (value >>> 16)) >>> 0;
}

/** Deterministic per-stage seeds derived from a master seed (UI display only). */
export function deriveStageSeeds(seed: number): Required<StageSeeds> {
  return {
    terrain: hashSeed(seed, 1),
    hydrology: hashSeed(seed, 2),
    climate: hashSeed(seed, 3),
    human: hashSeed(seed, 4),
  };
}

/** Explicit stage seeds currently present on the document (no fallbacks). */
export function explicitStageSeeds(document: WorldDocument): StageSeeds {
  const raw = (document.params as WorldParams).stageSeeds;
  if (!raw || typeof raw !== "object") return {};
  const result: StageSeeds = {};
  for (const key of STAGE_KEYS) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      result[key] = Math.round(value) >>> 0;
    }
  }
  return result;
}

export function hasStageSeed(document: WorldDocument, key: StageKey): boolean {
  return explicitStageSeeds(document)[key] !== undefined;
}

export function withStageSeeds(document: WorldDocument, seeds: StageSeeds): WorldDocument {
  const params: WorldParams = { ...document.params, stageSeeds: { ...seeds } };
  return { ...document, params };
}

/** Read stage seeds including derived display fallbacks (never mutates). */
export function readStageSeeds(document: WorldDocument): Required<StageSeeds> {
  const explicit = explicitStageSeeds(document);
  const fallback = deriveStageSeeds(document.seed);
  return {
    terrain: explicit.terrain ?? fallback.terrain,
    hydrology: explicit.hydrology ?? fallback.hydrology,
    climate: explicit.climate ?? fallback.climate,
    human: explicit.human ?? fallback.human,
  };
}

export function randomStageSeed(rng: () => number = Math.random): number {
  return Math.floor(rng() * 0xffffffff) >>> 0;
}

/** Seed suffix used in the generated summary (#abcd). */
export function seedLabel(seed: number): string {
  return `#${String(seed).slice(-4).padStart(4, "0")}`;
}

export function lockLabels(locks: LockState): { locked: string[]; open: string[] } {
  const locked: string[] = [];
  const open: string[] = [];
  for (const key of LOCK_KEYS) {
    if (locks[key]) locked.push(LOCK_META[key].label);
    else open.push(LOCK_META[key].label);
  }
  return { locked, open };
}

export function describeLockToast(locks: LockState): string {
  const { locked, open } = lockLabels(locks);
  if (open.length === 0) return "所有阶段均已锁定，没有可更换的内容";
  const changed = `已换：${open.join("、")}`;
  return locked.length > 0
    ? `${changed} · 保留：${locked.join("、")}`
    : changed;
}
