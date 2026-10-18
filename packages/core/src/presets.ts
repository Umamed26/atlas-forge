/**
 * Scenario presets — one-click starting points for the "extreme easy to pick
 * up" generation flow. Pure data (no logic) so the UI, tests and future tools
 * can share the exact same numbers.
 *
 * `params`/`style` are partial overrides merged on top of DEFAULT_PARAMS /
 * DEFAULT_STYLE; `seedStrategy` is a hint for the UI:
 *  - "random"    roll a fresh random seed each time the preset is applied
 *  - "fixed-salt" derive the seed from `fixedSalt` so a scenario keeps a
 *                recognisable world (still editable afterwards)
 */
import { DEFAULT_PARAMS, DEFAULT_STYLE } from "./defaults";
import type { RenderStyle, WorldParams } from "./types";

export interface ScenarioPreset {
  id: string;
  name: string;
  tagline: string;
  emoji?: string;
  params: Partial<WorldParams>;
  style: Partial<RenderStyle>;
  seedStrategy?: "random" | "fixed-salt";
  fixedSalt?: number;
}

export const SCENARIO_PRESETS: readonly ScenarioPreset[] = [
  {
    id: "archipelago",
    name: "群岛贸易",
    tagline: "碎片化的群岛与海峡贸易：多块互不相连的岛屿之间靠航路往来。",
    emoji: "🏝️",
    params: {
      // Tuned for *fragmentation*, not just more water: high-frequency
      // continent noise + maximum warp + almost no radial falloff splits the
      // map into many separate landmasses (>= 8 4-connected islands, largest
      // island < 45% of land) while keeping land at 18-30% for readability.
      seaLevel: 0.52,
      continentScale: 4.0,
      continentality: 0.05,
      warpStrength: 1.0,
      ridgeStrength: 0.45,
      ridgeScale: 3.5,
      riverDensity: 0.55,
      windBands: true,
      moistureBias: 0.06,
    },
    style: {
      preset: "parchment-classic",
      labelDensity: 0.7,
      coastHatching: 0.75,
      hillshadeStrength: 0.45,
    },
    seedStrategy: "random",
  },
  {
    id: "arid-empire",
    name: "干旱帝国",
    tagline: "大河沿岸的辽阔旱地与帝国边陲，适合政治与战争题材。",
    emoji: "🏜️",
    params: {
      seaLevel: 0.34,
      continentScale: 0.85,
      continentality: 0.8,
      warpStrength: 0.25,
      ridgeStrength: 0.62,
      riverDensity: 0.22,
      moistureBias: -0.3,
      temperatureOffset: 0.14,
    },
    style: {
      preset: "parchment-classic",
      labelDensity: 0.5,
      paperTexture: 0.7,
    },
    seedStrategy: "random",
  },
  {
    id: "polar-frontier",
    name: "极地边疆",
    tagline: "冰封海岸与陡峭山脊，适合探索、生存与边疆开拓。",
    emoji: "❄️",
    params: {
      seaLevel: 0.45,
      continentality: 0.55,
      ridgeStrength: 0.75,
      ridgeScale: 2.6,
      erosionIterations: 80,
      riverDensity: 0.35,
      temperatureOffset: -0.3,
      moistureBias: -0.05,
    },
    style: {
      preset: "aged-ink",
      hillshadeStrength: 0.7,
      labelDensity: 0.45,
    },
    seedStrategy: "fixed-salt",
    fixedSalt: 90210,
  },
  {
    id: "classic",
    name: "温带大陆",
    tagline: "均衡的默认世界：大陆、山脉、河流与温带森林。",
    emoji: "🌍",
    params: { ...DEFAULT_PARAMS },
    style: { ...DEFAULT_STYLE },
    seedStrategy: "random",
  },
];

/** Look up a preset by id (handy for the UI's preset chooser). */
export function getScenarioPreset(id: string): ScenarioPreset | undefined {
  return SCENARIO_PRESETS.find((preset) => preset.id === id);
}
