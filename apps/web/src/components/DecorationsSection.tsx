/** Map chrome configuration (v0.6): per-element visibility, anchor and text. */
import {
  DEFAULT_DECORATIONS,
  resolveDecorations,
  type DecorAnchor,
  type DecorConfig,
  type DecorId,
  type Decorations,
} from "@atlas/core";

import { useWorldStore } from "../state/worldStore";
import { Section, SelectField, ToggleField } from "./ui";

interface DecorRow {
  id: DecorId;
  label: string;
  hint: string;
  anchor: boolean;
}

const ROWS: DecorRow[] = [
  { id: "title", label: "标题饰框", hint: "世界名 / 副标题 / 种子行", anchor: true },
  { id: "compass", label: "指北针", hint: "罗盘玫瑰", anchor: true },
  { id: "scaleBar", label: "比例尺", hint: "公里刻度尺", anchor: true },
  { id: "legend", label: "图例", hint: "城市 / 河流 / 山脉 / 海洋", anchor: true },
  { id: "credits", label: "署名", hint: "制图署名，可自定义文字", anchor: true },
  { id: "graticule", label: "经纬网", hint: "古地图式经纬网格", anchor: false },
  { id: "border", label: "装饰边框", hint: "双重手绘边框", anchor: false },
];

const ANCHOR_OPTIONS: { value: DecorAnchor; label: string }[] = [
  { value: "top-left", label: "左上" },
  { value: "top-center", label: "上中" },
  { value: "top-right", label: "右上" },
  { value: "bottom-left", label: "左下" },
  { value: "bottom-center", label: "下中" },
  { value: "bottom-right", label: "右下" },
];

export function DecorationsSection() {
  const style = useWorldStore((state) => state.document.style);
  const decorations = resolveDecorations(style.decorations);

  const apply = (patch: Decorations) => {
    const next: Decorations = { ...resolveDecorations(style.decorations), ...patch };
    useWorldStore.getState().updateStyle({ decorations: next }, { history: "push" });
  };

  const update = (id: DecorId, patch: Partial<DecorConfig>) => {
    apply({ [id]: { ...decorations[id], ...patch } } as Decorations);
  };

  const allOff = () => {
    const next = {} as Decorations;
    for (const id of Object.keys(DEFAULT_DECORATIONS) as DecorId[]) {
      next[id] = { ...decorations[id], visible: false };
    }
    apply(next);
  };

  const resetAll = () => {
    const next = {} as Decorations;
    for (const id of Object.keys(DEFAULT_DECORATIONS) as DecorId[]) {
      next[id] = { ...DEFAULT_DECORATIONS[id] };
    }
    apply(next);
  };

  const visibleCount = ROWS.filter((row) => decorations[row.id].visible).length;

  return (
    <Section
      title="装饰元素"
      icon="❖"
      note={`图中的标题、指北针、比例尺、图例等全部可单独开关与换位（当前 ${visibleCount}/7 可见）。关闭后不占位置。`}
      testId="section-decorations"
    >
      <div className="decor-actions">
        <button type="button" className="btn btn--small btn--ghost" data-testid="decorations-all-off" onClick={allOff}>
          全部关闭
        </button>
        <button type="button" className="btn btn--small btn--ghost" data-testid="decorations-reset" onClick={resetAll}>
          恢复默认
        </button>
      </div>

      <div className="toggle-stack">
        {ROWS.map((row) => (
          <div className="decor-row" key={row.id} data-testid={`decor-row-${row.id}`}>
            <ToggleField
              label={row.label}
              hint={row.hint}
              checked={decorations[row.id].visible}
              testId={`decor-toggle-${row.id}`}
              onChange={(visible) => update(row.id, { visible })}
            />
            {row.anchor ? (
              <SelectField
                label="位置"
                value={decorations[row.id].anchor ?? "top-center"}
                testId={`decor-anchor-${row.id}`}
                options={ANCHOR_OPTIONS.map((option) => ({ ...option }))}
                onChange={(value) => update(row.id, { anchor: value as DecorAnchor })}
              />
            ) : null}
          </div>
        ))}
      </div>

      <label className="decor-text-field">
        <span>主标题（留空跟随世界名）</span>
        <input
          type="text"
          maxLength={80}
          data-testid="decor-text-title"
          value={decorations.title.text ?? ""}
          placeholder={style.title || useWorldStore.getState().document.name}
          onChange={(event) => update("title", { text: event.target.value })}
        />
      </label>
      <label className="decor-text-field">
        <span>副标题</span>
        <input
          type="text"
          maxLength={80}
          data-testid="decor-subtitle-title"
          value={decorations.title.subtitle ?? ""}
          placeholder="A CHART OF THE KNOWN WORLD"
          onChange={(event) => update("title", { subtitle: event.target.value })}
        />
      </label>
      <label className="decor-text-field">
        <span>署名文字</span>
        <input
          type="text"
          maxLength={80}
          data-testid="decor-text-credits"
          value={decorations.credits.text ?? ""}
          placeholder="Atlas Forge"
          onChange={(event) => update("credits", { text: event.target.value })}
        />
      </label>
      <p className="field-hint">装饰改动只重绘，不会重新生成世界；可撤销。</p>
      <span className="sr-only" data-testid="decor-visible-count">{visibleCount}</span>
    </Section>
  );
}
