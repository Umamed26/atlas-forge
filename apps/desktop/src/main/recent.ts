/** Recent world files, stored in the app's userData directory. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";

import type { RecentWorldFile } from "../../shared/ipc";

const MAX_RECENT = 12;

function recentPath(): string {
  return join(app.getPath("userData"), "recent-worlds.json");
}

export function loadRecentFiles(): RecentWorldFile[] {
  try {
    const raw = readFileSync(recentPath(), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is RecentWorldFile =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as RecentWorldFile).path === "string" &&
        typeof (entry as RecentWorldFile).name === "string",
    );
  } catch {
    return [];
  }
}

export function saveRecentFiles(files: RecentWorldFile[]): void {
  try {
    writeFileSync(recentPath(), JSON.stringify(files.slice(0, MAX_RECENT), null, 2), "utf8");
  } catch (error) {
    console.warn("failed to persist recent files", error);
  }
}

export function addRecentFile(entry: RecentWorldFile): void {
  const existing = loadRecentFiles().filter((file) => file.path !== entry.path);
  existing.unshift(entry);
  saveRecentFiles(existing);
}

export function clearRecentFiles(): void {
  saveRecentFiles([]);
}

export function pruneMissingRecentFiles(): RecentWorldFile[] {
  const existing = loadRecentFiles();
  const alive = existing.filter((file) => existsSync(file.path));
  if (alive.length !== existing.length) saveRecentFiles(alive);
  return alive;
}
