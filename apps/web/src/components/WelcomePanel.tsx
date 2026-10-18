/** First-run scenario picker (10 seconds to a good-looking map). */
import type { ScenarioPreset } from "../lib/scenarios";

export interface WelcomePanelProps {
  open: boolean;
  scenarios: ScenarioPreset[];
  currentScenarioId: string;
  onPick: (scenarioId: string) => void;
  onRandom: () => void;
  onSkip: () => void;
}

export function WelcomePanel({
  open,
  scenarios,
  currentScenarioId,
  onPick,
  onRandom,
  onSkip,
}: WelcomePanelProps) {
  if (!open) return null;
  return (
    <div className="welcome-layer" data-testid="welcome" role="dialog" aria-modal="true" aria-label="选择世界场景">
      <div className="welcome-card">
        <header className="welcome-head">
          <span className="welcome-mark" aria-hidden="true">✦</span>
          <div>
            <h2>先选一个世界，10 秒出第一张地图</h2>
            <p>场景会自动套用参数与风格；之后随时可以在顶栏「场景」里更换，或直接在左栏微调。</p>
          </div>
        </header>
        <div className="welcome-grid">
          {scenarios.map((scenario) => (
            <button
              key={scenario.id}
              type="button"
              className={`preset-card ${currentScenarioId === scenario.id ? "is-current" : ""}`}
              data-testid={`preset-card-${scenario.id}`}
              onClick={() => onPick(scenario.id)}
            >
              <span
                className="preset-thumb"
                aria-hidden="true"
                style={{
                  background: `linear-gradient(140deg, ${scenario.palette[0]}, ${scenario.palette[1]} 55%, ${scenario.palette[2]})`,
                }}
              >
                <img
                  className="preset-thumb-img"
                  src={`/presets/${scenario.id}.png`}
                  alt=""
                  loading="lazy"
                  draggable={false}
                  onError={(event) => {
                    event.currentTarget.style.display = "none";
                  }}
                />

              </span>
              <span className="preset-card-name">{scenario.name}</span>
              <span className="preset-card-tagline">{scenario.tagline}</span>
              <span className="preset-card-desc">{scenario.description}</span>
            </button>
          ))}
        </div>
        <footer className="welcome-actions">
          <button type="button" className="btn btn--ghost" data-testid="welcome-skip" onClick={onSkip}>
            跳过，直接用当前世界
          </button>
          <button type="button" className="btn btn--primary" data-testid="welcome-random" onClick={onRandom}>
            随机一张
          </button>
        </footer>
      </div>
    </div>
  );
}
