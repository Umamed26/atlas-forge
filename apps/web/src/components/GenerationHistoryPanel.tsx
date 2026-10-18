/** Recent generation history with thumbnails + restore. */
import { useWorldStore } from "../state/worldStore";
import { formatClock } from "../lib/utils";
import { seedLabel } from "../lib/stageSeeds";
import { scenarioById } from "../lib/scenarios";

export function GenerationHistoryPanel() {
  const history = useWorldStore((state) => state.generationHistory);
  return (
    <div className="gen-history-panel">
      {history.length === 0 ? (
        <p className="empty-note">生成几次之后，这里会保留最近 10 张地图，随时可以回到之前的世界。</p>
      ) : (
        <ul className="gen-history" data-testid="gen-history">
          {history.map((entry, index) => {
            const scenario = scenarioById(entry.scenarioId);
            return (
              <li key={entry.id} className="gen-history-item">
                <button
                  type="button"
                  className="gen-history-thumb-button"
                  data-testid={`gen-history-item-${index}`}
                  title={`${scenario.name} · ${seedLabel(entry.document.seed)} · ${formatClock(entry.createdAt)}`}
                  onClick={() => useWorldStore.getState().restoreGenerationHistory(entry.id)}
                >
                  {entry.thumbnail ? (
                    <img
                      className="gen-history-thumb"
                      src={entry.thumbnail}
                      alt={`${scenario.name} 缩略图`}
                      draggable={false}
                    />
                  ) : (
                    <span className="gen-history-thumb is-empty" aria-hidden="true">◈</span>
                  )}
                  <span className="gen-history-meta">
                    <span className="gen-history-seed">{seedLabel(entry.document.seed)}</span>
                    <span className="gen-history-scenario">{scenario.name}</span>
                    <span className="gen-history-time">{formatClock(entry.createdAt)}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="link-button"
                  data-testid={`gen-history-restore-${index}`}
                  onClick={() => useWorldStore.getState().restoreGenerationHistory(entry.id)}
                >
                  恢复
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="section-note">恢复历史只占 1 条撤销，并会先把当前世界也存入历史。</p>
    </div>
  );
}
