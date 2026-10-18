/**
 * Single source of truth for keyboard shortcuts.
 *
 * The help dialog, the global key handler and the DEV debug API all read from
 * this module so documentation, behaviour and E2E checks can never drift apart.
 */
import type { ToolId } from "./constants";

export type ShortcutScope = "global" | "map" | "place" | "export" | "dialog";

export interface ShortcutDef {
  id: string;
  keys: string;
  action: string;
  scope: ShortcutScope;
}

/** Digit / letter keys that switch the active map tool. */
export const TOOL_SHORTCUTS: Readonly<Record<string, ToolId>> = {
  "1": "elevation",
  "2": "river",
  "3": "biome",
  "4": "places",
  v: "pan",
};

/** Escape priority order, highest first. Keep in sync with useShortcuts. */
export const ESCAPE_ORDER: readonly string[] = [
  "dialog",
  "place-rename",
  "place-placement",
  "place-selection",
  "river-draft",
];

export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: "undo", keys: "Ctrl / ⌘ + Z", action: "撤销上一步（按一次笔画 / 一次操作快照）", scope: "global" },
  { id: "redo", keys: "Ctrl / ⌘ + Shift + Z", action: "重做", scope: "global" },
  { id: "generate", keys: "Ctrl / ⌘ + Enter", action: "立即按当前文档重新生成", scope: "global" },
  { id: "tools-1-4", keys: "1 / 2 / 3 / 4", action: "切换海拔 / 河道 / 群系 / 地点工具", scope: "map" },
  { id: "tool-pan", keys: "V", action: "切换平移工具", scope: "map" },
  { id: "pan-space", keys: "Space（按住）", action: "临时进入平移模式", scope: "map" },
  { id: "zoom-wheel", keys: "滚轮", action: "以光标为中心缩放地图", scope: "map" },
  { id: "zoom-in-out", keys: "+ / −", action: "放大 / 缩小", scope: "map" },
  { id: "zoom-fit", keys: "F", action: "适配窗口", scope: "map" },
  { id: "zoom-one", keys: "0", action: "1:1 像素还原", scope: "map" },
  { id: "river-commit", keys: "回车 / 双击", action: "完成强制河道折线", scope: "map" },
  { id: "river-undo-point", keys: "Backspace", action: "删除河道最后一个节点", scope: "map" },
  { id: "place-rename", keys: "双击地点", action: "重命名选中的地点或地名", scope: "place" },
  { id: "place-drag", keys: "拖动地点", action: "把地点 / 地名移动到新位置", scope: "place" },
  { id: "place-delete", keys: "Delete", action: "彻底删除选中的用户新增地点", scope: "place" },
  { id: "escape", keys: "Esc", action: "按 弹窗 → 重命名 → 放置 → 选中 → 河道 的顺序取消", scope: "global" },
  { id: "help", keys: "?", action: "打开本帮助", scope: "global" },
];

export function getShortcutList(): ShortcutDef[] {
  return SHORTCUTS.map((shortcut) => ({ ...shortcut }));
}

export function findShortcut(id: string): ShortcutDef | null {
  return SHORTCUTS.find((shortcut) => shortcut.id === id) ?? null;
}
