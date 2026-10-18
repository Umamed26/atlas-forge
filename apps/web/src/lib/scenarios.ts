/**
 * Scenario presets — thin UI adapter over core's finalized `SCENARIO_PRESETS`.
 *
 * Core owns the numbers/ids/params/style; this module only adds the palette
 * used by the CSS thumbnails (until render's preset PNGs land) and helper
 * functions for the welcome panel / preset badges.
 */
import {
  DEFAULT_PARAMS,
  SCENARIO_PRESETS as CORE_SCENARIOS,
  getScenarioPreset,
  type ScenarioPreset as CoreScenarioPreset,
  type WorldParams,
} from "@atlas/core";

export interface ScenarioPreset extends CoreScenarioPreset {
  /** CSS gradient palette used before real preset thumbnails ship. */
  palette: [string, string, string];
  /** One-sentence description shown on the welcome cards. */
  description: string;
}

const PALETTES: Record<string, [string, string, string]> = {
  archipelago: ["#2f4f5a", "#8fb3a8", "#e6dcc0"],
  "arid-empire": ["#8a5c33", "#d8b273", "#f0e2bd"],
  "polar-frontier": ["#4c5a5c", "#9fb0a6", "#e9ece4"],
  classic: ["#7a6a45", "#c2a76b", "#efe4c8"],
};

const DESCRIPTIONS: Record<string, string> = {
  archipelago: "适合航海贸易、群岛城邦与海盗题材。",
  "arid-empire": "适合沙漠商路、绿洲与帝国兴衰。",
  "polar-frontier": "适合冰原探险、极地科考与边疆拓荒。",
  classic: "经典温带大陆，适合大多数奇幻与中世纪设定。",
};

export const SCENARIOS: ScenarioPreset[] = CORE_SCENARIOS.map((preset) => ({
  ...preset,
  palette: PALETTES[preset.id] ?? PALETTES.classic,
  description: DESCRIPTIONS[preset.id] ?? preset.tagline,
}));

export const DEFAULT_SCENARIO_ID = "classic";

export function scenarioById(id: string | null | undefined): ScenarioPreset {
  const found = SCENARIOS.find((scenario) => scenario.id === id);
  if (found) return found;
  const core = id ? getScenarioPreset(id) : undefined;
  if (core) {
    return {
      ...core,
      palette: PALETTES[core.id] ?? PALETTES.classic,
      description: DESCRIPTIONS[core.id] ?? core.tagline,
    };
  }
  return SCENARIOS.find((scenario) => scenario.id === DEFAULT_SCENARIO_ID)!;
}

export function isKnownScenario(id: string): boolean {
  return getScenarioPreset(id) !== undefined;
}

export function randomScenarioId(
  excludeId?: string | null,
  rng: () => number = Math.random,
): string {
  const candidates = SCENARIOS.filter((scenario) => scenario.id !== excludeId);
  const pool = candidates.length > 0 ? candidates : SCENARIOS;
  const raw = rng();
  const index = Math.min(
    pool.length - 1,
    Math.max(0, Math.floor((Number.isFinite(raw) ? raw : 0) * pool.length)),
  );
  return pool[index].id;
}

/** Baseline params for a scenario = core defaults merged with its preset patch. */
export function scenarioBaselineParams(scenario: ScenarioPreset): WorldParams {
  return { ...DEFAULT_PARAMS, ...scenario.params };
}

const PARAM_KEYS = Object.keys(DEFAULT_PARAMS) as (keyof WorldParams)[];

/** Number of parameters that differ from the scenario baseline. */
export function countScenarioParamDiffs(params: WorldParams, scenario: ScenarioPreset): number {
  const baseline = scenarioBaselineParams(scenario);
  let diff = 0;
  for (const key of PARAM_KEYS) {
    if (key === "gridSize" || key === "namingLanguage") continue;
    if (params[key] !== baseline[key]) diff += 1;
  }
  return diff;
}

/** Diff only the keys belonging to one parameter group (for group badges). */
export function countScenarioDiffsForKeys(
  params: WorldParams,
  scenario: ScenarioPreset,
  keys: (keyof WorldParams)[],
): number {
  const baseline = scenarioBaselineParams(scenario);
  let diff = 0;
  for (const key of keys) {
    if (key === "gridSize" || key === "namingLanguage") continue;
    if (params[key] !== baseline[key]) diff += 1;
  }
  return diff;
}

/** Pick the closest scenario for documents restored without scenario metadata. */
export function findClosestScenarioId(params: WorldParams): string {
  let best = SCENARIOS[0].id;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (const scenario of SCENARIOS) {
    const diff = countScenarioParamDiffs(params, scenario);
    if (diff < bestDiff) {
      best = scenario.id;
      bestDiff = diff;
    }
  }
  return best;
}

/** Display helper used by the generated summary. */
export function scenarioDisplayName(id: string): string {
  return scenarioById(id).name;
}
