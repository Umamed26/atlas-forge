/** Non-blocking readability hints below the map (renderer assessment). */
import type { RenderStyle, WorldParams } from "@atlas/core";

import { useWorldStore } from "../state/worldStore";

export function ReadabilityBanner() {
  const report = useWorldStore((state) => state.readability);
  const dismissed = useWorldStore((state) => state.readabilityDismissed);
  if (!report || dismissed || report.issues.length === 0) return null;
  const fail = report.issues.some((issue) => issue.severity === "fail");
  // render's issue.message already embeds the count (e.g. "标签相互重叠 4 处"),
  // so do not append the count a second time.
  const messages = report.issues
    .slice(0, 2)
    .map((issue) => issue.message)
    .join(" · ");

  const applyFix = () => {
    const store = useWorldStore.getState();
    const current = store.readability;
    if (!current) return;
    const paramPatch: Partial<WorldParams> = {};
    const stylePatch: Partial<RenderStyle> = {};
    const labels: string[] = [];
    for (const issue of current.issues) {
      const fix = issue.fixes[0];
      if (!fix) continue;
      if (fix.param) {
        (paramPatch as Record<string, number | string | boolean>)[fix.param] = fix.value;
        labels.push(`${fix.param} ${String(fix.value)}`);
      }
      if (fix.style) {
        (stylePatch as Record<string, number | string | boolean>)[fix.style] = fix.value;
        labels.push(`${fix.style} ${String(fix.value)}`);
      }
    }
    const hasParams = Object.keys(paramPatch).length > 0;
    const hasStyle = Object.keys(stylePatch).length > 0;
    if (!hasParams && !hasStyle) {
      store.pushToast("info", "当前可读性问题没有自动修复建议");
      return;
    }
    if (hasParams) {
      store.updateParams(paramPatch, { history: "push", sim: "now" });
    }
    if (hasStyle) {
      store.updateStyle(stylePatch, { history: hasParams ? "none" : "push" });
      if (!hasParams) store.requestRender();
    }
    store.pushToast(
      "success",
      `已按建议调整：${labels.slice(0, 3).join("、")}${labels.length > 3 ? "…" : ""}`,
    );
  };

  return (
    <div
      className={`readability-banner ${fail ? "readability-banner--fail" : ""}`}
      data-testid="readability-banner"
      role="status"
    >
      <span className="readability-icon" aria-hidden="true">
        {fail ? "⚠" : "◔"}
      </span>
      <span className="readability-text">这张图可能不好读：{messages}</span>
      <div className="readability-actions">
        <button
          type="button"
          className="btn btn--small btn--primary"
          data-testid="readability-fix"
          onClick={applyFix}
        >
          一键修复
        </button>
        <button
          type="button"
          className="btn btn--small"
          data-testid="readability-reroll"
          onClick={() => useWorldStore.getState().rerollUnlocked()}
        >
          换一张
        </button>
        <button
          type="button"
          className="btn btn--small btn--ghost"
          data-testid="readability-dismiss"
          onClick={() => useWorldStore.getState().dismissReadability()}
        >
          忽略
        </button>
      </div>
    </div>
  );
}
