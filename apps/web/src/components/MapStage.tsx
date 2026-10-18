/**
 * Interactive map stage.
 *
 * Two stacked canvases:
 *  - `map-canvas`    (pointer target) draws the rasterized base map with the
 *                    current pan/zoom transform. Never re-simulates on zoom.
 *  - `brush-overlay` draws brush cursor, live stroke stamps, forced-river
 *                    polylines and the in-progress river drafting line.
 *
 * All edit coordinates are normalized world space [0,1] and are committed into
 * document.overrides; nothing here is view-dependent persistence.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  BIOME_NAMES,
  PIPELINE_STAGE_LABELS,
  type BiomeId,
  type BiomeStamp,
  type ElevationStamp,
  type PipelineStage,
} from "@atlas/core";

import {
  BASE_RENDER_SIZE,
  BIOME_COLORS,
  BIOME_ORDER,
  ELEVATION_MODES,
  MAX_STROKE_STAMPS,
  TOOLS,
  type ToolId,
} from "../lib/constants";
import { clamp01, formatMs, isEditableTarget } from "../lib/utils";
import { screenToWorld, useViewStore } from "../state/viewStore";
import { useWorldStore, type BrushState } from "../state/worldStore";
import { ProgressBar, Swatch } from "./ui";

const STAGES: PipelineStage[] = ["terrain", "hydrology", "climate", "biome", "human"];
const RIVER_MIN_POINT_DISTANCE = 0.00499;

interface PanSession {
  pointerId: number;
  startX: number;
  startY: number;
  offsetX: number;
  offsetY: number;
}

interface StrokeSession {
  pointerId: number;
  kind: "elevation" | "biome";
  stamps: (ElevationStamp | BiomeStamp)[];
}

type StampPoint = { x: number; y: number };

function makeElevationStamp(point: StampPoint, brush: BrushState): ElevationStamp {
  const value =
    brush.elevationMode === "lock"
      ? clamp01(brush.lockHeight)
      : brush.elevationMode === "lower"
        ? -brush.strength
        : brush.strength;
  return {
    x: clamp01(point.x),
    y: clamp01(point.y),
    radius: brush.radius,
    value,
    mode: brush.elevationMode,
  };
}

function makeBiomeStamp(point: StampPoint, brush: BrushState): BiomeStamp {
  return {
    x: clamp01(point.x),
    y: clamp01(point.y),
    radius: brush.radius,
    biome: brush.biome,
  };
}

function makeStamp(kind: "elevation" | "biome", point: StampPoint, brush: BrushState) {
  return kind === "elevation" ? makeElevationStamp(point, brush) : makeBiomeStamp(point, brush);
}

/** #rrggbb → rgba() with the given alpha. */
function withAlpha(hex: string, alpha: number): string {
  const value = hex.replace("#", "");
  if (value.length !== 6) return hex;
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// ── Toolbar sub-components ────────────────────────────────────────────────

function MiniSlider({
  label,
  value,
  min,
  max,
  step,
  format,
  testId,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  testId?: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label className={`mini-slider ${disabled ? "is-disabled" : ""}`}>
      <span className="mini-label">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        aria-label={label}
        data-testid={testId}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <em className="mini-value">{format(value)}</em>
    </label>
  );
}

function ToolOptions() {
  const tool = useWorldStore((state) => state.tool);
  const brush = useWorldStore((state) => state.brush);
  const draft = useWorldStore((state) => state.riverDraft);
  const store = useWorldStore.getState();

  if (tool === "pan") {
    return (
      <div className="tool-options">
        <span className="tool-options-hint">拖动平移，或按住空格临时平移；滚轮以光标为中心缩放。</span>
      </div>
    );
  }

  if (tool === "elevation") {
    return (
      <div className="tool-options">
        <div className="segmented" role="group" aria-label="海拔模式">
          {ELEVATION_MODES.map((mode) => (
            <button
              key={mode.id}
              type="button"
              className={`segmented-button ${brush.elevationMode === mode.id ? "is-active" : ""}`}
              aria-pressed={brush.elevationMode === mode.id}
              title={mode.title}
              data-testid={`elev-mode-${mode.id}`}
              onClick={() => useWorldStore.getState().setElevationMode(mode.id)}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <MiniSlider
          label="半径"
          value={brush.radius}
          min={0.005}
          max={0.12}
          step={0.001}
          testId="brush-radius"
          format={(value) => `${(value * 100).toFixed(1)}%`}
          onChange={(value) => store.setBrush({ radius: value })}
        />
        <MiniSlider
          label="强度"
          value={brush.strength}
          min={0.02}
          max={0.4}
          step={0.01}
          testId="brush-strength"
          disabled={brush.elevationMode === "lock"}
          format={(value) => value.toFixed(2)}
          onChange={(value) => store.setBrush({ strength: value })}
        />
        {brush.elevationMode === "lock" ? (
          <MiniSlider
            label="锁定海拔"
            value={brush.lockHeight}
            min={0.05}
            max={0.95}
            step={0.01}
            testId="brush-lock-height"
            format={(value) => value.toFixed(2)}
            onChange={(value) => store.setBrush({ lockHeight: value })}
          />
        ) : null}
      </div>
    );
  }

  if (tool === "river") {
    return (
      <div className="tool-options">
        <MiniSlider
          label="河宽"
          value={brush.riverWidth}
          min={0.001}
          max={0.03}
          step={0.001}
          testId="river-width"
          format={(value) => `${(value * 100).toFixed(2)}%`}
          onChange={(value) => store.setBrush({ riverWidth: value })}
        />
        <span className="tool-options-count" data-testid="river-draft-count">
          节点 {draft.points.length}
        </span>
        <button
          type="button"
          className="btn btn--small btn--ghost"
          disabled={draft.points.length === 0}
          data-testid="river-undo-point"
          onClick={() => store.undoRiverPoint()}
        >
          退一点
        </button>
        <button
          type="button"
          className="btn btn--small"
          disabled={draft.points.length < 2}
          data-testid="river-commit"
          onClick={() => store.commitRiverDraft()}
        >
          完成（回车）
        </button>
        <button
          type="button"
          className="btn btn--small btn--ghost"
          disabled={draft.points.length === 0}
          data-testid="river-cancel"
          onClick={() => store.clearRiverDraft()}
        >
          取消
        </button>
      </div>
    );
  }

  return (
    <div className="tool-options">
      <label className="biome-picker">
        <span className="mini-label">群系</span>
        <Swatch color={BIOME_COLORS[brush.biome]} />
        <select
          value={String(brush.biome)}
          aria-label="选择群系"
          data-testid="biome-select"
          onChange={(event) =>
            useWorldStore.getState().setBiome(Number(event.target.value) as BiomeId)
          }
        >
          {BIOME_ORDER.map((biome) => (
            <option key={biome} value={biome}>
              {BIOME_NAMES[biome]}
            </option>
          ))}
        </select>
      </label>
      <MiniSlider
        label="半径"
        value={brush.radius}
        min={0.005}
        max={0.12}
        step={0.001}
        testId="brush-radius"
        format={(value) => `${(value * 100).toFixed(1)}%`}
        onChange={(value) => store.setBrush({ radius: value })}
      />
    </div>
  );
}

// ── Generation overlays ───────────────────────────────────────────────────

function GenerationOverlay() {
  const phase = useWorldStore((state) => state.generation.phase);
  const progress = useWorldStore((state) => state.generation.progress);
  const startedAt = useWorldStore((state) => state.generation.startedAt);
  const queuedLatest = useWorldStore((state) => state.generation.queuedLatest);
  const [now, setNow] = useState(() => Date.now());
  const active = phase === "generating" || phase === "queued";

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 120);
    return () => window.clearInterval(timer);
  }, [active]);

  if (!active) return null;
  const percent = Math.round((progress?.progress ?? 0) * 100);
  const elapsed = startedAt ? Math.max(0, now - startedAt) : 0;
  const activeStage = progress?.stage ?? "terrain";
  const activeIndex = STAGES.indexOf(activeStage);

  return (
    <div className="stage-overlay" data-testid="progress">
      <div className="progress-card">
        <div className="progress-title">
          <span className="spinner" aria-hidden="true" />
          正在生成世界
          <span className="progress-percent">{percent}%</span>
        </div>
        <ProgressBar value={progress?.progress ?? 0.02} />
        <div className="progress-meta">
          <span>{progress?.label ?? "排队准备"}…</span>
          <span>{formatMs(elapsed)}</span>
        </div>
        <ol className="stage-steps">
          {STAGES.map((stage, index) => {
            const stateClass =
              index < activeIndex
                ? "is-done"
                : index === activeIndex && phase === "generating"
                  ? "is-active"
                  : "";
            return (
              <li key={stage} className={stateClass}>
                {PIPELINE_STAGE_LABELS[stage]}
              </li>
            );
          })}
        </ol>
        {queuedLatest ? (
          <p className="progress-note">已提交最新参数，当前任务结束后立即重算。</p>
        ) : null}
      </div>
    </div>
  );
}

function GenerationErrorBanner() {
  const phase = useWorldStore((state) => state.generation.phase);
  const error = useWorldStore((state) => state.generation.error);
  if (phase !== "error" || !error) return null;
  return (
    <div className="stage-error" role="alert" data-testid="generation-error">
      <div className="stage-error-copy">
        <strong>生成失败</strong>
        <span>{error}</span>
      </div>
      <div className="stage-error-actions">
        <button
          type="button"
          className="btn btn--small btn--primary"
          data-testid="retry-generate"
          onClick={() => useWorldStore.getState().requestGeneration("now")}
        >
          重试
        </button>
        <button
          type="button"
          className="btn btn--small btn--ghost"
          onClick={() => useWorldStore.getState().clearGenerationError()}
        >
          关闭
        </button>
      </div>
    </div>
  );
}

function StageHint() {
  const tool = useWorldStore((state) => state.tool);
  const toolDef = TOOLS.find((entry) => entry.id === tool) ?? TOOLS[0];
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    setVisible(true);
    const timer = window.setTimeout(() => setVisible(false), 1600);
    return () => window.clearTimeout(timer);
  }, [tool]);
  return (
    <div
      className={`stage-hint ${visible ? "is-visible" : ""}`}
      data-testid="tool-hint"
      aria-live="polite"
    >
      <span className="stage-hint-icon" aria-hidden="true">{toolDef.icon}</span>
      <strong>{toolDef.label}</strong>
      <span className="stage-hint-text">{toolDef.hint}</span>
    </div>
  );
}

function EmptyStage() {
  const hasCanvas = useWorldStore((state) => state.baseCanvas !== null);
  const active = useWorldStore(
    (state) => state.generation.phase === "generating" || state.generation.phase === "queued",
  );
  if (hasCanvas || active) return null;
  return (
    <div className="stage-empty" data-testid="empty-state">
      <div className="stage-empty-card">
        <span className="stage-empty-mark" aria-hidden="true">✦</span>
        <h2>尚未生成世界</h2>
        <p>调整左侧参数，或直接生成一张全新的羊皮纸世界地图。</p>
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => useWorldStore.getState().requestGeneration("now")}
        >
          生成世界
        </button>
      </div>
    </div>
  );
}

// ── Map stage ─────────────────────────────────────────────────────────────

export function MapStage() {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const mapCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawRafRef = useRef<number | null>(null);
  const pointerRef = useRef<{ x: number; y: number; inside: boolean }>({
    x: 0,
    y: 0,
    inside: false,
  });
  const panRef = useRef<PanSession | null>(null);
  const strokeRef = useRef<StrokeSession | null>(null);
  const spaceRef = useRef(false);

  const [spaceDown, setSpaceDown] = useState(false);
  const [panning, setPanning] = useState(false);

  const tool = useWorldStore((state) => state.tool);
  const brush = useWorldStore((state) => state.brush);
  const riverDraft = useWorldStore((state) => state.riverDraft);
  const riverForce = useWorldStore((state) => state.document.overrides.riverForce);
  const baseVersion = useWorldStore((state) => state.render.baseVersion);
  const scale = useViewStore((state) => state.scale);

  // ── draw ────────────────────────────────────────────────────────────
  const draw = useCallback(() => {
    const mapCanvas = mapCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    if (!mapCanvas || !overlayCanvas) return;
    const mapCtx = mapCanvas.getContext("2d");
    const overlayCtx = overlayCanvas.getContext("2d");
    if (!mapCtx || !overlayCtx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssWidth = mapCanvas.clientWidth;
    const cssHeight = mapCanvas.clientHeight;
    if (cssWidth === 0 || cssHeight === 0) return;

    const world = useWorldStore.getState();
    const view = useViewStore.getState();
    const { scale: viewScale, offsetX, offsetY } = view;
    const mapPx = BASE_RENDER_SIZE * viewScale;

    // Base layer: dark backdrop + paper sheet + raster.
    mapCtx.setTransform(1, 0, 0, 1, 0, 0);
    mapCtx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
    mapCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const backdrop = mapCtx.createLinearGradient(0, 0, cssWidth, cssHeight);
    backdrop.addColorStop(0, "#1a1611");
    backdrop.addColorStop(1, "#0e0c09");
    mapCtx.fillStyle = backdrop;
    mapCtx.fillRect(0, 0, cssWidth, cssHeight);
    const vignette = mapCtx.createRadialGradient(
      cssWidth / 2,
      cssHeight / 2,
      Math.min(cssWidth, cssHeight) * 0.18,
      cssWidth / 2,
      cssHeight / 2,
      Math.max(cssWidth, cssHeight) * 0.72,
    );
    vignette.addColorStop(0, "rgba(90, 70, 40, 0.18)");
    vignette.addColorStop(1, "rgba(0, 0, 0, 0.32)");
    mapCtx.fillStyle = vignette;
    mapCtx.fillRect(0, 0, cssWidth, cssHeight);

    if (world.baseCanvas) {
      mapCtx.save();
      mapCtx.shadowColor = "rgba(0, 0, 0, 0.6)";
      mapCtx.shadowBlur = 28;
      mapCtx.shadowOffsetY = 10;
      mapCtx.fillStyle = "#e8dcc0";
      mapCtx.fillRect(offsetX, offsetY, mapPx, mapPx);
      mapCtx.restore();
      mapCtx.imageSmoothingEnabled = true;
      mapCtx.imageSmoothingQuality = "high";
      mapCtx.drawImage(world.baseCanvas, offsetX, offsetY, mapPx, mapPx);
      mapCtx.strokeStyle = "rgba(217, 181, 108, 0.35)";
      mapCtx.lineWidth = 1;
      mapCtx.strokeRect(offsetX + 0.5, offsetY + 0.5, mapPx - 1, mapPx - 1);
    }

    // Overlay layer: editing feedback only.
    overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const toScreen = (x: number, y: number) => ({
      x: offsetX + x * mapPx,
      y: offsetY + y * mapPx,
    });

    // Existing forced rivers, shown as dashed guides while using the river tool.
    if (world.tool === "river" && world.document.overrides.riverForce.length > 0) {
      overlayCtx.save();
      overlayCtx.setLineDash([7, 6]);
      overlayCtx.lineCap = "round";
      overlayCtx.lineJoin = "round";
      overlayCtx.strokeStyle = "rgba(126, 198, 214, 0.7)";
      for (const river of world.document.overrides.riverForce) {
        overlayCtx.beginPath();
        river.points.forEach(([x, y], index) => {
          const point = toScreen(x, y);
          if (index === 0) overlayCtx.moveTo(point.x, point.y);
          else overlayCtx.lineTo(point.x, point.y);
        });
        overlayCtx.lineWidth = Math.max(1.5, river.width * mapPx);
        overlayCtx.stroke();
      }
      overlayCtx.restore();
    }

    // River drafting polyline.
    if (world.tool === "river" && world.riverDraft.points.length > 0) {
      const points = world.riverDraft.points.map(([x, y]) => toScreen(x, y));
      overlayCtx.save();
      overlayCtx.lineCap = "round";
      overlayCtx.lineJoin = "round";
      overlayCtx.strokeStyle = "rgba(232, 186, 110, 0.92)";
      overlayCtx.lineWidth = Math.max(1.5, world.brush.riverWidth * mapPx);
      overlayCtx.beginPath();
      points.forEach((point, index) => {
        if (index === 0) overlayCtx.moveTo(point.x, point.y);
        else overlayCtx.lineTo(point.x, point.y);
      });
      overlayCtx.stroke();
      for (const point of points) {
        overlayCtx.beginPath();
        overlayCtx.arc(point.x, point.y, 3.2, 0, Math.PI * 2);
        overlayCtx.fillStyle = "rgba(240, 214, 152, 0.95)";
        overlayCtx.fill();
        overlayCtx.strokeStyle = "rgba(30, 24, 16, 0.9)";
        overlayCtx.lineWidth = 1;
        overlayCtx.stroke();
      }
      const pointer = pointerRef.current;
      if (pointer.inside) {
        const last = points[points.length - 1];
        if (last) {
          overlayCtx.setLineDash([5, 5]);
          overlayCtx.strokeStyle = "rgba(232, 186, 110, 0.45)";
          overlayCtx.beginPath();
          overlayCtx.moveTo(last.x, last.y);
          overlayCtx.lineTo(pointer.x, pointer.y);
          overlayCtx.stroke();
        }
      }
      overlayCtx.restore();
    }

    // Live brush stroke stamps (before the layer is committed + re-simulated).
    const stroke = strokeRef.current;
    if (stroke) {
      for (const stamp of stroke.stamps) {
        const center = toScreen(stamp.x, stamp.y);
        const radius = Math.max(1, stamp.radius * mapPx);
        overlayCtx.beginPath();
        overlayCtx.arc(center.x, center.y, radius, 0, Math.PI * 2);
        if (stroke.kind === "biome") {
          overlayCtx.fillStyle = withAlpha(BIOME_COLORS[(stamp as BiomeStamp).biome], 0.42);
          overlayCtx.fill();
        } else {
          const elevation = stamp as ElevationStamp;
          const color =
            elevation.mode === "raise"
              ? "rgba(232, 186, 110, 0.4)"
              : elevation.mode === "lower"
                ? "rgba(122, 164, 208, 0.4)"
                : "rgba(244, 230, 190, 0.45)";
          overlayCtx.fillStyle = color;
          overlayCtx.fill();
        }
      }
    }

    // Brush cursor / preview circle.
    const pointer = pointerRef.current;
    const canPreview =
      pointer.inside && world.tool !== "pan" && world.tool !== "river" && !spaceRef.current;
    if (canPreview) {
      const radius = Math.max(2.5, world.brush.radius * mapPx);
      let strokeColor = "rgba(217, 181, 108, 0.95)";
      let fillColor = "rgba(217, 181, 108, 0.1)";
      let dashed = false;
      if (world.tool === "elevation") {
        if (world.brush.elevationMode === "raise") {
          strokeColor = "rgba(232, 186, 110, 0.95)";
          fillColor = "rgba(232, 186, 110, 0.12)";
        } else if (world.brush.elevationMode === "lower") {
          strokeColor = "rgba(130, 172, 214, 0.95)";
          fillColor = "rgba(130, 172, 214, 0.12)";
        } else {
          strokeColor = "rgba(244, 230, 190, 0.95)";
          fillColor = "rgba(244, 230, 190, 0.14)";
          dashed = true;
        }
      } else if (world.tool === "biome") {
        strokeColor = withAlpha(BIOME_COLORS[world.brush.biome], 0.95);
        fillColor = withAlpha(BIOME_COLORS[world.brush.biome], 0.18);
      }
      overlayCtx.save();
      overlayCtx.beginPath();
      overlayCtx.arc(pointer.x, pointer.y, radius, 0, Math.PI * 2);
      overlayCtx.fillStyle = fillColor;
      overlayCtx.fill();
      overlayCtx.strokeStyle = strokeColor;
      overlayCtx.lineWidth = 1.5;
      if (dashed) overlayCtx.setLineDash([6, 5]);
      overlayCtx.stroke();
      overlayCtx.restore();
      overlayCtx.save();
      overlayCtx.strokeStyle = strokeColor;
      overlayCtx.lineWidth = 1;
      overlayCtx.beginPath();
      overlayCtx.moveTo(pointer.x - 4, pointer.y);
      overlayCtx.lineTo(pointer.x + 4, pointer.y);
      overlayCtx.moveTo(pointer.x, pointer.y - 4);
      overlayCtx.lineTo(pointer.x, pointer.y + 4);
      overlayCtx.stroke();
      overlayCtx.restore();
    }
  }, []);

  const requestDraw = useCallback(() => {
    if (drawRafRef.current !== null) return;
    drawRafRef.current = window.requestAnimationFrame(() => {
      drawRafRef.current = null;
      draw();
    });
  }, [draw]);

  const cancelDraw = useCallback(() => {
    if (drawRafRef.current !== null) {
      window.cancelAnimationFrame(drawRafRef.current);
      drawRafRef.current = null;
    }
  }, []);

  // ── resize & viewport sync ──────────────────────────────────────────
  useEffect(() => {
    const wrap = wrapRef.current;
    const mapCanvas = mapCanvasRef.current;
    const overlayCanvas = overlayCanvasRef.current;
    if (!wrap || !mapCanvas || !overlayCanvas) return;
    const sync = () => {
      const rect = wrap.getBoundingClientRect();
      const cssWidth = Math.max(1, Math.round(rect.width));
      const cssHeight = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const backingWidth = Math.round(cssWidth * dpr);
      const backingHeight = Math.round(cssHeight * dpr);
      for (const canvas of [mapCanvas, overlayCanvas]) {
        if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
          canvas.width = backingWidth;
          canvas.height = backingHeight;
        }
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
      }
      useViewStore.getState().setViewport(cssWidth, cssHeight);
      requestDraw();
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(wrap);
    window.addEventListener("resize", sync);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", sync);
      cancelDraw();
    };
  }, [requestDraw, cancelDraw]);

  // ── redraw triggers ─────────────────────────────────────────────────
  useEffect(() => {
    const unsubscribe = useViewStore.subscribe(() => requestDraw());
    return unsubscribe;
  }, [requestDraw]);

  useEffect(() => {
    requestDraw();
  }, [requestDraw, tool, brush, riverDraft, riverForce, baseVersion]);

  // ── wheel zoom (cursor anchored) ────────────────────────────────────
  useEffect(() => {
    const canvas = mapCanvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      useViewStore.getState().zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor);
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  // ── space-to-pan ────────────────────────────────────────────────────
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      if (isEditableTarget(event.target)) return;
      if (!pointerRef.current.inside) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "BUTTON" || target.tagName === "A" || target.tagName === "SELECT")) {
        return;
      }
      event.preventDefault();
      spaceRef.current = true;
      setSpaceDown(true);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      spaceRef.current = false;
      setSpaceDown(false);
    };
    const onBlur = () => {
      spaceRef.current = false;
      setSpaceDown(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  // ── pointer helpers ─────────────────────────────────────────────────
  const localPoint = (event: { clientX: number; clientY: number }) => {
    const canvas = mapCanvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const pointToWorld = (x: number, y: number) => {
    const view = useViewStore.getState();
    return screenToWorld(x, y, view.scale, view.offsetX, view.offsetY, BASE_RENDER_SIZE);
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = mapCanvasRef.current;
    if (!canvas) return;
    if (event.button !== 0 && event.button !== 1) return;
    const point = localPoint(event);
    pointerRef.current = { x: point.x, y: point.y, inside: true };
    const store = useWorldStore.getState();
    const wantsPan =
      event.button === 1 || (event.button === 0 && (spaceRef.current || store.tool === "pan"));
    canvas.setPointerCapture(event.pointerId);

    if (wantsPan) {
      event.preventDefault();
      const view = useViewStore.getState();
      panRef.current = {
        pointerId: event.pointerId,
        startX: point.x,
        startY: point.y,
        offsetX: view.offsetX,
        offsetY: view.offsetY,
      };
      setPanning(true);
      requestDraw();
      return;
    }

    event.preventDefault();
    const world = pointToWorld(point.x, point.y);

    if (store.tool === "river") {
      if (event.detail >= 2) {
        store.commitRiverDraft();
        requestDraw();
        return;
      }
      store.addRiverPoint(world.x, world.y);
      requestDraw();
      return;
    }

    if (store.tool === "elevation" || store.tool === "biome") {
      store.beginInteraction();
      const kind = store.tool;
      strokeRef.current = {
        pointerId: event.pointerId,
        kind,
        stamps: [makeStamp(kind, world, store.brush)],
      };
      requestDraw();
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const point = localPoint(event);
    pointerRef.current = { x: point.x, y: point.y, inside: true };

    const pan = panRef.current;
    if (pan && pan.pointerId === event.pointerId) {
      const dx = point.x - pan.startX;
      const dy = point.y - pan.startY;
      useViewStore.getState().setOffset(pan.offsetX + dx, pan.offsetY + dy);
      requestDraw();
      return;
    }

    const stroke = strokeRef.current;
    if (stroke && stroke.pointerId === event.pointerId) {
      const world = pointToWorld(point.x, point.y);
      const store = useWorldStore.getState();
      const last = stroke.stamps[stroke.stamps.length - 1];
      const minDistance = Math.max(0.0015, store.brush.radius * 0.28);
      if (
        !last ||
        Math.hypot(world.x - last.x, world.y - last.y) >= minDistance
      ) {
        if (stroke.stamps.length < MAX_STROKE_STAMPS) {
          stroke.stamps.push(makeStamp(stroke.kind, world, store.brush));
        }
      }
      requestDraw();
      return;
    }

    requestDraw();
  };

  const finishStroke = () => {
    const stroke = strokeRef.current;
    if (!stroke) return;
    strokeRef.current = null;
    const store = useWorldStore.getState();
    if (stroke.kind === "elevation") {
      store.addElevationStamps(stroke.stamps as ElevationStamp[]);
    } else {
      store.addBiomeStamps(stroke.stamps as BiomeStamp[]);
    }
    store.endInteraction();
    requestDraw();
  };

  const finishPan = () => {
    if (!panRef.current) return;
    panRef.current = null;
    setPanning(false);
    requestDraw();
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = mapCanvasRef.current;
    if (canvas && canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    if (panRef.current?.pointerId === event.pointerId) finishPan();
    if (strokeRef.current?.pointerId === event.pointerId) finishStroke();
    requestDraw();
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (panRef.current?.pointerId === event.pointerId) finishPan();
    if (strokeRef.current?.pointerId === event.pointerId) finishStroke();
    pointerRef.current.inside = false;
    requestDraw();
  };

  const onPointerEnter = () => {
    pointerRef.current.inside = true;
    requestDraw();
  };

  const onPointerLeave = () => {
    if (panRef.current || strokeRef.current) return;
    pointerRef.current.inside = false;
    requestDraw();
  };

  const onDoubleClick = () => {
    const store = useWorldStore.getState();
    if (store.tool === "river" && store.riverDraft.points.length >= 2) {
      store.commitRiverDraft();
      requestDraw();
    }
  };

  // ── cursor class ────────────────────────────────────────────────────
  const cursorClass = panning
    ? "cursor-grabbing"
    : spaceDown || tool === "pan"
      ? "cursor-grab"
      : tool === "river"
        ? "cursor-crosshair"
        : "cursor-brush";

  return (
    <section className="stage" data-testid="map-stage" aria-label="地图画布">
      <div className="stage-head">
        <div className="stage-tools" data-testid="toolbar">
          <div className="tool-row" role="toolbar" aria-label="编辑工具">
            {TOOLS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={`tool-button ${tool === entry.id ? "is-active" : ""}`}
                aria-pressed={tool === entry.id}
                title={entry.title}
                data-testid={`tool-${entry.id}`}
                onClick={() => useWorldStore.getState().setTool(entry.id as ToolId)}
              >
                <span className="tool-icon" aria-hidden="true">{entry.icon}</span>
                <span className="tool-label">{entry.label}</span>
                <kbd className="tool-kbd">{entry.shortcut}</kbd>
              </button>
            ))}
          </div>
          <ToolOptions />
        </div>
        <div className="stage-head-hint" aria-hidden="true">
          空格平移 · 滚轮缩放 · F 适配 · ? 帮助
        </div>
      </div>

      <div className="stage-wrap" ref={wrapRef}>
        <canvas
          ref={mapCanvasRef}
          className={`map-canvas ${cursorClass}`}
          data-testid="map-canvas"
          aria-label="世界地图画布：拖动平移，滚轮缩放"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerCancel}
          onPointerEnter={onPointerEnter}
          onPointerLeave={onPointerLeave}
          onDoubleClick={onDoubleClick}
          onContextMenu={(event) => event.preventDefault()}
        />
        <canvas
          ref={overlayCanvasRef}
          className="brush-overlay"
          data-testid="brush-overlay"
          aria-hidden="true"
        />

        <StageHint />

        <div className="stage-zoom" role="group" aria-label="缩放控制">
          <button
            type="button"
            className="zoom-button"
            title="缩小（-）"
            aria-label="缩小"
            data-testid="zoom-out"
            onClick={() => useViewStore.getState().zoomBy(0.8)}
          >
            −
          </button>
          <span className="zoom-level" data-testid="zoom-level">{Math.round(scale * 100)}%</span>
          <button
            type="button"
            className="zoom-button"
            title="放大（+）"
            aria-label="放大"
            data-testid="zoom-in"
            onClick={() => useViewStore.getState().zoomBy(1.25)}
          >
            ＋
          </button>
          <button
            type="button"
            className="zoom-button zoom-button--wide"
            title="适配窗口（F）"
            data-testid="zoom-fit"
            onClick={() => useViewStore.getState().fit()}
          >
            适配
          </button>
          <button
            type="button"
            className="zoom-button zoom-button--wide"
            title="1:1 像素（0）"
            data-testid="zoom-one-to-one"
            onClick={() => useViewStore.getState().oneToOne()}
          >
            1:1
          </button>
        </div>

        <GenerationOverlay />
        <GenerationErrorBanner />
        <EmptyStage />
      </div>
    </section>
  );
}
