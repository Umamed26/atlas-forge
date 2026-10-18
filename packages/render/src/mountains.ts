/**
 * Hand-drawn mountain glyphs, the signature visual of parchment cartography.
 *
 * Peaks are detected as coarse-grid local maxima of the height field, then drawn
 * as little engraved summit symbols (bell outline + shadow hachures) whose size
 * and ink weight follow the theme. Glyphs are deterministic and scale with the
 * output, so 1024 and 4096 maps read the same.
 */
import type { RenderPass } from "./pass";
import { hash01 } from "./noise";
import { cssRgb } from "./style";

const NEIGHBORS: Array<[number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

function qualitySize(quality: RenderPass["quality"]): number {
  return quality === "export" ? 1.2 : 1.1;
}

/** Draw mountain symbols on high terrain. Returns the number of glyphs drawn. */
export function drawMountainGlyphs(pass: RenderPass, maxLand: number): number {
  const { ctx, layers, theme, scale, seed, seaLevel, quality } = pass;
  const n = layers.size;
  const height = layers.height;
  const ocean = layers.ocean;
  const lake = layers.lake;
  if (!height || n < 8) return 0;
  const step = Math.max(2, Math.min(18, Math.round(n / (quality === "export" ? 96 : 88))));
  const threshold = 0.24;
  const ink = cssRgb(theme.ink.main, 0.86);
  const paper = cssRgb(theme.paper.light, 0.22);
  let drawn = 0;
  const maxGlyphs = quality === "export" ? 260 : 110;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (let y = step; y < n - step; y += step) {
    if (drawn >= maxGlyphs) break;
    for (let x = step; x < n - step; x += step) {
      if (drawn >= maxGlyphs) break;
      const i = y * n + x;
      if (ocean[i] || lake[i]) continue;
      const h = height[i];
      const t = (h - seaLevel) / Math.max(1e-4, maxLand);
      if (t < threshold) continue;
      // Coarse local maximum only: one cluster per summit.
      let isMax = true;
      for (const [dx, dy] of NEIGHBORS) {
        if (height[(y + dy * step) * n + (x + dx * step)] > h + 1e-5) {
          isMax = false;
          break;
        }
      }
      if (!isMax) continue;
      // Prominence: the summit must stand out from the surrounding ridge.
      let ringMin = h;
      for (let ry = -2; ry <= 2; ry += 1) {
        for (let rx = -2; rx <= 2; rx += 1) {
          const rx2 = x + rx * step;
          const ry2 = y + ry * step;
          if (rx2 < 0 || ry2 < 0 || rx2 >= n || ry2 >= n) continue;
          const rv = height[ry2 * n + rx2];
          if (rv < ringMin) ringMin = rv;
        }
      }
      if (h - ringMin < maxLand * 0.055) continue;

      // Ridge tangent (perpendicular to the height gradient) so satellites run
      // along the range instead of scattering randomly.
      const hxm = height[(y * n + Math.max(0, x - step))];
      const hxp = height[(y * n + Math.min(n - 1, x + step))];
      const hym = height[(Math.max(0, y - step) * n) + x];
      const hyp = height[(Math.min(n - 1, y + step) * n) + x];
      let tx = -(hyp - hym);
      let ty = hxp - hxm;
      const tlen = Math.hypot(tx, ty) || 1;
      tx /= tlen;
      ty /= tlen;
      const jx = (hash01(x, y, seed + 1201) - 0.5) * step * 0.55;
      const jy = (hash01(x, y, seed + 1207) - 0.5) * step * 0.4;
      const u = (x + jx) / n;
      const v = (y + jy) / n;
      if (u < 0.045 || u > 0.955 || v < 0.045 || v > 0.955) continue;
      const sizeRand = hash01(x, y, seed + 1213);
      const baseW =
        (6.2 + sizeRand * 4.6) * scale * (0.82 + 0.42 * Math.min(1, t)) * qualitySize(quality);
      const clusterCount = quality === "export" ? 4 : 3;
      for (let c = 0; c < clusterCount; c += 1) {
        if (drawn >= maxGlyphs) break;
        const along = (c - (clusterCount - 1) / 2) * step * 0.6;
        const su = u + (tx * along) / n;
        const sv = v + (ty * along) / n;
        if (su < 0.03 || su > 0.97 || sv < 0.03 || sv > 0.97) continue;
        const falloff = c === 0 ? 1 : 0.62 + 0.18 * hash01(c, x + y * n, seed + 1223);
        const gw = baseW * falloff;
        const gh = gw * (0.95 + hash01(c, x + y * n, seed + 1229) * 0.4);
        drawPeak(
          ctx,
          su * pass.width,
          sv * pass.height,
          gw,
          gh,
          ink,
          paper,
          scale,
          x + y * n + c * 17,
          seed,
        );
        drawn += 1;
      }
    }
  }
  ctx.restore();
  return drawn;
}

function quadPoint(
  ax: number,
  ay: number,
  cxp: number,
  cyp: number,
  bx: number,
  by: number,
  t: number,
): [number, number] {
  const mt = 1 - t;
  return [
    mt * mt * ax + 2 * mt * t * cxp + t * t * bx,
    mt * mt * ay + 2 * mt * t * cyp + t * t * by,
  ];
}

function drawPeak(
  ctx: RenderPass["ctx"],
  x: number,
  y: number,
  w: number,
  h: number,
  ink: string,
  paper: string,
  scale: number,
  glyphSeed: number,
  seed: number,
): void {
  const baseY = y + h * 0.42;
  // Small companion peak behind (drawn first, fainter).
  const cw = w * 0.62;
  const ch = h * 0.66;
  const cxp = x - w * 0.82;
  ctx.beginPath();
  ctx.moveTo(cxp - cw, baseY - h * 0.04);
  ctx.quadraticCurveTo(cxp - cw * 0.36, baseY - ch * 0.76, cxp, baseY - ch);
  ctx.quadraticCurveTo(cxp + cw * 0.36, baseY - ch * 0.76, cxp + cw, baseY - h * 0.04);
  ctx.fillStyle = paper;
  ctx.fill();
  ctx.strokeStyle = ink;
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = Math.max(0.55, 0.8 * scale);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Main bell-shaped summit.
  const ctrlX = x + w * 0.2;
  const ctrlY = y - h * 0.02;
  ctx.beginPath();
  ctx.moveTo(x - w, baseY);
  ctx.quadraticCurveTo(x - w * 0.24, y - h * 0.06, x, y - h);
  ctx.quadraticCurveTo(x + w * 0.24, y - h * 0.06, x + w, baseY);
  ctx.closePath();
  ctx.fillStyle = paper;
  ctx.fill();
  ctx.strokeStyle = ink;
  ctx.globalAlpha = 0.92;
  ctx.lineWidth = Math.max(0.7, 1 * scale);
  ctx.stroke();

  // Shadow hachures on the east slope.
  ctx.beginPath();
  const hatchCount = 5;
  for (let k = 1; k <= hatchCount; k += 1) {
    const f = 0.18 + (k / (hatchCount + 1)) * 0.76;
    const [px, py] = quadPoint(x, y - h, ctrlX, ctrlY, x + w, baseY, f);
    const [qx, qy] = quadPoint(x, y - h, ctrlX, ctrlY, x + w, baseY, Math.min(1, f + 0.1));
    let dx = qx - px;
    let dy = qy - py;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const jitter = (hash01(glyphSeed, k, seed + 1301) - 0.5) * 0.24;
    const hatchLen = h * (0.18 + 0.08 * (k / hatchCount));
    ctx.moveTo(px, py);
    ctx.lineTo(px + (dx - dy * jitter) * hatchLen, py + (dy + dx * jitter) * hatchLen);
  }
  ctx.strokeStyle = ink;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = Math.max(0.5, 0.75 * scale);
  ctx.stroke();
  ctx.globalAlpha = 1;
  // Faint ground line grounds the symbol on the slope.
  ctx.beginPath();
  ctx.moveTo(x - w * 1.15, baseY + 0.8 * scale);
  ctx.lineTo(x + w * 1.15, baseY + 0.8 * scale);
  ctx.strokeStyle = ink;
  ctx.globalAlpha = 0.22;
  ctx.lineWidth = Math.max(0.4, 0.5 * scale);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Tiny apex tick.
  ctx.beginPath();
  ctx.moveTo(x, y - h - 0.6 * scale);
  ctx.lineTo(x, y - h - 2.4 * scale);
  ctx.strokeStyle = ink;
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = Math.max(0.5, 0.65 * scale);
  ctx.stroke();
  ctx.globalAlpha = 1;
}
