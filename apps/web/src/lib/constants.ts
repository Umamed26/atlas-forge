/**
 * UI-side constants, parameter metadata and visual presets.
 *
 * All persisted data shapes come from @atlas/core (WorldDocument / WorldParams /
 * RenderStyle); this file only adds presentation metadata and UI limits.
 */
import type { BiomeId, RenderStyle, WorldParams } from "@atlas/core";

// ── Timing / storage / render limits ──────────────────────────────────────
export const STORAGE_KEY = "atlas_forge.world.v1";
export const BASE_RENDER_SIZE = 1024;
export const SIM_DEBOUNCE_MS = 120;
export const RENDER_DEBOUNCE_MS = 40;
export const AUTOSAVE_DEBOUNCE_MS = 800;
export const HISTORY_CAP = 50;
export const TOAST_DISMISS_MS = 4200;

export const MAX_ELEVATION_STAMPS = 6000;
export const MAX_BIOME_STAMPS = 6000;
export const MAX_RIVER_PATHS = 80;
export const MAX_RIVER_POINTS = 2000;
export const MAX_STROKE_STAMPS = 4000;
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
export const MAX_NAME_LENGTH = 80;

export const MIN_ZOOM = 0.04;
export const MAX_ZOOM = 16;

// ── Tools ─────────────────────────────────────────────────────────────────
export type ToolId = "pan" | "elevation" | "river" | "biome" | "places";

export interface ToolDef {
  id: ToolId;
  label: string;
  icon: string;
  shortcut: string;
  hint: string;
  title: string;
}

export const TOOLS: ToolDef[] = [
  {
    id: "pan",
    label: "平移",
    icon: "✥",
    shortcut: "V",
    hint: "拖动平移画布 · 滚轮以光标为中心缩放 · F 适配",
    title: "平移画布（V / 按住空格临时平移）",
  },
  {
    id: "elevation",
    label: "海拔",
    icon: "△",
    shortcut: "1",
    hint: "按住拖动：抬升 / 压低 / 锁定海拔 · 松开后重新生成",
    title: "海拔画笔：抬升、压低或锁定局部海拔（1）",
  },
  {
    id: "river",
    label: "河道",
    icon: "≈",
    shortcut: "2",
    hint: "单击添加节点 · 双击或回车完成 · Esc 取消 · Backspace 退一点",
    title: "强制河道：逐点绘制折线，完成后写入世界数据（2）",
  },
  {
    id: "biome",
    label: "群系",
    icon: "✿",
    shortcut: "3",
    hint: "选择群系后按住拖动涂抹 · 松开后重新生成",
    title: "群系画笔：涂抹指定群系（3）",
  },
  {
    id: "places",
    label: "地点",
    icon: "◉",
    shortcut: "4",
    hint: "单击选中地点/地名 · 拖动定位 · 双击重命名 · 「放置」后点击地图新增",
    title: "地点与地名编辑：选中、改名、拖动、隐藏、新增（4）",
  },
];

export type ElevationMode = "raise" | "lower" | "lock";

export const ELEVATION_MODES: { id: ElevationMode; label: string; title: string }[] = [
  { id: "raise", label: "抬升", title: "在地表上叠加正高度" },
  { id: "lower", label: "压低", title: "在地表上叠加负高度" },
  { id: "lock", label: "锁定", title: "把区域海拔固定到目标值" },
];

// ── Parameter metadata ────────────────────────────────────────────────────
export interface ParamSliderDef {
  key: Exclude<
    keyof WorldParams,
    "gridSize" | "windBands" | "namingLanguage" | "stageSeeds" | "terrainModel" | "tectonicPlates"
  >;
  label: string;
  min: number;
  max: number;
  step: number;
  decimals: number;
  unit?: string;
  hint?: string;
}

export interface ParamGroupDef {
  id: "terrain" | "hydrology" | "climate" | "human";
  title: string;
  icon: string;
  note?: string;
  sliders: ParamSliderDef[];
}

export const PARAM_GROUPS: ParamGroupDef[] = [
  {
    id: "terrain",
    title: "地形",
    icon: "△",
    note: "大陆形状、海岸与山脉的决定性参数。",
    sliders: [
      { key: "seaLevel", label: "海平面", min: 0.2, max: 0.7, step: 0.005, decimals: 3, hint: "越高，被海水淹没的面积越大" },
      { key: "continentScale", label: "大陆尺度", min: 0.25, max: 4, step: 0.05, decimals: 2, hint: "越小，大陆越少越大；4.0 可用于真群岛" },
      { key: "continentality", label: "大陆度", min: 0, max: 1, step: 0.01, decimals: 2, hint: "地图边缘的径向海洋衰减强度" },
      { key: "warpStrength", label: "海岸扭曲", min: 0, max: 1, step: 0.01, decimals: 2, hint: "domain warp，让海岸线更自然" },
      { key: "ridgeStrength", label: "山脉强度", min: 0, max: 1, step: 0.01, decimals: 2 },
      { key: "ridgeScale", label: "山脉尺度", min: 1, max: 4, step: 0.05, decimals: 2 },
      { key: "erosionIterations", label: "侵蚀迭代", min: 0, max: 200, step: 5, decimals: 0, hint: "越高山脊越柔和、河谷越清晰" },
    ],
  },
  {
    id: "hydrology",
    title: "水文",
    icon: "≈",
    note: "填洼 → 汇流 → 河流。强制河道会在此阶段被刻入地形。",
    sliders: [
      { key: "riverDensity", label: "河流密度", min: 0, max: 1, step: 0.01, decimals: 2, hint: "越低只保留主干河流" },
    ],
  },
  {
    id: "climate",
    title: "气候",
    icon: "☁",
    note: "风带、雨影与纬度共同决定温度与湿度。",
    sliders: [
      { key: "windAngle", label: "信风角度", min: 0, max: 360, step: 1, decimals: 0, unit: "°", hint: "0° = 自西向东，90° = 自南向北" },
      { key: "moistureBias", label: "湿度偏差", min: -0.5, max: 0.5, step: 0.01, decimals: 2 },
      { key: "temperatureOffset", label: "温度偏移", min: -0.35, max: 0.35, step: 0.01, decimals: 2 },
    ],
  },
  {
    id: "human",
    title: "人文",
    icon: "◈",
    note: "城镇与地名由生成器按宜居度、河流与海岸自动布置，读取上方地形/水文/气候结果。",
    sliders: [],
  },
];

/** Preview simulation grid sizes offered in the UI. */
export const GRID_SIZE_OPTIONS: { value: number; label: string; hint: string }[] = [
  { value: 512, label: "512² · 草稿", hint: "最快，适合快速试参数" },
  { value: 768, label: "768² · 流畅", hint: "参数拖动更跟手" },
  { value: 1024, label: "1024² · 默认", hint: "性能与细节平衡" },
  { value: 1536, label: "1536² · 精细", hint: "更慢，细节更多" },
];

export const NAMING_LANGUAGE_OPTIONS: {
  value: WorldParams["namingLanguage"];
  label: string;
}[] = [
  { value: "auto", label: "自动（跟随世界风格）" },
  { value: "cjk", label: "中文（汉字音节命名）" },
  { value: "latin", label: "拉丁（西文音节命名）" },
];

export const DEFAULT_PARAM_VALUES: WorldParams = {
  gridSize: 1024,
  seaLevel: 0.42,
  continentScale: 1,
  continentality: 0.62,
  warpStrength: 0.35,
  ridgeStrength: 0.55,
  ridgeScale: 2.1,
  erosionIterations: 60,
  riverDensity: 0.5,
  windAngle: 0,
  windBands: true,
  moistureBias: 0,
  temperatureOffset: 0,
  namingLanguage: "auto",
};


// ── Human-readable parameter copy (P1-1) ─────────────────────────────────
export interface ParamReadability {
  plain: string;
  low: string;
  mid: string;
  high: string;
}

export const PARAM_READABILITY: Record<string, ParamReadability> = {
  seaLevel: {
    plain: "越高，陆地越少、海岸越碎；越低，大陆越完整。",
    low: "多陆地",
    mid: "均衡",
    high: "多海洋",
  },
  continentScale: {
    plain: "越小，大陆越少越大；越大，陆地越碎越多岛。",
    low: "整块大陆",
    mid: "常规",
    high: "群岛密布",
  },
  continentality: {
    plain: "控制地图边缘向内衰减的强度，越高边缘越容易变成海。",
    low: "边缘少海",
    mid: "自然",
    high: "四面临海",
  },
  warpStrength: {
    plain: "让海岸线更弯曲、更自然；过高会显得像噪声。",
    low: "平直海岸",
    mid: "自然曲折",
    high: "极度破碎",
  },
  ridgeStrength: {
    plain: "山脉的隆起强度；越高山系越明显、阴影越重。",
    low: "平原为主",
    mid: "丘陵起伏",
    high: "高山连绵",
  },
  ridgeScale: {
    plain: "山脉的尺度：越小山系越密，越大山系越宏伟。",
    low: "细碎山脊",
    mid: "常规山脉",
    high: "巨型山系",
  },
  erosionIterations: {
    plain: "侵蚀迭代越多，山脊越圆润、河谷越清晰。",
    low: "原始地貌",
    mid: "较自然",
    high: "深度风化",
  },
  riverDensity: {
    plain: "河流的数量；越高支流越多、平原更容易被切割。",
    low: "仅主干河",
    mid: "常规水系",
    high: "水网密布",
  },
  windAngle: {
    plain: "主导风向：影响雨影与湿润空气的推进方向。",
    low: "西风",
    mid: "斜风",
    high: "东风",
  },
  moistureBias: {
    plain: "整体更干（左）或更湿（右）；会影响荒漠与森林范围。",
    low: "更干旱",
    mid: "平衡",
    high: "更湿润",
  },
  temperatureOffset: {
    plain: "整体更冷（左）或更热（右）；会影响冰原与热带范围。",
    low: "更寒冷",
    mid: "平衡",
    high: "更炎热",
  },
};

// ── Style metadata ────────────────────────────────────────────────────────
export type StyleToggleKey =
  | "showLabels"
  | "showRivers"
  | "showGraticule"
  | "showBorder"
  | "showCompass"
  | "showLegend";

export const STYLE_TOGGLES: { key: StyleToggleKey; label: string; hint: string }[] = [
  { key: "showLabels", label: "地名标注", hint: "区域、水域、山川与城镇名称" },
  { key: "showRivers", label: "河流水系", hint: "河流、湖泊与入海口" },
  { key: "showGraticule", label: "经纬网格", hint: "古地图式的经纬网" },
  { key: "showBorder", label: "装饰边框", hint: "双重手绘边框" },
  { key: "showCompass", label: "指北针", hint: "罗盘玫瑰" },
  { key: "showLegend", label: "图例", hint: "群系 / 符号说明" },
];

export type StyleSliderKey = "labelDensity" | "paperTexture" | "hillshadeStrength" | "coastHatching";

export const STYLE_SLIDERS: {
  key: StyleSliderKey;
  label: string;
  min: number;
  max: number;
  step: number;
  decimals: number;
  hint: string;
}[] = [
  { key: "labelDensity", label: "标注密度", min: 0, max: 1, step: 0.01, decimals: 2, hint: "0 = 不自动取名，1 = 尽量多" },
  { key: "paperTexture", label: "纸纹质感", min: 0, max: 1, step: 0.01, decimals: 2, hint: "羊皮纸噪点、污渍与暗角" },
  { key: "hillshadeStrength", label: "山体阴影", min: 0, max: 1, step: 0.01, decimals: 2, hint: "NW 315° 光照的山影强度" },
  { key: "coastHatching", label: "海岸晕线", min: 0, max: 1, step: 0.01, decimals: 2, hint: "沿岸的古典排线" },
];

export type StylePresetId = RenderStyle["preset"];

export const STYLE_PRESETS: Record<
  StylePresetId,
  { label: string; description: string; style: Partial<RenderStyle> }
> = {
  "parchment-classic": {
    label: "羊皮纸经典",
    description: "明亮米色纸张、轻纸纹、标准海岸晕线",
    style: {
      preset: "parchment-classic",
      showLabels: true,
      showRivers: true,
      showGraticule: false,
      showBorder: true,
      showCompass: true,
      showLegend: true,
      labelDensity: 0.6,
      paperTexture: 0.55,
      hillshadeStrength: 0.55,
      coastHatching: 0.6,
    },
  },
  "aged-ink": {
    label: "陈墨古卷",
    description: "更深的纸色与污渍、重晕线、经纬网",
    style: {
      preset: "aged-ink",
      showLabels: true,
      showRivers: true,
      showGraticule: true,
      showBorder: true,
      showCompass: true,
      showLegend: true,
      labelDensity: 0.45,
      paperTexture: 0.82,
      hillshadeStrength: 0.78,
      coastHatching: 0.9,
    },
  },
};

// ── Biome legend ──────────────────────────────────────────────────────────
/** Legend order (ocean last, land first) and UI swatch colors. */
export const BIOME_ORDER: BiomeId[] = [
  5, // TemperateForest
  6, // Grassland
  7, // Shrubland
  8, // Savanna
  9, // Desert
  10, // TropicalForest
  4, // BorealForest
  3, // Tundra
  2, // Ice
  11, // Wetland
  12, // Beach
  13, // Mountain
  14, // SnowPeak
  1, // Lake
  0, // Ocean
];

export const BIOME_COLORS: Record<BiomeId, string> = {
  0: "#6d8782",
  1: "#8ba49b",
  2: "#e6e6dd",
  3: "#b3b49d",
  4: "#6c7c59",
  5: "#82996a",
  6: "#b4ad74",
  7: "#ab9368",
  8: "#c6b06d",
  9: "#d9c48f",
  10: "#5c7d51",
  11: "#7c9179",
  12: "#d8caa4",
  13: "#9a8a72",
  14: "#e4e0d3",
};

// ── Export presets ────────────────────────────────────────────────────────
export interface ExportPreset {
  size: number;
  label: string;
  mode: "local" | "server";
  note: string;
  estimate: string;
}

export const EXPORT_PRESETS: ExportPreset[] = [
  { size: 1024, label: "1024²", mode: "local", note: "快速预览 / 网页分享", estimate: "预估 < 2 秒" },
  { size: 2048, label: "2048²", mode: "local", note: "高清插图 / 社区分享", estimate: "预估 2–4 秒" },
  { size: 4096, label: "4096²", mode: "server", note: "印刷级 · 需要导出服务", estimate: "预估 3–8 秒" },
  { size: 8192, label: "8192²", mode: "server", note: "海报级 · 需要导出服务与你耐心", estimate: "预估 10–30 秒" },
];


