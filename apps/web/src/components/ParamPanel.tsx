/** Left panel: every WorldParams control grouped by pipeline stage + edit log. */
import { useEffect, useState } from "react";

import type { WorldParams } from "@atlas/core";

import {
  DEFAULT_PARAM_VALUES,
  GRID_SIZE_OPTIONS,
  NAMING_LANGUAGE_OPTIONS,
  PARAM_GROUPS,
  PARAM_READABILITY,
  type ParamGroupDef,
} from "../lib/constants";
import { countOverrides } from "../lib/documentIO";
import {
  countScenarioParamDiffs,
  scenarioBaselineParams,
  scenarioById,
} from "../lib/scenarios";
import { formatMs, formatPercent } from "../lib/utils";
import { useWorldStore } from "../state/worldStore";
import { UI_PREF_KEYS } from "../lib/uiPrefs";
import { GenerationHistoryPanel } from "./GenerationHistoryPanel";
import { WorldDiagnostics } from "./WorldDiagnostics";
import { PlacesPanel } from "./PlacesPanel";
import {
  CollapsibleGroup,
  ScrollHint,
  Section,
  SelectField,
  SliderField,
  ToggleField,
  useScrollHint,
} from "./ui";

function groupParamKeys(group: ParamGroupDef): (keyof typeof DEFAULT_PARAM_VALUES)[] {
  if (group.id === "terrain") {
    return ["gridSize", "seaLevel", "continentScale", "continentality", "warpStrength", "ridgeStrength", "ridgeScale", "erosionIterations"];
  }
  if (group.id === "hydrology") return ["riverDensity"];
  if (group.id === "climate") return ["windBands", "windAngle", "moistureBias", "temperatureOffset"];
  return [];
}

export function ParamPanel() {
  const document = useWorldStore((state) => state.document);
  const layers = useWorldStore((state) => state.layers);
  const params = document.params;
  const overrides = countOverrides(document.overrides);
  const [confirmClear, setConfirmClear] = useState(false);
  const scroll = useScrollHint();
  const scenarioId = useWorldStore((state) => state.scenarioId);
  const scenario = scenarioById(scenarioId);
  const scenarioBaseline = scenarioBaselineParams(scenario);
  const presetDiffCount = countScenarioParamDiffs(params, scenario);

  useEffect(() => {
    if (!confirmClear) return;
    const timer = window.setTimeout(() => setConfirmClear(false), 5000);
    return () => window.clearTimeout(timer);
  }, [confirmClear]);

  const begin = () => useWorldStore.getState().beginInteraction();
  const endParamInteraction = (changed: boolean) => {
    const store = useWorldStore.getState();
    if (changed) store.requestGeneration("now");
    store.endInteraction();
  };

  const resetGroup = (group: ParamGroupDef) => {
    useWorldStore.getState().resetParams(groupParamKeys(group));
  };

  const population = layers
    ? layers.settlements.reduce((sum, settlement) => sum + (settlement.population ?? 0), 0)
    : 0;

  const elevationByMode = document.overrides.elevation.reduce(
    (counts, stamp) => {
      counts[stamp.mode] += 1;
      return counts;
    },
    { raise: 0, lower: 0, lock: 0 },
  );

  return (
    <aside className="panel panel--params" aria-label="生成参数面板">
      <div className="panel-head">
        <div>
          <h2>编辑面板</h2>
          <p className="panel-sub">可折叠分区 · 展开状态自动记忆</p>
        </div>
        <div className="panel-head-actions">
          {presetDiffCount > 0 ? (
            <span
              className="preset-badge"
              data-testid="preset-modified-badge"
              title={`场景「${scenario.name}」的推荐参数已被修改 ${presetDiffCount} 项`}
            >
              基于 {scenario.name} · 已改 {presetDiffCount} 项
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn--small"
            title={`恢复场景「${scenario.name}」的推荐参数`}
            data-testid="preset-reset"
            onClick={() => {
              useWorldStore.getState().updateParams(scenarioBaseline, {
                history: "push",
                sim: "now",
              });
              useWorldStore.getState().pushToast("info", `已还原场景「${scenario.name}」的推荐参数`);
            }}
          >
            还原预设
          </button>
          <button
            type="button"
            className="btn btn--small btn--ghost"
            title="恢复全部默认参数（不依赖场景）"
            data-testid="reset-all-params"
            onClick={() => useWorldStore.getState().resetParams()}
          >
            全部默认
          </button>
        </div>
      </div>

      <div className="panel-scroll" ref={scroll.ref} data-testid="params-scroll">
        <CollapsibleGroup
          title="世界编辑（地点）"
          icon="◉"
          storageKey={UI_PREF_KEYS.leftWorld}
          testId="group-places"
        >
          <PlacesPanel />
        </CollapsibleGroup>
        <CollapsibleGroup
          title="生成参数"
          icon="△"
          storageKey={UI_PREF_KEYS.leftParams}
          testId="group-params"
        >
        {PARAM_GROUPS.map((group) => (
          <Section
            key={group.id}
            title={group.title}
            icon={group.icon}
            note={group.note}
            defaultOpen
            testId={`section-${group.id}`}
            actions={
              group.id !== "human" ? (
                <button
                  type="button"
                  className="link-button"
                  title={`恢复「${group.title}」默认值`}
                  onClick={() => resetGroup(group)}
                >
                  默认
                </button>
              ) : null
            }
          >
            {group.id === "terrain" ? (
              <SelectField
                label="预览网格"
                value={params.gridSize}
                testId="param-gridSize"
                options={GRID_SIZE_OPTIONS.map((option) => ({
                  value: option.value,
                  label: option.label,
                }))}
                hint={GRID_SIZE_OPTIONS.find((option) => option.value === params.gridSize)?.hint}
                onChange={(value) => {
                  const store = useWorldStore.getState();
                  store.beginInteraction();
                  store.updateParams(
                    { gridSize: Number(value) },
                    { history: "push", sim: "now" },
                  );
                  store.endInteraction();
                }}
              />
            ) : null}

            {group.id === "climate" ? (
              <ToggleField
                label="纬度风带"
                hint="开启后按信风 / 西风带模拟；关闭则使用单一信风角度"
                checked={params.windBands}
                testId="param-windBands"
                onChange={(checked) => {
                  const store = useWorldStore.getState();
                  store.beginInteraction();
                  store.updateParams({ windBands: checked }, { history: "push", sim: "now" });
                  store.endInteraction();
                }}
              />
            ) : null}

            {group.sliders.map((slider) => (
              <SliderField
                key={slider.key}
                label={slider.label}
                value={params[slider.key]}
                min={slider.min}
                max={slider.max}
                step={slider.step}
                decimals={slider.decimals}
                unit={slider.unit}
                hint={slider.hint}
                testId={`param-${slider.key}`}
                plain={PARAM_READABILITY[slider.key]?.plain}
                scaleLabels={
                  PARAM_READABILITY[slider.key]
                    ? [
                        PARAM_READABILITY[slider.key].low,
                        PARAM_READABILITY[slider.key].mid,
                        PARAM_READABILITY[slider.key].high,
                      ]
                    : undefined
                }
                recommended={
                  typeof scenarioBaseline[slider.key] === "number"
                    ? (scenarioBaseline[slider.key] as number)
                    : DEFAULT_PARAM_VALUES[slider.key]
                }
                recommendTestId={`param-recommend-${slider.key}`}
                onResetRecommended={() => {
                  const recommended = scenarioBaseline[slider.key];
                  if (typeof recommended !== "number") return;
                  useWorldStore.getState().updateParams(
                    { [slider.key]: recommended } as Partial<WorldParams>,
                    { history: "push", sim: "now" },
                  );
                }}
                onBegin={begin}
                onLive={(value, interacting) =>
                  useWorldStore
                    .getState()
                    .updateParams({ [slider.key]: value } as Partial<WorldParams>, {
                      draft: interacting === true,
                    })
                }
                onEnd={endParamInteraction}
              />
            ))}

            {group.id === "human" ? (
              <>
                <SelectField
                  label="命名语言"
                  value={params.namingLanguage}
                  testId="param-namingLanguage"
                  options={NAMING_LANGUAGE_OPTIONS.map((option) => ({
                    value: option.value,
                    label: option.label,
                  }))}
                  hint="影响城镇 / 河流 / 区域地名的音节体系，切换后重新生成"
                  onChange={(value) => {
                    const store = useWorldStore.getState();
                    store.beginInteraction();
                    store.updateParams(
                      { namingLanguage: value as WorldParams["namingLanguage"] },
                      { history: "push", sim: "now" },
                    );
                    store.endInteraction();
                  }}
                />
                <div className="stat-list">
                <div className="stat-row">
                  <span>城镇</span>
                  <strong>{layers ? `${layers.settlements.length} 座` : "—"}</strong>
                </div>
                <div className="stat-row">
                  <span>自动地名</span>
                  <strong>{layers ? `${layers.autoLabels.length} 条` : "—"}</strong>
                </div>
                <div className="stat-row">
                  <span>估算人口</span>
                  <strong>{layers ? population.toLocaleString("zh-CN") : "—"}</strong>
                </div>
                <div className="stat-row">
                  <span>人文层耗时</span>
                  <strong>{formatMs(layers?.stats.humanMs)}</strong>
                </div>
                <div className="stat-row">
                  <span>陆地占比</span>
                  <strong>{formatPercent(layers?.stats.landFraction)}</strong>
                </div>
                </div>
              </>
            ) : null}
          </Section>
        ))}
        </CollapsibleGroup>

        <CollapsibleGroup
          title="画笔编辑"
          icon="✎"
          storageKey={UI_PREF_KEYS.leftBrushes}
          testId="group-brushes"
        >
        <Section
          title="编辑记录与清理"
          icon="✎"
          testId="section-edits"
          note="所有编辑以归一化世界坐标保存，重新生成 / 改种子后依然保留。"
        >
          <div className="stat-list">
            <div className="stat-row">
              <span>海拔编辑点</span>
              <strong data-testid="override-elevation-count">{overrides.elevation}</strong>
            </div>
            <div className="stat-row">
              <span>强制河道</span>
              <strong data-testid="override-river-count">
                {overrides.rivers} 条 / {overrides.riverPoints} 节点
              </strong>
            </div>
            <div className="stat-row">
              <span>群系涂抹点</span>
              <strong data-testid="override-biome-count">{overrides.biome}</strong>
            </div>
            <div className="stat-row">
              <span>海拔模式</span>
              <strong>
                抬升 {elevationByMode.raise} · 压低 {elevationByMode.lower} · 锁定 {elevationByMode.lock}
              </strong>
            </div>
          </div>

          {document.overrides.riverForce.length > 0 ? (
            <ul className="river-list" data-testid="river-list">
              {document.overrides.riverForce.map((river, index) => (
                <li key={river.id} className="river-item">
                  <span className="river-swatch" aria-hidden="true" />
                  <span className="river-meta">
                    河道 {index + 1} · {river.points.length} 节点 · 宽 {(river.width * 100).toFixed(2)}%
                  </span>
                  <button
                    type="button"
                    className="link-button link-button--danger"
                    onClick={() => useWorldStore.getState().deleteRiver(river.id)}
                    data-testid={`delete-river-${index}`}
                  >
                    删除
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="empty-note">暂无强制河道。选择「河道」画笔在地图上逐点绘制。</p>
          )}

          <button
            type="button"
            className={`btn btn--block ${confirmClear ? "btn--danger" : ""}`}
            disabled={overrides.total === 0}
            data-testid="clear-overrides"
            onClick={() => {
              if (confirmClear) {
                useWorldStore.getState().clearOverrides();
                setConfirmClear(false);
              } else {
                setConfirmClear(true);
              }
            }}
          >
            {confirmClear ? "再点一次确认清空" : "清空全部画笔编辑"}
          </button>
        </Section>
        </CollapsibleGroup>

        <CollapsibleGroup
          title="生成历史"
          icon="◷"
          storageKey={UI_PREF_KEYS.leftHistory}
          testId="group-history"
        >
          <GenerationHistoryPanel />
        </CollapsibleGroup>

        <CollapsibleGroup
          title="世界诊断"
          icon="◎"
          storageKey={UI_PREF_KEYS.leftDiagnostics}
          testId="group-diagnostics"
        >
          <WorldDiagnostics />
        </CollapsibleGroup>
      </div>
      <ScrollHint visible={scroll.scrollable && !scroll.atBottom} testId="params-scroll-hint">
        向下滚动查看其余生成参数 ↓
      </ScrollHint>
    </aside>
  );
}
