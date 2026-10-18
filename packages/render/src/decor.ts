/**
 * Cartographic decorations: border, title cartouche, compass rose, scale bar,
 * legend, graticule and the final paper-ageing wash.
 *
 * Everything is procedural (no assets) and scales with the design unit so the
 * 1024 preview and the 4096 export stay visually identical. The planner returns
 * the rectangles that labels must avoid and two draw phases: `drawUnder` runs
 * before labels (graticule), `drawOver` after them (frames, cartouche, ageing).
 */
import { hasCjk, textFont } from "./fonts";
import { drawTrackedText, measureWithTracking } from "./labels";
import type { Rect } from "./layout";
import { hash01, hashSigned, SeededRandom } from "./noise";
import type { RenderPass } from "./pass";
import { cssRgb } from "./style";

export interface DecorPlan {
  avoid: Rect[];
  drawUnder(): void;
  drawOver(): void;
}

interface Layout {
  m1: number;
  m2: number;
  m3: number;
  cartouche: Rect;
  compass: { cx: number; cy: number; r: number } | null;
  scaleBar: { x: number; y: number; w: number; h: number } | null;
  legend: Rect | null;
  title: string;
  subtitle: string;
  footer: string;
  cjk: boolean;
  titleSize: number;
  subtitleSize: number;
  titleTracking: number;
}

const ROMAN: Array<[number, string]> = [
  [1000, "M"],
  [900, "CM"],
  [500, "D"],
  [400, "CD"],
  [100, "C"],
  [90, "XC"],
  [50, "L"],
  [40, "XL"],
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];

function roman(value: number): string {
  let n = Math.max(1, Math.min(3999, Math.round(value)));
  let out = "";
  for (const [v, sym] of ROMAN) {
    while (n >= v) {
      out += sym;
      n -= v;
    }
  }
  return out;
}

function niceKm(value: number): number {
  const steps = [100, 200, 250, 500, 750, 1000, 1500, 2000, 2500, 3000, 4000, 5000];
  let best = steps[0];
  let bestDiff = Infinity;
  for (const step of steps) {
    const diff = Math.abs(step - value);
    if (diff < bestDiff) {
      best = step;
      bestDiff = diff;
    }
  }
  return best;
}

function yearFromDocument(pass: RenderPass): number {
  const created = Date.parse(pass.document.createdAt ?? "");
  return Number.isFinite(created) ? new Date(created).getUTCFullYear() : 2026;
}

function computeLayout(pass: RenderPass): Layout {
  const { ctx, width, height, scale, theme, document } = pass;
  const style = document.style;
  const size = Math.min(width, height);
  const title = (style.title || document.name || "Untitled World").trim() || "Untitled World";
  const cjk = hasCjk(title);
  const m1 = (style.showBorder ? theme.decor.frameInset : 6) * scale;
  const m2 = (style.showBorder ? theme.decor.frameInnerInset : 10) * scale;
  const m3 = (style.showBorder ? theme.decor.innerRuleInset : 14) * scale;
  const titleSize = theme.decor.titleScale * scale;
  const subtitleSize = theme.decor.subtitleScale * scale;
  const titleTracking = (cjk ? 0.2 : 0.14) * titleSize;
  const pad = 12 * scale;

  // Title cartouche, fitted to the frame.
  const titleText = cjk ? title : title.toUpperCase();
  const titleFont = textFont(titleText, titleSize, false);
  let fittedSize = titleSize;
  let fittedTracking = titleTracking;
  let titleW = measureWithTracking(ctx, titleText, titleFont, fittedTracking);
  const maxCartoucheW = Math.min(width * 0.58, width - m3 * 2 - 12 * scale);
  const maxTextW = maxCartoucheW - pad * 2;
  for (let i = 0; i < 8 && titleW > maxTextW; i += 1) {
    fittedSize *= 0.92;
    fittedTracking = (cjk ? 0.2 : 0.14) * fittedSize;
    titleW = measureWithTracking(ctx, titleText, textFont(titleText, fittedSize, false), fittedTracking);
  }
  const subtitle = cjk ? "寰 宇 图 志" : "A CHART OF THE KNOWN WORLD";
  const footerText = cjk
    ? `寰宇工坊 · 种子 ${document.seed}`
    : `ATLAS FORGE · SEED ${document.seed}`;
  const cartoucheW = Math.max(width * 0.34, titleW + pad * 2.2);
  const cartoucheH = fittedSize * 1.55 + subtitleSize * 1.9 + pad * 1.3;
  const cartouche: Rect = {
    x: (width - cartoucheW) / 2,
    y: m1 * 0.55,
    w: cartoucheW,
    h: cartoucheH,
  };

  const compassRadius = theme.decor.compassRadius * scale;
  const compass = style.showCompass
    ? {
        cx: width - m3 - compassRadius * 1.12,
        cy: m3 + compassRadius * 1.12,
        r: compassRadius,
      }
    : null;

  const scaleW = Math.min(theme.decor.scaleWidth * scale, width * 0.25);
  const scaleH = theme.decor.scaleHeight * scale;
  const scaleBar = style.showLegend
    ? { x: m3 + 10 * scale, y: height - m3 - 26 * scale, w: scaleW, h: scaleH }
    : null;
  // The scale bar is always drawn under the map, so reserve its space only if
  // the legend is also on (otherwise it would collide with the legend box).
  const showScale = style.showLegend;
  const scalePlan = showScale
    ? { x: m3 + 10 * scale, y: height - m3 - 24 * scale, w: scaleW, h: scaleH }
    : null;

  let legend: Rect | null = null;
  if (style.showLegend) {
    const rowH = 18 * scale;
    const headerH = 20 * scale;
    const legendW = Math.min(width * 0.215, 260 * scale);
    const legendH = headerH + rowH * 4 + 12 * scale;
    legend = {
      x: width - m3 - legendW,
      y: height - m3 - legendH,
      w: legendW,
      h: legendH,
    };
  }

  void scaleBar;
  return {
    m1,
    m2,
    m3,
    cartouche,
    compass,
    scaleBar: scalePlan,
    legend,
    title: titleText,
    subtitle,
    footer: footerText,
    cjk,
    titleSize: fittedSize,
    subtitleSize,
    titleTracking: fittedTracking,
  };
}

// ── Drawing primitives ────────────────────────────────────────────────────

function roundRectPath(ctx: RenderPass["ctx"], rect: Rect, radius: number): void {
  const r = Math.min(radius, rect.w / 2, rect.h / 2);
  const x = rect.x;
  const y = rect.y;
  const w = rect.w;
  const h = rect.h;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function diamondPath(ctx: RenderPass["ctx"], cx: number, cy: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx + r, cy);
  ctx.lineTo(cx, cy + r);
  ctx.lineTo(cx - r, cy);
  ctx.closePath();
}

// ── Graticule ─────────────────────────────────────────────────────────────

function drawGraticule(pass: RenderPass, layout: Layout): void {
  const { ctx, width, height, scale, theme, quality } = pass;
  const left = layout.m3;
  const top = layout.m3;
  const right = width - layout.m3;
  const bottom = height - layout.m3;
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, right - left, bottom - top);
  ctx.clip();
  const alpha = theme.decor.graticuleAlpha;
  const dash = theme.decor.graticuleDash * scale;
  ctx.lineWidth = 0.7 * scale;
  ctx.strokeStyle = cssRgb(theme.ink.soft, alpha);
  ctx.setLineDash([dash, dash * 1.4]);
  for (let i = 1; i < 12; i += 1) {
    if (i === 6) continue;
    const x = left + ((right - left) * i) / 12;
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
    ctx.stroke();
    const y = top + ((bottom - top) * i) / 12;
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.lineWidth = 1.05 * scale;
  ctx.strokeStyle = cssRgb(theme.ink.soft, alpha * 1.55);
  ctx.beginPath();
  ctx.moveTo(left + (right - left) / 2, top);
  ctx.lineTo(left + (right - left) / 2, bottom);
  ctx.moveTo(left, top + (bottom - top) / 2);
  ctx.lineTo(right, top + (bottom - top) / 2);
  ctx.stroke();

  // Coordinate labels along the top and left edges.
  if (quality === "export" || width >= 900) {
    const labelSize = 11 * scale;
    ctx.font = textFont("W", labelSize, false);
    ctx.fillStyle = cssRgb(theme.ink.soft, alpha * 3.1);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (let i = 1; i < 12; i += 1) {
      if (i === 6) continue;
      const x = left + ((right - left) * i) / 12;
      const lon = Math.round(((i / 12) - 0.5) * 360);
      const suffix = lon === 0 ? "" : lon < 0 ? "°W" : "°E";
      ctx.fillText(`${Math.abs(lon)}${suffix}`, x, top + labelSize * 1.1);
      const y = top + ((bottom - top) * i) / 12;
      const lat = Math.round((0.5 - i / 12) * 180);
      const latSuffix = lat === 0 ? "°" : lat < 0 ? "°S" : "°N";
      ctx.textAlign = "left";
      ctx.fillText(`${Math.abs(lat)}${latSuffix}`, left + labelSize * 0.7, y);
      ctx.textAlign = "center";
    }
  }
  ctx.restore();
}

// ── Border ────────────────────────────────────────────────────────────────

function drawBorder(pass: RenderPass, layout: Layout): void {
  const { ctx, width, height, scale, theme } = pass;
  const { m1, m2, m3 } = layout;
  const ink = cssRgb(theme.ink.border);

  ctx.save();
  ctx.lineJoin = "miter";
  // Outer heavy rule.
  ctx.strokeStyle = cssRgb(theme.ink.border, 0.92);
  ctx.lineWidth = theme.decor.frameThickness * scale;
  ctx.strokeRect(m1, m1, width - m1 * 2, height - m1 * 2);
  // Inner fine rule pair.
  ctx.lineWidth = 0.95 * scale;
  ctx.strokeStyle = cssRgb(theme.ink.border, 0.75);
  ctx.strokeRect(m2, m2, width - m2 * 2, height - m2 * 2);
  ctx.lineWidth = 0.55 * scale;
  ctx.strokeStyle = cssRgb(theme.ink.border, 0.45);
  ctx.strokeRect(m3, m3, width - m3 * 2, height - m3 * 2);

  // Diamonds at the inner rule corners and edge midpoints.
  const d = 2.6 * scale;
  ctx.fillStyle = cssRgb(theme.paper.light, 0.95);
  ctx.strokeStyle = cssRgb(theme.ink.border, 0.75);
  ctx.lineWidth = 0.7 * scale;
  const corners: Array<[number, number]> = [
    [m2, m2],
    [width - m2, m2],
    [width - m2, height - m2],
    [m2, height - m2],
  ];
  for (const [x, y] of corners) {
    diamondPath(ctx, x, y, d);
    ctx.fill();
    ctx.stroke();
  }
  const mids: Array<[number, number]> = [
    [width / 2, m2],
    [width / 2, height - m2],
    [m2, height / 2],
    [width - m2, height / 2],
  ];
  for (const [x, y] of mids) {
    diamondPath(ctx, x, y, d * 0.85);
    ctx.fillStyle = cssRgb(theme.ink.border, 0.7);
    ctx.fill();
  }

  // Corner flourishes just inside the content rule.
  const L = Math.min(width, height) * 0.034;
  const inset = m3 + 2 * scale;
  const drawCorner = (sx: number, sy: number): void => {
    ctx.save();
    ctx.translate(sx > 0 ? width - inset : inset, sy > 0 ? height - inset : inset);
    ctx.scale(sx, sy);
    ctx.strokeStyle = cssRgb(theme.ink.border, 0.55);
    ctx.lineWidth = 0.8 * scale;
    ctx.beginPath();
    ctx.moveTo(L, 0);
    ctx.lineTo(L * 0.28, 0);
    ctx.quadraticCurveTo(0, 0, 0, L * 0.28);
    ctx.lineTo(0, L);
    ctx.moveTo(L * 0.68, 0.16 * L);
    ctx.lineTo(L * 0.2, 0.16 * L);
    ctx.lineTo(0.16 * L, 0.2 * L);
    ctx.lineTo(0.16 * L, L * 0.68);
    ctx.stroke();
    ctx.fillStyle = cssRgb(theme.ink.border, 0.6);
    diamondPath(ctx, 0.07 * L, 0.07 * L, 1.5 * scale);
    ctx.fill();
    ctx.restore();
  };
  drawCorner(1, 1);
  drawCorner(-1, 1);
  drawCorner(1, -1);
  drawCorner(-1, -1);
  ctx.restore();
  void ink;
}

// ── Cartouche ─────────────────────────────────────────────────────────────

function drawCartouche(pass: RenderPass, layout: Layout): void {
  const { ctx, width, scale, theme } = pass;
  const rect = layout.cartouche;
  const pad = 12 * scale;
  ctx.save();
  // Parchment plate under the title.
  ctx.fillStyle = cssRgb(theme.paper.light, Math.min(1, theme.decor.cartoucheAlpha + 0.06));
  roundRectPath(ctx, rect, 5 * scale);
  ctx.fill();
  ctx.strokeStyle = cssRgb(theme.ink.border, 0.85);
  ctx.lineWidth = 1.35 * scale;
  ctx.stroke();
  const inner: Rect = {
    x: rect.x + 4.5 * scale,
    y: rect.y + 4.5 * scale,
    w: rect.w - 9 * scale,
    h: rect.h - 9 * scale,
  };
  ctx.strokeStyle = cssRgb(theme.ink.border, 0.55);
  ctx.lineWidth = 0.6 * scale;
  roundRectPath(ctx, inner, 3 * scale);
  ctx.stroke();

  // Corner curls.
  const curl = 7 * scale;
  ctx.strokeStyle = cssRgb(theme.ink.border, 0.7);
  ctx.lineWidth = 1 * scale;
  const curlAt = (x: number, y: number, sx: number, sy: number): void => {
    ctx.beginPath();
    ctx.moveTo(x + sx * curl, y);
    ctx.quadraticCurveTo(x + sx * curl * 0.2, y, x, y + sy * curl * 0.2);
    ctx.moveTo(x + sx * curl * 0.55, y + sy * 0.12 * curl);
    ctx.quadraticCurveTo(x + sx * curl * 0.1, y + sy * 0.1 * curl, x + sx * 0.12 * curl, y + sy * curl * 0.55);
    ctx.stroke();
  };
  curlAt(rect.x, rect.y, -1, -1);
  curlAt(rect.x + rect.w, rect.y, 1, -1);
  curlAt(rect.x, rect.y + rect.h, -1, 1);
  curlAt(rect.x + rect.w, rect.y + rect.h, 1, 1);

  const cx = width / 2;
  const titleY = rect.y + rect.h * 0.34;
  // Diamond fleuron above the title.
  ctx.fillStyle = cssRgb(theme.ink.border, 0.8);
  diamondPath(ctx, cx, rect.y + 9 * scale, 2.4 * scale);
  ctx.fill();
  drawTrackedText(
    ctx,
    layout.title,
    cx,
    titleY,
    layout.titleSize,
    layout.titleTracking,
    textFont(layout.title, layout.titleSize, false),
    "center",
  );
  ctx.fillStyle = cssRgb(theme.ink.main, 0.92);

  // Subtitle with flanking rules.
  const subY = rect.y + rect.h * 0.72;
  const subFont = textFont(layout.subtitle, layout.subtitleSize, false);
  const subW = measureWithTracking(ctx, layout.subtitle, subFont, layout.subtitleSize * 0.12);
  ctx.font = subFont;
  ctx.fillStyle = cssRgb(theme.ink.soft, 0.92);
  drawTrackedText(
    ctx,
    layout.subtitle,
    cx,
    subY,
    layout.subtitleSize,
    layout.subtitleSize * 0.12,
    subFont,
    "center",
  );
  const ruleGap = layout.subtitleSize * 0.8;
  const ruleLen = Math.min(rect.w * 0.2, (rect.w - subW) * 0.45);
  ctx.strokeStyle = cssRgb(theme.ink.soft, 0.65);
  ctx.lineWidth = 0.7 * scale;
  ctx.beginPath();
  ctx.moveTo(cx - subW / 2 - ruleGap - ruleLen, subY);
  ctx.lineTo(cx - subW / 2 - ruleGap, subY);
  ctx.moveTo(cx + subW / 2 + ruleGap, subY);
  ctx.lineTo(cx + subW / 2 + ruleGap + ruleLen, subY);
  ctx.stroke();
  for (const sx of [-1, 1]) {
    diamondPath(ctx, cx + sx * (subW / 2 + ruleGap + ruleLen + 2 * scale), subY, 1.6 * scale);
    ctx.fillStyle = cssRgb(theme.ink.soft, 0.65);
    ctx.fill();
  }

  // Footer line: seed / maker's imprint.
  const footerSize = layout.subtitleSize * 0.72;
  ctx.font = textFont(layout.footer, footerSize, false);
  ctx.fillStyle = cssRgb(theme.ink.soft, 0.7);
  drawTrackedText(
    ctx,
    layout.footer,
    cx,
    rect.y + rect.h - pad * 0.45,
    footerSize,
    footerSize * 0.16,
    textFont(layout.footer, footerSize, false),
    "center",
  );
  void pad;
  ctx.restore();
}

// ── Compass rose ──────────────────────────────────────────────────────────

function drawCompass(pass: RenderPass, layout: Layout): void {
  const compass = layout.compass;
  if (!compass) return;
  const { ctx, scale, theme } = pass;
  const { cx, cy, r } = compass;
  ctx.save();
  ctx.translate(cx, cy);
  const paper = cssRgb(theme.paper.light, 0.96);
  const ink = cssRgb(theme.ink.main, 0.9);
  const soft = cssRgb(theme.ink.main, 0.55);

  // Rings and ticks.
  ctx.strokeStyle = cssRgb(theme.ink.main, 0.75);
  ctx.lineWidth = 0.95 * scale;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = soft;
  ctx.lineWidth = 0.6 * scale;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.82, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  for (let i = 0; i < 16; i += 1) {
    const a = (i / 16) * Math.PI * 2;
    const inner = r * (i % 4 === 0 ? 0.88 : 0.93);
    ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner);
    ctx.lineTo(Math.cos(a) * r * 0.99, Math.sin(a) * r * 0.99);
  }
  ctx.stroke();

  // Eight-point star. Cardinal points are longer; each point is split into a
  // shaded and a light half like a classic engraved compass rose.
  for (let i = 0; i < 8; i += 1) {
    const angle = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const len = i % 2 === 0 ? r * 0.86 : r * 0.52;
    const half = len * 0.2;
    const dirX = Math.cos(angle);
    const dirY = Math.sin(angle);
    const perpX = -dirY;
    const perpY = dirX;
    const tipX = dirX * len;
    const tipY = dirY * len;
    // Dark half.
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(0, 0);
    ctx.lineTo(perpX * half, perpY * half);
    ctx.closePath();
    ctx.fillStyle = cssRgb(theme.ink.main, i === 0 ? 0.88 : 0.72);
    ctx.fill();
    // Light half.
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(0, 0);
    ctx.lineTo(-perpX * half, -perpY * half);
    ctx.closePath();
    ctx.fillStyle = paper;
    ctx.fill();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 0.55 * scale;
    ctx.stroke();
  }
  // Centre boss.
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.075, 0, Math.PI * 2);
  ctx.fillStyle = ink;
  ctx.fill();
  // North marker and fleur tip.
  ctx.fillStyle = cssRgb(theme.ink.accent, 0.95);
  diamondPath(ctx, 0, -r * 0.86, r * 0.055);
  ctx.fill();
  const northSize = r * 0.36;
  ctx.font = textFont("N", northSize, false);
  ctx.fillStyle = cssRgb(theme.ink.accent, 0.95);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("N", 0, -r * 1.16);
  ctx.restore();
}

// ── Scale bar ─────────────────────────────────────────────────────────────

function drawScaleBar(pass: RenderPass, layout: Layout): void {
  const scaleBar = layout.scaleBar;
  if (!scaleBar) return;
  const { ctx, width, scale, theme } = pass;
  const { x, y, w, h } = scaleBar;
  const ink = cssRgb(theme.ink.main, 0.86);
  const segments = 4;
  const segW = w / segments;
  ctx.save();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.9 * scale;
  for (let i = 0; i < segments; i += 1) {
    if (i % 2 === 0) {
      ctx.fillStyle = cssRgb(theme.ink.main, 0.78);
      ctx.fillRect(x + i * segW, y, segW, h);
    } else {
      ctx.fillStyle = cssRgb(theme.paper.light, 0.9);
      ctx.fillRect(x + i * segW, y, segW, h);
    }
  }
  ctx.strokeRect(x, y, w, h);
  ctx.beginPath();
  for (let i = 0; i <= segments; i += 1) {
    ctx.moveTo(x + i * segW, y - 2.2 * scale);
    ctx.lineTo(x + i * segW, y + h + 2.2 * scale);
  }
  ctx.stroke();

  const totalKm = niceKm((8000 * w) / width);
  const midKm = totalKm / 2;
  const labelSize = 13 * scale;
  const unit = layout.cjk ? "公里" : "km";
  ctx.font = textFont(layout.cjk ? "公" : "k", labelSize, false);
  ctx.fillStyle = cssRgb(theme.ink.main, 0.9);
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const labelY = y + h + 5 * scale;
  ctx.fillText("0", x, labelY);
  ctx.fillText(String(midKm), x + w / 2, labelY);
  ctx.fillText(`${totalKm} ${unit}`, x + w, labelY);
  ctx.restore();
}

// ── Legend ────────────────────────────────────────────────────────────────

function drawLegend(pass: RenderPass, layout: Layout): void {
  const legend = layout.legend;
  if (!legend) return;
  const { ctx, scale, theme } = pass;
  const cjk = layout.cjk;
  const rowH = 18 * scale;
  const headerH = 20 * scale;
  const pad = 8 * scale;
  ctx.save();
  ctx.fillStyle = cssRgb(theme.paper.light, 0.86);
  roundRectPath(ctx, legend, 3 * scale);
  ctx.fill();
  ctx.strokeStyle = cssRgb(theme.ink.border, 0.8);
  ctx.lineWidth = 1 * scale;
  ctx.stroke();
  ctx.strokeStyle = cssRgb(theme.ink.border, 0.45);
  ctx.lineWidth = 0.5 * scale;
  roundRectPath(
    ctx,
    { x: legend.x + 3 * scale, y: legend.y + 3 * scale, w: legend.w - 6 * scale, h: legend.h - 6 * scale },
    2 * scale,
  );
  ctx.stroke();

  const header = cjk ? "图  例" : "L E G E N D";
  const headerSize = 10.5 * scale;
  ctx.font = textFont(header, headerSize, false);
  ctx.fillStyle = cssRgb(theme.ink.main, 0.92);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  drawTrackedText(
    ctx,
    header,
    legend.x + legend.w / 2,
    legend.y + headerH * 0.55,
    headerSize,
    cjk ? headerSize * 0.12 : headerSize * 0.16,
    textFont(header, headerSize, false),
    "center",
  );
  ctx.strokeStyle = cssRgb(theme.ink.soft, 0.6);
  ctx.lineWidth = 0.6 * scale;
  ctx.beginPath();
  ctx.moveTo(legend.x + pad, legend.y + headerH);
  ctx.lineTo(legend.x + legend.w - pad, legend.y + headerH);
  ctx.stroke();

  const entries: Array<{ kind: "city" | "river" | "mountain" | "ocean"; label: string }> = [
    { kind: "city", label: cjk ? "城市" : "CITY" },
    { kind: "river", label: cjk ? "河流" : "RIVER" },
    { kind: "mountain", label: cjk ? "山脉" : "MOUNTAINS" },
    { kind: "ocean", label: cjk ? "海洋" : "OCEAN" },
  ];
  const glyphX = legend.x + pad + 8 * scale;
  const textSize = 10 * scale;
  let rowY = legend.y + headerH + rowH * 0.62;
  for (const entry of entries) {
    drawLegendGlyph(ctx, entry.kind, glyphX, rowY, scale, theme);
    ctx.font = textFont(entry.label, textSize, false);
    ctx.fillStyle = cssRgb(theme.ink.main, 0.9);
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(entry.label, glyphX + 14 * scale, rowY);
    rowY += rowH;
  }
  ctx.restore();
}

function drawLegendGlyph(
  ctx: RenderPass["ctx"],
  kind: "city" | "river" | "mountain" | "ocean",
  x: number,
  y: number,
  scale: number,
  theme: RenderPass["theme"],
): void {
  const ink = cssRgb(theme.ink.main, 0.88);
  ctx.save();
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (kind === "city") {
    ctx.beginPath();
    ctx.arc(x, y, 3.4 * scale, 0, Math.PI * 2);
    ctx.strokeStyle = ink;
    ctx.lineWidth = 0.8 * scale;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 1.6 * scale, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === "river") {
    ctx.lineWidth = 1.7 * scale;
    ctx.beginPath();
    ctx.moveTo(x - 5 * scale, y + 2 * scale);
    ctx.quadraticCurveTo(x - 2 * scale, y - 2.5 * scale, x + 0.5 * scale, y);
    ctx.quadraticCurveTo(x + 3 * scale, y + 2.5 * scale, x + 5.5 * scale, y - 1.5 * scale);
    ctx.stroke();
  } else if (kind === "mountain") {
    ctx.lineWidth = 0.8 * scale;
    for (const dx of [-4, 1.5]) {
      ctx.beginPath();
      ctx.moveTo(x + dx * scale, y + 3.5 * scale);
      ctx.lineTo(x + (dx + 2) * scale, y - 3 * scale);
      ctx.lineTo(x + (dx + 4) * scale, y + 3.5 * scale);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + (dx + 2) * scale, y + 3.5 * scale);
      ctx.lineTo(x + (dx + 2) * scale, y - 3 * scale);
      ctx.stroke();
    }
  } else {
    ctx.lineWidth = 0.7 * scale;
    ctx.strokeStyle = cssRgb(theme.ocean.ruling, 0.8);
    for (let i = -1; i <= 1; i += 1) {
      ctx.beginPath();
      ctx.moveTo(x - 5 * scale, y + i * 2.4 * scale);
      ctx.quadraticCurveTo(x - 2 * scale, y + i * 2.4 * scale - 1.4 * scale, x, y + i * 2.4 * scale);
      ctx.quadraticCurveTo(x + 2 * scale, y + i * 2.4 * scale + 1.4 * scale, x + 5 * scale, y + i * 2.4 * scale);
      ctx.stroke();
    }
  }
  ctx.restore();
}

// ── Paper ageing overlay ──────────────────────────────────────────────────

function drawAging(pass: RenderPass): void {
  const { ctx, width, height, scale, theme, seed, quality } = pass;
  const size = Math.min(width, height);
  const rng = new SeededRandom((seed ^ 0x5bd1e995) | 0);
  ctx.save();
  // Warm varnish gradient.
  const varnish = ctx.createLinearGradient(0, 0, width, height);
  varnish.addColorStop(0, "rgba(120, 90, 45, 0.045)");
  varnish.addColorStop(0.5, "rgba(90, 66, 35, 0.02)");
  varnish.addColorStop(1, "rgba(105, 76, 40, 0.06)");
  ctx.fillStyle = varnish;
  ctx.fillRect(0, 0, width, height);

  // Corner darkening.
  for (const [cx, cy] of [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ]) {
    const radius = size * (0.24 + rng.next() * 0.12);
    const stain = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    stain.addColorStop(0, "rgba(86, 60, 30, 0.13)");
    stain.addColorStop(0.55, "rgba(96, 70, 38, 0.05)");
    stain.addColorStop(1, "rgba(96, 70, 38, 0)");
    ctx.fillStyle = stain;
    ctx.fillRect(0, 0, width, height);
  }

  // Seeded age stains.
  const stainCount = quality === "export" ? 9 : 6;
  for (let i = 0; i < stainCount; i += 1) {
    const cx = hash01(i, 11, seed) * width;
    const cy = hash01(i, 23, seed) * height;
    const radius = size * (0.05 + hash01(i, 37, seed) * 0.16);
    const grad = ctx.createRadialGradient(cx, cy, radius * 0.1, cx, cy, radius);
    const strength = 0.06 + hash01(i, 41, seed) * 0.1;
    grad.addColorStop(0, `rgba(112, 82, 44, ${strength.toFixed(3)})`);
    grad.addColorStop(0.6, `rgba(112, 82, 44, ${(strength * 0.4).toFixed(3)})`);
    grad.addColorStop(1, "rgba(112, 82, 44, 0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
  }

  // A few broad damp stains that cross both land and sea.
  for (let i = 0; i < 2; i += 1) {
    const cx = hash01(i, 131, seed) * width;
    const cy = hash01(i, 137, seed) * height;
    const radius = size * (0.3 + hash01(i, 139, seed) * 0.18);
    const grad = ctx.createRadialGradient(cx, cy, radius * 0.2, cx, cy, radius);
    grad.addColorStop(0, "rgba(150, 116, 66, 0.075)");
    grad.addColorStop(0.55, "rgba(140, 108, 62, 0.035)");
    grad.addColorStop(1, "rgba(140, 108, 62, 0)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
  }

  // Fold creases: a soft shadow/highlight pair.
  const fold = (vertical: boolean, at: number): void => {
    const band = 2.6 * scale;
    let grad;
    if (vertical) {
      grad = ctx.createLinearGradient(at - band * 4, 0, at + band * 4, 0);
    } else {
      grad = ctx.createLinearGradient(0, at - band * 4, 0, at + band * 4);
    }
    grad.addColorStop(0, "rgba(90, 64, 32, 0)");
    grad.addColorStop(0.4, "rgba(90, 64, 32, 0.045)");
    grad.addColorStop(0.5, "rgba(255, 246, 222, 0.05)");
    grad.addColorStop(0.6, "rgba(90, 64, 32, 0.035)");
    grad.addColorStop(1, "rgba(90, 64, 32, 0)");
    ctx.fillStyle = grad;
    if (vertical) ctx.fillRect(at - band * 4, 0, band * 8, height);
    else ctx.fillRect(0, at - band * 4, width, band * 8);
  };
  fold(true, width * 0.5);
  fold(false, height * 0.5);

  // Foxing specks.
  const speckCount = quality === "export" ? 320 : 140;
  ctx.fillStyle = "rgba(96, 66, 32, 0.16)";
  ctx.beginPath();
  for (let i = 0; i < speckCount; i += 1) {
    const x = hash01(i, 71, seed) * width;
    const y = hash01(i, 89, seed) * height;
    const r = (0.35 + hash01(i, 97, seed) * 1.1) * scale;
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.restore();
  void hashSigned;
}

// ── Planner ───────────────────────────────────────────────────────────────

export function planDecorations(pass: RenderPass): DecorPlan {
  const layout = computeLayout(pass);
  const style = pass.document.style;
  const avoid: Rect[] = [];
  avoid.push({
    x: layout.cartouche.x - 6,
    y: layout.cartouche.y - 6,
    w: layout.cartouche.w + 12,
    h: layout.cartouche.h + 12,
  });
  if (layout.compass) {
    const c = layout.compass;
    avoid.push({ x: c.cx - c.r, y: c.cy - c.r, w: c.r * 2, h: c.r * 2 });
  }
  if (layout.legend) {
    const l = layout.legend;
    avoid.push({ x: l.x, y: l.y, w: l.w, h: l.h });
  }
  if (layout.scaleBar) {
    const s = layout.scaleBar;
    avoid.push({ x: s.x - 4, y: s.y - 6, w: s.w + 8, h: s.h + 22 * pass.scale });
  }
  const canvas: Rect = { x: 0, y: 0, w: pass.width, h: pass.height };
  void canvas;

  return {
    avoid,
    drawUnder(): void {
      if (style.showGraticule) drawGraticule(pass, layout);
    },
    drawOver(): void {
      if (style.showBorder) drawBorder(pass, layout);
      drawCartouche(pass, layout);
      if (style.showCompass) drawCompass(pass, layout);
      if (style.showLegend) {
        drawScaleBar(pass, layout);
        drawLegend(pass, layout);
      }
      drawAging(pass);
    },
  };
}
