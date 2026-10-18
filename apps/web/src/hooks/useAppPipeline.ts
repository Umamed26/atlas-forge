/**
 * App-level plumbing: worker lifecycle (latest-wins), debounced regeneration,
 * base-map rendering, autosave, API health and global error reporting.
 *
 * Kept in one hook so the effects run exactly once per app mount and tolerate
 * React StrictMode's double mount/cleanup cycle.
 */
import { useEffect, useRef } from "react";

import { GenerationClient } from "../generation/generationClient";
import {
  AUTOSAVE_DEBOUNCE_MS,
  BASE_RENDER_SIZE,
  RENDER_DEBOUNCE_MS,
  SIM_DEBOUNCE_MS,
} from "../lib/constants";
import { installDebugApi } from "../lib/debug";
import { loadRenderFonts } from "../lib/fonts";
import { saveAutosave } from "../lib/documentIO";
import { renderMapToCanvas } from "../lib/renderMap";
import { refreshServerStatus } from "../lib/api";
import { useWorldStore } from "../state/worldStore";

export function useAppPipeline(): void {
  const clientRef = useRef<GenerationClient | null>(null);
  const renderTimerRef = useRef<number | null>(null);

  // ── Worker lifecycle + initial generation ────────────────────────────
  useEffect(() => {
    const client = new GenerationClient({
      onDispatch: (seq) => useWorldStore.getState().generationStarted(seq),
      onQueued: (seq) => useWorldStore.getState().generationQueued(seq),
      onProgress: (seq, update) => useWorldStore.getState().generationProgress(seq, update),
      onLayers: (seq, layers, document) =>
        useWorldStore.getState().generationSucceeded(seq, layers, document),
      onError: (seq, message) => useWorldStore.getState().generationFailed(seq, message),
    });
    client.start();
    clientRef.current = client;
    client.request(useWorldStore.getState().document);
    return () => {
      if (clientRef.current === client) clientRef.current = null;
      client.terminate();
    };
  }, []);

  // ── Pipeline cache reset (after importing a different world) ─────────
  const pipelineResetTick = useWorldStore((state) => state.pipelineResetTick);
  useEffect(() => {
    if (pipelineResetTick === 0) return;
    clientRef.current?.reset();
  }, [pipelineResetTick]);

  // ── Debounced regeneration ───────────────────────────────────────────
  const simTick = useWorldStore((state) => state.simTick);
  useEffect(() => {
    if (simTick === 0) return;
    const mode = useWorldStore.getState().simMode;
    const delay = mode === "now" ? 0 : SIM_DEBOUNCE_MS;
    const timer = window.setTimeout(() => {
      const client = clientRef.current;
      if (!client) return;
      client.request(useWorldStore.getState().document);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [simTick]);

  // ── Base map rasterization (style-only changes land here) ────────────
  const renderTick = useWorldStore((state) => state.renderTick);
  useEffect(() => {
    if (renderTick === 0) return;
    if (renderTimerRef.current !== null) window.clearTimeout(renderTimerRef.current);
    renderTimerRef.current = window.setTimeout(() => {
      renderTimerRef.current = null;
      const state = useWorldStore.getState();
      if (!state.layers) return;
      state.renderStarted();
      const startedAt = performance.now();
      try {
        const canvas = renderMapToCanvas(state.layers, state.document, BASE_RENDER_SIZE, "preview");
        useWorldStore.getState().renderDone(canvas, performance.now() - startedAt);
      } catch (error) {
        useWorldStore
          .getState()
          .renderFailed(error instanceof Error ? error.message : String(error));
      }
    }, RENDER_DEBOUNCE_MS);
    return () => {
      if (renderTimerRef.current !== null) {
        window.clearTimeout(renderTimerRef.current);
        renderTimerRef.current = null;
      }
    };
  }, [renderTick]);

  // ── Autosave (debounced, flushed on unload / tab hide) ───────────────
  useEffect(() => {
    let timer: number | null = null;

    const write = (markSaving: boolean) => {
      const state = useWorldStore.getState();
      if (markSaving) state.markSaving();
      const result = saveAutosave(state.document);
      if (result.ok) {
        useWorldStore.getState().markSaved(result.savedAt);
      } else {
        const wasError = useWorldStore.getState().save.phase === "error";
        useWorldStore.getState().markSaveError(result.error ?? "自动保存失败");
        if (!wasError && result.error) {
          useWorldStore.getState().pushToast("error", result.error);
        }
      }
    };

    const flush = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      write(false);
    };

    const unsubscribe = useWorldStore.subscribe((state, previous) => {
      if (state.document === previous.document) return;
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        write(true);
      }, AUTOSAVE_DEBOUNCE_MS);
    });

    if (!useWorldStore.getState().restoredFromAutosave) {
      timer = window.setTimeout(() => {
        timer = null;
        write(false);
      }, 1200);
    }

    const onBeforeUnload = () => flush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      unsubscribe();
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("visibilitychange", onVisibility);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  // ── Font readiness: re-rasterize the preview with EB Garamond ───────
  useEffect(() => {
    let cancelled = false;
    void loadRenderFonts().then((loaded) => {
      if (cancelled || !loaded) return;
      useWorldStore.getState().requestRender();
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // ── Backend health probe ─────────────────────────────────────────────
  useEffect(() => {
    void refreshServerStatus();
  }, []);

  // ── Global error reporting (never a white screen) ────────────────────
  useEffect(() => {
    const onError = (event: ErrorEvent) => {
      const message = event.message || "未知脚本错误";
      // ResizeObserver noise from browsers is not actionable for users.
      if (/ResizeObserver loop/.test(message)) return;
      useWorldStore.getState().pushToast("error", `页面异常：${message}`);
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message =
        reason instanceof Error ? reason.message : typeof reason === "string" ? reason : String(reason);
      if (/AbortError/.test(message)) return;
      useWorldStore.getState().pushToast("error", `异步错误：${message}`);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // ── DEV QA hooks (window.__atlasDebug / __atlasDebugDocument) ────────
  useEffect(() => {
    if (import.meta.env.DEV) installDebugApi();
  }, []);
}
