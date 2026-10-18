/** Generation experience strip: scenario, summary, next actions, locks. */
import { LOCK_KEYS, LOCK_META, seedLabel } from "../lib/stageSeeds";
import { SCENARIOS } from "../lib/scenarios";
import { scenarioById } from "../lib/scenarios";
import { useWorldStore } from "../state/worldStore";

export interface GenerateBarProps {
  onOpenScenario: () => void;
  onOpenExport: () => void;
}

function focusFirstParam() {
  const group = document.querySelector('[data-testid="group-params"]');
  if (!group) return;
  const head = group.querySelector<HTMLButtonElement>(".panel-group-head");
  if (head && head.getAttribute("aria-expanded") === "false") head.click();
  window.setTimeout(() => {
    const slider = document.querySelector<HTMLInputElement>('[data-testid="param-seaLevel"]');
    slider?.focus({ preventScroll: false });
    slider?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, 60);
}

export function GenerateBar({ onOpenScenario, onOpenExport }: GenerateBarProps) {
  const scenarioId = useWorldStore((state) => state.scenarioId);
  const seed = useWorldStore((state) => state.document.seed);
  const locks = useWorldStore((state) => state.locks);
  const ready = useWorldStore((state) => state.layers !== null);
  const scenario = scenarioById(scenarioId);
  const lockedCount = LOCK_KEYS.filter((key) => locks[key]).length;

  return (
    <div className="generate-bar" data-testid="generate-bar">
      <button
        type="button"
        className="btn btn--small btn--accent"
        data-testid="preset-open"
        title="重新选择场景预设"
        onClick={onOpenScenario}
      >
        ✦ 场景
      </button>

      {ready ? (
        <span className="generated-summary" data-testid="generated-summary">
          已生成：{scenario.name} · {seedLabel(seed)}
        </span>
      ) : (
        <span className="generated-summary is-muted" data-testid="generated-summary">
          正在准备第一张地图…
        </span>
      )}

      <div className="next-actions" role="group" aria-label="下一步">
        <button
          type="button"
          className="btn btn--small"
          data-testid="next-reroll"
          onClick={() => useWorldStore.getState().rerollUnlocked()}
        >
          换一张
        </button>
        <button type="button" className="btn btn--small" data-testid="next-tweak" onClick={focusFirstParam}>
          微调
        </button>
        <button type="button" className="btn btn--small" data-testid="next-export" onClick={onOpenExport}>
          导出 PNG
        </button>
      </div>

      <div className="lock-group" role="group" aria-label="锁定阶段">
        <span className="lock-caption">
          🔐 锁定 <span className="lock-count">{lockedCount}/5</span>
        </span>
        {LOCK_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className={`lock-chip ${locks[key] ? "is-locked" : ""}`}
            aria-pressed={locks[key]}
            data-testid={`lock-${key}`}
            title={`${locks[key] ? "已锁定" : "解锁"}：${LOCK_META[key].hint}`}
            onClick={() => useWorldStore.getState().setLock(key, !locks[key])}
          >
            <span aria-hidden="true">{locks[key] ? "🔒" : "🔓"}</span>
            {LOCK_META[key].label}
          </button>
        ))}
        <button
          type="button"
          className="btn btn--small btn--primary"
          data-testid="reroll-locked"
          title="只重掷未锁定的阶段"
          onClick={() => useWorldStore.getState().rerollUnlocked()}
        >
          换一张（尊重锁定）
        </button>
        <button
          type="button"
          className="btn btn--small btn--ghost"
          data-testid="reroll-names"
          title="只重掷地名，地形与河流不变"
          onClick={() => useWorldStore.getState().rerollNames()}
        >
          换一批地名
        </button>
      </div>
      <span className="generate-bar-hint" aria-hidden="true">
        {SCENARIOS.length} 个场景 · 锁定后重掷只换未锁定阶段
      </span>
    </div>
  );
}
