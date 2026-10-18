/**
 * Adapter around the finalized core document API.
 *
 * core now owns validation / default merging / normalization:
 *   normalizeWorldDocument(input): { document, issues }
 *   parseWorldDocumentJson(text): { document, issues }   (never throws)
 *
 * This wrapper only adds last-resort exception safety and readable issue
 * formatting for the UI; the legacy web normalizer in documentIO remains as a
 * fallback for exceptional cases.
 */
import {
  normalizeWorldDocument as coreNormalizeWorldDocumentImpl,
  parseWorldDocumentJson as coreParseWorldDocumentJsonImpl,
} from "@atlas/core";
import type { DocumentIssue, NormalizedDocument } from "@atlas/core";

export type { DocumentIssue, NormalizedDocument };

export function hasCoreDocumentApi(): boolean {
  return true;
}

export function coreNormalizeWorldDocument(input: unknown): NormalizedDocument | null {
  try {
    return coreNormalizeWorldDocumentImpl(input);
  } catch {
    return null;
  }
}

export function coreParseWorldDocumentJson(text: string): NormalizedDocument | null {
  try {
    return coreParseWorldDocumentJsonImpl(text);
  } catch {
    return null;
  }
}

/** Human readable summary of the most important issues (path + message). */
export function formatDocumentIssues(issues: DocumentIssue[], limit = 2): string {
  const errors = issues.filter((issue) => issue.severity === "error");
  const relevant = errors.length > 0 ? errors : issues;
  const shown = relevant.slice(0, limit).map((issue) => {
    const prefix = issue.path ? `${issue.path}: ` : "";
    return `${prefix}${issue.message}`;
  });
  const rest = relevant.length - shown.length;
  return shown.join("；") + (rest > 0 ? `；另有 ${rest} 项` : "");
}

export function countIssues(issues: DocumentIssue[], severity: "error" | "warning"): number {
  return issues.filter((issue) => issue.severity === severity).length;
}
