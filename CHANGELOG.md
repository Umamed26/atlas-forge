# Changelog

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
