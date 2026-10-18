# Atlas Forge

程序化世界地图生成器（Web）· 面向小说 / 世界观创作者。

- 参数一键生成 → 真水文 / 气候模拟 → 羊皮纸风格地图
- 画笔精修（海拔锁定、强制河道、刷群系），编辑不因重新生成丢失
- 导出 World JSON（唯一真源）与 PNG；大图（≥4096²）由 Node 后端渲染

## 开发

```bash
pnpm install
pnpm dev        # web http://localhost:5173 + api http://127.0.0.1:8787
pnpm typecheck
pnpm test
pnpm qa:render  # Node 端生成 QA PNG 到 out/
```

详见 [TODO.md](./TODO.md) 的里程碑、数据契约与验收标准。
