# Changelog

## v0.3.0 — 2026-10-18

### Added / Improved
- **同源命中**：renderer 新增 `measureMapContent`（layout 与绘制共用同一套字体/避让），Web 命中改为文字包围盒 + drawOrder topmost；长标签尾部可点选，悬停/选中高亮同步为 bbox 描边；命中 ~0.7ms@1024。
- **撤销一致性**：一次用户动作一条历史（改名仅 Enter/失焦提交、拖动仅 pointerup、隐藏/恢复各一条），选区/悬停/自动保存/导出不进历史；跨功能撤销链可回溯。
- **键盘与焦点**：单一快捷键表（17 条）驱动帮助与实际行为；重命名输入框内 Delete/Backspace 安全；Esc 五级优先级；提交/取消焦点回画布；a11y（aria-label/focus-visible/aria-live/reduced-motion）。
- **导入/自动存档健壮性**：core 新增 `normalizeWorldDocument`/`parseWorldDocumentJson`；坏 JSON 拒绝且不半加载；自动保存主/备双槽 + 损坏恢复面板；quota 失败提示并可立即导出备份。
- **导出可预期**：按钮显示当前尺寸；文件名 `atlas-<world>-<seed>-<preset>-<size>.png`；分阶段进度与取消（AbortController）；完成后释放 canvas/worker；服务端 abort 跳过编码并释放内存。
- **布局**：左右面板改为可折叠分组、sticky 标题、展开状态记忆；1280×800 / 1024×768 无溢出。
- **命名**：自动命名纯函数 + 注入 RNG + 重名稳定后缀。
- **工程**：CI 增加 `qa:render` 冒烟；E2E 浏览器解析可移植；节点渲染器 v1.1.0（视觉零变化，像素级回归验证）。

## v0.2.0 — 2026-10-18

### Added
- 地点与地名编辑：新「地点」工具（快捷键 4），支持单击选中、双击改名、拖动定位、
  新增地点（city/town/port/fortress/ruin/custom）与标注（region/water/mountain/custom）。
- 隐藏/恢复：隐藏写入 `overrides.hiddenIds`，被隐藏条目在 `layers.hidden` 中返回并可在检查器恢复。
- `WorldLayers.hidden`（additive）：向 UI 提供「已隐藏但可恢复」的地点/标注列表。
- 地点列表、选中高亮、拖动 ghost、调试出口 `__atlasDebug.getSummary().places`、E2E 断言与文档截图。

### Fixed
- 渲染器按 id 合并 `layers.autoLabels` 与 `document.labels`，避免用户标签重复绘制。
- `hiddenIds` 现在同时压制生成条目与用户 pinned 条目，隐藏语义全局一致。
- 仓库工程化：MIT License、GitHub Actions CI（typecheck + tests + build）。

## v0.1.0 — 2026-10-18

- 首个可运行版本：真水文/气候世界生成管线、羊皮纸渲染器、浏览器交互编辑
  （海拔/河道/群系）、地点/标签自动生成、JSON/PNG 导出、Node 后端 4096/8192 大图渲染。
