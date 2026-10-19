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
import { isDesktop } from "../lib/desktopBridge";
import { loadRenderFonts } from "../lib/fonts";
import { saveAutosave } from "../lib/documentIO";
import { createThumbnail } from "../lib/history";
import { collectPlaces } from "../lib/places";
import { assessReadabilityWithRender } from "../lib/readability";
import {
  measureRenderPlaceBoxes,
  synthesizeMarkerBoxes,
} from "../lib/placeHitTest";
import { renderMapToCanvas } from "../lib/renderMap";
import { refreshServerStatus } from "../lib/api";
import { useWorldStore } from "../state/worldStore";

/** Draft previews are throttled, not debounced: while a slider is dragged the
 * user must see a 512² preview roughly every 150ms (leading + trailing). */
const DRAFT_THROTTLE_MS = 150;

export function useAppPipeline(): void {
  const clientRef = useRef<GenerationClient | null>(null);
  const renderTimerRef = useRef<number | null>(null);
  const draftTimerRef = useRef<number | null>(null);
  const lastDraftAtRef = useRef(0);
  const lastFullRequestAtRef = useRef(0);

  // ── Worker lifecycle + initial generation ────────────────────────────
  useEffect(() => {
    const client = new GenerationClient({
      onDispatch: (seq, _document, options) =>
        useWorldStore.getState().generationStarted(seq, options.draft ? "draft" : "full"),
      onQueued: (seq) => useWorldStore.getState().generationQueued(seq),
      onProgress: (seq, update) => useWorldStore.getState().generationProgress(seq, update),
      onLayers: (seq, layers, document, meta) => {
        const store = useWorldStore.getState();
        if (meta.draft) {
          store.setDraftResult(seq, layers, document);
          return;
        }
        store.generationSucceeded(seq, layers, document, { size: meta.size ?? undefined });
      },
      onError: (seq, message) => useWorldStore.getState().generationFailed(seq, message),
      onCancelled: (seq) => useWorldStore.getState().markGenerationCancelled(seq),
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

  // ── Regeneration scheduling ──────────────────────────────────────────
  // Full rebuilds are debounced (wait for the user to settle). Draft previews
  // are *throttled*: dragging a slider emits updates every 16–80ms, so a pure
  // debounce would starve the draft request and the user would never see it.
  const simTick = useWorldStore((state) => state.simTick);
  useEffect(() => {
    if (simTick === 0) return;
    const store = useWorldStore.getState();
    const mode = store.simMode;
    const kind = store.simKind;

    if (kind === "draft") {
      // A draft request is already scheduled for the current throttle window;
      // keep it (its callback reads the latest document when it fires).
      if (draftTimerRef.current !== null) return;
      const sendDraft = () => {
        draftTimerRef.current = null;
        lastDraftAtRef.current = Date.now();
        const client = clientRef.current;
        if (!client) return;
        // A full rebuild was requested moments ago (slider released): never let
        // a late trailing draft replace the full job in the latest-wins queue.
        if (Date.now() - lastFullRequestAtRef.current < 400) return;
        const state = useWorldStore.getState();
        state.noteDraftRequest();
        client.request(state.document, { size: 512, draft: true });
      };
      const since = Date.now() - lastDraftAtRef.current;
      const wait = Math.max(0, DRAFT_THROTTLE_MS - since);
      draftTimerRef.current = window.setTimeout(sendDraft, wait);
      return;
    }

    // A full request takes precedence: drop any pending trailing draft so it
    // cannot replace the full job in the client's latest-wins queue.
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    lastFullRequestAtRef.current = Date.now();
    const delay = mode === "now" ? 0 : SIM_DEBOUNCE_MS;
    const timer = window.setTimeout(() => {
      const client = clientRef.current;
      if (!client) return;
      const state = useWorldStore.getState();
      const sizeOverride = state.consumeRequestSizeOverride();
      client.request(
        state.document,
        typeof sizeOverride === "number" ? { size: sizeOverride } : {},
      );
    }, delay);
    return () => window.clearTimeout(timer);
  }, [simTick]);

  // Clear a pending draft timer on unmount (the effect above intentionally has
  // no per-tick cleanup for drafts, so it is not reset by every pointermove).
  useEffect(() => {
    return () => {
      if (draftTimerRef.current !== null) {
        window.clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
    };
  }, []);

  // ── Cancel the in-flight generation (terminates + recreates the worker) ──
  const cancelTick = useWorldStore((state) => state.cancelTick);
  useEffect(() => {
    if (cancelTick === 0) return;
    clientRef.current?.cancel();
  }, [cancelTick]);

  // ── Base map rasterization (style-only changes land here) ────────────
  const renderTick = useWorldStore((state) => state.renderTick);
  useEffect(() => {
    if (renderTick === 0) return;
    if (renderTimerRef.current !== null) window.clearTimeout(renderTimerRef.current);
    renderTimerRef.current = window.setTimeout(() => {
      renderTimerRef.current = null;
      const state = useWorldStore.getState();
      const drafting = state.draftActive && state.draftLayers !== null;
      const renderLayers = drafting ? state.draftLayers : state.layers;
      const renderDocument = drafting ? state.draftDocument ?? state.document : state.document;
      if (!renderLayers) return;
      state.renderStarted();
      const startedAt = performance.now();
      try {
        const canvas = renderMapToCanvas(renderLayers, renderDocument, BASE_RENDER_SIZE, "preview");
        useWorldStore.getState().renderDone(canvas, performance.now() - startedAt);
        try {
          const boxes = measureRenderPlaceBoxes(renderDocument, renderLayers);
          if (boxes) {
            useWorldStore.getState().setHitBoxes(boxes, "renderer");
          } else {
            const visible = collectPlaces(renderDocument, renderLayers).visible;
            useWorldStore.getState().setHitBoxes(synthesizeMarkerBoxes(visible), "marker");
          }
        } catch {
          useWorldStore.getState().setHitBoxes(null, null);
        }
        if (!drafting) {
          const latest = useWorldStore.getState();
          if (latest.readabilityPending) {
            latest.setReadabilityPending(false);
            latest.setReadability(
              assessReadabilityWithRender(canvas, latest.document, latest.layers),
            );
          }
          if (latest.historyPending) {
            latest.setHistoryPending(false);
            latest.pushGenerationHistory({
              id: `gen-${Date.now().toString(36)}`,
              document: latest.layersDocument ?? latest.document,
              scenarioId: latest.scenarioId,
              thumbnail: createThumbnail(canvas),
              createdAt: Date.now(),
            });
          }
        }
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
      if (state.autosaveRecovery) return; // do not overwrite a corrupt autosave
      if (markSaving) state.markSaving();
      const result = saveAutosave(state.document);
      if (result.ok) {
        useWorldStore.getState().markSaved(result.savedAt);
      } else {
        useWorldStore.getState().markSaveError(result.error ?? "自动保存失败");
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

    if (
      !useWorldStore.getState().restoredFromAutosave &&
      !useWorldStore.getState().autosaveRecovery
    ) {
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

  // ── QA hooks (window.__atlasDebug / __atlasDebugDocument) ────────────
  // Browser production keeps them dev-only. The packaged desktop build also
  // ships the read-only QA surface so desktop E2E can read the same
  // document/summary as the web harness; it exposes no privileged IPC surface.
  useEffect(() => {
    if (import.meta.env.DEV || isDesktop()) installDebugApi();
  }, []);
}
