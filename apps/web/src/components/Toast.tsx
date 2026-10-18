/** Single-slot toast notification. */
import { useEffect } from "react";

import { TOAST_DISMISS_MS } from "../lib/constants";
import { exportDocumentJson } from "../lib/documentIO";
import { useWorldStore } from "../state/worldStore";

const ICONS: Record<string, string> = {
  info: "ⓘ",
  success: "✓",
  error: "✕",
};

export function ToastViewport() {
  const toast = useWorldStore((state) => state.toast);
  const dismissToast = useWorldStore((state) => state.dismissToast);

  useEffect(() => {
    if (!toast) return;
    const delay = toast.kind === "error" ? TOAST_DISMISS_MS + 2200 : TOAST_DISMISS_MS;
    const timer = window.setTimeout(() => dismissToast(toast.id), delay);
    return () => window.clearTimeout(timer);
  }, [toast, dismissToast]);

  if (!toast) return null;
  return (
    <div className="toast-layer" aria-live="polite">
      <div className={`toast toast--${toast.kind}`} data-testid="toast" data-kind={toast.kind}>
        <span className="toast-icon" aria-hidden="true">
          {ICONS[toast.kind] ?? "ⓘ"}
        </span>
        <span className="toast-text">{toast.text}</span>
        {toast.action ? (
          <button
            type="button"
            className="toast-action"
            data-testid="toast-action"
            onClick={() => {
              const action = toast.action;
              if (!action) return;
              const store = useWorldStore.getState();
              if (action.kind === "export-json") {
                try {
                  const filename = exportDocumentJson(store.document);
                  store.pushToast("success", `已导出 ${filename}`);
                } catch (error) {
                  store.pushToast(
                    "error",
                    `导出备份失败：${error instanceof Error ? error.message : String(error)}`,
                  );
                }
              } else if (action.kind === "recover-autosave") {
                store.recoverAutosave();
              }
              store.dismissToast(toast.id);
            }}
          >
            {toast.action.label}
          </button>
        ) : null}
        <button
          type="button"
          className="toast-close"
          aria-label="关闭提示"
          onClick={() => dismissToast(toast.id)}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
