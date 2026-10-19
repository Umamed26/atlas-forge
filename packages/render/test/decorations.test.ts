/**
 * Map-chrome configuration tests (v0.6).
 *
 *   pnpm -C packages/render test
 *
 * Every element (title / compass / scaleBar / legend / graticule / border /
 * credits) can be hidden or re-anchored. A hidden element must leave no space
 * and no SVG node; visible elements are placed by the shared chrome layout so
 * canvas and SVG agree.
 */
import assert from "node:assert/strict";
import { GlobalFonts } from "@napi-rs/canvas";
import { createDefaultDocument, resolveDecorations, type DecorAnchor, type DecorId, type WorldDocument } from "@atlas/core";

import { computeChromeLayout } from "../src/chrome";
import { renderSvg } from "../src/svg";
import { createCanvas } from "@napi-rs/canvas";
import { defaultDocumentForRenderTests } from "../src/testing";
import { installNodeFonts } from "../src/node-fonts";
import { resolveTheme } from "../src/style";

installNodeFonts(GlobalFonts, { quiet: true });

const DECOR_IDS: DecorId[] = ["title", "compass", "scaleBar", "legend", "graticule", "border", "credits"];
const DECOR_TAGS: DecorId[] = ["compass", "legend", "scaleBar", "credits"];

// Measure with the same bundled font the renderer uses.
const measureCtx = createCanvas(64, 64).getContext("2d");
const measure = (text: string, font: string, tracking: number): number => {
  measureCtx.font = font;
  const base = measureCtx.measureText(text).width;
  return base + Math.max(0, Array.from(text).length - 1) * tracking;
};

function world(): { document: WorldDocument; layers: ReturnType<typeof defaultDocumentForRenderTests>["layers"] } {
  const base = defaultDocumentForRenderTests(512);
  const document: WorldDocument = {
    ...base.document,
    name: "Decor Test",
    style: {
      ...base.document.style,
      title: "Decor Test",
      decorations: { ...resolveDecorations(base.document.style.decorations) },
    },
  };
  return { document, layers: base.layers };
}

function pass(name: string): void {
  console.log(`  ✓ ${name}`);
}

// Theme: obtain it once from the renderer's style resolver.
const theme = resolveTheme("parchment-classic");

// Mirrors the renderer: design units are authored at 1024 and scaled down.
function layoutFor(document: WorldDocument) {
  return computeChromeLayout({ document, width: 512, height: 512, scale: 0.5, theme, measure });
}

// 1) All elements visible by default and laid out inside the frame.
{
  const { document } = world();
  const layout = layoutFor(document);
  assert.ok(layout.title.visible && layout.title.rect.w > 0, "title should be visible by default");
  assert.ok(layout.compass, "compass missing");
  assert.ok(layout.scaleBar, "scale bar missing");
  assert.ok(layout.legend, "legend missing");
  assert.ok(layout.credits && layout.credits.rect.w > 0, "credits missing");
  assert.equal(layout.border, true);
  pass("default chrome exposes all seven elements");
}

// 2) Hiding each element removes it from the layout (no space reserved).
for (const id of DECOR_IDS) {
  const { document } = world();
  const decorations = { ...resolveDecorations(document.style.decorations) };
  decorations[id] = { ...decorations[id], visible: false };
  const hidden: WorldDocument = { ...document, style: { ...document.style, decorations } };
  const layout = layoutFor(hidden);
  if (id === "title") assert.equal(layout.title.visible, false, "title still visible");
  if (id === "compass") assert.equal(layout.compass, null, "compass still laid out");
  if (id === "scaleBar") assert.equal(layout.scaleBar, null, "scale bar still laid out");
  if (id === "legend") assert.equal(layout.legend, null, "legend still laid out");
  if (id === "credits") assert.equal(layout.credits, null, "credits still laid out");
  if (id === "border") assert.equal(layout.border, false, "border still on");
  if (id === "graticule") assert.equal(layout.graticule, false, "graticule still on");
  // A hidden element must not reserve an avoid rectangle.
  assert.equal(
    layout.avoid.some((rect) => rect.w === 0 || rect.h === 0),
    false,
    `${id}: zero-size avoid rect leaked`,
  );
  pass(`hiding ${id} removes it from the layout`);
}

// 3) Hidden elements produce no SVG node; all-off emits no data-decor at all.
{
  const { document, layers } = world();
  const svg = renderSvg({ document, layers, width: 512, height: 512 });
  for (const tag of DECOR_TAGS) assert.ok(svg.includes(`data-decor="${tag}"`), `${tag} missing from default svg`);
  assert.ok(svg.includes('data-decor="title"'), "cartouche group missing from default svg");

  const decorations = { ...resolveDecorations(document.style.decorations) };
  for (const id of DECOR_IDS) decorations[id] = { ...decorations[id], visible: false };
  const bare: WorldDocument = { ...document, style: { ...document.style, decorations } };
  const bareSvg = renderSvg({ document: bare, layers, width: 512, height: 512 });
  for (const tag of DECOR_TAGS) {
    assert.ok(!bareSvg.includes(`data-decor="${tag}"`), `${tag} leaked into the all-off svg`);
  }
  assert.ok(!bareSvg.includes('data-decor="title"'), "cartouche leaked into the all-off svg");
  pass("hidden elements emit no SVG nodes (all-off is a clean base map)");
}

// 4) Anchors move elements inside the safe area.
{
  const { document } = world();
  const moved = JSON.parse(JSON.stringify(document)) as WorldDocument;
  const anchors: Record<string, DecorAnchor> = {
    compass: "bottom-left",
    legend: "top-left",
    scaleBar: "top-right",
    credits: "top-center",
  };
  for (const [id, anchor] of Object.entries(anchors)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (moved.style.decorations as any)[id] = { ...(moved.style.decorations as any)[id], anchor };
  }
  const layout = layoutFor(moved);
  const safe = layout.safe;
  const cx = (rect: { x: number; w: number }) => rect.x + rect.w / 2;
  const cy = (rect: { y: number; h: number }) => rect.y + rect.h / 2;
  assert.ok(layout.compass && cx({ x: layout.compass.cx - layout.compass.r, w: layout.compass.r * 2 }) < safe.x + safe.w * 0.35, "compass not moved to the left");
  assert.ok(layout.legend && layout.legend.x < safe.x + safe.w * 0.35, "legend not moved to top-left");
  assert.ok(layout.scaleBar && layout.scaleBar.x > safe.x + safe.w * 0.5, "scale bar not moved to the right");
  assert.ok(layout.credits && cy(layout.credits.rect) < safe.y + safe.h * 0.3, "credits not moved to the top");
  pass("anchors reposition elements inside the safe area");
}

// 5) Title is centred in the safe area and never overlaps other elements.
{
  const { document } = world();
  const layout = layoutFor(document);
  const title = layout.title.rect;
  const expected = layout.safe.x + layout.safe.w / 2;
  const actual = title.x + title.w / 2;
  assert.ok(Math.abs(expected - actual) <= 1, `title centre off by ${(actual - expected).toFixed(2)}px`);
  const leftPad = title.x - layout.safe.x;
  const rightPad = layout.safe.x + layout.safe.w - (title.x + title.w);
  assert.ok(Math.abs(leftPad - rightPad) <= 1, `title padding differs by ${Math.abs(leftPad - rightPad).toFixed(2)}px`);

  const boxes: Array<{ id: string; x: number; y: number; w: number; h: number }> = [
    { id: "title", ...title },
    ...(layout.compass ? [{ id: "compass", x: layout.compass.cx - layout.compass.r, y: layout.compass.cy - layout.compass.r, w: layout.compass.r * 2, h: layout.compass.r * 2 }] : []),
    ...(layout.legend ? [{ id: "legend", ...layout.legend }] : []),
    ...(layout.scaleBar ? [{ id: "scaleBar", ...layout.scaleBar }] : []),
    ...(layout.credits ? [{ id: "credits", ...layout.credits.rect }] : []),
  ];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i];
      const b = boxes[j];
      const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      assert.ok(!(overlapX > 1 && overlapY > 1), `${a.id} overlaps ${b.id}`);
    }
  }
  pass("title is centred in the safe area and chrome elements never overlap");
}

// 6) Text overrides flow into canvas + SVG, XML-escaped.
{
  const { document, layers } = world();
  const custom: WorldDocument = {
    ...document,
    style: {
      ...document.style,
      decorations: {
        ...resolveDecorations(document.style.decorations),
        title: { visible: true, anchor: "top-center", text: "Custom & <Title>", subtitle: "A Subtitle" },
        credits: { visible: true, anchor: "bottom-center", text: "by Someone & Co." },
      },
    },
  };
  const svg = renderSvg({ document: custom, layers, width: 512, height: 512 });
  // Latin titles are rendered in small caps (uppercased) by design.
  assert.ok(
    /CUSTOM &amp; &lt;TITLE&gt;/i.test(svg),
    "title override missing/unescaped",
  );
  assert.ok(svg.includes("A Subtitle"), "subtitle override missing");
  assert.ok(svg.includes("by Someone &amp; Co."), "credits override missing/unescaped");
  pass("title/subtitle/credits overrides reach the SVG and are escaped");
}

console.log("decoration configuration tests passed");
