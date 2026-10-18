/** Bottom status bar: generation status, world stats, save & server health. */
import { useEffect, useState } from "react";

import { formatClock, formatMs, formatPercent, truncateMiddle } from "../lib/utils";
import { useViewStore } from "../state/viewStore";
import { useWorldStore } from "../state/worldStore";

function useElapsed(startedAt: number | null, active: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 150);
    return () => window.clearInterval(timer);
  }, [active]);
  if (!startedAt) return null;
  return Math.max(0, now - startedAt);
}

type StatusTone = "idle" | "busy" | "error";

function statusInfo(): {
  text: string;
  tone: StatusTone;
  state: "idle" | "generating" | "error";
} {
  const stateOf = (tone: StatusTone): "idle" | "generating" | "error" =>
    tone === "busy" ? "generating" : tone === "error" ? "error" : "idle";
  const wrap = (info: { text: string; tone: StatusTone }) => ({
    ...info,
    state: stateOf(info.tone),
  });

  const state = useWorldStore.getState();
  const generation = state.generation;
  if (generation.phase === "generating") {
    const progress = generation.progress;
    const percent = progress ? Math.round(progress.progress * 100) : 0;
    const label = progress?.label ?? "准备";
    if (generation.queuedLatest) {
      return wrap({ text: `生成中 · ${label} ${percent}% · 已排队最新参数`, tone: "busy" });
    }
    return wrap({ text: `生成中 · ${label} ${percent}%`, tone: "busy" });
  }
  if (generation.phase === "queued") {
    return wrap({ text: "生成中 · 等待执行最新参数…", tone: "busy" });
  }
  if (generation.phase === "error" && generation.error) {
    return wrap({ text: `生成失败：${truncateMiddle(generation.error, 90)}`, tone: "error" });
  }
  if (state.render.rendering) {
    return wrap({ text: "重绘中…", tone: "busy" });
  }
  if (generation.durationMs !== null) {
    return wrap({ text: `就绪 · 本次生成 ${formatMs(generation.durationMs)}`, tone: "idle" });
  }
  return wrap({ text: "就绪", tone: "idle" });
}

function StatusTicker() {
  const generation = useWorldStore((state) => state.generation);
  const render = useWorldStore((state) => state.render);
  const active = generation.phase === "generating" || generation.phase === "queued";
  const startedAt = generation.startedAt;
  const elapsed = useElapsed(startedAt, active);
  const info = statusInfo();

  return (
    <div className="statusbar-item statusbar-status">
      <span className={`status-dot status-dot--${info.tone}`} aria-hidden="true" />
      <span data-testid="status" data-state={info.state} title={generation.error ?? ""}>
        {info.text}
      </span>
      {active && elapsed !== null ? (
        <span className="statusbar-extra">{formatMs(elapsed)}</span>
      ) : null}
      {render.lastMs !== null && !active ? (
        <span className="statusbar-extra" title="上次离屏重绘耗时">
          重绘 {formatMs(render.lastMs)}
        </span>
      ) : null}
    </div>
  );
}

export function StatusBar() {
  const layers = useWorldStore((state) => state.layers);
  const save = useWorldStore((state) => state.save);
  const server = useWorldStore((state) => state.server);
  const overridesTotal = useWorldStore(
    (state) =>
      state.document.overrides.elevation.length +
      state.document.overrides.riverForce.length +
      state.document.overrides.biome.length,
  );
  const zoomPercent = useViewStore((state) => Math.round(state.scale * 100));

  let saveText = "未保存";
  let saveTitle = "尚未写入本地自动存档";
  if (save.phase === "saved") {
    saveText = `已保存 ${formatClock(save.savedAt)}`;
    saveTitle = "自动保存到浏览器 localStorage（800ms 防抖）";
  } else if (save.phase === "saving") {
    saveText = "保存中…";
  } else if (save.phase === "error") {
    saveText = "保存失败";
    saveTitle = save.error ?? "自动保存失败";
  }

  let serverText = "服务端未知";
  let serverTitle = "正在探测 /api/health";
  if (server.phase === "online") {
    serverText = `服务端在线${server.latencyMs !== null ? ` ${Math.round(server.latencyMs)}ms` : ""}`;
    serverTitle = `Node 导出服务可用（最大 ${server.maxSize ?? "—"}px）`;
  } else if (server.phase === "offline") {
    serverText = "服务端离线";
    serverTitle = "4096 / 8192 导出需要 Node API（pnpm dev 默认启动 8787）";
  }

  return (
    <footer className="statusbar" data-testid="statusbar">
      <StatusTicker />
      <span className="statusbar-sep" aria-hidden="true" />
      <span className="statusbar-item" title="当前预览模拟网格">
        模拟 {layers ? `${layers.size}²` : "—"}
      </span>
      <span className="statusbar-item" title="陆地面积占比">
        陆地 {formatPercent(layers?.stats.landFraction)}
      </span>
      <span className="statusbar-item" title="自动生成的城镇数量">
        城镇 {layers ? layers.settlements.length : "—"}
      </span>
      <span className="statusbar-item" title="归一化世界坐标中的画笔编辑总数">
        编辑 {overridesTotal}
      </span>
      <span className="statusbar-spacer" />
      <span className="statusbar-item" title="地图缩放比例">
        缩放 {zoomPercent}%
      </span>
      <span className="statusbar-item" title={serverTitle}>
        <span className={`status-dot status-dot--${server.phase === "online" ? "ok" : server.phase === "offline" ? "warn" : "idle"}`} aria-hidden="true" />
        {serverText}
      </span>
      <span className="statusbar-item" title={saveTitle} data-testid="save-status">
        {saveText}
      </span>
      <span className="statusbar-item statusbar-version">Atlas Forge · M6</span>
    </footer>
  );
}
