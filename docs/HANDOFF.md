# 交接文档 · Atlas Forge

> 给接手这个仓库的开发者。目标不是复述功能，而是让你**今天能跑起来、这周能改东西、知道下一步该动哪里**。
>
> 仓库状态对应 `main@fab98a8`（提交 2026-10-19，tag `v0.7.0`）；文档编写 / 复核 2026-10-22。仓库里的数字会随版本漂移；本文给出的"实测基线"是当时在本机跑出来的值，你复现时如果有少量差异，以**当前命令输出**为准（见 §10-P3 的文档漂移说明）。

---

## 0. 60 秒版本

**这是什么**：Atlas Forge 是面向小说 / 世界观创作者的**程序化世界地图生成器**。种子 + 参数 → 地形 / 水文 / 气候 / 群系 / 人文管线 → 可编辑、可导出的羊皮纸世界地图。世界 JSON 是唯一真源，PNG / SVG 只是渲染产物。

**三种交付形态，共用同一套生成器与渲染器**：

1. **Web 编辑器**（`apps/web`，Vite + React 19 + Zustand + Canvas2D）：交互预览 1024²，大图导出走 Node 服务；
2. **Node 导出服务**（`apps/server`，Fastify + `@napi-rs/canvas`）：`POST /api/render`（512–8192 PNG）、`POST /api/export/svg`；
3. **Electron 桌面端**（`apps/desktop`，Electron 44.4.5）：完全离线生成 / 编辑 / 导出，原生文件与菜单，三平台**未签名**安装包由 CI 产出。

**当前状态一句话**：v0.7.0 已发布，`main` 与 `origin/main` 同步，CI（`CI` + `Desktop`）最近几轮全绿，各门禁最近一次运行均通过（报告时间不同，数字与证据来源见 §8）；**产品可交付使用，但离"长期可维护的商业产品"还差签名/公证、自动更新、浏览器 E2E 进 CI、mac/win 运行时冒烟**——这些在 §10 有优先级和验收标准。

**第一步**：

```bash
pnpm install
pnpm dev                      # Web http://127.0.0.1:5173 · API http://127.0.0.1:8787
pnpm typecheck && pnpm test   # 5 个包类型检查 + core 82 tests + render 4 个断言套件全绿
```

环境约定：Node 24（CI 固定 24；README 写 ≥20，但实际开发与 CI 都用 24）、pnpm 11（CI 固定 11）。仓库里**没有** `.nvmrc` / `.node-version`，版本靠 CI 与文档约定。

---

## 1. 接手路径（按时间排）

### 第 1 天：先跑通，建立"改完怎么验"的直觉

1. 按 §0 启动 `pnpm dev`，打开 5173，点「随机一张」能出图；状态栏右侧应显示服务端在线（`/api/health`）。
2. `pnpm typecheck` + `pnpm test` 全绿。
3. 跑一次 `pnpm qa:render`：产出 `out/qa-*.png`，打开看羊皮纸风格；这一步同时会跑视觉回归（4/4）。QA 产物都在 `out/`（已 gitignore）。
4. 想动桌面端再看 `docs/desktop.md`，桌面端有自己的 Electron 二进制前置条件（§9 第 1 条）。

### 第 2–3 天：按数据流读代码（推荐顺序，跟着数据走就不会乱）

1. `apps/web/src/App.tsx`（组合根）→ `apps/web/src/hooks/useAppPipeline.ts`（Worker 生命周期、防抖/节流、渲染、自动保存、错误兜底）；
2. `apps/web/src/generation/generationClient.ts` + `apps/web/src/worker/worldWorker.ts`（latest-wins 调度；typed array 用 transferable 回传）；
3. `packages/core/src/types.ts`（**唯一契约，先读它**）→ `packages/core/src/pipeline.ts`（阶段、缓存键、override 注入点）；
4. `packages/render/src/index.ts`（`renderWorld` 一次画完）→ `chrome.ts` / `decor.ts`（装饰布局）→ `svg.ts`（矢量导出）；
5. `apps/web/src/state/worldStore.ts`（很大，1637 行；按 action 名跳读：`commitDocument` / `updateParams` / `generation*` / `undo`）→ `apps/web/src/components/MapStage.tsx`（画布交互与命中）；
6. 需要桌面端时再进 `apps/desktop`（§7）。

### 第 1 周：认领一件待办，跑完它对应的门禁

从 §10 挑一件（建议先做 P1 的"浏览器 E2E 进 CI"或"签名"）。判定做完的标准不是"看起来对"，而是**对应门禁全绿 + 文档/基线/截图同步**，见 §8 的"什么算改完通过"。

### 这台机器的现状（只对这台开发机；换机器请重新按 §0 安装）

- 仓库已经 `pnpm install` 过；`out/` 有历史 QA 产物（gitignored）；`apps/desktop/dist/` 有本机打好的 `AtlasForge-0.7.0-linux-x86_64.AppImage`（约 141MB / 135MiB）、`linux-amd64.deb`、`linux-unpacked/`（均 gitignored）。
- `node_modules/.pnpm/electron@…/electron/dist` 是 symlink 到仓库外（`/home/uent26/noveleditor` 里的 Electron dist），`path.txt` 内容为 `electron`——见 §7 与 §9.1；换机器必须重新准备 Electron 二进制。
- Playwright Chromium 在 `~/.cache/ms-playwright/chromium-1243`（来自其它项目，不是本仓库装的）；`DISPLAY=:0`，`xvfb-run` 可用。
- 本机 `node` 是 `/usr/local/bin/node` v24.21.0；`pnpm` 实际走的是 WSL 下 Windows npm 全局 bin（`/mnt/c/.../npm/pnpm`）v11.21.0。与 CI 版本一致，但路径特殊，换 shell 时注意。
- 当前没有常驻 dev server；`pnpm dev` 会占用 5173（web）与 8787（api）。

---

## 2. 仓库地图：你会去哪里改东西

| 位置 | 职责 | 什么时候进来 | 注意 |
| --- | --- | --- | --- |
| `packages/core/src` | 纯 TS、无 DOM、无运行时依赖：RNG / 噪声 / 地形 / 板块 / 水文 / 气候 / 群系 / 人文 / override / 阶段缓存 / 场景预设 | 改算法、参数、数据契约 | `types.ts` 是跨端契约，改它要全链路同步；`terrain.ts` 里 legacy fBm 常量被黄金哈希锁定，不要"顺手优化" |
| `packages/render/src` | Canvas2D 渲染器（浏览器与 Node 共用）、PNG/SVG、命中测量、可读性 | 改视觉、装饰、标签排版、导出 | 视觉变更必须更新视觉基线（§5.1），否则 `qa:visual` / `qa:render` 红 |
| `apps/web/src` | 编辑器 UI、Worker、store、编辑交互、导出编排 | 改界面 / 交互 / 自动保存 / 导出流程 | 桌面分支必须是 `isDesktop()` 的浏览器 no-op 降级；改完浏览器 QA 仍要绿 |
| `apps/server/src` | Fastify 单文件（641 行）：`/api/health`、`/api/render`、`/api/export/svg` | 改大图导出、队列、内存策略 | 限 `MAX_BODY_BYTES=16MB`、`MAX_QUEUE=2`；默认渲染 4096，>4096 需 `ATLAS_ALLOW_LARGE=1` 或请求体 `allowLarge` |
| `apps/desktop` | Electron 壳、IPC、原生文件/菜单、离线导出、打包、桌面 E2E | 改原生能力 / 菜单 / IPC / 打包 | `shared/ipc.ts` 是 IPC 契约（字段名别改）；`electron-builder.yml` **不要**加 `publish:` 块 |
| `scripts` | Node / Playwright QA harness + 视觉判定库 | 加门禁、修 QA、复现失败 | `qa-desktop.mjs` 1705 行，改前先读文件头注释 |
| `examples` | 提交进仓库的成图 / 截图 / 示例世界 JSON | 换产品截图、加示例 | README 引用它们；别放临时产物 |
| `docs` | `desktop.md`（桌面端手册，375 行）+ 本文档 | 写文档 | 文档数字会漂移（§10 P3） |
| `.github/workflows` | `ci.yml`（类型/测试/构建/渲染/视觉/算法）+ `desktop.yml`（三平台打包 + Linux packaged QA） | 改验证覆盖 | `desktop-qa` 的 `needs: [package]` 与 job id 是契约 |

记忆锚点：**core 决定"地图对不对"，render 决定"地图好不好看"，web 决定"人能不能用"，desktop 决定"能不能交付"，scripts/CI 决定"改坏了会不会被发现"。**

---

## 3. 数据契约（先读 `packages/core/src/types.ts`）

- **唯一真源**：`WorldDocument`（持久化 JSON）。
  - `version: 1` 是文档格式版本；`algorithmVersion?: number` 是**生成算法**版本（缺省或 <2 = legacy 世界）。
  - `params` 生成参数；`style` 渲染风格（含 `style.decorations` 装饰树）；`overrides` 编辑；`settlements` / `labels` **只存用户新增/修改/钉住的条目**；`createdAt/updatedAt`。
  - 派生图层 `WorldLayers`（typed arrays）**永不持久化**，由 pipeline 生成、可 transfer、渲染器消费。
- **编辑 override 全部用归一化世界坐标 [0,1]**（`x, y, radius`；河道是折线点），在阶段边界注入，与网格分辨率解耦：
  - `elevation`: `{ value, mode: lock | raise | lower }`
  - `riverForce`: 归一化折线 + width（填洼前刻槽）
  - `biome`: 群系 stamp
  - `hiddenIds`: **hidden 优先**——同时压制生成条目与用户 pinned 条目；被过滤的条目进 `WorldLayers.hidden` 供 UI「恢复」列表使用。
- **装饰**：`style.decorations` 有 7 个稳定 id：`title / compass / scaleBar / legend / graticule / border / credits`，每项 `{ visible, anchor?, text?, subtitle? }`；`DEFAULT_DECORATIONS` 提供默认值，`resolveDecorations()` 做 item 级合并。canvas 与 SVG 共用 `computeChromeLayout`，隐藏元素零尺寸、不占位、SVG 不输出 `data-decor` 节点。旧文档的 `showCompass` 等布尔在 `document.ts` 归一化时迁移。
- **分阶段种子**：`params.stageSeeds?: { terrain?, hydrology?, climate?, human? }`。每阶段有效种子 = `stageSeeds.x ?? document.seed`；**未设置时输出与 v0.3.0 逐字节一致**（`test/stage-seeds.test.ts` 用黄金哈希锁定）。这是「锁海岸只换河流」的技术前提。
- **兼容性规则（重要）**：
  - 缺 `algorithmVersion`（或 <2）→ legacy：强制 fBm 地形 + v0.4 的气候/河网语义，导入旧世界必须逐字节还原原貌。
  - 新字段必须 **additive**（可选 + 缺省回退）；迁移逻辑集中在 `packages/core/src/document.ts`，不要散落到各层。
  - `terrainModel` 的口径要分清：**新建世界默认 fBm**（`defaults.ts` 的 `DEFAULT_PARAMS`，与 README / TODO 一致）；legacy 文档被强制 `fbm`；但 **v2+ 的导入文档若缺 `terrainModel`，`document.ts` 的 normalize 会补成 `plates`**（`pipeline.ts` 对现代文档也有 `plates` fallback）。这是 v0.5「plates 曾计划做默认、后来改回 fBm」留下的历史痕迹，v2+ 缺字段这条边缘路径**没有测试覆盖**；`types.ts` 注释说 plates 是 v0.5 default 已过时。动之前先确认产品意图，别只改注释。

---

## 4. 生成管线（`packages/core`）

**阶段顺序即依赖顺序，也是缓存边界**：`terrain → hydrology → climate → biome → human`；`render` 不缓存（只改风格时只重渲染）。

| 阶段 | 输入指纹（简化） | 主要工作 |
| --- | --- | --- |
| terrain | size + terrainSeed + 地形参数 + elevation/river override 哈希 + model | 大陆 fBm + domain warping + 径向衰减；ridged 山脉；热力 + 液滴 + stream-power 侵蚀；海岸 roughen（侵蚀之后）；板块模型 opt-in |
| hydrology | terrain 键 + seaLevel + riverDensity + hydrologySeed | priority-flood 填洼 → D8 → 汇流 → Strahler 级序 / 河宽 ∝ √flow / 三角洲 / 湖泊（面积上限 + 内陆盆地抬升）；强制河道刻槽 |
| climate | terrain 键 + 风 / 湿度 / 温度参数 + climateSeed | 纬度温度带 + 海拔递减 + 距海 BFS 大陆度 + 纬向风带 + 迎风升坡 / 背风雨影 |
| biome | climate 键 + biome override 哈希 | Whittaker 温度×降水查表 + 海滩 / 湿地 / 山地 / 雪线 |
| human | biome 键 + hydrology 键 + humanSeed + namingLanguage + 用户内容哈希 | 宜居度选址、城镇 / 港口、CJK / 拉丁命名、分级 autoLabels、hidden 过滤 |

**契约（改代码前必须遵守）**：

- 同 `(document, size)` → **逐字节一致**。生成路径里禁止 `Math.random` / `Date` / 环境相关输入；随机全部走 `rng.ts`。
- typed arrays 长度永远是 `size * size`；阶段缓存只存 pristine 数组，返回给调用方的是**拷贝**（Worker 会 transfer/detach，缓存不能被调用方破坏）。
- 缓存每阶段单条（`cache.ts` 的 `SingleStageCache`）；上限 `MAX_CACHED_CELLS` 定义在 `pipeline.ts`（4_194_304 格），超过（如 8192²）不缓存。
- 有测试 / 门禁的不变量：河从高到低、最终入海或入湖、无悬挂河（`hydrology.test.ts` + `qa:algo`）；单湖面积 ≤2%（`qa:algo`）；背风面显著更干、赤道暖 / 两极冷（`climate.test.ts`）。群系多样性门禁阈值是 **≥6**（`qa:algo`；本机 24 seed 观测 min 12；README 的「≥12」是验收口径，不是测试断言）；「雪线随纬度下降」是 `biome.ts` 的实现行为，当前**没有专项断言**。`pnpm qa:algo` 用 24 seed（`--full` 120 seed）查**分布**，不只看单张图；CI 只跑默认 24 seed，120 seed 全量是手动可选、仓库里没有落盘证据。

**加一个新参数的完整改动面**（照做即可）：

1. `types.ts` 的 `WorldParams`（可选字段 + 注释写清缺省语义）；
2. `defaults.ts` 的 `DEFAULT_PARAMS`；
3. `pipeline.ts` 对应的 `*Signature()`（决定缓存失效边界）+ 阶段实现；
4. 若影响 legacy 兼容，用 `modern` / `legacyDocument` 分支隔离，并在 `stage-seeds.test.ts` 加黄金哈希；
5. `apps/web/src/lib/constants.ts`（`PARAM_GROUPS` / `PARAM_READABILITY` / `DEFAULT_PARAM_VALUES`）与 `ParamPanel` 文案（低/中/高语义刻度、场景推荐值）；
6. 测试：core 单测 / 不变量；必要时调 `qa:algo` 阈值并写明理由。

**性能现状（本机 1024²）**：README 历史实测冷启 0.35–0.85s、缓存命中 15–25ms、只改下游参数 200–280ms；本次 HEAD 实测 `qa:render` sim 513–615ms、1024 渲染 120–150ms、4096 导出 4.4s，`qa:algo` 24 seed@512² p50 183ms / p95 243ms（预算 900ms）。性能断言在 CI 上放宽过（`assessWorldMetrics < 15ms`），别把共享 runner 的波动当回归。

---

## 5. 渲染（`packages/render`）

- **一套实现两端跑**：传入浏览器 `CanvasRenderingContext2D` 或 `@napi-rs/canvas` 的 context，统一 `Ctx2D` 接口；`renderWorld()` 是纯函数（无随机 / 时间 / DOM），两端共用同一份渲染代码与几何提取，结构与观感一致。**没有做跨端逐像素断言**（字体 / 抗锯齿可能有差异，视觉门禁本身用容差判定，见 §5.1）。
- 绘制顺序：raster（地形 / 纸纹 / 做旧）→ 山形 / 森林符号 → 海 / 海岸线 / 湖泊 → 河流 → 装饰底层（经纬网）→ 标签 / 城镇 → 装饰顶层 / 边框 / 图例。
- 质量档：< 2048 默认 `preview`，≥ 2048 用 `export`；内部会限制采样 grid（preview 384 / export 2048 等）。这是性能关键，别随手提高。
- **命中测试同源**：`measureMapContent` 与绘制共用 label 布局（bbox + drawOrder），Web 端 ~0.7ms@1024；渲染器不可用时 UI 回退 marker 距离（`debug.hitBoxesSource` 可观测）。
- **可读性**：`assessMapReadability`（生成后算一次）检查陆地比例 / 河流 / 标签重叠越界 / 城镇密度 / 对比度；UI 是非阻断横幅。`readability.test.ts` 实测约 0.5–1.3ms（旧 README 的 5–6ms 是端到端口径）。
- **SVG**：`renderSvg()` 输出分层矢量（海岸线 / 河流按级序变宽 / 湖泊 / 群系 / 文字 / 装饰），支持 A3@300dpi；隐藏装饰不输出 `data-decor` 节点；文字仍是 `<text>`（印刷前建议转曲，见 §10-P2）。
- **版本**：`RENDERER_VERSION`（`version.ts`）当前 **1.3.0**；视觉契约变化要 bump 并同步基线。

### 5.1 改视觉时怎么做（防止误红 / 漏红）

1. 改渲染代码，跑 `pnpm qa:render`：出图 + 视觉判定；**先看图**，再决定是不是有意变更。
2. 有意变更：`pnpm qa:visual -- --update`（= `tsx scripts/visual-compare.ts --update`）重建 `packages/render/test/baselines`，把基线 PNG + `manifest.json` 一起提交；`pnpm qa:baseline` 只重建基线。
3. 视觉判定是**容差判定**（单通道 Δ>16 的结构差异 ≤0.15%，64×64 均值 Δ≤3；sha256 只作诊断），原因：CI Ubuntu 的字体抗锯齿与本地不同。不要因为 sha 不一致就判失败。
4. 基线用**固定合成地形 fixture**（`packages/render/test/fixtures/visualFixture.ts`），与真实管线解耦——算法升级**不应**触发基线更新。若改算法却导致视觉基线红，先检查是不是误动了 fixture 或渲染器。

---

## 6. Web 应用（`apps/web`）

- **状态**：`worldStore`（文档、undo/redo、生成/渲染状态、自动保存、地点、场景/锁定、生成历史）；`viewStore`（相机 zoom/pan、hover/选区等视图态，**不进文档**）。
- **数据流**：`document` → `GenerationClient`（latest-wins：一次只跑一个，旧 seq 丢弃）→ `worldWorker`（`createPipeline` 并保留实例以命中缓存）→ `WorldLayers` → `renderMapToCanvas` → canvas。预览是 1024 离屏渲染后缩放，极端放大略软；大图导出才清晰。
- **何时重算 / 重绘**：
  - 改参数 → `simTick`：草稿 512² 用**节流** 150ms（拖动中必须持续出图），正式重算用防抖 120ms；
  - 只改风格 / 装饰 → `renderTick`：40ms 防抖，**不重新生成世界**；
  - 导入世界 → `pipelineResetTick`：清 worker 里的阶段缓存。
- **撤销模型**：一次用户动作一条历史（`HISTORY_CAP=50`）；拖拽等连续交互用 `beginInteraction` / `endInteraction` 合并；选区 / hover / 自动保存 / 导出**不产生**历史。改这个语义会打爆 `qa-ui` 的撤销断言。
- **自动保存**：localStorage 主 / 备双槽（`atlas_forge.world.v1` + `atlas_forge.world.backup.v1`），损坏时出恢复面板；写入前校验，坏 JSON 不替换当前世界。
- **导出**：浏览器本地 1024 / 2048（Web Worker + OffscreenCanvas，不支持时回退主线程）；4096 / 8192 走 `/api/render`（8192 显式 opt-in + 内存预检）；SVG 优先本地，失败回退 `/api/export/svg`；桌面端全部走 IPC（§7）。导出有进度、可取消（取消服务端导出会产生一次预期的 `net::ERR_ABORTED`）。
- **`window.__atlasDebug`**：dev 与桌面构建暴露只读 QA 面（`getDocument` / `getSummary` / `quickGenerate` / `regenerate` 等），浏览器生产包不暴露。**QA 依赖它**；要移除先改 QA 并接受若干断言变 skipped。
- **i18n**：UI 文案中文，代码 / 注释英文；地名支持 CJK / 拉丁两套命名（这是地名文化，不是 UI i18n）。

---

## 7. 桌面端（`apps/desktop`）

> 详细手册在 [`docs/desktop.md`](./desktop.md)：安装、运行、打包、未签名说明、离线边界、QA 环境变量表、故障排查表。这里只给接手要点。

- **不是另一个应用**：同一个 `apps/web` 渲染层装进 Electron；主进程额外提供文件 / 菜单 / 最近文件 / 离线导出。共用 `packages/core` + `packages/render`，同一份 JSON 两端结构与观感一致（未做逐像素断言，见 §5）。
- **开发运行**：`pnpm desktop:dev` **不会**帮你起 Vite dev server——先 `pnpm dev:web`（或 `pnpm dev`），再另开终端跑 `pnpm desktop:dev`；否则脚本会等 5173 直到默认 60s 超时（`ATLAS_DESKTOP_DEV_TIMEOUT_MS` 可调）。
- **加载方式**：生产用特权 `app://atlas/` 协议（`protocol.registerSchemesAsPrivileged` + `protocol.handle`），因为 `file://` 下 ESM / module worker / localStorage / CSP 都不正常；dev 仍加载 Vite dev server。
- **安全基线**：`contextIsolation: true` + `sandbox: true` + `nodeIntegration: false` + `app.enableSandbox()`；preload 是单文件 CJS（sandbox 下 require polyfill 只提供 electron/events/timers/url，不能加载兄弟模块）；IPC 白名单；导航白名单；新窗口走 `openExternal`；权限请求默认拒绝；CSP 同时写在响应头与构建期 meta（`style-src` 含 `'unsafe-inline'`，React 内联样式需要，属已知让步）。
- **发布面注意**：桌面生产构建仍会安装只读 `window.__atlasDebug`，并在设置 `ATLAS_TEST_EXPORT_DIR` 时跳过保存对话框直接落盘（测试钩子）。docs/desktop.md §5.6–5.7 已说明如何移除及对 QA 的影响；安全评审要求更严时再做发布清理。
- **IPC 契约**：`apps/desktop/shared/ipc.ts` 是唯一真源（`window.atlasDesktop` 全部方法 + channel 常量）。加一个 IPC 的完整改动面：`ipc.ts` → `src/preload/index.ts` 暴露 → `src/main/index.ts` handler → `apps/web/src/lib/desktopBridge.ts` → `useDesktopIntegration` → `qa-desktop` 断言 + 文档。**字段名 / 事件名是契约，不要重命名。**
- **离线导出**：主进程用 `@napi-rs/canvas` + core/render 现场生成 1024–8192 PNG 与 SVG，**不依赖 Node API**；有串行锁、8192 内存保护、canvas 释放。`ATLAS_TEST_EXPORT_DIR` 是测试钩子（设置后跳过保存对话框，仅 QA 设置）。
- **构建与打包**：`pnpm desktop:build`（= `node scripts/build.mjs`）只产出 `dist/main`、`dist/preload` 与 `dist/renderer`，**不调用 electron-builder**；安装包由 `pnpm desktop:pack`（`electron-builder --dir`，产出 `linux-unpacked/`）或 `pnpm desktop:dist`（`electron-builder --publish never`，只出当前平台安装包）生成，三平台产物由 CI matrix 产出。`electron-builder.yml`：asar、`asarUnpack` 原生模块、`npmRebuild: false`、三平台 target、**未签名**。**不要加 `publish:` 配置块**：electron-builder ≥26 会把 `never` 当 provider 名报错，禁用发布靠 CLI `--publish never`。
- **Electron 版本固定 44.4.5**：`electron-builder.yml` 的 `electronVersion` 与 `apps/desktop/package.json` 必须同步改；升级后跑 `qa:desktop`（`getAppInfo` 会打印实际版本）。
- **本机环境 workaround（不要提交）**：本机从 GitHub 下载 Electron 很慢，`node_modules/.pnpm/electron@44.4.5…/electron/dist` 被 symlink 到本机另一个项目的 Electron dist，`path.txt` 内容为 `electron`（Electron 44 的 index.js 会拼成 `dist/electron`）。这是**本机缓存方案**，CI 有网络会正常下载；**不要把路径或 `--config.electronDist` 写进仓库**（打包卡下载时可临时在命令行加）。

---

## 8. 验证矩阵：改完什么该跑什么

| 命令 | 覆盖 | 前置 | 本机耗时 | 在 CI？ |
| --- | --- | --- | --- | --- |
| `pnpm typecheck` | 5 个 workspace 包的 TS strict | — | ~20s | ✅ `ci.yml` |
| `pnpm test` | core 82 tests（13 files）+ render 4 个 tsx 套件（共 49 条通过输出） | — | ~35s | ✅ `ci.yml` |
| `pnpm build` | `pnpm -r build`：构建 apps/web（tsc + vite）与 apps/desktop（esbuild main/preload + renderer 拷贝）；**不含安装包**（安装包用 `desktop:pack` / `desktop:dist`） | — | ~20s | `ci.yml` 只 build web；`desktop.yml` 另 build desktop |
| `pnpm qa:render` | Node 出 1024×3 + aged-ink + 4096 PNG + SVG；**含视觉回归** | Node canvas | ~15s | ✅ `ci.yml` |
| `pnpm qa:visual` | 4 条 fixture 视觉基线（容差判定；只打印结果，不落盘） | 基线已提交 | ~2s | ✅ `ci.yml` |
| `pnpm qa:algo` | 24 seed 分布门禁 9 项（`--full` = 120 seed @1024²，手动全量） | — | 24 seed ~11s；`--full` 数分钟 | ✅ `ci.yml`（默认 24） |
| `pnpm qa:browser` | Playwright 浏览器 E2E：生成/调参/笔画/地点/命中/导入失败/存档恢复/导出，截图 + report | Playwright Chromium；自动起 `pnpm dev`（可 `--no-server`） | ~1min | ❌ 仅本地 |
| `node apps/web/scripts/qa-ui.mjs` | 243 项 UI 交互断言（撤销一致性 / 快捷键单一来源 / a11y / 窄屏 / 桌面 stub / 导出） | **dev server 需先运行**（脚本不会自动起）；Playwright Chromium（脚本里硬编码 `chromium-1243`） | ~2–3min | ❌ 仅本地 |
| `node scripts/qa-gen-ux.mjs` | 20 项生成体验（首屏 / 锁定重掷 / 历史 / 草稿 / 可读性） | 自动起 dev（`--no-server` 可关） | ~1min | ❌ 仅本地 |
| `pnpm qa:decor` | 14 项装饰 E2E（开关 / 换位 / 改文案 / 全关 / 撤销 / SVG 节点） | 自动起 dev | ~40s | ❌ 仅本地 |
| `pnpm qa:desktop` | 15 项打包产物 E2E（窗口 / bridge / 生成 / 装饰 / 4096 PNG / 断网 / console） | 打包产物（或 electron + 源码兜底）；无 GUI 用 `xvfb-run -a` | ~19s + 打包 | ✅ `desktop.yml`（Linux AppImage） |
| `pnpm -C apps/desktop run pack` / `run dist` | 未打包目录 / 当前平台安装包 | Electron 二进制可用 | 1–3min | ✅ `desktop.yml`（三平台 matrix） |

**跑之前的前置**：浏览器 QA（`qa:browser` / `qa-ui` / `qa-gen-ux` / `qa-decor`）需要本地有 Playwright Chromium——仓库只装了 `playwright-core`，**不包含浏览器**，也没有安装脚本；脚本会去 `~/.cache/ms-playwright` 找，找不到可用 `CHROME_PATH` 指向本机 Chrome/Chromium。新机器上先准备与 `playwright-core` 1.64.x 匹配的 Chromium（`chromium-1243`），或用 `CHROME_PATH` 覆盖；`qa-ui` 里硬编码了 `chromium-1243`，换环境可能要改脚本。

**CI 触发注意**：`desktop.yml` 的 PR `paths` 是 `apps/desktop/**`、`apps/web/**`、`packages/**`、根依赖配置与 workflow 自身（**不含根 `scripts/**` 与 `apps/server/**`**）；tag push 只触发 `Desktop`，不会跑 `ci.yml` 的 typecheck / test。改 QA harness 要手动验证；打 tag 前先确认 main CI 绿。

**证据位置**：本节所有"实测"数字来自命令输出与 `out/*/report.json`，而 `out/` 被 `.gitignore` 忽略——fresh clone 无法核对，需要自己重跑。CI 只在 `Desktop` workflow 上传 `out/desktop-qa` 的报告与截图；`qa:render` 的图、浏览器 QA 的 report 都不上传。

**当前 HEAD 的实测基线（HEAD 提交 2026-10-19；本机复核 2026-10-22）**：

- `pnpm typecheck` 5/5；`pnpm test` core 82/82 + render 套件全绿；
- `qa:render`：3 张 1024 预览 + aged-ink + 4096（4.4s / 25.9MB，25,260 KB）+ SVG；视觉回归 4/4（基线 `manifest.json` 已提交；4/4 结果只打印、无落盘报告）；1024 渲染约 120–150ms；
- `qa:algo` 9/9（24 seeds @512²，10.5s）：陆地 p10–p90 = 36.6–45.1%、海岸盒维数 min 1.16 / p50 1.21、悬挂河 0.00%、最大级序 ≥5、最大湖 0.59% 地图、群系 ≥12、p50 183ms / p95 243ms；
- 浏览器与桌面（最近一次记录，`out/*/report.json`）：`qa-ui` 243/243、`qa-gen-ux` 20/20、`qa-decor` 14/14、`qa-desktop` 15/15（打包 AppImage）、`qa-browser` 0 console/page/failed-request；
- CI：`CI` 与 `Desktop` 最近运行 success（`gh run list` 可查）。`CI` 跑 typecheck / tests / build web / qa:render / qa:visual / qa:algo；`Desktop` 跑三平台打包 + Linux packaged QA（mac/win 只构建、未启动）。
- 更早的数字（README / TODO.md 里的 141、200、227、120 seed、render 30 行断言等）是历史版本记录，不一致不代表回归；以当前命令输出为准。

**什么算"改完通过"**：

- 任何改动：`pnpm typecheck` + `pnpm test` 绿，CI 绿；
- 算法改动：+ `pnpm qa:algo --full`（120 seed）不弱化分布阈值，legacy 黄金哈希不变；
- 视觉改动：+ 有意更新基线并提交，`qa:render` / `qa:visual` 绿；
- UI / 交互改动：+ 对应浏览器 QA（`qa-ui` / `qa-browser` / `qa-gen-ux` / `qa-decor` 里至少相关那套）绿，无新 console / page error；
- 桌面改动：+ `pnpm qa:desktop`（驱动打包产物）绿，离线断言不 skipped（可用 `ATLAS_QA_STRICT=1` 把 skipped 也算失败）；
- 契约 / 打包 / CI 改动：+ 更新文档与（必要时）CHANGELOG，不要用"本地能跑"替代。

---

## 9. 已知坑与故障排查

1. **Electron 二进制缺失**：`pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 只放行 `esbuild`，Electron 的 postinstall 不会自动跑。补齐：`node node_modules/electron/install.js`（或 `pnpm rebuild electron`）。`path.txt` 必须存在且内容为 `electron`（Electron 44 拼 `dist/`）；**不要只建 path.txt 而不解压 dist**。
2. **打包卡在下载 Electron**：本机网络问题；可临时 `--config.electronDist=<本地 electron/dist>` 复用已解压的 dist（不要提交）；CI 有网络，别加。
3. **桌面白屏 / `app://atlas/api/health` 404 / 资源 404**：先确认 `pnpm -C apps/web build` + `pnpm -C apps/desktop build` 都成功；web 端资源必须用相对 base（`vite.config.ts` 的 `base: "./"`、`publicAssetUrl` 等），桌面构建不该发 `/api/*`（`isDesktop()` 短路）。
4. **`pnpm -C apps/desktop pack` 打成 tgz**：`pack` 是 pnpm 内置命令；要写 `pnpm -C apps/desktop run pack`。
5. **electron-builder 报 "Cannot find module for publisher never"**：不要写 `publish: never` 配置；用 CLI `--publish never`。
6. **桌面 SVG 导出报"渲染器没有返回有效的 SVG 文本"**：`renderSvg()` 输出以 `<?xml…?>` 开头，主进程写盘前要剥 prolog 或放宽校验（v0.7 已修，回归时先查这里）。
7. **`qa-ui` 全挂**：它**不会自动起 dev server**，先 `pnpm dev`（或 `pnpm dev:web`）；Chromium 取 `~/.cache/ms-playwright/chromium-1243`，可用 `CHROME_PATH` 覆盖。
8. **无 GUI / 沙箱报错**：`xvfb-run -a`；Chromium 沙箱失败用 `ATLAS_QA_NO_SANDBOX=1 ELECTRON_DISABLE_SANDBOX=1`（仅 QA / CI；**发布版保持 sandbox**）。
9. **视觉回归 CI 红、本地绿**：字体 / 抗锯齿差异；判定是容差判定，只有真实结构变化才该红；基线是 latin-only（不要往基线里加 CJK，除非所有 CI runner 都装了字体）。
10. **性能断言偶发红**：共享 runner 波动；已有先例放宽阈值（metrics < 15ms、首屏硬上限 10s）。调整要写理由，不要静默改。
11. **取消服务端导出出现 `net::ERR_ABORTED`**：预期行为，不是 bug。
12. **单实例锁冲突**：并行跑多个桌面 / QA 实例会互抢（单实例锁按 userData 判定）；QA 默认隔离 `ATLAS_QA_USER_DATA`，手工并行要显式设 `ATLAS_DESKTOP_USER_DATA_DIR`。
13. **`pnpm desktop:dev` 等 5173 超时**：它不自带 Vite dev server；先 `pnpm dev:web`（见 §7）。
14. **浏览器 QA 启动即报"找不到浏览器"**：仓库只装了 `playwright-core`，浏览器要自己准备（`~/.cache/ms-playwright` 或 `CHROME_PATH`，见 §8 前置）。

---

## 10. 未完成事项与建议优先级

> 按"会不会伤到已发布用户 > 会不会拖慢后续开发 > 新功能"排序。每项都写了验收标准，避免"做完不知道算不算完"。

### P1（发布可用性 / 质量保障，建议优先）

1. **代码签名、公证与自动更新**：现状未签名（macOS 需 `xattr -dr com.apple.quarantine`，Windows 会弹 SmartScreen）。做法：准备 Apple Developer ID + notarization、Windows Authenticode；`electron-builder.yml` 配 `mac.identity` / `win.certificateFile`；再决定 autoUpdater（electron-updater + 发布渠道）。验收：三平台安装包按 OS 标准流程可打开，CI 增加签名校验，文档更新。
2. **把浏览器 E2E 纳入 CI**：`qa-ui` / `qa-browser` / `qa-gen-ux` / `qa-decor` 目前只手工跑，UI 回归靠人；且 CI 没有 Playwright 浏览器安装步骤（仓库只有 `playwright-core`，`qa-ui` 还硬编码 `chromium-1243`）。做法：CI job 准备 Chromium、起 `pnpm dev` 跑这四套；把浏览器路径改成可配置；注意 runner 无 CJK 字体 / GPU 的差异，失败要有 report + 截图 artifact 可定位。验收：PR 上这些 job 必过或显式 allowlist。
3. **macOS / Windows 运行时冒烟**：现在 CI 只打包（+ Linux 跑 QA），mac/win 产物**从未真正启动过**。做法：在 `desktop.yml` 的 matrix 各加启动冒烟（boot + 首图 + 一次导出；`--print-target` 不算），或建立定期手动 checklist。验收：三平台等价断言绿（可缩小子集）。
4. **服务端 API 自动化测试**：`/api/render`、`/api/export/svg` 目前没有任何单测 / 集成测试，只被浏览器 E2E 间接覆盖（且不在 CI）。做法：用 `fastify.inject` 覆盖参数校验、尺寸边界（512 / 4096 / 8192 + `allowLarge`）、错误码、队列与内存预检；SVG 断言 `<svg>` / `data-decor`。验收：新增独立测试脚本并进 CI，PR 必过。

### P2（产品完成度）

5. **SVG 印刷就绪**：文字仍是 `<text>`，没有字体子集化 / 转曲。做法：字体子集 + `text` → path（或提供转曲脚本 / 文档）；可补 PDF 输出。验收：无字体环境打开不变形；体积可控；文档声明。
6. **板块地形（plates）决策**：实验性、默认关闭、细节不及 fBm。要么继续投入（海岸线 / 山带细节 + 与 fBm 的可比指标），要么正式标注"不推荐"并从 UI 移除入口，减少维护面。验收：`qa:algo` 对 plates 也跑分布门禁（目前只跑默认 fBm）；UI / 文档一致。
7. **8192 导出硬化**：低内存压测、可取消 / 进度、失败提示。现状：8192 显式 opt-in + 内存预检；桌面主进程串行、不可取消（峰值约 270MB）。验收：8GB 内存机器可完成或给出明确拒绝；取消不泄漏。
8. **最近文件刷新与菜单细节**：桌面最近文件没有 push 刷新；mac 的 Cmd 语义未在 mac 实测。验收：文件被外部删除 / 移动后列表自愈；三平台菜单冒烟。
9. **发布面清理（可选）**：桌面生产构建仍暴露只读 `window.__atlasDebug`，且 `ATLAS_TEST_EXPORT_DIR` 测试钩子留在发布代码里；CSP `style-src` 含 `'unsafe-inline'`（React 内联样式需要）。docs/desktop.md §5.6–5.7 已说明清理方式与对 QA 的影响。验收：按安全评审要求移除后，`qa-desktop` 相应断言改为 skipped 或替换为 UI 驱动版本，并在发布说明记录。

### P3（明确非目标，除非产品转向）

10. 多尺度下钻（世界→大陆→区域）、球面投影、账号 / 云同步 / 分享链接；TRPG hex / VTT 导出（只留接口）；移动端 / 触控（桌面优先 ≥1024）。
11. 装饰自由拖拽（当前四角 / 上中 / 下中预设，用户未要求）；Firefox / Safari 适配（只在 Chromium 实测）。
12. **文档漂移清理**（低成本，建议顺手做）：README / TODO.md 里 qa-ui 断言数有 141 / 200 / 227 / 243 等历史数字，README 还写 render「30 行断言」（当前是 49 条通过输出）；CHANGELOG 写 qa-desktop「14 项」（实际 15）；`types.ts` 与 `terrain.ts` 的 terrainModel 注释和 `defaults.ts` 实际默认冲突；`docs/desktop.md` 仍写 `publish: never`，且 Electron 二进制一处说 postinstall 提供、另一处说 postinstall 被跳过；`apps/desktop/scripts/dev.mjs` 头部注释写 `file://`（实际是 `app://`）；README 把 `desktop:dist` 写成"三平台"（实际只出宿主平台），又把 `desktop:dev` 写成自带 Vite dev server（实际要先起 web）；README 的 Node ≥20 / pnpm ≥9 与 CI 的 Node 24 / pnpm 11 口径不一；TODO.md 引用的 `examples/welcome-scenarios.png` 实际是 `.jpg`。统一口径为"以代码 / 命令输出为准"，或直接修掉。

---

## 11. 关键决策与取舍（为什么这么定，哪里还留有余地）

| 决策 | 理由 | 还有余地吗 |
| --- | --- | --- |
| 世界 JSON 唯一真源，派生层不持久化 | 导入 / 导出 / 自动保存 / 撤销都围绕一份文档，避免"图和文档不一致" | 基本不可逆；新增派生字段必须可重算 |
| override 用归一化世界坐标 stamp | 与网格分辨率解耦；重生成 / 换 seed 再换回不丢编辑 | 区域级编辑需扩展契约（additive） |
| 分层管线 + 单条阶段缓存 | 改下游只算下游，参数拖动可交互 | 缓存策略可调（多文档 / 多尺寸场景） |
| 一套渲染器跑浏览器与 Node（Canvas2D 抽象） | 避免两端漂移；预览 / 导出 / 桌面同源 | 若换 WebGPU / 原生 SVG 渲染，需要新抽象层 |
| 大图导出放 Node 服务（后来桌面主进程也做） | 浏览器内存 / 耗时限制；4096 / 8192 必须离屏 | 桌面已可完全离线；服务端仍对 Web 有价值 |
| 默认 fBm 地形，plates 实验性 | v0.5 的 plates 视觉细节不如 fBm，按"不把退化当升级"保留 fbm 默认 | 可继续投入 plates，或移除（§10-P2） |
| legacy 文档逐字节兼容 | 用户导入旧世界必须看到原图 | 黄金哈希锁定；改算法要显式版本升级 |
| stageSeeds additive | 锁定重掷（只换河流 / 地名）的前提，且不破坏旧输出 | 可扩展到更多阶段 |
| 装饰树（7 个稳定 id + 四角锚点） | canvas / SVG / 印刷同源；关闭不留位 | 可加自由拖拽 / 更多元素（当前用户没要求） |
| Electron 用 `app://` 而非 `file://` | file:// 下 ESM / module worker / CSP 不可用 | 若换 Tauri 等壳，加载与 IPC 要重做 |
| 未签名 + CI 产物 | 没有证书；先把可安装产物跑通 | 签名 / 公证 / 自动更新是明确的下一步 |
| 桌面优先、不承诺移动 / 触控 | 用户与场景（创作者桌面工作流） | 产品若转向平板需重做交互 |

---

## 12. 历史与文档考古（写代码前先知道"为什么"）

- **提交历史**：截至 v0.7.0 tag（`fab98a8`）共 17 个提交，线性 `main`；tag 从 `v0.2.0` 到 `v0.7.0`（含 `v0.4.1` 跨环境修复）。`CHANGELOG.md` 有 v0.1.0 起的全部版本；GitHub Releases 从 v0.3.0 起。
- **`TODO.md` 不是待办列表**（名字有误导）：§1 是用户已确认决策，§12–18 是 v0.1–v0.7 的**验收记录 / 已知限制**。真正的待办在本文 §10 或 GitHub issue；接手后建议把 §10 转成 issue，别继续往 TODO.md 堆。
- **`CHANGELOG.md`**：面向用户的 Added / Changed / Fixed，发版时更新；只写用户能感知的，实现细节留在 commit / 文档。
- **`README.md`**：功能面 + 快速开始 + 验证命令 + 已知限制，是"产品说明书"；其中验证数字会随版本漂移（§10-P3）。
- **`docs/desktop.md`**：桌面端唯一手册（含 QA 环境变量表与排障表），改桌面端先读它。
- **`examples/`**：产品截图 / 示例世界 JSON / 成图；README 引用它们，换截图要同步 alt 文案。成图/截图的生成器**不在仓库**（曾在 gitignored 的 `out/make-examples.ts`）；要复现或更新 README 图，需重写一个生成脚本。
- **调试遗留**：仓库里有若干 tracked 的探针脚本（`packages/core/test/_modernprobe.ts` / `_plateprobe.ts` / `_quality.ts`、`packages/render/test/dev-large.ts` / `dev-real.ts` / `dev-shot.ts` / `make-requests.ts`、`scripts/_svg-test.ts`、`scripts/visual-selftest.ts`）。它们没有 root alias、不进 CI，不属于门禁；清理前先确认没人引用。
- **AI 协作痕迹**：这个项目由「Lead + 子 agent（core / render / ui / desktop）」并行开发，`team_task_*` 任务板与审阅记录**不在仓库里**；本文档是唯一沉淀。若你继续用 AI agent：本环境的顾问 `consult_task` 曾多次返回空输出（advisor-empty-output，属本环境观察、不是仓库事实）；遇到空输出**不要把它当验收证据**，换人或直接自己验证。

---

## 13. 归属与联系

- 仓库：<https://github.com/Umamed26/atlas-forge>（public，`main`；本地 `gh` CLI 已认证为 Umamed26）
- 许可：MIT（`LICENSE`）。字体 EB Garamond 为 SIL OFL（见 README「字体与许可」；文件在 `packages/render/assets/fonts/` 与 `apps/web/public/fonts/`）
- 关键第三方依赖：Electron 44.4.5、`@napi-rs/canvas`、Fastify 5、React 19、Zustand、Vite 6、Playwright（core）、vitest、tsx
- 发布：GitHub Releases（v0.3.0–v0.7.0）；桌面安装包在 Actions artifact（`atlas-forge-desktop-<os>`，保留 14 天）
- 维护者信息：README 未写邮箱；需要决策时在 issue 里留档，别只靠口头 / AI 对话

---

## 附录 A：关键文件速查

| 区域 | 文件 | 一句话 |
| --- | --- | --- |
| core | `types.ts` | 全部数据契约（文档 / 图层 / 管线 / 装饰 / 导出常量） |
| core | `defaults.ts` | 默认参数 / 风格 / 装饰 / 新世界工厂 |
| core | `pipeline.ts` | 阶段编排、缓存指纹、legacy 判定、override 注入 |
| core | `terrain.ts` / `plates.ts` | fBm / 板块地形、侵蚀、海岸细节、校准 |
| core | `hydrology.ts` | priority-flood 填洼、D8、河流阈值、Strahler、湖泊、三角洲 |
| core | `climate.ts` / `biome.ts` / `human.ts` | 因果气候 / Whittaker 群系 / 城镇与命名 |
| core | `overrides.ts` / `document.ts` / `cache.ts` / `rng.ts` | 编辑注入 + 哈希 / 归一化与迁移 / 单条缓存 / 确定性 RNG |
| core | `presets.ts` / `metrics.ts` | 4 个场景预设 / 算法质量指标 |
| render | `index.ts` | `renderWorld` 主体与公开导出 |
| render | `chrome.ts` / `decor.ts` | 共享装饰布局（canvas + SVG）/ 装饰绘制 |
| render | `svg.ts` | `renderSvg`，分层矢量 + `data-decor` |
| render | `labels.ts` / `measure.ts` | 标签排版与避让 / 渲染器同源命中框 |
| render | `raster.ts` / `coast.ts` / `hydro.ts` / `mountains.ts` / `forests.ts` | 像素光栅 / 海岸 / 河流 / 山形 / 森林符号 |
| render | `style.ts` / `fonts.ts` / `node-fonts.ts` / `readability.ts` / `version.ts` | 主题与质量档 / 浏览器字体 / Node 字体 / 可读性 / 渲染器版本 |
| web | `App.tsx` / `hooks/useAppPipeline.ts` | 组合根 / Worker 生命周期与调度 |
| web | `generation/generationClient.ts` / `worker/worldWorker.ts` / `worker/exportWorker.ts` | latest-wins 客户端 / 生成 worker / 本地导出 worker |
| web | `state/worldStore.ts` / `state/viewStore.ts` | 文档与历史、生成状态 / 相机与视图态 |
| web | `components/MapStage.tsx` / `components/TopBar.tsx` / `components/ExportDialog.tsx` | 画布交互 / 顶栏与桌面按钮 / 导出弹窗 |
| web | `lib/documentIO.ts` / `lib/exportPng.ts` / `lib/exportSvg.ts` / `lib/desktopBridge.ts` | 导入导出与自动存档 / PNG / SVG / 桌面桥 |
| web | `lib/placeHitTest.ts` / `lib/places.ts` / `lib/worldAlgorithm.ts` / `lib/debug.ts` | 命中 / 地点合并 / 算法徽标与升级 / QA debug API |
| server | `src/index.ts` | Fastify：校验、队列、内存预检、PNG/SVG、health |
| desktop | `shared/ipc.ts` | IPC 契约（唯一真源） |
| desktop | `src/main/`（`index` / `files` / `menu` / `recent` / `exports`） | 窗口与安全 / 文件 / 菜单 / 最近文件 / 离线导出 |
| desktop | `src/preload/index.ts` / `scripts/{build,copy-assets,dev}.mjs` / `electron-builder.yml` | 桥 / 构建与打包 / 打包配置 |
| scripts | `qa-render.ts` / `qa-algo.ts` / `qa-browser.mjs` / `qa-gen-ux.mjs` / `qa-decor.mjs` / `qa-desktop.mjs` / `visual-*.ts` | 各自头注释就是用法说明 |
| docs | `docs/desktop.md` / `docs/HANDOFF.md` | 桌面端手册 / 本文档 |

## 附录 B：环境变量速查

| 变量 | 用在哪 | 作用 |
| --- | --- | --- |
| `WEB_URL` / `API_URL` | 浏览器 QA | dev server / API 地址，默认 5173 / 8787 |
| `CHROME_PATH` | 浏览器 QA | 覆盖 Playwright Chromium 可执行文件 |
| `PORT` / `HOST` | `apps/server` | 默认 8787 / 127.0.0.1 |
| `ATLAS_ALLOW_LARGE=1` | `apps/server` | 允许 8192² 渲染（默认关闭） |
| `ATLAS_SIM_MAX` | `apps/server` | 服务端模拟网格上限（默认 2048） |
| `ATLAS_RENDER_TIMEOUT_MS` | `apps/server` | 单次渲染超时（默认 0 = 不限） |
| `ATLAS_DESKTOP_DEV=1` | 桌面主进程 | 强制 dev 模式（仅未打包时生效；`scripts/dev.mjs` 自动设置） |
| `ATLAS_WEB_URL` | dev 脚本 | Vite dev server 地址（默认 5173） |
| `ATLAS_DESKTOP_NO_SANDBOX=1` | `scripts/dev.mjs` | 本地 / WSL 以 `--no-sandbox` 启动 |
| `ELECTRON_OVERRIDE_DIST_PATH` | dev / QA | 复用本机已解压的 Electron dist |
| `ATLAS_TEST_EXPORT_DIR` / `ATLAS_QA_USER_DATA` / `ATLAS_DESKTOP_USER_DATA_DIR` | 桌面测试钩子 / 主进程 | 跳过保存对话框 / 隔离 userData（QA 会把 userData 覆盖值转成主进程的 `ATLAS_DESKTOP_USER_DATA_DIR`） |
| `ATLAS_DESKTOP_APP` | `qa-desktop` | 显式指定被测打包产物 |
| `ATLAS_QA_REQUIRE_PACKAGED=1` | `qa-desktop` | 只接受打包产物（CI 用） |
| `ATLAS_QA_NO_SANDBOX=1` / `ELECTRON_DISABLE_SANDBOX=1` | `qa-desktop` | 无沙箱环境（CI 用） |
| `ATLAS_QA_GEN_BUDGET_MS` / `ATLAS_QA_FIRST_SCREEN_HARD_CAP_MS` | `qa-desktop` | 生成耗时预算 / 首屏硬上限 |
| `ATLAS_QA_STRICT=1` | `qa-desktop` | skipped 也算失败 |
| `ATLAS_QA_OUT_DIR` / `ATLAS_QA_USER_DATA` | `qa-desktop` | 并行跑 QA 时隔离输出 / userData |

QA 相关变量见 `docs/desktop.md` §5.4；桌面 dev 变量见 §2.1。

## 附录 C：术语表

- **阶段（stage）**：terrain / hydrology / climate / biome / human；顺序即依赖，也是缓存边界。
- **指纹（fingerprint）**：阶段缓存键，只看该阶段真正消费的参数（见 `pipeline.ts`）。
- **黄金哈希（golden hash）**：`stage-seeds.test.ts` 里固化的旧版输出哈希，用于保证 legacy 逐字节兼容。
- **override / stamp**：用户编辑以归一化世界坐标存进文档，生成时在阶段边界栅格化注入。
- **派生层（layers）**：`WorldLayers`，typed arrays，不持久化，可 transfer。
- **装饰（chrome / decorations）**：地图上的标题、指北针、比例尺、图例、经纬网、边框、署名。
- **fixture / 基线（baseline）**：视觉回归用的固定合成地形与提交进仓库的参考 PNG。
- **门禁（gate）**：会以非 0 退出码阻断的 QA 脚本（`qa:render` / `qa:visual` / `qa:algo` / `qa:desktop` 等）。
- **latest-wins**：生成任务调度策略，新请求替换待跑请求，旧 seq 的返回被丢弃。
- **草稿（draft）**：512² 快速预览，不替换正式图层。
- **锁定重掷**：用 `stageSeeds` 锁住某阶段种子，只重掷其他阶段。

---

## 最后：交接 checklist（可以逐项勾掉）

- [ ] `pnpm install && pnpm dev` 能出图，状态栏显示服务端在线
- [ ] `pnpm typecheck && pnpm test` 全绿
- [ ] `pnpm qa:render` 出图 + 视觉回归 4/4
- [ ] 浏览器 QA 至少跑通 `qa-ui`（先起 dev server）
- [ ] 桌面端：`pnpm desktop:build && pnpm -C apps/desktop run pack` 成功；有 GUI / xvfb 时 `qa:desktop` 绿
- [ ] 读过 §3 与 §10，能说出"下一个要做什么、怎么算完成"
- [ ] 把本文档里已过期或不准确的地方更新掉——文档也是交接的一部分，不是一次性产物
