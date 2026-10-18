# Changelog

## v0.4.0 — 2026-10-19

主题：**让不懂参数的创作者 10 秒拿到一张能用的图，并且换不坏。**

### Added
- **场景预设首屏**：群岛贸易 / 干旱帝国 / 极地边疆 / 温带大陆，每张卡打包地形+风格+命名，点一下直接出图；首次访问引导，之后可从顶栏「场景」重开；真缩略图随仓库发布。
- **锁定重掷**：海岸 / 生态 / 河流 / 地名 / 风格 5 个锁，换一张只重掷未锁阶段（基于新增的分阶段子 seed），锁住的海岸逐像素不变；toast 明示保留项。
- **生成历史**：最近 10 次生成（缩略图/seed/场景/时间），一键回到上一张，恢复前自动保留当前世界。
- **换一批地名**：只重算命名阶段（~100–200ms），地形与河流不变。
- **人话滑杆**：结果语言说明、低/中/高 语义刻度、场景推荐刻度与「恢复推荐」；参数组显示「基于 X，已改 N 项」并可一键还原。
- **草稿预览**：拖动滑杆时节流（150ms）出 512² 草稿并显示角标，松手全量重算；生成可取消，失败保留上一张并可重试/快速模式。
- **可读性检查**：生成后检查陆地比例/河流/标签重叠与越界/城镇密度/对比度，非阻断横幅 + 一键修复。
- **下一步动作**：生成条显示「已生成：场景 · #seed」+ 换一张 / 微调 / 导出。
- **视觉回归基准**：8 条固定矩阵基准（场景预设 × seed）与 `qa:visual` 门禁，防「更好上手」把出图质量做退。

### Improved
- 分阶段子 seed（`WorldParams.stageSeeds`，可选）：无该字段时输出与 v0.3.0 逐字节一致（哈希常量回归测试）。
- biome 色调区分度提升（冰原/苔原/沙漠/雨林可辨，新增 `RenderStyle.biomeTint`），aged-ink 不再把冷色群系统一拉暖。
- 群岛预设重构为「真群岛」（多岛+海峡，连通陆地分量 ≥8）。

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
