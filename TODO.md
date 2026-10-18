# Atlas Forge · 程序化世界地图生成器（Web）

> 目标：让小说 / 世界观创作者用「种子 + 参数 + 少量画笔」，在几分钟内得到一张**自洽、美观、可导出**的世界地图。

## 1. 已确认决策（2026-10-18 用户问答）

| 决策点 | 结论 |
| --- | --- |
| 尺度 | 世界级单张平面图；多尺度只保留数据接口，不做下钻 UI |
| 生成 / 编辑 | 混合：参数一键生成 + 画笔精修（海拔锁定、强制河道、刷群系） |
| 自洽性 | 真模拟：填洼 → 汇流 → 河流；风带 / 雨影 → 气候；纬度 + 海拔 → 群系 |
| 目标用户 | 小说 / 世界观创作者（地名、标注、PNG / JSON 导出） |
| 部署 | 浏览器交互预览；**Node 后端负责 ≥4096 大图渲染** |
| 美术 | 羊皮纸古地图（手绘海岸、晕线、纸纹、衬线地名） |
| 推进 | TODO 后直接开工 |

## 2. 首版范围（MVP）

**做：**
- 一键生成 1024² 交互预览；2048² 前端导出；4096² / 8192² 后端导出
- 参数面板：种子、海平面、大陆尺度、大陆度（径向衰减）、domain warp、山脉强度/尺度、侵蚀迭代、河流密度、信风/西风带、湿度偏差、温度偏移
- 画笔编辑：抬升 / 压低 / 海拔锁定、强制河道、群系涂抹；**编辑以世界坐标 stamp 存储，重新生成不丢失**
- 地名：程序化音节命名（拉丁 / 汉字两套），海、湖、河、山脉、城市分类型；可手动改名 / 拖动
- 羊皮纸渲染：海拔色带 + 山体阴影 + 海岸抖动 + 晕线 + 河流渐细 + 纸纹 + 双重边框 + 指北针 + 图例 + 标题饰框
- World JSON 导入 / 导出（唯一真源）、PNG 导出、撤销 / 重做、本地自动保存、2 套预设风格
- 河流/海岸/气候的自动不变量测试与可视化 QA

**不做（明确非目标）：**
- 世界→大陆→区域下钻、球面投影、账号 / 云同步 / 分享链接
- TRPG hex 网格、VTT / 游戏数据资产导出（只留接口，不排期）
- 多人协作、移动端适配（桌面优先 ≥1280px）

## 3. 技术架构

pnpm monorepo + TypeScript strict：

```
atlas_forge/
├─ apps/web/            Vite + React 19 + Zustand；Canvas2D 预览；Web Worker 跑生成管线
├─ apps/server/         Fastify + @napi-rs/canvas；复用 core/render 做 ≥4096 大图导出
├─ packages/core/       纯 TS、无 DOM：RNG / 噪声 / 地形 / 水文 / 气候 / 群系 / 人文 / 命名 / override / pipeline
├─ packages/render/     只依赖 Canvas2D 的渲染器，浏览器与 Node 共用（像素光栅 + 矢量叠加）
└─ scripts/             Node 侧 QA：无浏览器渲染 PNG、指标报告
```

**数据流：** `WorldDocument`(JSON，唯一真源) → Worker `pipeline.generate()` → `WorldLayers`(typed arrays) → `renderWorld()`。
大图导出：前端 `POST /api/render` → server 重新生成 + 渲染 → 返回 PNG。server 离线时前端明确降级提示（≤2048 本地导出仍可用）。

**关键决策：**
- 世界 JSON 是唯一真源，图片只是渲染产物；派生图层不持久化。
- 编辑 override 存**世界坐标 stamp（x/y/r 归一化）**，与网格分辨率解耦。
- 生成器分层、可缓存：改下游参数只重算下游；改风格只重渲染，零模拟开销。
- 渲染器基于「抽象 Canvas2D 接口 + 纯 TS 像素光栅」，同一份代码跑浏览器与 Node，避免两套渲染漂移。

## 4. 数据契约（核心）

```ts
interface WorldDocument {
  version: 1; id: string; name: string; seed: number;
  params: WorldParams; style: RenderStyle;
  overrides: WorldOverrides;       // 世界坐标 stamp
  settlements: Settlement[];       // 用户修改/钉住的
  labels: MapLabel[];              // 用户添加/修改的
  createdAt: string; updatedAt: string;
}

interface WorldOverrides {
  elevation: ElevationStamp[];     // x,y,r(归一化), value, mode: lock|raise|lower
  riverForce: RiverForcePath[];    // 归一化折线 + width
  biome: BiomeStamp[];             // x,y,r, biomeId
}

interface WorldLayers {            // 派生，不持久化，可 transfer
  size: number; seed: number;
  height / filled: Float32Array;
  ocean / lake / river: Uint8Array;
  flow / temperature / moisture: Float32Array;
  biome: Uint8Array;
  settlements: Settlement[];
  autoLabels: MapLabel[];
  stats: PipelineStats;
}
```

## 5. 生成管线（顺序即依赖，也是缓存边界）

| # | 阶段 | 内容 | 缓存键 | Override 注入点 |
| --- | --- | --- | --- | --- |
| 1 | terrain | 大陆 fBm + domain warping + 径向衰减；ridged multifractal 山脉掩码 | seed + 地形参数 + 海拔 stamp 哈希 | 海拔 stamp（fill 之前） |
| 2 | hydrology | priority-flood 填洼 → D8 汇流 → 流量阈值起河 → 湖泊；sqrt(flow) 决定河宽 | terrain 键 + 海平面 + 河流密度 + 强制河道哈希 | 强制河道在填洼前刻槽 |
| 3 | climate | 纬度温度带 + 海拔递减；风带 + domain 湿润度平流 + 迎风/背风雨影 | terrain 键 + 风/湿度/温度参数 | — |
| 4 | biome | 温度 × 湿度 × 海拔 × 海岸分类 | climate 键 + 群系 stamp 哈希 | 群系 stamp（分类之后） |
| 5 | human | 宜居度打分 → 城镇/港口；音节命名；河流/海岸地名 | biome 键 + seed | 用户钉住条目覆盖 |
| 6 | render | 像素光栅（色带/山影/纸纹）+ 矢量叠层（海岸/河/标签/装饰） | 不缓存，风格变更只重渲染 | — |

**硬性不变量（自动测试）：**
- 同 seed + 同参数 → 逐字节相同输出
- 每条河从高处流向低处，最终入海或入湖，不允许断头 / 倒流
- 海平面以下必为 ocean；湖必有出水口（或标记为内流盐湖）
- 背风面湿度显著低于迎风面；两极温度低于赤道

## 6. 视觉规范（羊皮纸）

- 纸张底 `#e8dcc0`，纸纹用可复现 fBm 噪点 + 轻微污渍 + 暗角，不用外部贴图
- 海洋：淡墨青灰渲染色，沿岸 2~3 圈宽度递增的晕线（hachure），内圈深外圈浅
- 陆地：低地米白/橄榄 → 高地赭石 → 山地灰褐 → 峰顶象牙；山地叠加 NW（315°）山体阴影
- 河流：墨青，宽度 sqrt(flow) 渐细，注入海/湖处收尖；湖泊勾边
- 海岸线：基于 ocean mask 的 marching squares 折线 + 确定性抖动（seed 决定），双线加深
- 地名：衬线字体（拉丁 EB Garamond；CJK 宋体栈），纸色描边 halo，区域名加大字距
- 装饰：双重边框、指北针、比例尺、标题 cartouche（世界名）、图例；全部程序化绘制
- 风格预设：`Parchment Classic`（默认）、`Aged Ink`（更暗、更重晕线）

## 7. 里程碑与验收

| # | Owner | 交付 | 验收标准 |
| --- | --- | --- | --- |
| M0 | Lead | monorepo 骨架、契约 types、可运行 dev（web+api）、Worker 管线打通、Node 出图脚本 | `pnpm dev` 出页面；点生成能显示 stub 地图；`pnpm typecheck` 通过；`pnpm qa:render` 出 PNG |
| M1 | core-dev | RNG / 噪声 / 大陆 + 山脉地形 | 确定性测试；1024² 地形 <150ms；3 seed 轮廓可区分 |
| M2 | core-dev | 填洼 / D8 / 河网 / 湖泊 | 30 seed 水文不变量全过；1024² 水文 <500ms |
| M3 | core-dev | 气候 + 群系 | 雨影/纬向单测；群系分布合理；1024² 气候+群系 <300ms |
| M4 | core-dev | 人文层（城镇/命名，拉丁+汉字） | 城镇落在宜居区、临水优先；命名可复现；用户钉住覆盖生效 |
| M5 | render-dev | 羊皮纸渲染器 + Node 大图渲染端点 | 1024² 渲染 <120ms；4096² 后端 <8s；浏览器/Node 同参数出图结构一致；截图过美术验收 |
| M6 | ui-dev | 完整 Web UI：参数、画布缩放、画笔、撤销、导出、自动保存 | 关键交互走查通过；画笔编辑重生成后不丢；PNG/JSON 往返一致 |
| M7 | Lead | 集成、E2E、性能预算、README、顾问复核 | 全部检查项有证据；截图审图 + 代码复核；无阻断缺陷 |

**性能预算：** 参数拖动（debounce 120ms）→ 1024² 预览 ≤1.2s p95；画笔笔画结束 → 重生成 ≤1.2s；页面首屏 <2s；4096² 导出服务端 ≤8s。

## 8. 团队分工与写权限（互不重叠）

| 成员 | 写范围 | 职责 |
| --- | --- | --- |
| Lead | 根配置、`scripts/**`、契约仲裁、集成修复 | 契约、集成、QA、终极验收 |
| core-dev | `packages/core/**` | M1–M4 生成管线 + 单测/不变量测试 |
| render-dev | `packages/render/**`、`apps/server/**` | M5 渲染器、Node 导出端点、字体资源 |
| ui-dev | `apps/web/**` | M6 全部界面、Worker 胶水、编辑与导出交互 |

契约（`packages/core/src/types.ts` 的公开接口）变更必须先 Lead 确认，避免三方漂移。

## 9. 验证计划

1. **单测/不变量**（vitest，core）：确定性、水文流向、雨影、群系分布、override 重生成保持
2. **Node 渲染 QA**：`scripts/qa-render.ts` 用 @napi-rs/canvas 出多 seed PNG + 指标（land fraction、河流数、耗时）
3. **浏览器 E2E**（Playwright，若可安装）：生成 → 调参 → 画笔 → 撤销 → 导出 JSON/PNG 全链路 + 截图
4. **顾问复核**：pipeline 正确性（code）、画面（截图 appearance）、交互（Playwright 截图/日志）、交付（delivery）
5. **交付物**：可运行仓库 + README（安装/使用/架构）+ 样例世界 JSON + 示例 PNG

## 10. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 8192² 内存/耗时爆炸 | 服务端限制 + 分块渲染 + 像素光栅直接写 ImageData；默认 4096，8192 需显式选择 |
| 河流穿帮（断头/倒流/翻山） | priority-flood + D8 严格实现 + 30 seed 不变量；测试失败不允许合入 |
| 羊皮纸风格做不像 | 色带/hillshade/晕线/纸纹分层可调；先出 1 张样图人工审，再批量套用 |
| 编辑重生成丢失 | override 世界坐标 stamp + 单测「编辑→改种子→恢复原种子」必须还原 |
| 浏览器/Node 渲染不一致 | 同一套像素光栅 + 抽象 Canvas2D；QA 脚本对比结构指标 |
| 无头浏览器不可用 | 退化为 Node PNG 人工看图 + core 单测 + 手动 接口/构建验证 |

## 11. 命令

```bash
pnpm install
pnpm dev            # web(5173) + api(8787)
pnpm typecheck
pnpm test
pnpm qa:render      # Node 端出 QA PNG 到 out/
pnpm qa:browser     # Playwright E2E + 截图到 out/e2e/
pnpm build
```

## 12. 交付状态（2026-10-18）

| 里程碑 | 状态 | 证据 |
| --- | --- | --- |
| M0 骨架/契约 | ✅ | monorepo、Worker 管线打通、Node 出图链路、`pnpm dev` |
| M1–M4 生成管线 | ✅ | core 9 test files / 44 tests；30 seed 水文不变量；override 逐字节往返；缓存命中 15–25ms；1024² 550–850ms |
| M5 渲染 + 后端导出 | ✅ | 共享渲染器 + EB Garamond；两套预设；1024 render 100–140ms；4096 端到端 5–8s；health/错误码/队列/内存预检 |
| M6 Web UI | ✅ | 参数/风格面板、pan/zoom、三类画笔、撤销、JSON/PNG 导出、自动保存、命名语言；Playwright 47 断言通过 |
| M7 集成验收 | ✅ | `pnpm typecheck`、core 44 tests、render 12 tests、web build、Lead E2E（0 console/page error，生成/调参/笔画/强制河道/撤销/导出/恢复全通过）、截图审图 |

**命名语言追加**：`WorldParams.namingLanguage: "auto" | "cjk" | "latin"`（additive；auto 与旧文档逐字节一致），UI 已提供下拉。

**交付物**：可运行仓库 + `examples/`（示例世界 JSON、经典/Aged Ink 成图、应用截图）+ `README.md` 使用与架构说明 + 本 TODO 验收记录。

**遗留（非首版目标）**：地名/城镇交互式改名拖动、8192 低内存压测、Firefox/Safari 兼容、多尺度下钻/球面投影/账号云同步。

## 13. v1.1 地点与地名编辑（2026-10-18）

**新增功能（用户已选）**：地点与地名编辑 —— 单击选中、双击改名、拖动定位、隐藏/恢复、新增地点（city/town/port/fortress/ruin/custom）与标注（region/water/mountain/custom），全部写入世界 JSON，支持撤销/重做、自动保存与种子往返保留。

**契约变更（additive）**：
- `WorldLayers.hidden?: { settlements: Settlement[]; labels: MapLabel[] }` —— 被 hiddenIds 过滤的条目（含生成与 pinned）供 UI「恢复」列表。
- 合并语义统一为「hidden 优先」：`overrides.hiddenIds` 同时压制生成条目与用户 pinned 条目；用户 pinned 条目按 id 覆盖生成条目。

**渲染修正**：`layers.autoLabels` 与 `document.labels` 按 id 合并去重（用户优先），settlement 合并过滤 hiddenIds，避免重复标签/隐藏条目重新出现。

**验证**：
- core：10 test files / 50 tests 全绿（新增 places 6 用例：pinned 覆盖、用户新增可复现、hidden 压制+恢复、hidden 稳定性）
- render：14 组断言全绿（新增 label 去重、hidden 过滤、pinned 覆盖、用户新增 label）
- web：typecheck/build 通过；ui-dev QA 85/85 断言、0 console/page error
- Lead E2E：放置→改名→撤销/重做→拖动→隐藏→恢复→新增标注→JSON 导出→刷新恢复 全通过；0 console/page error
- GitHub：public 仓库 `Umamed26/atlas-forge`，main 分支，CI（typecheck + tests + build）通过

**已知限制**：命中测试基于条目锚点 16px（长标签文字范围未覆盖，密集区取最近）；自动命名随机但落盘后确定；生成条目只能隐藏、用户新增条目可彻底删除。

## 14. v0.3.0 全量打磨（2026-10-18）

**范围**：不新增功能面，按真实用户路径打磨全部现有功能。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 同源命中 | ✅ renderer `measureMapContent` 与绘制同源（bbox + drawOrder），长标签尾部可选中、重叠取最上层，~0.7ms@1024 | render 21 行断言（含一致性/性能）；Lead E2E 标签尾部点击 id 精确匹配；ui-qa 06e 截图 |
| 撤销/重做一致 | ✅ 一次动作一条历史；选区/hover/自动保存/导出 0 条；跨功能撤销链 | qa-ui 141 断言；ui-dev 报告 |
| 键盘/焦点/单一来源 | ✅ 17 条快捷键单源（帮助=行为）；输入框内 Delete 守卫；Esc 五级；焦点回画布 | Lead E2E `shortcuts debug=17 helpRows=17`、`rename guard unchanged=true` |
| 导入/自动存档失败路径 | ✅ core 校验/规范化；坏 JSON 拒绝且文档不变；主/备双槽 + 损坏恢复面板 | Lead E2E `docUnchanged=true`、`recovery panel=1/recoveredSeed=20261018`；core 61 tests |
| 导出可预期 | ✅ 尺寸/文件名/禁用原因/分阶段进度/取消/释放 canvas/服务端 abort 内存不累积 | Lead E2E 文件名 `atlas-Aetheris-20261018-parchment-1024.png`；server 连续 4096 rss 544→528MB |
| 布局/窄屏 | ✅ 可折叠分组 + sticky + 记忆；1280×800、1024×768 无溢出 | Lead E2E `persisted=true`、`overflow={h:0,v:0}`；截图 12-narrow-* |
| 命名/性能/a11y | ✅ 命名纯函数+RNG+去重后缀；hitTest ~0.1ms、hover 零重算；aria/focus/reduced-motion | Lead E2E hover seq 不变；qa-ui a11y/预算断言 |
| 发布 | v0.3.0：main 提交 + tag + GitHub Release + CI 绿 | 见 GitHub Actions |

**已知限制**：桌面优先（≥1024 不溢出，未承诺触控拖动/双击）；自动存档仅当前+上一份备份；取消服务端导出会产生一次预期中的 `ERR_ABORTED`。

## 15. v0.4.0 生成体验打磨（2026-10-19）

**主题**：让不懂参数的创作者 10 秒拿到一张能用的图，并且「换不坏」。

**批准的流程变更（additive，向后兼容）**：`WorldParams.stageSeeds?: { terrain?, hydrology?, climate?, human? }` —— 每阶段有效种子 = stageSeeds.x ?? document.seed；未设置时输出与 v0.3.0 **逐字节一致**（`test/stage-seeds.test.ts` 用 3 组 v0.3.0 输出哈希常量固化）。这是「锁海岸只换河流」的技术前提。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 场景预设首屏 | ✅ 4 预设打包参数+风格+命名，真缩略图，首次引导+可重开 | core SCENARIO_PRESETS（4 预设 1024² 可读性断言）；qa-gen-ux 首屏四卡；截图 examples/welcome-scenarios.png |
| 锁定重掷 | ✅ 5 锁；锁海岸连换 3 次 height/ocean 层级哈希一致、river 变化 | core stage-seeds 13 用例；Lead E2E `getLayerSignature` 断言；qa-ui 200/200 |
| 生成历史 | ✅ 最近 10 次缩略图，恢复前保留当前，只占 1 条撤销 | Lead E2E 历史恢复；ui-qa 23-history |
| 换一批地名 | ✅ 只重掷 human 子 seed，height/river/biome 哈希不变 | Lead E2E；qa-ui |
| 人话滑杆 | ✅ 结果语言 + 低/中/高 + 场景推荐刻度 + 恢复推荐 + 「已改 N 项」 | 截图 examples/locked-reroll.png；qa-ui |
| 草稿预览/取消/失败保留 | ✅ 150ms 节流 512² 草稿（原先误用尾部防抖导致拖动中永不触发，已修）；可取消；失败保留旧图+重试/快速模式 | Lead 定位并提出节流方案；qa-ui 连续拖动断言；Lead qa-gen-ux 20/20 |
| 可读性检查 | ✅ 生成后一次（5–6ms）：标签碰撞/越界/陆地比例/河流/密度/对比度 + 一键修复 | render readability 8 用例；截图 25-readability |
| 视觉回归 | ✅ 8 条基准（4 预设×2 seed，512²）+ `qa:visual` 门禁进 CI | `qa:visual` 8/8 identical（renderer 1.3.0） |
| 群岛构图 | ✅ 从「一块主陆」改为真群岛：seed 101/202/303 岛屿 21/34/22 块，最大岛 34/39/21% | core scenarios 测试；out/qa-preset-archipelago-101.png |
| 群系可辨 | ✅ 冰原/苔原/沙漠/雨林在 256px 可区分，新增 biomeTint；aged-ink 保留色相 | render 前后对比图；qa:baseline 重建 |

**验证汇总**：typecheck ×5 包；core 82 tests（13 files）；render synthetic+readability 全绿；web build；`qa:render` 8/8 视觉一致；`qa:visual` PASS；`qa-ui` 200/200；Lead `qa-gen-ux` 20/20 + `qa-browser` 全绿（0 console/page/request error）。

**已知限制**：锁住阶段不写显式 subs seed，故「换一张」时 seed 编号后缀不变；应用场景预设等价新建世界（会重置用户地点，可撤销）；可读性仅生成/预设后计算，纯风格改动后横幅可能滞后。

## 16. v0.5.0 生成算法商用级（2026-10-19）

**目标**：把生成从「调参能出好看图」升级为「地理成因可验证 + 跨端可复现 + 可交付矢量成品」。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 因果气候 | ✅ 纬度/海拔/距海 BFS/风带/雨影；Whittaker 群系；雪线随纬度 | core climate/biome 单测；qa:algo 群系≥12 |
| 河流拓扑 | ✅ Strahler 级序 + 宽度 √flow + 三角洲 + 无悬挂河 | qa:algo 悬挂河 0.00%、级序 ≥4；core 30-seed 不变量 |
| 湖泊治理 | ✅ 单湖 ≤2%、内陆盆地抬升；消除 6% 湖泊异常 | qa:algo 单湖 ≤0.60%；诊断图对比 |
| 板块构造（可选） | ⚠️ 已实现（Voronoi 板块/收敛造山带/离散裂谷），**实验性**：细节不及 fBm，默认关闭 | `terrainModel:"plates"`；UI 一键试用/撤销；qa:algo 对默认模型全绿 |
| 算法门禁 | ✅ 9 项分布断言 + P95 延迟，CI 内置 | `pnpm qa:algo` 9/9；`--full` 120 seed 9/9 |
| 视觉基线解耦 | ✅ 改用固定合成地形 fixture，算法升级不再使基线失效 | `qa:visual` 4/4；manifest fixtureVersion |
| 性能 | ✅ 修复 O(n²) 湖泊扫描：最慢 seed 3.4s → 53ms；1024² p95 379–425ms | qa:algo 报表 out/qa-algo.json |
| 矢量导出 | ✅ SVG 分层矢量 + A3@300dpi + 服务端端点 | render svg 7 tests；1024² 198KB/774ms |
| 旧世界兼容 | ✅ 缺 algorithmVersion → fbm+旧管线逐字节一致；可一键试用板块并撤销 | stage-seeds 黄金哈希 82 tests 全绿 |
| 诊断面板 | ✅ 地形/水文/气候/群系/性能 + 气候叠加 | qa-ui 227/227；截图 30-algorithm-badge |

**取舍说明**：板块地形没有作为默认——它在成因上正确，但视觉质量（海岸/山带细节）仍不及已验证的 fBm 骨架；按「不把退化当升级」的原则，默认保留 fBm + 现代气候/河网管线，板块作为可选项并在文档中标注实验性。
