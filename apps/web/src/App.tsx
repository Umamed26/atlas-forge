import { useCallback, useRef, useState } from "react";

import { AutosaveRecoveryPanel } from "./components/AutosaveRecoveryPanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ExportDialog } from "./components/ExportDialog";
import { HelpDialog } from "./components/HelpDialog";
import { MapStage } from "./components/MapStage";
import { ParamPanel } from "./components/ParamPanel";
import { StatusBar } from "./components/StatusBar";
import { StylePanel } from "./components/StylePanel";
import { ToastViewport } from "./components/Toast";
import { TopBar } from "./components/TopBar";
import { useAppPipeline } from "./hooks/useAppPipeline";
import { useShortcuts } from "./hooks/useShortcuts";

type DialogId = "export" | "help" | null;

function AppShell() {
  useAppPipeline();
  const [dialog, setDialog] = useState<DialogId>(null);
  const dialogRef = useRef<DialogId>(null);
  dialogRef.current = dialog;

  const openExport = useCallback(() => setDialog("export"), []);
  const openHelp = useCallback(() => setDialog("help"), []);
  const closeOverlays = useCallback((): boolean => {
    if (dialogRef.current === null) return false;
    setDialog(null);
    return true;
  }, []);
  const closeDialog = useCallback(() => setDialog(null), []);

  useShortcuts({ onOpenExport: openExport, onOpenHelp: openHelp, closeOverlays });

  return (
    <div className="app">
      <TopBar onOpenExport={openExport} onOpenHelp={openHelp} />
      <AutosaveRecoveryPanel />
      <main className="layout">
        <ParamPanel />
        <MapStage />
        <StylePanel />
      </main>
      <StatusBar />
      <ExportDialog open={dialog === "export"} onClose={closeDialog} />
      <HelpDialog open={dialog === "help"} onClose={closeDialog} />
      <ToastViewport />
    </div>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <AppShell />
    </ErrorBoundary>
  );
}
