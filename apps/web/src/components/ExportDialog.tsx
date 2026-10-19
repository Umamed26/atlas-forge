/**
 * PNG export dialog.
 *
 * - 1024 / 2048 render locally in a Worker (cancellable, real progress).
 * - 4096 / 8192 render on the Node backend (cancellable fetch, staged progress).
 * - The selected size lives in the store so the top bar button reflects it, and
 *   the chosen size is persisted across sessions.
 */
import { useEffect, useRef, useState } from "react";

import { EXPORT_PRESETS, type ExportPreset } from "../lib/constants";
import { refreshServerStatus } from "../lib/api";
import {
  exportPng as desktopExportPng,
  exportSvg as desktopExportSvg,
  isDesktop,
} from "../lib/desktopBridge";
import { ExportError, exportLocalPng, exportServerPng, pngFilename } from "../lib/exportPng";
import { exportSvg, getClientSvgRenderer, hasSvgExport } from "../lib/exportSvg";
import { downloadBlob, formatMs } from "../lib/utils";
import { useWorldStore } from "../state/worldStore";
import { Modal, ProgressBar } from "./ui";

type ExportPhase = "idle" | "working" | "success" | "error";

interface ExportOutcome {
  filename: string;
  meta: {
    size: number;
    simSize: number | null;
    totalMs: number | null;
    simMs: number | null;
    renderMs: number | null;
    fontsReady: boolean | null;
    /** Rendered + written by the Electron main process (no HTTP server). */
    desktop?: boolean;
  };
}

interface ExportFailure {
  kind: string;
  message: string;
  server: boolean;
}

export interface ExportDialogProps {
  open: boolean;
  onClose: () => void;
  /** Format preselected by the native menu (export-png / export-svg). */
  initialFormat?: "png" | "svg";
}

function presetFor(size: number): ExportPreset {
  return EXPORT_PRESETS.find((preset) => preset.size === size) ?? EXPORT_PRESETS[1];
}

const SERVER_STAGES = ["上传世界数据", "服务端生成", "服务端渲染", "下载 PNG"];

/** Desktop exports have no IPC progress channel: stage the label locally. */
const DESKTOP_STAGES = ["生成世界图层", "主进程光栅化", "编码并写入文件"];

const SVG_PRINT_HINTS: Record<number, string> = {
  1024: "A6 @300dpi",
  2048: "A5 @300dpi",
  4096: "A3 @300dpi",
  8192: "A1 @300dpi",
};

export function ExportDialog({ open, onClose, initialFormat = "png" }: ExportDialogProps) {
  const desktop = isDesktop();
  const exportSize = useWorldStore((state) => state.exportSize);
  const documentName = useWorldStore((state) => state.document.name);
  const documentSeed = useWorldStore((state) => state.document.seed);
  const presetId = useWorldStore((state) => state.document.style.preset);
  const setExportSize = useWorldStore((state) => state.setExportSize);
  const server = useWorldStore((state) => state.server);
  const generationActive = useWorldStore(
    (state) =>
      state.generation.phase === "generating" ||
      state.generation.phase === "queued" ||
      state.render.rendering,
  );

  const [format, setFormat] = useState<"png" | "svg">("png");
  const [svgReady, setSvgReady] = useState<boolean | null>(null);
  const [svgClientMode, setSvgClientMode] = useState<boolean>(false);
  const [phase, setPhase] = useState<ExportPhase>("idle");
  const [stageLabel, setStageLabel] = useState("准备导出");
  const [stageIndex, setStageIndex] = useState(-1);
  const [progress, setProgress] = useState(0);
  const [outcome, setOutcome] = useState<ExportOutcome | null>(null);
  const [failure, setFailure] = useState<ExportFailure | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [cancelReason, setCancelReason] = useState<string | null>(null);
  const startedAtRef = useRef<number>(0);
  const abortRef = useRef<AbortController | null>(null);
  const preset = presetFor(exportSize);
  const working = phase === "working";

  // Desktop exports are rendered/written by the Electron main process, so the
  // Node API/offline state and the browser SVG renderer are irrelevant there.
  const serverOffline = !desktop && server.phase === "offline";
  const selectedNeedsServer = !desktop && format === "png" && preset.mode === "server";
  const svgNeedsServer = !desktop && format === "svg" && !svgClientMode;
  const disabledReason = (() => {
    if (generationActive) return "正在生成世界，请等待完成后再导出";
    if (format === "svg") {
      if (desktop) return null;
      if (svgReady === null) return "正在检测 SVG 导出能力…";
      if (svgReady === false) return "SVG 导出不可用：渲染器与服务端均未就绪，可回退 PNG";
      if (svgNeedsServer && serverOffline) return "SVG 需要服务端渲染，当前离线，可回退 PNG";
      return null;
    }
    if (selectedNeedsServer && serverOffline) return "导出服务离线：4096 / 8192 需要 Node API";
    return null;
  })();

  // Native menu "导出 PNG/SVG" preselects the matching format.
  useEffect(() => {
    if (!open) return;
    setFormat(initialFormat);
  }, [open, initialFormat]);

  useEffect(() => {
    if (!open) return;
    if (!desktop) void refreshServerStatus();
    let cancelled = false;
    void (async () => {
      const [ready, renderer] = await Promise.all([hasSvgExport(), getClientSvgRenderer()]);
      if (cancelled) return;
      setSvgReady(ready);
      setSvgClientMode(renderer !== null);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, desktop]);

  useEffect(() => {
    if (!working) return;
    startedAtRef.current = Date.now();
    const timer = window.setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 120);
    return () => window.clearInterval(timer);
  }, [working]);

  // Server-side exports have no progress events: stage the label locally.
  useEffect(() => {
    if (!working || desktop || format !== "png" || preset.mode !== "server") return;
    let index = 0;
    setStageIndex(0);
    setStageLabel(SERVER_STAGES[0]);
    setProgress(0.08);
    const timer = window.setInterval(() => {
      index = Math.min(SERVER_STAGES.length - 1, index + 1);
      setStageIndex(index);
      setStageLabel(SERVER_STAGES[index]);
      setProgress(Math.min(0.85, 0.08 + index * 0.22));
    }, 1400);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working, preset.mode, format, desktop]);

  // Desktop exports also lack IPC progress: animate the local stage labels.
  useEffect(() => {
    if (!working || !desktop) return;
    let index = 0;
    setStageIndex(0);
    setStageLabel(DESKTOP_STAGES[0]);
    setProgress(0.12);
    const timer = window.setInterval(() => {
      index = Math.min(DESKTOP_STAGES.length - 1, index + 1);
      setStageLabel(DESKTOP_STAGES[index]);
      setProgress(Math.min(0.92, 0.12 + index * 0.32));
    }, 1600);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [working, desktop, format]);

  // Abort any in-flight export when the dialog unmounts.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const resetFeedback = () => {
    setPhase("idle");
    setOutcome(null);
    setFailure(null);
    setProgress(0);
    setStageLabel("准备导出");
    setStageIndex(-1);
    setElapsedMs(0);
    setCancelReason(null);
  };

  const cancelExport = (notify = true) => {
    if (!working) return;
    abortRef.current?.abort();
    abortRef.current = null;
    setPhase("idle");
    setStageLabel("已取消导出");
    setProgress(0);
    setCancelReason("已取消导出");
    if (notify) useWorldStore.getState().pushToast("info", "已取消导出");
  };

  const handleClose = () => {
    // Desktop IPC renders cannot be aborted: the main process finishes writing
    // and the completion toast still lands after the dialog closed.
    if (working && !desktop) cancelExport(false);
    onClose();
  };

  const runExport = async (
    size: number,
    mode: "local" | "server",
    formatOverride: "png" | "svg" = format,
  ) => {
    if (working) return;
    resetFeedback();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase("working");
    startedAtRef.current = Date.now();
    const storeState = useWorldStore.getState();
    const document = storeState.document;
    try {
      if (desktop) {
        // Electron main process: native save dialog + local render + write.
        // Works fully offline, including 4096 / 8192 and SVG.
        const printMm = Math.round(((size / 300) * 25.4 + Number.EPSILON) * 10) / 10;
        const request =
          formatOverride === "svg"
            ? { document, size, physical: { dpi: 300, widthMm: printMm, heightMm: printMm } }
            : { document, size };
        const result =
          formatOverride === "svg"
            ? await desktopExportSvg(request)
            : await desktopExportPng(request);
        if (!result || result.canceled) {
          setPhase("idle");
          setStageLabel("已取消导出");
          setProgress(0);
          setCancelReason(null);
          return;
        }
        const savedPath = result.path ?? "";
        setOutcome({
          filename: savedPath || "已保存",
          meta: {
            size,
            simSize: null,
            totalMs: result.ms ?? null,
            simMs: null,
            renderMs: null,
            fontsReady: null,
            desktop: true,
          },
        });
        setPhase("success");
        setProgress(1);
        useWorldStore
          .getState()
          .pushToast(
            "success",
            `${formatOverride === "svg" ? "SVG" : "PNG"} 已保存：${savedPath}`,
          );
        return;
      }
      if (formatOverride === "svg") {
        const result = await exportSvg(document, size, {
          signal: controller.signal,
          layers: storeState.layers,
          onProgress: (update) => {
            setStageLabel(update.stage);
            setStageIndex(-1);
            setProgress(update.progress);
          },
        });
        if (controller.signal.aborted) throw new ExportError("cancelled", "已取消导出");
        const filename = downloadBlob(result.blob, result.filename);
        setOutcome({
          filename,
          meta: {
            size,
            simSize: null,
            totalMs: result.meta.totalMs,
            simMs: null,
            renderMs: result.meta.renderMs,
            fontsReady: null,
          },
        });
        setPhase("success");
        setProgress(1);
        useWorldStore.getState().pushToast("success", `SVG 导出完成：${filename}`);
        return;
      }
      if (mode === "local") {
        const result = await exportLocalPng(
          document,
          size,
          (update) => {
            setStageLabel(update.stage === "done" ? "光栅化" : update.label);
            setStageIndex(-1);
            setProgress(update.progress);
          },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) throw new ExportError("cancelled", "已取消导出");
        const filename = downloadBlob(result.blob, pngFilename(document, size));
        setOutcome({ filename, meta: result.meta });
        setPhase("success");
        setProgress(1);
        useWorldStore.getState().pushToast("success", `PNG 导出完成：${filename}`);
      } else {
        const result = await exportServerPng(document, size, {
          timeoutMs: size >= 8192 ? 180_000 : 120_000,
          signal: controller.signal,
        });
        if (controller.signal.aborted) throw new ExportError("cancelled", "已取消导出");
        const filename = downloadBlob(result.blob, pngFilename(document, size));
        setOutcome({ filename, meta: result.meta });
        setPhase("success");
        setProgress(1);
        useWorldStore.getState().pushToast("success", `PNG 导出完成：${filename}`);
        void refreshServerStatus();
      }
    } catch (error) {
      if (error instanceof ExportError && error.kind === "cancelled") {
        setPhase("idle");
        setStageLabel("已取消导出");
        setProgress(0);
        setCancelReason("已取消导出");
        return;
      }
      const kind = error instanceof ExportError ? error.kind : "render";
      const message = error instanceof Error ? error.message : String(error);
      const usedServer = desktop
        ? false
        : formatOverride === "svg"
          ? !svgClientMode
          : mode === "server";
      setFailure({ kind, message, server: usedServer });
      setPhase("error");
      if (usedServer) {
        useWorldStore.getState().setServerStatus({
          phase: "offline",
          latencyMs: null,
          maxSize: null,
        });
      }
      useWorldStore.getState().pushToast(
        "error",
        `${formatOverride === "svg" ? "SVG" : "PNG"} 导出失败：${message}`,
      );
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  };

  const fallbackToLocal = () => {
    setFormat("png");
    setExportSize(2048);
    void runExport(2048, "local", "png");
  };

  const footer = (
    <div className="dialog-actions">
      {working ? (
        desktop ? (
          <span className="desktop-working-hint" data-testid="desktop-export-working">
            桌面本地渲染与写盘不可中断，请稍候…
          </span>
        ) : (
          <button
            type="button"
            className="btn btn--ghost"
            data-testid="export-cancel-running"
            onClick={() => cancelExport()}
          >
            取消导出
          </button>
        )
      ) : (
        <button type="button" className="btn btn--ghost" onClick={handleClose} data-testid="export-cancel">
          {phase === "success" ? "关闭" : "取消"}
        </button>
      )}
      <button
        type="button"
        className="btn btn--primary"
        disabled={working || disabledReason !== null}
        title={disabledReason ?? undefined}
        data-testid="export-start"
        onClick={() =>
          void runExport(
            exportSize,
            format === "svg" ? (svgClientMode ? "local" : "server") : preset.mode,
          )
        }
      >
        {working ? "导出中…" : `导出 ${preset.label} ${format.toUpperCase()}`}
      </button>
    </div>
  );

  return (
    <Modal
      open={open}
      title={format === "svg" ? "导出 SVG（矢量）" : "导出 PNG"}
      subtitle={
        format === "svg"
          ? "矢量路径与文字，适合印刷 / Illustrator 再加工；世界 JSON 仍是唯一真源。"
          : "世界 JSON 才是唯一真源；PNG 是当前文档的渲染产物。"
      }
      onClose={handleClose}
      footer={footer}
      width={640}
      testId="export-dialog"
    >
      {desktop ? (
        <div className="desktop-export-badge" data-testid="desktop-export-note">
          <span className="desktop-export-badge-icon" aria-hidden="true">⌘</span>
          <span>
            <strong>桌面本地渲染，无需服务端</strong>
            ：4096 / 8192 PNG 与 SVG 均由本机主进程生成并直接写入文件，断网也能导出。
          </span>
        </div>
      ) : null}

      <div className="export-format-tabs" role="group" aria-label="导出格式">
        <button
          type="button"
          className={`export-format-tab ${format === "png" ? "is-selected" : ""}`}
          data-testid="export-format-png"
          aria-pressed={format === "png"}
          disabled={working}
          onClick={() => {
            if (format === "png") return;
            setFormat("png");
            resetFeedback();
          }}
        >
          <span className="export-format-tab-title">PNG 位图</span>
          <span className="export-format-tab-note">网页 / 社交分享 · 1024–8192 · 本地或服务端光栅</span>
        </button>
        <button
          type="button"
          className={`export-format-tab ${format === "svg" ? "is-selected" : ""}`}
          data-testid="export-format-svg"
          aria-pressed={format === "svg"}
          disabled={working || (!desktop && svgReady === false)}
          title={
            desktop
              ? "桌面主进程本地渲染，无需服务端"
              : svgReady === false
                ? "SVG 渲染器与服务端均未就绪"
                : "矢量路径与文字，适合印刷"
          }
          onClick={() => {
            if (format === "svg") return;
            setFormat("svg");
            resetFeedback();
          }}
        >
          <span className="export-format-tab-title">SVG 矢量（印刷）</span>
          <span className="export-format-tab-note">
            无限缩放 / 可编辑 ·{" "}
            {desktop
              ? "桌面主进程 renderSvg"
              : svgClientMode
                ? "客户端 renderSvg"
                : "服务端 /api/export/svg"}
          </span>
        </button>
      </div>

      <div className="export-grid">
        {EXPORT_PRESETS.map((option) => {
          const requiresServer = option.mode === "server" && !desktop;
          const sizeDisabled =
            working ||
            (format === "svg"
              ? !desktop && svgReady !== true
              : requiresServer && serverOffline);
          return (
            <button
              key={option.size}
              type="button"
              className={`export-card ${exportSize === option.size ? "is-selected" : ""}`}
              aria-pressed={exportSize === option.size}
              aria-disabled={sizeDisabled}
              data-testid={`export-size-${option.size}`}
              disabled={sizeDisabled}
              onClick={() => {
                if (sizeDisabled) return;
                setExportSize(option.size);
                resetFeedback();
              }}
            >
              <span className="export-card-size">{option.label}</span>
              <span className="export-card-note">{option.note}</span>
              <span className="export-card-mode">
                {desktop
                  ? option.size >= 4096
                    ? "桌面本地渲染 · 无需服务端"
                    : "桌面本地渲染"
                  : requiresServer
                    ? serverOffline
                      ? "服务端离线 · 需 Node API"
                      : "服务端渲染"
                    : "本地渲染"}{" "}
                · {desktop ? "由本机主进程写盘" : option.estimate}
              </span>
            </button>
          );
        })}
      </div>

      <div className="export-summary">
        <div className="export-summary-row" data-testid="export-filename-preview">
          <span>输出尺寸</span>
          <strong data-testid="export-size-summary">
            {preset.size} × {preset.size} · {((preset.size * preset.size) / 1_000_000).toFixed(1)} MP
          </strong>
        </div>
        <div className="export-summary-row">
          <span>文件名</span>
          <strong data-testid="export-filename">
            atlas-{documentName || "world"}-{documentSeed}-{presetId === "aged-ink" ? "aged-ink" : "parchment"}-
            {exportSize}.{format === "svg" ? "svg" : "png"}
          </strong>
        </div>
        {format === "svg" ? (
          <div className="export-summary-row">
            <span>印刷参考</span>
            <strong data-testid="export-print-size">
              {SVG_PRINT_HINTS[exportSize] ?? "A3 @300dpi"} · 矢量可无损放大
            </strong>
          </div>
        ) : null}
        <div className="export-summary-row">
          <span>渲染方式</span>
          <strong>
            {desktop
              ? format === "svg"
                ? "桌面主进程 renderSvg（矢量路径 + 文字）"
                : "桌面主进程 @atlas/render（离线光栅）"
              : format === "svg"
                ? svgClientMode
                  ? "客户端 renderSvg（矢量路径 + 文字）"
                  : "POST /api/export/svg（Node 矢量渲染）"
                : preset.mode === "local"
                  ? "浏览器离屏 Canvas（Web Worker）"
                  : "POST /api/render（Node + @napi-rs/canvas）"}
          </strong>
        </div>
        <div className="export-summary-row">
          <span>导出服务</span>
          <strong data-testid="export-server-status">
            {desktop
              ? "桌面本地（无需服务端）"
              : server.phase === "online"
                ? `在线${server.latencyMs !== null ? ` · ${Math.round(server.latencyMs)}ms` : ""}`
                : server.phase === "offline"
                  ? "离线"
                  : "探测中…"}
          </strong>
        </div>
      </div>

      {disabledReason ? (
        <div className="dialog-warning" data-testid="export-disabled-reason">
          {disabledReason}
          {selectedNeedsServer && serverOffline ? " 可改用 1024 / 2048 本地导出。" : null}
        </div>
      ) : null}

      {working ? (
        <div className="export-progress" data-testid="export-progress">
          <ProgressBar value={progress} />
          <div className="export-progress-meta">
            <span data-testid="export-progress-stage">
              {stageLabel}
              {stageIndex >= 0 ? `（${stageIndex + 1}/${SERVER_STAGES.length}）` : ""}…
            </span>
            <span data-testid="export-progress-percent">{Math.round(progress * 100)}%</span>
            <span>{formatMs(elapsedMs)}</span>
          </div>
        </div>
      ) : null}

      {phase === "idle" && cancelReason ? (
        <div className="dialog-warning" data-testid="export-cancelled">
          {cancelReason}
        </div>
      ) : null}

      {phase === "success" && outcome ? (
        <div className="dialog-success" data-testid="export-result">
          <strong data-testid="export-result-filename">
            {outcome.meta.desktop ? "已保存：" : "导出完成："}
            {outcome.filename}
          </strong>
          <span>
            用时 {formatMs(outcome.meta.totalMs)}
            {outcome.meta.desktop ? " · 桌面本地渲染，无需服务端" : ""}
            {outcome.meta.simMs !== null ? ` · 模拟 ${formatMs(outcome.meta.simMs)}` : ""}
            {outcome.meta.renderMs !== null ? ` · 渲染 ${formatMs(outcome.meta.renderMs)}` : ""}
            {outcome.meta.simSize !== null ? ` · 模拟网格 ${outcome.meta.simSize}²` : ""}
            {outcome.meta.fontsReady !== null
              ? ` · 字体 EB Garamond ${outcome.meta.fontsReady ? "已加载" : "回退"}`
              : ""}
          </span>
          {outcome.meta.desktop ? (
            <button
              type="button"
              className="btn btn--small btn--ghost"
              data-testid="export-copy-path"
              onClick={() => {
                void (async () => {
                  try {
                    await navigator.clipboard.writeText(outcome.filename);
                    useWorldStore.getState().pushToast("success", "已复制保存路径");
                  } catch {
                    useWorldStore.getState().pushToast("error", "复制路径失败，请手动选择文本");
                  }
                })();
              }}
            >
              复制保存路径
            </button>
          ) : null}
        </div>
      ) : null}

      {phase === "error" && failure ? (
        <div className="dialog-error" data-testid="export-error">
          <strong>导出失败</strong>
          <span>{failure.message}</span>
          {failure.server ? (
            <button
              type="button"
              className="btn btn--small"
              data-testid="export-fallback-local"
              onClick={fallbackToLocal}
            >
              改用 2048 本地导出
            </button>
          ) : null}
          {desktop ? (
            <span className="dialog-note">
              桌面本地渲染失败：可尝试降低尺寸（8192² 约需 270MB 内存）或检查磁盘空间。
            </span>
          ) : null}
        </div>
      ) : null}

      <p className="dialog-note">
        {desktop ? (
          <>
            导出由 Electron 主进程使用 <code>@atlas/core</code> + <code>@atlas/render</code> 本机完成：
            无需 Node API、断网可用；保存对话框与写盘都在主进程，导出不会修改世界文档（JSON 仍是唯一真源）。
          </>
        ) : format === "svg" ? (
          <>
            SVG 优先使用客户端渲染器；不可用时走 <code>POST /api/export/svg</code>。
            矢量文件包含路径与文字，适合印刷与 Illustrator 二次编辑；文件名格式
            `atlas-&lt;世界名&gt;-&lt;种子&gt;-&lt;预设&gt;-&lt;尺寸&gt;.svg`。
          </>
        ) : (
          <>
            大图（4096 / 8192）由 Node 后端重新生成并渲染，浏览器只负责下载 blob；
            服务不可用时会明确提示并保留本地导出作为降级出口。文件名格式
            `atlas-&lt;世界名&gt;-&lt;种子&gt;-&lt;预设&gt;-&lt;尺寸&gt;.png`。
          </>
        )}
      </p>
    </Modal>
  );
}
