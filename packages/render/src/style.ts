/**
 * Parchment rendering styles.
 *
 * All geometry/size values in a theme are expressed in "design units":
 * pixels on a 1024x1024 reference map. The renderer multiplies them by
 * `designScale = min(width, height) / 1024` so a 4096 export keeps the exact
 * same visual proportions as the browser preview.
 */
import type { RenderStyle } from "@atlas/core";

export type RGB = readonly [number, number, number];
export type Quality = "preview" | "export";

export interface BiomeTint {
  /** Albedo tint applied on land, blended at `biomeMix`. */
  color: RGB;
}

export interface RenderTheme {
  preset: RenderStyle["preset"];
  quality: Quality;

  paper: {
    base: RGB;
    light: RGB;
    shade: RGB;
    /** Multiplier on style.paperTexture for per-pixel grain. */
    grain: number;
    /** Multiplier for low-frequency mottling. */
    mottle: number;
    /** Multiplier for age stains. */
    stain: number;
    /** Corner/edge darkening strength. */
    vignette: number;
    /** Extra burn-in on the outer margins. */
    edge: number;
  };

  ink: {
    main: RGB;
    soft: RGB;
    coast: RGB;
    hatch: RGB;
    river: RGB;
    lake: RGB;
    label: RGB;
    labelWater: RGB;
    halo: RGB;
    border: RGB;
    accent: RGB;
  };

  ocean: {
    shallow: RGB;
    mid: RGB;
    deep: RGB;
    /** Color mixed in near the coast (pale shallow shelf). */
    shelf: RGB;
    ruling: RGB;
    rulingAlpha: number;
    /** Design-px between engraved sea ruling lines. */
    rulingSpacing: number;
    rulingWave: number;
    rulingWidth: number;
  };

  land: {
    low: RGB;
    olive: RGB;
    mid: RGB;
    high: RGB;
    rock: RGB;
    peak: RGB;
    /** Snow / polar wash tint. */
    cold: RGB;
    /** Warm grey-brown wash for mountain belts. */
    relief: RGB;
  };

  /** Per-biome wash tint (indexed by BiomeId). */
  biomeTints: RGB[];
  /**
   * Albedo tint weight. Can be overridden per render via the additive
   * `RenderStyle.biomeTint` field (read structurally until core adds it).
   */
  biomeMix: number;

  hillshade: {
    strength: number;
    /** Vertical exaggeration applied to height gradient. */
    exaggeration: number;
    /** Shadow / highlight tint used to blend hillshade into the ink wash. */
    shadow: RGB;
    highlight: RGB;
    shadowMix: number;
    highlightMix: number;
    /** Valley/ridge curvature shading strength. */
    curvature: number;
  };

  contour: {
    bands: number;
    strength: number;
    /** Design-px line width target. */
    width: number;
  };

  coast: {
    lineWidth: number;
    doubleOffset: number;
    jitter: number;
    /** Concentric hachure bands drawn into the sea. */
    hatchBands: number;
    hatchSpacing: number;
    hatchLength: number;
    hatchWidth: number;
    hatchAlpha: number;
    /** Pale ink wash band hugging the coastline. */
    washWidth: number;
    washAlpha: number;
  };

  lake: {
    lineWidth: number;
    innerOffset: number;
    hatchAlpha: number;
    shallow: RGB;
    deep: RGB;
    /** Opacity of the pale wash filled inside lake outlines. */
    fillAlpha: number;
  };

  river: {
    minWidth: number;
    maxWidth: number;
    alpha: number;
    bankAlpha: number;
    bankWidth: number;
  };

  label: {
    regionSize: number;
    waterSize: number;
    mountainSize: number;
    customSize: number;
    settlementSize: number;
    /** Extra tracking (em fraction) for region labels. */
    tracking: number;
    haloWidth: number;
    haloAlpha: number;
    /** Settlement label letter spacing. */
    settlementTracking: number;
  };

  decor: {
    frameThickness: number;
    frameInset: number;
    frameInnerInset: number;
    innerRuleInset: number;
    compassRadius: number;
    compassInset: number;
    scaleWidth: number;
    scaleHeight: number;
    graticuleAlpha: number;
    graticuleDash: number;
    titleScale: number;
    subtitleScale: number;
    cartoucheAlpha: number;
  };
}

// ── Palette building blocks ───────────────────────────────────────────────

const PARCHMENT_PAPER_BASE: RGB = [232, 220, 192];
const PARCHMENT_OCEAN_SHALLOW: RGB = [225, 222, 203];
const PARCHMENT_OCEAN_MID: RGB = [211, 211, 196];
const PARCHMENT_OCEAN_DEEP: RGB = [193, 197, 191];
const PARCHMENT_OCEAN_SHELF: RGB = [232, 230, 211];

const AGED_PAPER_BASE: RGB = [211, 194, 158];
const AGED_OCEAN_SHALLOW: RGB = [201, 195, 169];
const AGED_OCEAN_MID: RGB = [179, 181, 162];
const AGED_OCEAN_DEEP: RGB = [157, 166, 158];
const AGED_OCEAN_SHELF: RGB = [212, 205, 179];

/**
 * Biome wash tints. Land biomes get a hand-painted monochrome wash: muted
 * greens for forests, dusty yellow for grass/desert, bluish-grey for ice.
 */
const BIOME_TINTS_COMMON: RGB[] = [
  [120, 140, 150], // Ocean (unused on land)
  [128, 152, 158], // Lake (unused on land)
  [174, 214, 240], // Ice — cold pale blue, forms visible ice sheets at 256px
  [140, 162, 150], // Tundra — cold grey-green lichen
  [62, 104, 88], // BorealForest — cool dark green
  [80, 120, 94], // TemperateForest — cool mid green
  [206, 190, 116], // Grassland — warm yellow
  [166, 152, 104], // Shrubland
  [186, 152, 76], // Savanna — golden, darker than desert
  [242, 220, 164], // Desert — light warm sand (no green)
  [38, 86, 54], // TropicalForest — deep green
  [102, 134, 110], // Wetland
  [224, 208, 160], // Beach
  [150, 134, 112], // Mountain
  [248, 250, 252], // SnowPeak — near white
];

function tint(colors: RGB[], biome: number, color: RGB): RGB[] {
  colors[biome] = color;
  return colors;
}

function biomeTints(preset: RenderStyle["preset"]): RGB[] {
  const colors = BIOME_TINTS_COMMON.map((c): RGB => [c[0], c[1], c[2]]);
  if (preset === "aged-ink") {
    return colors.map((c, i): RGB => {
      // Aged maps are slightly browner, but hue differences (ice vs desert vs
      // forest) must survive at thumbnail size.
      if (i === 0 || i === 1) return c;
      const warm = 0.07;
      const desat = 0.12;
      const luma = c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
      return [
        Math.round((c[0] + (luma - c[0]) * desat) * (1 - warm) + 150 * warm),
        Math.round((c[1] + (luma - c[1]) * desat) * (1 - warm) + 128 * warm),
        Math.round((c[2] + (luma - c[2]) * desat) * (1 - warm) + 92 * warm),
      ];
    });
  }
  return colors;
}

function parchmentClassic(style: RenderStyle, quality: Quality): RenderTheme {
  return {
    preset: "parchment-classic",
    quality,
    paper: {
      base: PARCHMENT_PAPER_BASE,
      light: [243, 235, 214],
      shade: [205, 188, 155],
      grain: 6.2,
      mottle: 19,
      stain: 0.1,
      vignette: 0.26,
      edge: 0.14,
    },
    ink: {
      main: [58, 45, 32],
      soft: [104, 86, 64],
      coast: [64, 49, 34],
      hatch: [92, 78, 58],
      river: [56, 74, 78],
      lake: [58, 76, 80],
      label: [48, 37, 26],
      labelWater: [52, 66, 70],
      halo: [237, 226, 200],
      border: [66, 51, 36],
      accent: [122, 56, 36],
    },
    ocean: {
      shallow: PARCHMENT_OCEAN_SHALLOW,
      mid: PARCHMENT_OCEAN_MID,
      deep: PARCHMENT_OCEAN_DEEP,
      shelf: PARCHMENT_OCEAN_SHELF,
      ruling: [96, 112, 106],
      rulingAlpha: 0.21,
      rulingSpacing: 8.4,
      rulingWave: 1.6,
      rulingWidth: 0.8,
    },
    land: {
      low: [238, 230, 205],
      olive: [224, 214, 177],
      mid: [203, 183, 140],
      high: [174, 149, 114],
      rock: [144, 121, 96],
      peak: [236, 229, 215],
      cold: [198, 208, 212],
      relief: [200, 181, 152],
    },
    biomeTints: biomeTints("parchment-classic"),
    biomeMix: 0.55,
    hillshade: {
      strength: style.hillshadeStrength,
      exaggeration: 330,
      shadow: [92, 73, 51],
      highlight: [255, 250, 234],
      shadowMix: 0.44,
      highlightMix: 0.2,
      curvature: 72,
    },
    contour: { bands: 20, strength: 0.15, width: 0.85 },
    coast: {
      lineWidth: 1.55,
      doubleOffset: 2.4,
      jitter: 0.9,
      hatchBands: 3,
      hatchSpacing: 4.8,
      hatchLength: 4.2,
      hatchWidth: 0.8,
      hatchAlpha: 0.5,
      washWidth: 8,
      washAlpha: 0.075,
    },
    lake: { lineWidth: 1.4, innerOffset: 1.3, hatchAlpha: 0.18, shallow: [206, 213, 203], deep: [178, 194, 192], fillAlpha: 0.5 },
    river: { minWidth: 0.95, maxWidth: 4.6, alpha: 0.9, bankAlpha: 0.28, bankWidth: 0.55 },
    label: {
      regionSize: 26.5,
      waterSize: 18.5,
      mountainSize: 14,
      customSize: 19.5,
      settlementSize: 12,
      tracking: 0.13,
      haloWidth: 0.14,
      haloAlpha: 0.9,
      settlementTracking: 0.09,
    },
    decor: {
      frameThickness: 3.4,
      frameInset: 11,
      frameInnerInset: 17,
      innerRuleInset: 23,
      compassRadius: 50,
      compassInset: 84,
      scaleWidth: 214,
      scaleHeight: 11,
      graticuleAlpha: 0.16,
      graticuleDash: 3.4,
      titleScale: 34,
      subtitleScale: 13,
      cartoucheAlpha: 0.9,
    },
  };
}

function agedInk(style: RenderStyle, quality: Quality): RenderTheme {
  const base = parchmentClassic(style, quality);
  return {
    ...base,
    preset: "aged-ink",
    paper: {
      base: AGED_PAPER_BASE,
      light: [226, 209, 176],
      shade: [170, 148, 112],
      grain: 8.2,
      mottle: 30,
      stain: 0.26,
      vignette: 0.5,
      edge: 0.34,
    },
    ink: {
      main: [34, 25, 16],
      soft: [74, 57, 40],
      coast: [38, 27, 17],
      hatch: [54, 42, 28],
      river: [36, 51, 55],
      lake: [38, 53, 57],
      label: [30, 22, 14],
      labelWater: [34, 46, 50],
      halo: [224, 207, 172],
      border: [40, 29, 18],
      accent: [102, 38, 26],
    },
    ocean: {
      shallow: AGED_OCEAN_SHALLOW,
      mid: AGED_OCEAN_MID,
      deep: AGED_OCEAN_DEEP,
      shelf: AGED_OCEAN_SHELF,
      ruling: [78, 92, 87],
      rulingAlpha: 0.28,
      rulingSpacing: 7.4,
      rulingWave: 1.8,
      rulingWidth: 0.88,
    },
    land: {
      low: [216, 200, 164],
      olive: [198, 180, 137],
      mid: [175, 149, 106],
      high: [147, 121, 89],
      rock: [115, 95, 73],
      peak: [218, 207, 185],
      cold: [186, 196, 202],
      relief: [166, 142, 111],
    },
    biomeMix: 0.5,
    hillshade: {
      ...base.hillshade,
      strength: Math.min(1, style.hillshadeStrength * 1.2),
      shadowMix: 0.55,
      highlightMix: 0.18,
      curvature: 80,
    },
    contour: { bands: 18, strength: 0.24, width: 1 },
    coast: {
      ...base.coast,
      lineWidth: 1.95,
      jitter: 1.1,
      hatchBands: 4,
      hatchSpacing: 4,
      hatchLength: 3.2,
      hatchWidth: 0.85,
      hatchAlpha: 0.72,
      washWidth: 12,
      washAlpha: 0.14,
    },
    lake: { lineWidth: 1.45, innerOffset: 1.2, hatchAlpha: 0.26, shallow: [200, 204, 190], deep: [176, 188, 184], fillAlpha: 0.44 },
    river: { minWidth: 0.9, maxWidth: 3.9, alpha: 0.95, bankAlpha: 0.36, bankWidth: 0.6 },
    label: {
      ...base.label,
      regionSize: 28,
      waterSize: 18.5,
      mountainSize: 14,
      haloWidth: 0.15,
      haloAlpha: 0.82,
    },
    decor: {
      ...base.decor,
      frameThickness: 4.4,
      graticuleAlpha: 0.22,
      cartoucheAlpha: 0.94,
    },
  };
}

/**
 * Resolve a RenderStyle (plus quality tier) into the concrete theme used by the
 * rasterizer and vector layers. Every RenderStyle number is folded in here, so
 * changing style never requires re-running the simulation.
 */
export function resolveTheme(style: RenderStyle, quality: Quality): RenderTheme {
  const base = style.preset === "aged-ink" ? agedInk(style, quality) : parchmentClassic(style, quality);
  const styleFactor = 0.55 + 0.9 * clamp01(style.paperTexture);
  const coastFactor = 0.4 + 1.0 * clamp01(style.coastHatching);
  const styleBiomeTint = readBiomeTint(style);
  return {
    ...base,
    biomeMix: styleBiomeTint ?? base.biomeMix,
    paper: {
      ...base.paper,
      grain: base.paper.grain * styleFactor,
      mottle: base.paper.mottle * styleFactor,
      stain: base.paper.stain * styleFactor,
    },
    coast: {
      ...base.coast,
      hatchAlpha: base.coast.hatchAlpha * coastFactor,
      hatchBands:
        quality === "preview"
          ? Math.max(1, base.coast.hatchBands - 1)
          : base.coast.hatchBands + (style.coastHatching > 0.8 ? 1 : 0),
      washAlpha: base.coast.washAlpha * coastFactor,
    },
    hillshade: { ...base.hillshade, strength: clamp01(style.hillshadeStrength) },
  };
}

/** Optional additive style control: 0..1 biome wash weight. */
function readBiomeTint(style: RenderStyle): number | undefined {
  const raw = (style as RenderStyle & { biomeTint?: unknown }).biomeTint;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return clamp01(raw);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Hex string from RGB, used for canvas styles. */
export function cssRgb(color: RGB, alpha = 1): string {
  if (alpha >= 1) return `rgb(${color[0] | 0}, ${color[1] | 0}, ${color[2] | 0})`;
  return `rgba(${color[0] | 0}, ${color[1] | 0}, ${color[2] | 0}, ${alpha.toFixed(3)})`;
}
