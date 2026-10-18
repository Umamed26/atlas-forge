/** Help dialog: workflow, brush semantics, shortcuts, data model. */
import { KEYBOARD_SHORTCUTS, TOOLS } from "../lib/constants";
import { Kbd, Modal } from "./ui";

export interface HelpDialogProps {
  open: boolean;
  onClose: () => void;
}

export function HelpDialog({ open, onClose }: HelpDialogProps) {
  return (
    <Modal
      open={open}
      title="使用说明与快捷键"
      subtitle="Atlas Forge：用种子 + 参数 + 少量画笔，几分钟做出一张自洽的世界地图。"
      onClose={onClose}
      width={760}
      testId="help-dialog"
      footer={
        <div className="dialog-actions">
          <button type="button" className="btn btn--primary" onClick={onClose} data-testid="help-close">
            开始创作
          </button>
        </div>
      }
    >
      <div className="help-grid">
        <section className="help-section">
          <h3>快速上手</h3>
          <ol className="help-steps">
            <li>顶栏填世界名与种子，点「生成」得到第一版世界。</li>
            <li>左栏调地形 / 水文 / 气候参数，松手即重算（拖动时 120ms 防抖）。</li>
            <li>选择「海拔 / 河道 / 群系」画笔，在地图上精修局部；编辑按归一化世界坐标保存。</li>
            <li>右栏调风格 / 图例 / 纸纹，只重绘不重算；视觉满意后导出 PNG 或 JSON。</li>
            <li>所有改动 800ms 后自动保存到浏览器本地，刷新不丢；JSON 是唯一真源。</li>
          </ol>
        </section>

        <section className="help-section">
          <h3>画笔工具</h3>
          <ul className="help-tools">
            {TOOLS.map((tool) => (
              <li key={tool.id}>
                <span className="help-tool-icon" aria-hidden="true">{tool.icon}</span>
                <div>
                  <strong>
                    {tool.label} <Kbd>{tool.shortcut}</Kbd>
                  </strong>
                  <p>{tool.hint}</p>
                </div>
              </li>
            ))}
          </ul>
          <p className="help-note">
            海拔画笔三种模式：抬升 / 压低叠加高度增量，锁定把区域海拔固定到目标值；
            河道会在地形填洼前刻槽；群系涂抹覆盖气候分类结果。
          </p>
        </section>

        <section className="help-section">
          <h3>快捷键</h3>
          <table className="shortcut-table">
            <tbody>
              {KEYBOARD_SHORTCUTS.map((shortcut) => (
                <tr key={shortcut.keys}>
                  <td>
                    <Kbd>{shortcut.keys}</Kbd>
                  </td>
                  <td>{shortcut.action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        <section className="help-section">
          <h3>导出与数据</h3>
          <ul className="help-bullets">
            <li>PNG：1024 / 2048 浏览器本地渲染；4096 / 8192 走 Node 服务端，服务离线时明确提示并可降级。</li>
            <li>JSON：包含 version / 种子 / 参数 / 风格 / 世界坐标编辑 / 用户标注，导入时校验 version=1 并合并缺省字段。</li>
            <li>重新生成、换种子再换回：画笔编辑都会保留，因为编辑不依赖模拟网格分辨率。</li>
            <li>撤销 / 重做按「一次笔画或一次操作」快照，深度 50。</li>
          </ul>
        </section>
      </div>
    </Modal>
  );
}
