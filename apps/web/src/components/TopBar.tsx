/** Top bar: world identity, generation controls, history, IO & help. */
import { useEffect, useRef, useState, type ChangeEvent } from "react";

import type { DesktopIntegration } from "../hooks/useDesktopIntegration";
import { STYLE_PRESETS, type StylePresetId } from "../lib/constants";
import { formatDocumentIssues, countIssues } from "../lib/coreDocumentAdapter";
import {
  exportDocumentJson,
  readWorldDocumentFile,
} from "../lib/documentIO";
import { useWorldStore } from "../state/worldStore";

export interface TopBarProps {
  /** Desktop (Electron) integration; `available === false` in the browser. */
  desktop: DesktopIntegration;
  onOpenExport: () => void;
  onOpenHelp: () => void;
}

function SeedInput() {
  const seed = useWorldStore((state) => state.document.seed);
  const [draft, setDraft] = useState(String(seed));

  useEffect(() => {
    setDraft(String(seed));
  }, [seed]);

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(seed));
      return;
    }
    const rounded = Math.max(0, Math.round(parsed));
    useWorldStore.getState().setSeed(rounded);
    setDraft(String(rounded));
  };

  return (
    <input
      className="seed-input"
      type="number"
      inputMode="numeric"
      min={0}
      max={999_999_999}
      step={1}
      value={draft}
      title="世界种子：相同种子 + 相同参数一定生成同一个世界"
      aria-label="世界种子"
      data-testid="seed-input"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function TopBar({ desktop, onOpenExport, onOpenHelp }: TopBarProps) {
  const name = useWorldStore((state) => state.document.name);
  const preset = useWorldStore((state) => state.document.style.preset);
  const exportSize = useWorldStore((state) => state.exportSize);
  const canUndo = useWorldStore((state) => state.historyPast.length > 0);
  const canRedo = useWorldStore((state) => state.historyFuture.length > 0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);

  const handleExportJson = () => {
    try {
      const filename = exportDocumentJson(useWorldStore.getState().document);
      useWorldStore.getState().pushToast("success", `已导出 ${filename}`);
    } catch (error) {
      useWorldStore
        .getState()
        .pushToast("error", `导出 JSON 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const handleImportFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setImporting(true);
    try {
      const result = await readWorldDocumentFile(file);
      const store = useWorldStore.getState();
      const errorCount = countIssues(result.issues, "error");
      if (!result.document || errorCount > 0) {
        store.pushToast(
          "error",
          `导入失败：${formatDocumentIssues(result.issues, 2)}`,
        );
        return;
      }
      store.importDocument(result.document);
      store.requestPipelineReset();
      const warningCount = countIssues(result.issues, "warning");
      if (warningCount > 0) {
        store.pushToast("info", `已导入并自动修复 ${warningCount} 处字段`);
      }
    } catch (error) {
      useWorldStore.getState().pushToast(
        "error",
        `导入失败：${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      setImporting(false);
    }
  };

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="brand-mark" aria-hidden="true">✦</span>
        <div className="brand-copy">
          <h1>Atlas Forge</h1>
          <span className="brand-sub">世界地图工坊 · M6</span>
        </div>
      </div>

      <div className="topbar-center">
        <label className="compact-field">
          <span>世界名</span>
          <input
            className="name-input"
            type="text"
            value={name}
            maxLength={80}
            placeholder="未命名世界"
            aria-label="世界名称"
            data-testid="world-name"
            onFocus={() => useWorldStore.getState().beginInteraction()}
            onChange={(event) => useWorldStore.getState().setName(event.target.value)}
            onBlur={(event) => {
              const value = event.target.value.trim();
              if (value.length === 0) useWorldStore.getState().setName("未命名世界");
              useWorldStore.getState().endInteraction();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        </label>
        <label className="compact-field">
          <span>种子</span>
          <SeedInput />
        </label>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          title="换一个随机种子"
          aria-label="换一个种子"
          data-testid="reroll"
          onClick={() => useWorldStore.getState().rerollSeed()}
        >
          🎲
        </button>
        <button
          type="button"
          className="btn btn--primary"
          title="立即按当前文档重新生成（Ctrl/⌘ + Enter）"
          data-testid="generate"
          onClick={() => useWorldStore.getState().requestGeneration("now")}
        >
          生成
        </button>
      </div>

      <div className="topbar-actions">
        <div className="history-buttons" role="group" aria-label="历史操作">
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            title="撤销（Ctrl/⌘ + Z）"
            aria-label="撤销"
            data-testid="undo"
            disabled={!canUndo}
            onClick={() => useWorldStore.getState().undo()}
          >
            ↶
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            title="重做（Ctrl/⌘ + Shift + Z）"
            aria-label="重做"
            data-testid="redo"
            disabled={!canRedo}
            onClick={() => useWorldStore.getState().redo()}
          >
            ↷
          </button>
        </div>

        <select
          className="preset-select"
          aria-label="风格预设"
          title="羊皮纸风格预设（只重绘，不重算世界）"
          data-testid="style-preset"
          value={preset}
          onChange={(event) =>
            useWorldStore.getState().applyPreset(event.target.value as StylePresetId)
          }
        >
          {(Object.keys(STYLE_PRESETS) as StylePresetId[]).map((id) => (
            <option key={id} value={id}>
              {STYLE_PRESETS[id].label}
            </option>
          ))}
        </select>

        {desktop.available ? (
          <div className="io-buttons desktop-io" data-testid="desktop-io">
            <button
              type="button"
              className="btn btn--ghost"
              title="打开世界 JSON（Ctrl/⌘ + O）"
              data-testid="desktop-open"
              disabled={desktop.busy === "open"}
              onClick={() => void desktop.openWorld()}
            >
              {desktop.busy === "open" ? "打开中…" : "打开"}
            </button>
            <details className="recent-files" data-testid="desktop-recent">
              <summary
                className="btn btn--ghost btn--small recent-files-toggle"
                title="最近打开的世界（最多 3 个）"
                data-testid="desktop-recent-toggle"
              >
                最近{desktop.recent.length > 0 ? ` ${desktop.recent.length}` : ""}
              </summary>
              <div className="recent-files-menu" role="menu" aria-label="最近打开的世界">
                {desktop.recent.length === 0 ? (
                  <span className="recent-files-empty">暂无最近文件</span>
                ) : (
                  desktop.recent.map((file, index) => (
                    <button
                      key={file.path}
                      type="button"
                      role="menuitem"
                      className="recent-file-item"
                      data-testid={`desktop-recent-item-${index}`}
                      title={file.path}
                      onClick={(event) => {
                        // Close the native <details> before opening the dialog.
                        event.currentTarget.closest("details")?.removeAttribute("open");
                        void desktop.openRecent(file.path);
                      }}
                    >
                      <span className="recent-file-name">{file.name}</span>
                      <span className="recent-file-path">{file.path}</span>
                    </button>
                  ))
                )}
              </div>
            </details>
            <button
              type="button"
              className="btn btn--ghost"
              title={
                desktop.path
                  ? `保存到 ${desktop.path}（Ctrl/⌘ + S）`
                  : "保存世界 JSON（首次保存会询问位置）"
              }
              data-testid="desktop-save"
              disabled={desktop.busy === "save"}
              onClick={() => void desktop.saveWorld()}
            >
              {desktop.busy === "save" ? "保存中…" : "保存"}
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              title="另存为新的世界 JSON（Ctrl/⌘ + Shift + S）"
              data-testid="desktop-save-as"
              disabled={desktop.busy === "save"}
              onClick={() => void desktop.saveWorldAs()}
            >
              另存为
            </button>
            {desktop.dirty ? (
              <span
                className="desktop-dirty"
                data-testid="desktop-dirty"
                title={
                  desktop.path
                    ? `有未保存修改：${desktop.path}`
                    : "有未保存修改：尚未写入文件"
                }
              >
                ● 未保存
              </span>
            ) : null}
          </div>
        ) : (
          <div className="io-buttons">
            <button
              type="button"
              className="btn btn--ghost"
              title="导出世界 JSON（唯一真源，可随时导入恢复）"
              data-testid="export-json"
              onClick={handleExportJson}
            >
              导出 JSON
            </button>
            <button
              type="button"
              className="btn btn--ghost"
              title="导入世界 JSON（需要 version: 1）"
              data-testid="import-json"
              disabled={importing}
              onClick={() => fileInputRef.current?.click()}
            >
              {importing ? "导入中…" : "导入 JSON"}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="visually-hidden"
              data-testid="import-json-input"
              onChange={(event) => void handleImportFile(event)}
            />
          </div>
        )}

        <button
          type="button"
          className="btn btn--accent"
          title={
            desktop.available
              ? `导出 PNG / SVG · 当前选择 ${exportSize}²（桌面本地渲染，无需服务端）`
              : `导出 PNG · 当前选择 ${exportSize}²（1024/2048 本地，4096/8192 服务端）`
          }
          data-testid="export-png"
          onClick={onOpenExport}
        >
          导出 PNG · {exportSize}²
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--icon"
          title="快捷键与使用说明（?）"
          aria-label="帮助"
          data-testid="help"
          onClick={onOpenHelp}
        >
          ？
        </button>
      </div>
    </header>
  );
}
