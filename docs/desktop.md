# Atlas Forge 桌面版（v0.7）

Atlas Forge 的桌面版不是另一个应用：它把同一份 `apps/web` 渲染层装进 Electron，并在主进程里提供
文件读写、原生日志、最近文件、菜单命令与**离线大图导出**。浏览器版与桌面版共用
`packages/core`（生成管线）和 `packages/render`（羊皮纸渲染器），因此同一份世界 JSON
在两边生成的图完全一致。

```
apps/desktop/
├─ shared/ipc.ts           IPC 契约（唯一真源，preload 只暴露这里定义的 API）
├─ src/main/index.ts       窗口 / 安全基线 / 自定义 app:// 协议 / 菜单
├─ src/main/exports.ts     离线 PNG / SVG 导出（@napi-rs/canvas + @atlas/render）
├─ src/main/files.ts       打开 / 保存 / 另存为
├─ src/main/recent.ts      最近文件
├─ src/main/menu.ts        原生菜单
├─ src/preload/index.ts    单文件 CJS preload → window.atlasDesktop
└─ scripts/                build.mjs（esbuild 单文件打包）、copy-assets.mjs、dev.mjs
```

- **开发模式**：渲染层来自 Vite dev server（`http://127.0.0.1:5173`），主进程由 esbuild 打包。
- **构建 / 打包模式**：渲染层从 `apps/desktop/dist/renderer` 通过受保护的自定义协议
  `app://atlas/` 加载。使用标准/安全 scheme 而不是 `file://`，是为了让 ESM module、
  module worker、`localStorage` 与 CSP `'self'` 在打包后也行为正常。
- **导出**：PNG/SVG 在主进程用 `packages/core` + `packages/render` 现场生成，**不依赖 Node API
  服务**；4096 / 8192 因此可以在完全断网时使用。

---

## 1. 前置条件

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | 24.x | 与根仓库 / CI 一致 |
| pnpm | 11.x | workspace 包管理 |
| Electron | 44.4.5 | 已在 `apps/desktop/devDependencies` 固定；二进制由 `pnpm install` 的 postinstall 提供，或由 electron-builder 在打包时下载 |
| Linux 运行时库 | 见下 | 无 GUI 环境还需要 `xvfb` |

Linux（Ubuntu 22.04/24.04）最小依赖：

```bash
sudo apt-get install -y xvfb libnss3 libgbm1 libxss1 \
  libasound2t64 libatk-bridge2.0-0t64 libgtk-3-0t64
# Ubuntu 22.04 用不带 t64 后缀的包名：libasound2 libatk-bridge2.0-0 libgtk-3-0
```

> `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 只放行 `esbuild`，因此 Electron 的 npm
> postinstall **不会**自动执行。`pnpm install` 后如果 `node_modules/electron/dist` 缺失，
> 按下面「故障排查 → electron binary missing」处理。

## 2. 安装与运行

```bash
pnpm install
```

### 2.1 开发模式（HMR）

```bash
# 终端 A：Web 渲染层（Vite，5173）
pnpm dev:web

# 终端 B：Electron（主进程由 esbuild 打包后启动，渲染层连 5173）
pnpm desktop:dev
```

`apps/desktop/scripts/dev.mjs` 会自动构建主进程/preload，并等待 `http://127.0.0.1:5173`
就绪（默认 60s 超时，可用 `ATLAS_DESKTOP_DEV_TIMEOUT_MS` 调整）；超时会给出明确错误而不是
启动一个指向死地址的窗口。常用环境变量：

| 变量 | 作用 |
| --- | --- |
| `ATLAS_WEB_URL` | dev server 地址，默认 `http://127.0.0.1:5173/` |
| `ATLAS_DESKTOP_DEV_TIMEOUT_MS` | 等待 dev server 就绪的超时（默认 60000） |
| `ATLAS_DESKTOP_NO_SANDBOX=1` | 以 `--no-sandbox` 启动（WSL / 无特权容器 / CI） |

### 2.2 构建打包产物并预览

```bash
# 1) 构建：Web 生产包 → apps/desktop/dist/renderer；主进程/preload 由 esbuild 打包
pnpm desktop:build

# 2) 不上安装包，直接用构建产物启动（app://atlas/ 协议）
pnpm -C apps/desktop start          # = node scripts/dev.mjs --packaged

# 3) 生成未签名安装包（当前平台）
pnpm desktop:pack                   # electron-builder --dir，产出 dist/<platform>-unpacked
pnpm desktop:dist                   # 正式产物：AppImage/deb、dmg/zip、nsis/portable
```

`electron-builder` 配置在 `apps/desktop/electron-builder.yml`（`appId com.umamed.atlasforge`、
`productName "Atlas Forge"`、`asar: true`、`publish: never`、未签名）。打包时 electron-builder
会自行下载与 `electronVersion` 匹配的 Electron 发行版；下载失败会**显式失败**，不会产出截断的包。

### 2.3 产物位置

| 平台 | 未打包目录（`--dir`） | 安装包 |
| --- | --- | --- |
| Linux | `apps/desktop/dist/linux-unpacked/`（可执行文件名 `atlas-forge`） | `apps/desktop/dist/AtlasForge-<ver>-linux-x86_64.AppImage`、`AtlasForge-<ver>-linux-amd64.deb`（注意 AppImage 用 x86_64、deb 用 amd64） |
| macOS | `apps/desktop/dist/mac*/Atlas Forge.app` | `*.dmg`、`*.zip` |
| Windows | `apps/desktop/dist/win-unpacked/` | `*.exe`（nsis + portable） |

`./scripts/qa-desktop.mjs` 能自动识别上述布局；也可以用 `ATLAS_DESKTOP_APP` 显式指定解包目录或
可执行文件（见 §5）。

## 3. 未签名分发说明

v0.7 的三平台产物**全部未签名**（仓库没有代码签名证书）：

- **macOS**：首次打开会被 Gatekeeper 拦截。右键 →「打开」，或：
  ```bash
  xattr -dr com.apple.quarantine "/Applications/Atlas Forge.app"
  ```
  仍被拦截时用「系统设置 → 隐私与安全性 → 仍要打开」。
- **Windows**：SmartScreen 会提示「Windows 已保护你的电脑」→「更多信息」→「仍要运行」。
  nsis 安装器与 portable exe 行为一致。
- **Linux**：AppImage 需要先加执行权限：
  ```bash
  chmod +x AtlasForge-*.AppImage
  ./AtlasForge-*.AppImage
  ```
  没有 FUSE 的环境（容器 / 部分服务器）可以解包运行：
  ```bash
  ./AtlasForge-*.AppImage --appimage-extract
  ./squashfs-root/atlas-forge
  ```

发布正式版本前应补：macOS Developer ID 签名 + notarization、Windows Authenticode 证书，
并在 electron-builder 中配置 `mac.identity` / `win.certificateFile`。CI 目前明确设置
`CSC_IDENTITY_AUTO_DISCOVERY=false`，只上传未签名产物。

## 4. 离线能力边界

**断网仍可用（已在 `qa-desktop` 中自动验证）**

- 世界生成：`packages/core` 管线在渲染进程 Worker 中执行，不访问网络。
- PNG / SVG 导出：主进程本地生成（512 ~ 8192），不依赖 Node API。
- 字体：EB Garamond 随 `@atlas/render` 打包，主进程通过 `dist/assets/fonts` 注册；缺失时回退系统衬线。
- 文档：自动保存写 `localStorage`（`app://atlas/` 是一个标准安全源）；打开/保存/最近文件走本地 IPC。
- 菜单、快捷键、撤销/重做、地点编辑全部本地完成。

**断网不可用 / 边界**

- 浏览器版的 4096/8192 依赖 `pnpm dev` 的 Node API；桌面版不依赖它。桌面构建里
  `refreshServerStatus()` 通过 `isDesktop()` 直接短路：不发 `/api/health` 请求，状态栏显示
  「桌面端 · 本地渲染」（`data-testid="server-status"`）。因此离线时不会出现网络错误。
  历史版本曾探测一次 `/api/health`；QA 的 console allowlist 仍保留那条精确放行规则作为防御
  （详见 §5.5），正常情况下不会命中。
- 没有地图瓦片、在线底图、云同步、协作、自动更新器；不会上传任何用户数据。
- 8192² PNG 需要约 270 MB RGBA 画布内存；低内存机器建议 4096² 或更小（主进程会把
  分配/渲染错误转成可读提示，而不是崩溃）。

## 5. 桌面端 E2E（`scripts/qa-desktop.mjs`）

### 5.1 运行

```bash
# 有 GUI 的开发机
pnpm qa:desktop                 # = node scripts/qa-desktop.mjs

# 无 GUI 的 Linux / CI
xvfb-run -a node scripts/qa-desktop.mjs
# 脚本在没有 DISPLAY 且安装了 xvfb-run 时会自动以 xvfb-run -a 重新执行自己

# 显式指定被测产物（解包目录或可执行文件）
ATLAS_DESKTOP_APP=apps/desktop/dist/linux-unpacked node scripts/qa-desktop.mjs

# 只解析「将驱动哪个产物」而不启动（CI 日志里用来证明被测二进制）
node scripts/qa-desktop.mjs --print-target
```

`--print-target` 输出 `{mode, executablePath, args, appRoot, layout, asar}`：`mode` 为
`packaged` 时退出码 0，仅兜底模式时退出码 3，前置缺失时 2。

脚本用 `playwright-core` 的 `_electron.launch` 启动**打包产物**（不是 dev server，也不是
「electron + 源码目录」），驱动真实渲染层 + 真实 preload/IPC，产出：

```
out/desktop-qa/
├─ report.json          # 结构化报告：mode/断言/耗时/截图/导出/console/stderr/blocked
├─ run.log              # 逐步日志（CI artifact 里最有用）
├─ 01-window.png … 07-offline-export.png, 99-final.png
├─ fail-<check-id>.png  # 失败时的现场截图（每个失败断言一张）
└─ exports/             # 导出的 PNG/SVG（4096 PNG ≈ 20 MB，默认不上传 CI artifact）
```

### 5.2 启动模式（report.mode）

| mode | 含义 | 何时使用 |
| --- | --- | --- |
| `packaged` | 直接运行 electron-builder 产出的可执行文件（`dist/linux-unpacked/<exe>`、mac `.app/Contents/MacOS/…`、win `win-unpacked/*.exe`，或 `ATLAS_DESKTOP_APP` 指向可执行文件/解包目录） | 默认优先；CI 的唯一合法模式 |
| `electron-appdir` | `node_modules/electron` 可执行文件 + `apps/desktop`（`dist/main` + `dist/renderer` 已构建，走 `app://atlas/`） | 还没打包、只想快速回归主进程+渲染层时的兜底 |

`ATLAS_QA_REQUIRE_PACKAGED=1` 会把兜底模式判为 blocked（CI 使用）。`report.json` 的
`packaged` 字段与 `layout` 字段会写清实际被测形态，不会把「源码模式」冒充打包验证。

### 5.3 断言清单

| check id | 内容 |
| --- | --- |
| `app-window` | 窗口出现、标题含 Atlas Forge、渲染层来自本地源（`app://atlas/` / `file://` / localhost） |
| `desktop-bridge` | `window.atlasDesktop` 存在且 `isDesktop`、`getAppInfo()` 返回 electron/chrome 版本与离线导出能力（PNG/SVG 均含 4096） |
| `desktop-server-status` | 渲染层是纯本地：状态栏 `server-status` 显示「桌面端 · 本地渲染」，且整个运行期没有任何 `/api/*` 请求（请求日志断言） |
| `first-screen-generation` | 首屏生成完成（status `data-state=idle` + 「已生成」）；生成耗时（DOM `stat-generation-ms`）按默认 gridSize=1024² 记录。1024² 比 512² 的目标更严，因此这里只对 `ATLAS_QA_FIRST_SCREEN_HARD_CAP_MS`（默认 10000ms）硬失败、超出 2s 目标仅记录 note，避免慢 runner 假红；严格的 512² < 2s 由 `generation-512` / `generation-512-proxy` 断言 |
| `canvas-painted` | 地图 canvas 非空：下采样 96² 后亮度方差 / 非暗像素比例达标 |
| `generation-512` | 通过 `window.__atlasDebug.quickGenerate()` 触发 512² 生成，读 debug summary 的 `perf.lastGenerationMs` < 预算；debug API 不在时记 **skipped** 并说明原因（不静默通过） |
| `generation-512-proxy` | 无 debug 也能跑：通过 IPC `exportPng({size:512})` 测主进程 512² 管线（sim+render+encode）< 预算 |
| `export-svg-baseline` | IPC 导出 1024 SVG：合法 `<svg>`、>10KB、默认装饰的 `data-decor` 节点齐全 |
| `decor-toggle-compass` | 点 `decor-toggle-compass` → `aria-checked=false`、可见计数 -1、canvas 重绘、文档 `decorations.compass.visible=false`；导出的 SVG **不含** `data-decor="compass"`，且其他装饰仍在 |
| `decor-all-off` | 点「全部关闭」→ 可见计数 0；导出 SVG 中 `data-decor` 节点数为 **0** |
| `export-png-4096` | IPC 导出 4096 PNG：`canceled=false`、路径在 `ATLAS_TEST_EXPORT_DIR` 下、PNG 签名正确、IHDR 4096×4096、文件 > 1 MB、IPC 字节数与文件一致 |
| `offline-generation` | `context.setOffline(true)` 后（`navigator.onLine=false` / CDP 探测确认）点「换一张」，仍能完成生成，生成耗时 < 预算 |
| `offline-export` | 离线状态下再导出 SVG 1024 + PNG 1024 均成功；随后 `setOffline(false)` |
| `console-clean` | 无未放行的 console error / pageerror / renderer crash（放行项显式记录在 `report.console.allowlisted`；当前桌面构建期望 console error 数为 0） |
| `main-process-clean` | 主进程无 `Cannot find module` / uncaught / FATAL 等致命 stderr，且运行期间未提前退出 |

**参考实测**（WSL2 / Ubuntu 26.04，`xvfb-run`，被测 `dist/linux-unpacked/atlas-forge`，v0.7.0）：
15/15 通过；首屏 1024² 生成 811ms、512² 生成 334ms、4096 PNG 8.6s / 21.2 MB（IHDR 4096×4096）、
离线生成 771ms 且 SVG/PNG 导出成功；console error / pageerror / crash / /api 请求均为 0。
不同硬件会有差异，report.json 里是每次的真实值。

### 5.4 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ATLAS_DESKTOP_APP` | 自动探测 `apps/desktop/dist` | 显式指定被测可执行文件或解包目录 |
| `ATLAS_TEST_EXPORT_DIR` | `out/desktop-qa/exports` | 导出落盘目录。**这是主进程里的测试钩子**：设置后跳过保存对话框（详见 §5.6） |
| `ATLAS_QA_USER_DATA` | `out/desktop-qa/user-data` | 隔离的 Electron userData（以 `ATLAS_DESKTOP_USER_DATA_DIR` 传给主进程），避免单实例锁冲突与脏 localStorage |
| `ATLAS_QA_REQUIRE_PACKAGED=1` | 关 | 只接受打包产物；兜底模式判 blocked（CI 开） |
| `ATLAS_QA_STRICT=1` | 关 | 把 skipped 断言也算失败（当 CI 确认 debug hook 必须存在时开） |
| `ATLAS_QA_GEN_BUDGET_MS` | `2000` | 512² 生成耗时预算（`generation-512` / `generation-512-proxy` / 离线生成共用） |
| `ATLAS_QA_FIRST_SCREEN_HARD_CAP_MS` | `10000` | 首屏（默认 1024²）生成耗时的硬上限；超出 2s 目标只记录 note，不判失败 |
| `ATLAS_QA_TIMEOUT_MS` | `600000` | 整轮看门狗；超时也会写 report 并退出 |
| `ATLAS_QA_NO_SANDBOX=1` | 自动 | 强制 `--no-sandbox --disable-gpu --disable-dev-shm-usage` + `ELECTRON_DISABLE_SANDBOX=1` |
| `ATLAS_QA_OUT_DIR` | `out/desktop-qa` | 输出目录（report.json / run.log / 截图 / exports）。多人或多任务并行跑 QA 时各用私有目录，避免互相 `rm -rf` |
| `ATLAS_QA_NO_XVFB=1` | 关 | 禁止「无 DISPLAY 时自动 xvfb-run 重执行」 |
| `ELECTRON_PATH` | 自动 | 兜底模式下显式指定 Electron 可执行文件 |

### 5.5 退出码与失败分类

| 退出码 | 含义 |
| --- | --- |
| `0` | 全部断言通过（skipped 只有在 `ATLAS_QA_STRICT=1` 时才影响退出码） |
| `1` | 有断言失败（产品/打包缺陷；每个失败都有 `fail-<id>.png` 与 report 详情） |
| `2` | 前置被阻塞：electron 二进制缺失、打包产物/构建产物缺失、playwright-core 不可用、无可用显示、Electron 启动失败、harness 异常。`report.blocked` 会带 `reason`、`required`（修复命令）、`searched`、`stderrTail` |

**阻塞绝不静默**：脚本总是打印原因、写 `report.json` 并给非 0 退出码；CI 里会保留
`report.json` / `run.log` / 截图 artifact。

**console 放行项（显式、可审计）**：

- `Failed to load resource` 且 URL 含 `/api/health`（防御性放行）：桌面构建已改为不探测
  `/api/health`；若旧构建/回归版本又发出该请求，失败被应用捕获、状态栏显示离线原因，QA 不让它
  误报。正常 v0.7 构建不会命中此规则。
- 离线测试期间的 `ERR_INTERNET_DISCONNECTED` / `ERR_NAME_NOT_RESOLVED` 等（仅在 `offline=true`
  的记录上放行；正常路径不会产生）。
- Chromium 内建 Autofill 提示、favicon 404。

放行的每条记录都带 `allowlist` id 与 `reason` 写入 `report.console.allowlisted`；**未匹配的
console error 一律判失败**。

**已知盲区（如实记录）**：Playwright 在窗口创建后才拿到 `Page`，首窗加载最早期（preload 之前/
页面脚本注入前）的 console 事件可能收不到；主进程 stderr 从 `_electron.launch` 成功后开始收集。
`report.json` 记录了实际收集到的条数与末尾内容，不宣称「全量无错」。

### 5.6 测试专用导出钩子（`ATLAS_TEST_EXPORT_DIR`）

`apps/desktop/src/main/exports.ts` 的 `targetPath()` 在检测到 `ATLAS_TEST_EXPORT_DIR` 时：

1. `mkdirSync(dir, { recursive: true })`；
2. 返回 `join(dir, "atlas-<world>-<seed>-<size>.<png|svg>")`，**不弹保存对话框**；
3. 其余写盘 / 错误 / 取消逻辑完全复用正常路径。

未设置该环境变量时行为与发布版完全一致（原生保存对话框）。该变量只由测试进程设置，应用自身
从不设置；把它当作「发布构建里的后门」没有意义——任何能设置环境变量的人已经能控制进程。
即便如此，如需更严格的发布产物，可以在打包前移除该分支并用 `ATLAS_QA_REQUIRE_PACKAGED=0`
跑构建产物级测试（代价：需要驱动 UI 的导出弹窗而不是直接调 IPC）。

### 5.7 QA 与 `__atlasDebug`

桌面构建在 `window.atlasDesktop` 存在时会安装只读 debug API（`apps/web/src/hooks/useAppPipeline.ts`：
`import.meta.env.DEV || isDesktop()`），暴露 `getDocument/getSummary/quickGenerate/regenerate`
等纯读取与触发接口，**不暴露任何 IPC 写面**。它让 QA 能：

- 读 `perf.lastGenerationMs` 做 512² 的精确断言（`generation-512`）；
- 取出当前 `WorldDocument` 直接调 `window.atlasDesktop.exportSvg/exportPng`（无需解析自动存档）。

普通浏览器生产包（无 `window.atlasDesktop`）行为不变，不会安装该 API。若未来移除该 hook，
`generation-512` 会变为 skipped，`generation-512-proxy` + 首屏 DOM 计时仍覆盖生成性能，
`ATLAS_QA_STRICT=1` 可让 skipped 直接失败。

### 5.8 CI（`.github/workflows/desktop.yml` → `desktop-qa`）

`desktop-qa` job 依赖 `package` matrix 完成，然后：

1. 下载 `atlas-forge-desktop-ubuntu-latest` artifact（Linux AppImage）；
2. `./AtlasForge-*.AppImage --appimage-extract` 得到 `squashfs-root/`（无需 FUSE）；
3. `ATLAS_DESKTOP_APP=$GITHUB_WORKSPACE/dist-artifacts/squashfs-root` 指向解包产物；
4. `xvfb-run -a node scripts/qa-desktop.mjs`，环境 `ATLAS_QA_REQUIRE_PACKAGED=1`、
   `ATLAS_QA_NO_SANDBOX=1`、`ELECTRON_DISABLE_SANDBOX=1`；
5. `if: always()` 上传 `out/desktop-qa/{report.json,run.log,*.png}`。

这样测的就是用户实际下载的 AppImage 内容，而不是 CI 里另一次本地构建。

### 5.9 沙箱 / 无 GUI 兼容开关

Electron 的 Chromium 沙箱在 CI 容器、部分 WSL2 配置、无特权 user namespace 的环境里常常无法启动。
脚本与文档提供三层开关：

```bash
# 1) 推荐：有虚拟显示 + 关闭 Chromium 沙箱
xvfb-run -a node scripts/qa-desktop.mjs          # 无 DISPLAY 时会自动重执行
ATLAS_QA_NO_SANDBOX=1 ELECTRON_DISABLE_SANDBOX=1 node scripts/qa-desktop.mjs

# 2) 桌面开发脚本（WSL）
ATLAS_DESKTOP_NO_SANDBOX=1 pnpm desktop:dev

# 3) 手动给 electron 传 Chromium 开关
node_modules/.bin/electron --no-sandbox --disable-gpu apps/desktop
```

`qa-desktop` 默认先尝试带沙箱启动，失败后自动用 `--no-sandbox --disable-gpu --disable-dev-shm-usage`
重试一次，并把实际使用的开关写进 `report.sandbox`。**这是 QA 环境的兼容开关，不代表发布版应关闭沙箱**：
`apps/desktop/src/main/index.ts` 对生产窗口保持 `sandbox: true` + `app.enableSandbox()` +
`contextIsolation: true` + `nodeIntegration: false`。

WSLg / WSL2 注意事项：

- 有 `DISPLAY`（例如 WSLg 的 `:0`）时可直接跑，但 Chromium 沙箱通常不可用 → 用 `ATLAS_QA_NO_SANDBOX=1`；
- 没有 `DISPLAY` 时安装 `xvfb` 即可；`dbus` / `libva` / GPU 相关 stderr 噪声不会导致失败
  （`main-process-clean` 只对 `Cannot find module` / uncaught / FATAL 判失败）。

## 6. 已知限制与风险

1. **未签名**：mac 需要 `xattr -dr com.apple.quarantine`，Windows 会弹 SmartScreen（见 §3）。
2. **Electron 版本固定 44.4.5**：`electron-builder.yml` 的 `electronVersion` 与
   `apps/desktop/package.json` 必须同步升级；升级后需重跑 `qa-desktop`（`getAppInfo` 会打印实际版本）。
3. **单实例锁按 userData 判定**：并行运行多个 QA 实例会互相抢占。`ATLAS_DESKTOP_USER_DATA_DIR`
   （主进程支持）或 QA 默认的 `out/desktop-qa/user-data` 已隔离；手工并行启动 dev 实例时注意。
4. **生产 renderer 的调试面**：桌面版暴露只读 `window.__atlasDebug`（见 §5.7）。若安全评审要求
   生产产物零调试面，移除该 hook 后 QA 相应断言会 skipped（`ATLAS_QA_STRICT=1` 会红）。
5. **4096/8192 内存**：4096² ≈ 67 MB RGBA + 中间层；8192² ≈ 270 MB。导出在主进程串行执行，
   超低内存机器建议 ≤ 4096²；错误会以可读 toast 呈现。
6. **CI 的 AppImage 解包**：`--appimage-extract` 不依赖 FUSE，但会占用约 300 MB 磁盘；
   若 runner 磁盘紧张需清理。
7. **首屏计时受 CI 负载影响**：`first-screen-generation` 用 DOM 的「生成耗时」（不含 Electron
   冷启动），默认预算 2000ms（1024² 网格）。极慢的 runner 可用 `ATLAS_QA_GEN_BUDGET_MS` 调整，
   但调整会写进 `report.config`，便于审计。
8. **Web 与桌面共用代码**：桌面版任何关于 `window.atlasDesktop` 的分支都必须保证普通浏览器
   `no-op` 降级；`pnpm qa:browser` / `qa-decor` / `qa-ui` 仍覆盖浏览器路径。

## 7. 故障排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `report.blocked.reason = electron-binary-missing` | `pnpm install` 未执行 Electron postinstall（workspace 放行策略）。执行 `node node_modules/electron/install.js`（或 `pnpm rebuild electron`）；离线环境可把 `electron-v44.4.5-linux-x64.zip` 放进 `~/.cache/electron` 后重跑。**不要**只创建 `path.txt` 而不解压 dist。 |
| `packaged-artifact-and-build-missing` | 先 `pnpm desktop:build`；要测打包产物再 `pnpm -C apps/desktop run pack`（注意 `pnpm -C apps/desktop pack` 会命中 pnpm 内置 pack 打成 tgz，必须带 `run`）。CI 用 `ATLAS_QA_REQUIRE_PACKAGED=1` 时必须有 `linux-unpacked`。本机 electron-builder 若卡在 GitHub 下载 Electron zip，可加 `--config.electronDist=<本地 electron/dist>` 复用已解压的 Electron（CI 有网络不要加）。 |
| `electron-launch-failed` | 无显示（用 `xvfb-run -a`）或 Chromium 沙箱失败（`ATLAS_QA_NO_SANDBOX=1 ELECTRON_DISABLE_SANDBOX=1`）。`report.blocked.stderrTail` 有原始报错。 |
| `renderer-never-mounted` / 白屏 | 检查 `apps/desktop/dist/renderer/index.html` 是否存在、`pnpm -C apps/web build` 是否成功；`report.blocked.rendererContents` 有目录清单。 |
| 导出调用一直卡住 / 超时 | 未生效的 `ATLAS_TEST_EXPORT_DIR` 钩子会弹出原生保存对话框阻塞 IPC。确认 `apps/desktop/src/main/exports.ts` 里有该 env 分支，并重新 `pnpm desktop:build`（改了主进程必须重新打包）。 |
| `export-svg-*` 失败且报「渲染器没有返回有效的 SVG 文本」 | `renderSvg()` 的输出以 `<?xml …?>` 开头；主进程必须去掉 prolog 或放宽校验后再写盘（v0.7 已修复，回归时先查这里）。 |
| console-clean 失败 | 看 `report.console.errors`；若确认为环境噪声，**显式**加 allowlist 并写 reason，不要整体吞掉 error。 |
| Linux 上 `chrome-sandbox` 权限报错 | 非特权环境无 SUID sandbox：QA 用 `ATLAS_QA_NO_SANDBOX=1`；发布环境不要关闭 sandbox。 |

## 8. 相关命令速查

```bash
pnpm install                 # 安装依赖（含 Electron 包；二进制可能需单独安装）
pnpm desktop:build           # Web 生产包 + 主进程/preload 打包
pnpm desktop:dev             # dev 模式（需先 pnpm dev:web）
pnpm -C apps/desktop start   # 用构建产物启动（app://atlas/）
pnpm desktop:pack            # 未打包目录（electron-builder --dir）
pnpm desktop:dist            # 当前平台安装包（未签名）
pnpm qa:desktop              # 打包产物 E2E（GUI）
xvfb-run -a pnpm qa:desktop  # 打包产物 E2E（无 GUI）
```
