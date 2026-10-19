/**
 * Shared map-chrome layout (v0.6).
 *
 * Every configurable element (title cartouche, compass, scale bar, legend,
 * credits, graticule, border) is positioned here exactly once; the canvas
 * renderer and the SVG exporter both consume this layout. Visibility and anchor
 * come from `document.style.decorations` (core contract), with a graceful
 * fallback to the legacy show* booleans for documents that never went through
 * the v0.6 migration.
 *
 * Hidden elements produce `null`/zero rects, so hiding the title does not leave
 * a blank strip at the top of the map.
 */
import { resolveDecorations } from "@atlas/core";
import type { DecorAnchor, DecorConfig, DecorId, RenderStyle, WorldDocument } from "@atlas/core";

import { hasCjk, textFont } from "./fonts";
import type { Rect } from "./layout";
import type { RenderTheme } from "./style";

export interface DecorSettings {
  title: DecorConfig;
  compass: DecorConfig;
  scaleBar: DecorConfig;
  legend: DecorConfig;
  graticule: DecorConfig;
  border: DecorConfig;
  credits: DecorConfig;
}

/** Measure a text run (including manual tracking) in image pixels. */
export type MeasureText = (text: string, font: string, tracking: number) => number;

export interface ChromeLayout {
  m1: number;
  m2: number;
  m3: number;
  /** Printable area (inside the frame when the border is on). */
  safe: Rect;
  border: boolean;
  graticule: boolean;
  title: {
    visible: boolean;
    text: string;
    subtitle: string;
    footer: string;
    cjk: boolean;
    size: number;
    subtitleSize: number;
    tracking: number;
    rect: Rect;
  };
  compass: { cx: number; cy: number; r: number } | null;
  scaleBar: Rect | null;
  legend: Rect | null;
  credits: { rect: Rect; text: string; size: number } | null;
  /** Rectangles labels must avoid (only visible elements). */
  avoid: Rect[];
  anchors: Record<DecorId, DecorAnchor>;
}

export interface ChromeInput {
  document: WorldDocument;
  width: number;
  height: number;
  scale: number;
  theme: RenderTheme;
  measure: MeasureText;
}

/** Legacy show* booleans are folded in only when `decorations` is absent. */
export function resolveDecorSettings(document: WorldDocument): DecorSettings {
  const style = document.style as RenderStyle;
  const resolved = resolveDecorations(style.decorations);
  if (style.decorations === undefined) {
    // Pre-v0.6 in-memory document: honour the legacy toggles.
    if (typeof style.showCompass === "boolean") resolved.compass = { ...resolved.compass, visible: style.showCompass };
    if (typeof style.showLegend === "boolean") resolved.legend = { ...resolved.legend, visible: style.showLegend };
    if (typeof style.showGraticule === "boolean") resolved.graticule = { ...resolved.graticule, visible: style.showGraticule };
    if (typeof style.showBorder === "boolean") resolved.border = { ...resolved.border, visible: style.showBorder };
  }
  return resolved as DecorSettings;
}

function placeAtAnchor(
  anchor: DecorAnchor,
  width: number,
  height: number,
  margin: number,
  size: { w: number; h: number },
): { x: number; y: number } {
  const left = margin;
  const right = width - margin - size.w;
  const centerX = (width - size.w) / 2;
  const top = margin;
  const bottom = height - margin - size.h;
  switch (anchor) {
    case "top-left":
      return { x: left, y: top };
    case "top-center":
      return { x: centerX, y: top };
    case "top-right":
      return { x: right, y: top };
    case "bottom-left":
      return { x: left, y: bottom };
    case "bottom-center":
      return { x: centerX, y: bottom };
    case "bottom-right":
      return { x: right, y: bottom };
    default:
      return { x: centerX, y: top };
  }
}

function anchorFrom(config: DecorConfig, fallback: DecorAnchor): DecorAnchor {
  return (config.anchor ?? fallback) as DecorAnchor;
}

export function computeChromeLayout(input: ChromeInput): ChromeLayout {
  const { document, width, height, scale, theme, measure } = input;
  const style = document.style;
  const settings = resolveDecorSettings(document);
  const border = settings.border.visible;
  const m1 = (border ? theme.decor.frameInset : 6) * scale;
  const m2 = (border ? theme.decor.frameInnerInset : 10) * scale;
  const m3 = (border ? theme.decor.innerRuleInset : 14) * scale;
  const safe: Rect = {
    x: m1,
    y: m1,
    w: width - m1 * 2,
    h: height - m1 * 2,
  };
  const margin = m3 + 6 * scale;

  // ── Title cartouche ────────────────────────────────────────────────────
  const rawTitle = (settings.title.text ?? style.title ?? document.name ?? "Untitled World").trim();
  const titleSource = rawTitle.length > 0 ? rawTitle : "Untitled World";
  const cjk = hasCjk(titleSource);
  const titleText = cjk ? titleSource : titleSource.toUpperCase();
  const titleSize0 = theme.decor.titleScale * scale;
  const subtitleSize = theme.decor.subtitleScale * scale;
  const pad = 12 * scale;
  let size = titleSize0;
  let tracking = (cjk ? 0.2 : 0.14) * size;
  const fontOf = (s: number) => textFont(titleText, s, false);
  let textW = measure(titleText, fontOf(size), tracking);
  const maxCartoucheW = Math.min(width * 0.58, width - m3 * 2 - 12 * scale);
  const maxTextW = maxCartoucheW - pad * 2;
  for (let i = 0; i < 8 && textW > maxTextW; i += 1) {
    size *= 0.92;
    tracking = (cjk ? 0.2 : 0.14) * size;
    textW = measure(titleText, fontOf(size), tracking);
  }
  const subtitleText =
    settings.title.subtitle ??
    (cjk ? "寰 宇 图 志" : "A CHART OF THE KNOWN WORLD");
  // The cartouche footer is the provenance line; the credits element below the
  // map carries the (customisable) attribution so the two never duplicate.
  const footerText = cjk ? `寰宇工坊 · 种子 ${document.seed}` : `ATLAS FORGE · SEED ${document.seed}`;
  const creditsText = (settings.credits.text ?? "Atlas Forge").trim();
  const cartoucheW = Math.max(width * 0.34, textW + pad * 2.2);
  const cartoucheH = size * 1.55 + subtitleSize * 1.9 + pad * 1.3;
  const titleAnchor = anchorFrom(settings.title, "top-center");
  const titleVisible = settings.title.visible;
  let titleRect: Rect;
  if (!titleVisible) {
    titleRect = { x: (width - cartoucheW) / 2, y: m1 * 0.55, w: 0, h: 0 };
  } else if (titleAnchor.startsWith("bottom")) {
    const pos = placeAtAnchor(titleAnchor, width, height, margin, { w: cartoucheW, h: cartoucheH });
    titleRect = { x: pos.x, y: pos.y, w: cartoucheW, h: cartoucheH };
  } else {
    // Titles keep their traditional inset above the map artwork.
    titleRect = { x: (width - cartoucheW) / 2, y: m1 * 0.55, w: cartoucheW, h: cartoucheH };
    if (titleAnchor === "top-left") titleRect.x = margin;
    if (titleAnchor === "top-right") titleRect.x = width - margin - cartoucheW;
  }

  // ── Compass ────────────────────────────────────────────────────────────
  const compassRadius = theme.decor.compassRadius * scale;
  const compassAnchor = anchorFrom(settings.compass, "top-right");
  const compass = settings.compass.visible
    ? (() => {
        const pos = placeAtAnchor(compassAnchor, width, height, margin + compassRadius * 0.12, {
          w: compassRadius * 2,
          h: compassRadius * 2,
        });
        return { cx: pos.x + compassRadius, cy: pos.y + compassRadius, r: compassRadius };
      })()
    : null;

  // ── Scale bar ──────────────────────────────────────────────────────────
  const scaleW = Math.min(theme.decor.scaleWidth * scale, width * 0.25);
  const scaleH = theme.decor.scaleHeight * scale;
  const scaleAnchor = anchorFrom(settings.scaleBar, "bottom-left");
  const scaleBar = settings.scaleBar.visible
    ? (() => {
        // Leave room for the numeric labels under the bar.
        const pos = placeAtAnchor(scaleAnchor, width, height, margin, { w: scaleW, h: scaleH + 18 * scale });
        return { x: pos.x, y: pos.y, w: scaleW, h: scaleH };
      })()
    : null;

  // ── Legend ─────────────────────────────────────────────────────────────
  const legendW = Math.min(width * 0.215, 260 * scale);
  const rowH = 18 * scale;
  const legendH = 20 * scale + rowH * 4 + 12 * scale;
  const legendAnchor = anchorFrom(settings.legend, "bottom-right");
  const legend = settings.legend.visible
    ? (() => {
        const pos = placeAtAnchor(legendAnchor, width, height, margin, { w: legendW, h: legendH });
        return { x: pos.x, y: pos.y, w: legendW, h: legendH };
      })()
    : null;

  // ── Credits ────────────────────────────────────────────────────────────
  const creditsSize = Math.max(8 * scale, 10 * scale);
  const creditsH = creditsSize * 1.6;
  const creditsW = Math.min(width * 0.5, 420 * scale);
  const creditsAnchor = anchorFrom(settings.credits, "bottom-center");
  const credits = settings.credits.visible
    ? (() => {
        const pos = placeAtAnchor(creditsAnchor, width, height, margin * 0.6, { w: creditsW, h: creditsH });
        return { rect: { x: pos.x, y: pos.y, w: creditsW, h: creditsH }, text: creditsText, size: creditsSize };
      })()
    : null;

  // Collision relief: a wide cartouche can reach the top corners. Nudge corner
  // anchored chrome below the title instead of letting them overlap.
  const shifts: Array<{ rect: Rect | null; set: (dy: number) => void }> = [];
  if (titleVisible) {
    const t = titleRect;
    const overlapsTitle = (r: Rect) => {
      const ox = Math.min(t.x + t.w, r.x + r.w) - Math.max(t.x, r.x);
      const oy = Math.min(t.y + t.h, r.y + r.h) - Math.max(t.y, r.y);
      return ox > 1 && oy > 1;
    };
    if (compass) {
      const box = { x: compass.cx - compass.r, y: compass.cy - compass.r, w: compass.r * 2, h: compass.r * 2 };
      if (overlapsTitle(box)) {
        const dy = t.y + t.h + 8 * scale - box.y;
        compass.cy += dy;
      }
    }
    if (legend) {
      if (legend.y < t.y + t.h && overlapsTitle(legend)) legend.y = t.y + t.h + 8 * scale;
    }
    if (credits) {
      if (credits.rect.y < t.y + t.h && overlapsTitle(credits.rect)) credits.rect.y = t.y + t.h + 8 * scale;
    }
    if (scaleBar) {
      if (scaleBar.y < t.y + t.h && overlapsTitle(scaleBar)) scaleBar.y = t.y + t.h + 8 * scale;
    }
  }
  void shifts;

  const avoid: Rect[] = [];
  if (titleVisible) avoid.push({ x: titleRect.x - 6, y: titleRect.y - 6, w: titleRect.w + 12, h: titleRect.h + 12 });
  if (compass) avoid.push({ x: compass.cx - compass.r, y: compass.cy - compass.r, w: compass.r * 2, h: compass.r * 2 });
  if (legend) avoid.push({ x: legend.x, y: legend.y, w: legend.w, h: legend.h });
  if (scaleBar) avoid.push({ x: scaleBar.x - 4, y: scaleBar.y - 6, w: scaleBar.w + 8, h: scaleBar.h + 22 * scale });
  if (credits) avoid.push({ x: credits.rect.x, y: credits.rect.y - 4, w: credits.rect.w, h: credits.rect.h + 8 });

  return {
    m1,
    m2,
    m3,
    safe,
    border,
    graticule: settings.graticule.visible,
    title: {
      visible: titleVisible,
      text: titleText,
      subtitle: subtitleText,
      footer: footerText,
      cjk,
      size,
      subtitleSize,
      tracking,
      rect: titleRect,
    },
    compass,
    scaleBar,
    legend,
    credits,
    avoid,
    anchors: {
      title: titleAnchor,
      compass: compassAnchor,
      scaleBar: scaleAnchor,
      legend: legendAnchor,
      graticule: "top-center",
      border: "top-center",
      credits: creditsAnchor,
    },
  };
}

export type { DecorAnchor, DecorId };
