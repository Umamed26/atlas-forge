/**
 * Places & labels editing panel: inspector, visible place list, hidden/restore
 * list. Selection and rename state live in the world store so the canvas tool
 * can drive the same inspector.
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { focusMapCanvas } from "../lib/focus";
import {
  collectPlaces,
  findPlace,
  placeEntityLabel,
  placeTypeIcon,
  placeTypeLabel,
  type PlaceEntry,
} from "../lib/places";
import { useViewStore } from "../state/viewStore";
import { useWorldStore } from "../state/worldStore";


export function PlacesPanel() {
  const document = useWorldStore((state) => state.document);
  const layers = useWorldStore((state) => state.layers);
  const tool = useWorldStore((state) => state.tool);
  const selectedPlace = useWorldStore((state) => state.selectedPlace);
  const placeRename = useWorldStore((state) => state.placeRename);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const collections = useMemo(() => collectPlaces(document, layers), [document, layers]);
  const selected = useMemo(
    () => findPlace(collections, selectedPlace),
    [collections, selectedPlace],
  );
  const counts = useMemo(() => {
    let settlements = 0;
    let labels = 0;
    for (const entry of collections.visible) {
      if (entry.entity === "settlement") settlements += 1;
      else labels += 1;
    }
    return { settlements, labels, hidden: collections.hidden.length };
  }, [collections]);

  // Seed the inline rename input whenever the store asks for a rename.
  useEffect(() => {
    if (!placeRename) return;
    const entry = findPlace(collections, placeRename);
    setRenameValue(entry?.name ?? "");
    const timer = window.setTimeout(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [placeRename, collections]);

  // Drop selections whose entry no longer exists (delete/undo/import).
  useEffect(() => {
    if (!selectedPlace || !layers) return;
    if (findPlace(collections, selectedPlace)) return;
    useWorldStore.getState().selectPlace(null);
  }, [selectedPlace, layers, collections]);

  const locate = (entry: PlaceEntry) => {
    const view = useViewStore.getState();
    view.centerOn(entry.x, entry.y, Math.max(view.scale, 1));
  };

  const selectAndLocate = (entry: PlaceEntry) => {
    useWorldStore.getState().selectPlace({ id: entry.id, entity: entry.entity });
    locate(entry);
  };

  /** Commit once, using the *live* store state so blur-after-Escape is a no-op. */
  const commitRename = () => {
    const active = useWorldStore.getState().placeRename;
    if (!active) return;
    useWorldStore.getState().renamePlace(active.id, active.entity, renameValue);
    focusMapCanvas();
  };

  const cancelRename = () => {
    useWorldStore.getState().cancelPlaceRename();
    focusMapCanvas();
  };

  return (
    <div className="places-content" data-testid="section-places">
      <span className="visually-hidden" aria-live="polite">
        {selected
          ? `已选中${placeEntityLabel(selected.entity)}「${selected.name}」`
          : "未选中地点"}
      </span>
      <div className="places-topline">
        <span className="places-title">地点与地名</span>
        <span className="section-count" data-testid="place-count">
          地点 {counts.settlements} · 标注 {counts.labels}
          {counts.hidden > 0 ? ` · 隐藏 ${counts.hidden}` : ""}
        </span>
      </div>
      <p className="section-note">
        用「地点」工具（快捷键 4）：单击选中 · 拖动定位 · 双击改名；「放置」后点击地图新增。
      </p>
      {tool !== "places" ? (
        <button
          type="button"
          className="btn btn--small btn--block"
          data-testid="use-places-tool"
          onClick={() => useWorldStore.getState().setTool("places")}
        >
          切换到地点工具（4）
        </button>
      ) : null}

      {selected ? (
        <div className="place-inspector" data-testid="place-inspector">
          <div className="place-inspector-head">
            <span className="place-inspector-icon" aria-hidden="true">
              {placeTypeIcon(selected)}
            </span>
            <div className="place-inspector-titles">
              <strong data-testid="place-selected-name">{selected.name}</strong>
              <span className="place-inspector-meta">
                {placeEntityLabel(selected.entity)} · {placeTypeLabel(selected)} ·{" "}
                {selected.userAdded ? "用户新增" : "生成条目"}
                {selected.pinned ? " · 已固定" : ""}
              </span>
              <span className="place-inspector-coords">
                坐标 {selected.x.toFixed(3)}, {selected.y.toFixed(3)}
              </span>
            </div>
          </div>

          {placeRename &&
          placeRename.id === selected.id &&
          placeRename.entity === selected.entity ? (
            <div className="place-rename-row">
              <input
                ref={renameInputRef}
                type="text"
                className="place-rename-input"
                data-testid="place-rename-input"
                aria-label="重命名地点或地名"
                maxLength={80}
                value={renameValue}
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitRename();
                  } else if (event.key === "Escape") {
                    // Cancel only the rename; do not let the global handler
                    // deselect the place as a second Escape action.
                    event.preventDefault();
                    event.stopPropagation();
                    cancelRename();
                  }
                }}
                onBlur={commitRename}
              />
              <button
                type="button"
                className="btn btn--small btn--primary"
                data-testid="place-rename-commit"
                onClick={commitRename}
              >
                保存
              </button>
              <button
                type="button"
                className="btn btn--small btn--ghost"
                onMouseDown={(event) => event.preventDefault()}
                onClick={cancelRename}
              >
                取消
              </button>
            </div>
          ) : (
            <div className="place-actions">
              <button
                type="button"
                className="btn btn--small"
                data-testid="place-locate"
                onClick={() => locate(selected)}
              >
                定位
              </button>
              <button
                type="button"
                className="btn btn--small"
                data-testid="place-rename"
                onClick={() =>
                  useWorldStore.getState().beginPlaceRename(selected.id, selected.entity)
                }
              >
                重命名
              </button>
              <button
                type="button"
                className="btn btn--small"
                data-testid="place-hide"
                onClick={() => useWorldStore.getState().hidePlace(selected.id)}
              >
                隐藏
              </button>
              {selected.userAdded ? (
                <button
                  type="button"
                  className="btn btn--small btn--danger"
                  data-testid="place-delete"
                  onClick={() =>
                    useWorldStore.getState().deletePlace(selected.id, selected.entity)
                  }
                >
                  删除
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn--small btn--ghost"
                data-testid="place-cancel"
                onClick={() => useWorldStore.getState().selectPlace(null)}
              >
                取消选择
              </button>
            </div>
          )}
        </div>
      ) : (
        <p className="empty-note">
          {tool === "places"
            ? "正在编辑地点：单击地图上的地点或地名；也可用「放置」新增。"
            : "切换到地点工具后，单击地图上的地点或地名开始编辑。"}
        </p>
      )}

      <ul className="place-list" data-testid="place-list">
        {collections.visible.length === 0 ? (
          <li className="empty-note">当前世界没有可见地点或地名。</li>
        ) : null}
        {collections.visible.map((entry) => {
          const isSelected =
            selectedPlace?.id === entry.id && selectedPlace?.entity === entry.entity;
          return (
            <li key={`${entry.entity}:${entry.id}`}>
              <button
                type="button"
                className={`place-list-item ${isSelected ? "is-selected" : ""}`}
                data-testid={`place-list-item-${entry.id}`}
                aria-pressed={isSelected}
                title={`${placeEntityLabel(entry.entity)} · ${placeTypeLabel(entry)} · (${entry.x.toFixed(3)}, ${entry.y.toFixed(3)})`}
                onClick={() => selectAndLocate(entry)}
              >
                <span className="place-item-icon" aria-hidden="true">
                  {placeTypeIcon(entry)}
                </span>
                <span className="place-item-name">{entry.name}</span>
                <span className="place-item-type">{placeTypeLabel(entry)}</span>
              </button>
            </li>
          );
        })}
      </ul>

      {collections.hidden.length > 0 ? (
        <div className="place-hidden-block">
          <h4 className="place-subtitle">
            隐藏与恢复（{collections.hidden.length}）
          </h4>
          <ul className="place-hidden-list">
            {collections.hidden.map((entry) => (
              <li
                key={`hidden:${entry.entity}:${entry.id}`}
                className="place-hidden-item"
                data-testid={`place-hidden-item-${entry.id}`}
              >
                <span className="place-item-icon" aria-hidden="true">
                  {placeTypeIcon(entry)}
                </span>
                <span className="place-item-name">{entry.name}</span>
                <span className="place-item-type">{placeTypeLabel(entry)}</span>
                <button
                  type="button"
                  className="btn btn--small btn--ghost"
                  data-testid="place-restore"
                  data-place-id={entry.id}
                  data-entity={entry.entity}
                  aria-label={`恢复 ${entry.name}`}
                  onClick={() => useWorldStore.getState().restorePlace(entry.id)}
                >
                  恢复
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
