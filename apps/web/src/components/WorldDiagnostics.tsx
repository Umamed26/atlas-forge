/** World diagnostics: surface the numbers behind the map (no extra generation). */
import { useMemo } from "react";

import { readAlgorithm } from "../lib/worldAlgorithm";
import {
  computeDiagnostics,
  formatNumber,
  formatPercent,
} from "../lib/diagnostics";
import { useWorldStore } from "../state/worldStore";

function MetricRow({ label, testId, value }: { label: string; testId?: string; value: string }) {
  return (
    <div className="diag-row">
      <span className="diag-label">{label}</span>
      <span className="diag-value" data-testid={testId}>
        {value}
      </span>
    </div>
  );
}

export function WorldDiagnostics() {
  const document = useWorldStore((state) => state.document);
  const layers = useWorldStore((state) => state.layers);
  const climateOverlay = useWorldStore((state) => state.climateOverlay);
  const metrics = useMemo(() => computeDiagnostics(document, layers), [document, layers]);
  const algorithm = useMemo(() => readAlgorithm(document), [document]);

  if (!metrics) {
    return (
      <p className="section-note" data-testid="world-diagnostics-empty">
        生成完成后这里会显示地形、水文、气候与性能诊断。
      </p>
    );
  }

  return (
    <div className="world-diagnostics" data-testid="world-diagnostics">
      <div className="diag-group">
        <div className="diag-group-head">
          <span>算法</span>
          <span className={`algo-chip algo-chip--${algorithm.kind}`} data-testid="diag-algorithm">
            {algorithm.label}
          </span>
        </div>
        <p className="section-note">{algorithm.hint}</p>
      </div>

      <div className="diag-group">
        <div className="diag-group-head">
          <span>地形</span>
          <span className="diag-kicker">terrain model</span>
        </div>
        <MetricRow
          label="板块数"
          testId="diag-plate-count"
          value={metrics.plateCount === null ? "—" : String(metrics.plateCount)}
        />
        <MetricRow
          label="陆地比例"
          testId="diag-land-fraction"
          value={`${formatPercent(metrics.landFraction)}（core ${(metrics.landFraction * 100).toFixed(1)}%）`}
        />
        <MetricRow
          label="平均 / 最高海拔"
          testId="diag-elevation"
          value={`${formatNumber(metrics.elevationAvg)} / ${formatNumber(metrics.elevationMax)}`}
        />
        <MetricRow
          label="板块边界山脊占比"
          testId="diag-ridge-share"
          value={formatPercent(metrics.ridgeShare)}
        />
      </div>

      <div className="diag-group">
        <div className="diag-group-head">
          <span>水文</span>
          <span className="diag-kicker">Strahler</span>
        </div>
        <div className="diag-grid">
          <MetricRow label="河格数" testId="diag-river-cells" value={String(metrics.riverCells)} />
          <MetricRow label="河流条数" testId="diag-river-count" value={String(metrics.riverCount ?? 0)} />
          <MetricRow
            label="最大级"
            testId="diag-strahler"
            value={metrics.strahlerMax === null ? "—" : String(metrics.strahlerMax)}
          />
          <MetricRow
            label="悬挂河率"
            testId="diag-hanging-rate"
            value={metrics.hangingRiverRate === null ? "—" : formatPercent(metrics.hangingRiverRate, 2)}
          />
          <MetricRow label="湖泊数" testId="diag-lake-count" value={String(metrics.lakeCells)} />
          <MetricRow
            label="最长河流"
            testId="diag-longest-river"
            value={metrics.longestRiverCells === null ? "—" : `${metrics.longestRiverCells} 格`}
          />
        </div>
      </div>

      <div className="diag-group">
        <div className="diag-group-head">
          <span>气候</span>
          <button
            type="button"
            className={`btn btn--small ${climateOverlay ? "btn--primary" : "btn--ghost"}`}
            data-testid="diag-climate-toggle"
            aria-pressed={climateOverlay}
            onClick={() => useWorldStore.getState().setClimateOverlay(!climateOverlay)}
          >
            {climateOverlay ? "关闭气候叠加" : "气候诊断叠加"}
          </button>
        </div>
        <MetricRow
          label="最干区域"
          testId="diag-driest"
          value={
            metrics.driest
              ? `${metrics.driest.label} · 降水指数 ${formatNumber(metrics.driest.value, 2)}`
              : "—"
          }
        />
        <MetricRow
          label="最湿区域"
          testId="diag-wettest"
          value={
            metrics.wettest
              ? `${metrics.wettest.label} · 降水指数 ${formatNumber(metrics.wettest.value, 2)}`
              : "—"
          }
        />
      </div>

      <div className="diag-group">
        <div className="diag-group-head">
          <span>群系占比</span>
          <span className="diag-kicker">{metrics.biomeKinds} 类</span>
        </div>
        <div className="diag-biomes" data-testid="diag-biome-bars">
          {metrics.biomeShares.slice(0, 7).map((biome) => (
            <div key={biome.id} className="diag-biome">
              <span className="diag-biome-name">
                <i className="swatch-dot" style={{ background: biome.color }} aria-hidden="true" />
                {biome.name}
              </span>
              <span className="diag-biome-track" aria-hidden="true">
                <span
                  className="diag-biome-fill"
                  style={{ width: `${Math.max(2, biome.share * 100)}%`, background: biome.color }}
                />
              </span>
              <span className="diag-biome-share">{formatPercent(biome.share, 0)}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="diag-group">
        <div className="diag-group-head">
          <span>阶段耗时</span>
          <span className="diag-kicker">ms</span>
        </div>
        <div className="diag-stages" data-testid="diag-stage-timings">
          {metrics.stageMs
            ? [
                ["地形", metrics.stageMs.terrain],
                ["水文", metrics.stageMs.hydrology],
                ["气候", metrics.stageMs.climate],
                ["群系", metrics.stageMs.biome],
                ["人文", metrics.stageMs.human],
              ].map(([label, value]) => (
                <span key={String(label)} className="diag-stage">
                  <span>{label}</span>
                  <strong>{Math.round(value as number)}</strong>
                </span>
              ))
            : null}
          <span className="diag-stage diag-stage--total">
            <span>合计</span>
            <strong>{metrics.stageMs ? Math.round(metrics.stageMs.total) : "—"}</strong>
          </span>
        </div>
      </div>
    </div>
  );
}
