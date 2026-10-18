/**
 * Places editing model (settlements + map labels).
 *
 * The canonical data lives in WorldDocument.settlements / WorldDocument.labels
 * (pinned user overrides) plus overrides.hiddenIds; the derived WorldLayers are
 * the merged result produced by the core human stage. This module builds the
 * flat, renderer-agnostic "place" list used by hit-testing, the inspector, the
 * place list and the hidden/restore list.
 */
import {
  type LabelKind,
  type MapLabel,
  type Settlement,
  type SettlementKind,
  type WorldDocument,
  type WorldLayers,
} from "@atlas/core";

import { MAX_NAME_LENGTH } from "./constants";
import { clamp01, uid } from "./utils";

export type PlaceEntity = "settlement" | "label";

export interface PlaceSelection {
  id: string;
  entity: PlaceEntity;
}

export interface PlaceEntry {
  id: string;
  entity: PlaceEntity;
  name: string;
  type: SettlementKind | LabelKind;
  x: number;
  y: number;
  pinned: boolean;
  userAdded: boolean;
  hidden: boolean;
}

export interface PlaceCollections {
  visible: PlaceEntry[];
  hidden: PlaceEntry[];
  hiddenIds: string[];
}

export const SETTLEMENT_KINDS: SettlementKind[] = ["city", "town", "port", "fortress", "ruin", "custom"];
export const LABEL_KINDS: LabelKind[] = ["region", "water", "mountain", "custom"];

export const SETTLEMENT_KIND_META: Record<SettlementKind, { label: string; icon: string }> = {
  city: { label: "城市", icon: "◉" },
  town: { label: "村镇", icon: "◈" },
  port: { label: "港口", icon: "⚓" },
  fortress: { label: "要塞", icon: "▣" },
  ruin: { label: "遗迹", icon: "◇" },
  custom: { label: "自定义", icon: "●" },
};

export const LABEL_KIND_META: Record<LabelKind, { label: string; icon: string }> = {
  region: { label: "区域", icon: "❖" },
  water: { label: "水域", icon: "≈" },
  mountain: { label: "山脉", icon: "△" },
  custom: { label: "自定义标注", icon: "✎" },
};

export function placeTypeLabel(entry: Pick<PlaceEntry, "entity" | "type">): string {
  if (entry.entity === "settlement") {
    return SETTLEMENT_KIND_META[entry.type as SettlementKind]?.label ?? "地点";
  }
  return LABEL_KIND_META[entry.type as LabelKind]?.label ?? "标注";
}

export function placeTypeIcon(entry: Pick<PlaceEntry, "entity" | "type">): string {
  if (entry.entity === "settlement") {
    return SETTLEMENT_KIND_META[entry.type as SettlementKind]?.icon ?? "◉";
  }
  return LABEL_KIND_META[entry.type as LabelKind]?.icon ?? "❖";
}

export function placeEntityLabel(entity: PlaceEntity): string {
  return entity === "settlement" ? "地点" : "标注";
}

/** User-created ids are stable and prefixed; generated ids keep their own scheme. */
export function isUserPlaceId(entity: PlaceEntity, id: string): boolean {
  if (entity === "settlement") return id.startsWith("user-s-");
  return id.startsWith("user-l-");
}

/**
 * Read the additive `layers.hidden` field without requiring it to exist yet
 * (older core versions don't emit it; the UI then falls back to document data).
 */
export function getLayersHidden(layers: WorldLayers | null): {
  settlements: Settlement[];
  labels: MapLabel[];
} {
  const source = layers as
    | (WorldLayers & {
        hidden?: { settlements?: Settlement[]; labels?: MapLabel[] };
      })
    | null;
  const hidden = source?.hidden;
  const settlements = Array.isArray(hidden?.settlements) ? hidden.settlements : [];
  const labels = Array.isArray(hidden?.labels) ? hidden.labels : [];
  return { settlements, labels };
}

function settlementToPlace(
  settlement: Settlement,
  hidden: boolean,
  userDocumentIds: Set<string>,
): PlaceEntry {
  return {
    id: settlement.id,
    entity: "settlement",
    name: settlement.name || "未命名地点",
    type: settlement.kind ?? "custom",
    x: Number.isFinite(settlement.x) ? settlement.x : 0.5,
    y: Number.isFinite(settlement.y) ? settlement.y : 0.5,
    pinned: Boolean(settlement.pinned),
    userAdded: isUserPlaceId("settlement", settlement.id) || userDocumentIds.has(settlement.id),
    hidden,
  };
}

function labelToPlace(label: MapLabel, hidden: boolean, userDocumentIds: Set<string>): PlaceEntry {
  return {
    id: label.id,
    entity: "label",
    name: label.text || "未命名标注",
    type: label.kind ?? "custom",
    x: Number.isFinite(label.x) ? label.x : 0.5,
    y: Number.isFinite(label.y) ? label.y : 0.5,
    pinned: Boolean(label.pinned),
    userAdded: isUserPlaceId("label", label.id) || userDocumentIds.has(label.id),
    hidden,
  };
}

function sortPlaces(a: PlaceEntry, b: PlaceEntry): number {
  if (a.entity !== b.entity) return a.entity === "settlement" ? -1 : 1;
  return a.name.localeCompare(b.name, "zh-Hans-CN");
}

/**
 * Merge generated layers, pinned user entries and hiddenIds into flat lists.
 * Hidden user entries that the current core version does not filter out are
 * removed from `visible` here as well (hidden-first semantics, defensively).
 */
export function collectPlaces(
  document: WorldDocument | null,
  layers: WorldLayers | null,
): PlaceCollections {
  const hiddenIds = Array.isArray(document?.overrides?.hiddenIds)
    ? document!.overrides.hiddenIds.filter((id): id is string => typeof id === "string")
    : [];
  const hiddenIdSet = new Set(hiddenIds);
  const userSettlements = document?.settlements ?? [];
  const userLabels = document?.labels ?? [];
  const userSettlementIds = new Set(userSettlements.map((entry) => entry.id));
  const userLabelIds = new Set(userLabels.map((entry) => entry.id));

  const visibleById = new Map<string, PlaceEntry>();
  const hiddenById = new Map<string, PlaceEntry>();

  const addVisible = (entry: PlaceEntry) => {
    if (hiddenIdSet.has(entry.id)) {
      if (!hiddenById.has(`settlement:${entry.id}`) && !hiddenById.has(`label:${entry.id}`)) {
        hiddenById.set(`${entry.entity}:${entry.id}`, { ...entry, hidden: true });
      }
      return;
    }
    visibleById.set(`${entry.entity}:${entry.id}`, entry);
  };

  if (layers) {
    for (const settlement of layers.settlements ?? []) {
      addVisible(settlementToPlace(settlement, false, userSettlementIds));
    }
    for (const label of layers.autoLabels ?? []) {
      addVisible(labelToPlace(label, false, userLabelIds));
    }
  }

  // Document entries not present in the current layers (e.g. right after an add
  // before the next generation completes, or an older core version).
  for (const settlement of userSettlements) {
    const key = `settlement:${settlement.id}`;
    if (!visibleById.has(key) && !hiddenById.has(key)) {
      addVisible(settlementToPlace(settlement, false, userSettlementIds));
    }
  }
  for (const label of userLabels) {
    const key = `label:${label.id}`;
    if (!visibleById.has(key) && !hiddenById.has(key)) {
      addVisible(labelToPlace(label, false, userLabelIds));
    }
  }

  // Hidden entries: prefer the full data from layers.hidden, then document.
  const hiddenLayer = getLayersHidden(layers);
  for (const settlement of hiddenLayer.settlements) {
    const place = settlementToPlace(settlement, true, userSettlementIds);
    hiddenById.set(`settlement:${settlement.id}`, place);
  }
  for (const label of hiddenLayer.labels) {
    const place = labelToPlace(label, true, userLabelIds);
    hiddenById.set(`label:${label.id}`, place);
  }
  for (const settlement of userSettlements) {
    if (!hiddenIdSet.has(settlement.id)) continue;
    hiddenById.set(
      `settlement:${settlement.id}`,
      settlementToPlace(settlement, true, userSettlementIds),
    );
  }
  for (const label of userLabels) {
    if (!hiddenIdSet.has(label.id)) continue;
    hiddenById.set(`label:${label.id}`, labelToPlace(label, true, userLabelIds));
  }
  // Remaining ids without data (very old layers): still allow restoring them.
  for (const id of hiddenIds) {
    const hasSettlement = hiddenById.has(`settlement:${id}`);
    const hasLabel = hiddenById.has(`label:${id}`);
    if (hasSettlement || hasLabel) continue;
    const entity: PlaceEntity =
      id.startsWith("user-l-") || id.startsWith("l-") ? "label" : "settlement";
    hiddenById.set(`${entity}:${id}`, {
      id,
      entity,
      name: "已隐藏条目",
      type: "custom",
      x: 0.5,
      y: 0.5,
      pinned: true,
      userAdded: false,
      hidden: true,
    });
  }

  return {
    visible: Array.from(visibleById.values()).sort(sortPlaces),
    hidden: Array.from(hiddenById.values()).sort(sortPlaces),
    hiddenIds,
  };
}

export function findPlace(
  collections: Pick<PlaceCollections, "visible" | "hidden">,
  selection: PlaceSelection | null,
): PlaceEntry | null {
  if (!selection) return null;
  return (
    collections.visible.find(
      (entry) => entry.id === selection.id && entry.entity === selection.entity,
    ) ??
    collections.hidden.find(
      (entry) => entry.id === selection.id && entry.entity === selection.entity,
    ) ??
    null
  );
}

// ── Name generation for newly placed entries ─────────────────────────────

const SETTLEMENT_PREFIXES = [
  "新",
  "临",
  "雾",
  "霜",
  "银",
  "青",
  "赤",
  "白",
  "金",
  "石",
  "风",
  "月",
  "星",
  "云",
  "长",
  "远",
  "松",
  "枫",
  "澜",
  "潮",
  "崖",
  "岭",
  "海",
  "河",
];

const SETTLEMENT_SUFFIXES: Record<SettlementKind, string[]> = {
  city: ["城", "京", "都", "邑"],
  town: ["镇", "庄", "村", "集"],
  port: ["港", "津", "埠", "湾"],
  fortress: ["堡", "关", "塞", "台"],
  ruin: ["墟", "遗迹", "遗址"],
  custom: ["地", "境", "台"],
};

const LABEL_PREFIXES = [
  "雾",
  "霜",
  "青",
  "赤",
  "白",
  "银",
  "金",
  "苍",
  "玄",
  "长",
  "远",
  "风",
  "月",
  "星",
  "云",
  "幽",
  "寒",
  "暮",
];

const LABEL_SUFFIXES: Record<LabelKind, string[]> = {
  region: ["野", "原", "疆", "境", "域", "川"],
  water: ["海", "湖", "湾", "泽", "溪", "河"],
  mountain: ["岭", "峰", "山脉", "崖", "山"],
  custom: ["地", "境"],
};

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

export function generatePlaceName(entity: PlaceEntity, type: SettlementKind | LabelKind): string {
  if (entity === "settlement") {
    const prefix = pick(SETTLEMENT_PREFIXES);
    const suffix = pick(SETTLEMENT_SUFFIXES[type as SettlementKind] ?? SETTLEMENT_SUFFIXES.custom);
    return `${prefix}${suffix}`.slice(0, MAX_NAME_LENGTH);
  }
  const prefix = pick(LABEL_PREFIXES);
  const suffix = pick(LABEL_SUFFIXES[type as LabelKind] ?? LABEL_SUFFIXES.region);
  return `${prefix}${suffix}`.slice(0, MAX_NAME_LENGTH);
}

// ── Entry construction / upsert helpers ──────────────────────────────────

export function createUserSettlement(x: number, y: number, kind: SettlementKind, name: string): Settlement {
  return {
    id: `user-s-${uid("s").replace(/^s-/, "")}`,
    name: name.trim().slice(0, MAX_NAME_LENGTH),
    kind,
    x: clamp01(x),
    y: clamp01(y),
    pinned: true,
  };
}

export function createUserLabel(x: number, y: number, kind: LabelKind, name: string): MapLabel {
  return {
    id: `user-l-${uid("l").replace(/^l-/, "")}`,
    text: name.trim().slice(0, MAX_NAME_LENGTH),
    kind,
    x: clamp01(x),
    y: clamp01(y),
    pinned: true,
  };
}

export function upsertSettlement(entries: Settlement[], next: Settlement): Settlement[] {
  const index = entries.findIndex((entry) => entry.id === next.id);
  if (index < 0) return [...entries, next];
  const copy = entries.slice();
  copy[index] = next;
  return copy;
}

export function upsertLabel(entries: MapLabel[], next: MapLabel): MapLabel[] {
  const index = entries.findIndex((entry) => entry.id === next.id);
  if (index < 0) return [...entries, next];
  const copy = entries.slice();
  copy[index] = next;
  return copy;
}
