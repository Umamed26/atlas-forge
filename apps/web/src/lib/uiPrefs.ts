/** Persisted, tiny UI preferences (collapsible sections, export size). */

const PREFIX = "atlas_forge.ui.";

export const UI_PREF_KEYS = {
  leftWorld: `${PREFIX}left.world.open`,
  leftParams: `${PREFIX}left.params.open`,
  leftBrushes: `${PREFIX}left.brushes.open`,
  stylePreset: `${PREFIX}style.preset.open`,
  styleDetail: `${PREFIX}style.detail.open`,
  styleStats: `${PREFIX}style.stats.open`,
  exportSize: `${PREFIX}export.size`,
} as const;

export function readStoredBoolean(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    if (raw === "1") return true;
    if (raw === "0") return false;
  } catch {
    // storage unavailable
  }
  return fallback;
}

export function writeStoredBoolean(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    // best effort; UI preferences are not critical
  }
}

export function readStoredString(key: string, fallback: string): string {
  try {
    const raw = localStorage.getItem(key);
    if (typeof raw === "string" && raw.length > 0) return raw;
  } catch {
    // ignore
  }
  return fallback;
}

export function writeStoredString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}
