/** Right panel: every RenderStyle control (re-renders only) + stats + legend. */
import { BIOME_NAMES, type RenderStyle } from "@atlas/core";

import {
  BIOME_COLORS,
  BIOME_ORDER,
  STYLE_PRESETS,
  STYLE_SLIDERS,
  STYLE_TOGGLES,
  type StylePresetId,
  type StyleSliderKey,
  type StyleToggleKey,
} from "../lib/constants";
import { countOverrides } from "../lib/documentIO";
import { formatMs, formatPercent } from "../lib/utils";
import { useWorldStore } from "../state/worldStore";
import {
  ScrollHint,
  Section,
  SelectField,
  SliderField,
  Swatch,
  ToggleField,
  useScrollHint,
} from "./ui";

export function StylePanel() {
  const style = useWorldStore((state) => state.document.style);
  const layers = useWorldStore((state) => state.layers);
  const generation = useWorldStore((state) => state.generation);
  const render = useWorldStore((state) => state.render);
  const undoCount = useWorldStore((state) => state.historyPast.length);
  const redoCount = useWorldStore((state) => state.historyFuture.length);
  const documentOverrides = useWorldStore((state) => state.document.overrides);
  const overrides = countOverrides(documentOverrides);
  const scroll = useScrollHint();

  const updateToggle = (key: StyleToggleKey, value: boolean) => {
    useWorldStore.getState().updateStyle({ [key]: value }, { history: "push" });
  };

  return (
    <aside className="panel panel--style" aria-label="渲染风格面板">
      <div className="panel-head">
        <div>
          <h2>渲染风格</h2>
          <p className="panel-sub">只重绘不重算世界 · 立即生效</p>
        </div>
        <button
          type="button"
          className="btn btn--small btn--ghost"
          title="恢复默认羊皮纸风格"
          data-testid="reset-style"
          onClick={() => useWorldStore.getState().resetStyle()}
        >
          重置
        </button>
      </div>

      <div className="panel-scroll" ref={scroll.ref} data-testid="style-scroll">
        <Section title="预设与图题" icon="✦" testId="section-style-title">
          <SelectField
            label="风格预设"
            value={style.preset}
            testId="style-preset-panel"
            options={(Object.keys(STYLE_PRESETS) as StylePresetId[]).map((id) => ({
              value: id,
              label: STYLE_PRESETS[id].label,
            }))}
            hint={STYLE_PRESETS[style.preset]?.description}
            onChange={(value) =>
              useWorldStore.getState().applyPreset(value as StylePresetId)
            }
          />
          <div className="stat-row">
            <span>图题（跟随世界名）</span>
            <strong data-testid="style-title-readonly">{style.title || "—"}</strong>
          </div>
          <p className="field-hint">在顶栏修改「世界名」会同步更新地图 cartouche 图题。</p>
        </Section>

        <Section title="图层开关" icon="◫" testId="section-style-toggles">
          <div className="toggle-stack">
            {STYLE_TOGGLES.map((toggle) => (
              <ToggleField
                key={toggle.key}
                label={toggle.label}
                hint={toggle.hint}
                checked={style[toggle.key]}
                testId={`style-${toggle.key}`}
                onChange={(value) => updateToggle(toggle.key, value)}
              />
            ))}
          </div>
        </Section>

        <Section title="细节强度" icon="◇" testId="section-style-sliders">
          {STYLE_SLIDERS.map((slider) => (
            <SliderField
              key={slider.key}
              label={slider.label}
              value={style[slider.key as StyleSliderKey]}
              min={slider.min}
              max={slider.max}
              step={slider.step}
              decimals={slider.decimals}
              hint={slider.hint}
              testId={`style-${slider.key}`}
              onBegin={() => useWorldStore.getState().beginInteraction()}
              onLive={(value) =>
                useWorldStore.getState().updateStyle({
                  [slider.key]: value,
                } as Partial<RenderStyle>)
              }
              onEnd={(changed) => {
                const store = useWorldStore.getState();
                if (changed) store.requestRender();
                store.endInteraction();
              }}
            />
          ))}
        </Section>

        <Section title="世界统计" icon="▦" defaultOpen={true} testId="section-stats">
          <div className="stat-list">
            <div className="stat-row">
              <span>模拟网格</span>
              <strong>{layers ? `${layers.size}²` : "—"}</strong>
            </div>
            <div className="stat-row">
              <span>生成耗时</span>
              <strong data-testid="stat-generation-ms">
                {formatMs(generation.durationMs ?? layers?.stats.totalMs)}
              </strong>
            </div>
            <div className="stat-row">
              <span>地形 / 水文</span>
              <strong>
                {formatMs(layers?.stats.terrainMs)} / {formatMs(layers?.stats.hydrologyMs)}
              </strong>
            </div>
            <div className="stat-row">
              <span>气候 / 群系</span>
              <strong>
                {formatMs(layers?.stats.climateMs)} / {formatMs(layers?.stats.biomeMs)}
              </strong>
            </div>
            <div className="stat-row">
              <span>陆地占比</span>
              <strong>{formatPercent(layers?.stats.landFraction)}</strong>
            </div>
            <div className="stat-row">
              <span>城镇 / 地名</span>
              <strong>
                {layers ? `${layers.settlements.length} / ${layers.autoLabels.length}` : "—"}
              </strong>
            </div>
            <div className="stat-row">
              <span>上次重绘</span>
              <strong data-testid="stat-render-ms">{formatMs(render.lastMs)}</strong>
            </div>
            <div className="stat-row">
              <span>画笔编辑</span>
              <strong>
                海拔 {overrides.elevation} · 河 {overrides.rivers} · 群系 {overrides.biome}
              </strong>
            </div>
            <div className="stat-row">
              <span>撤销栈</span>
              <strong>
                {undoCount} / {redoCount}
              </strong>
            </div>
          </div>
        </Section>

        <Section title="群系图例" icon="❖" defaultOpen={true} testId="section-legend">
          <ul className="legend-grid">
            {BIOME_ORDER.map((biome) => (
              <li key={biome} className="legend-item">
                <Swatch color={BIOME_COLORS[biome]} />
                <span>{BIOME_NAMES[biome]}</span>
              </li>
            ))}
          </ul>
          <p className="section-note">图例色板为界面参考，最终色彩由渲染器决定。</p>
        </Section>
      </div>
      <ScrollHint visible={scroll.scrollable && !scroll.atBottom} testId="style-scroll-hint">
        向下滚动查看全部风格设置 ↓
      </ScrollHint>
    </aside>
  );
}
