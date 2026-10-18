/** Recovery panel shown when the browser autosave cannot be parsed. */
import { formatClock } from "../lib/utils";
import { useWorldStore } from "../state/worldStore";

export function AutosaveRecoveryPanel() {
  const recovery = useWorldStore((state) => state.autosaveRecovery);
  if (!recovery) return null;
  return (
    <div className="autosave-recovery" data-testid="autosave-recovery" role="alert">
      <div className="autosave-recovery-copy">
        <strong>自动存档损坏</strong>
        <span>{recovery.message}</span>
        {recovery.hasBackup ? (
          <span>
            找到上一份可用备份
            {recovery.backupSavedAt ? `（${formatClock(recovery.backupSavedAt)}）` : ""}，
            可恢复或清空后继续。
          </span>
        ) : (
          <span>没有可恢复的备份，可清空损坏存档后继续使用当前世界。</span>
        )}
      </div>
      <div className="autosave-recovery-actions">
        {recovery.hasBackup ? (
          <button
            type="button"
            className="btn btn--small btn--primary"
            data-testid="autosave-recover"
            onClick={() => useWorldStore.getState().recoverAutosave()}
          >
            恢复上一份
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--small btn--ghost"
          data-testid="autosave-clear"
          onClick={() => useWorldStore.getState().clearCorruptedAutosave()}
        >
          清空存档
        </button>
      </div>
    </div>
  );
}
