import { useCallback, useRef, useState } from "react";

import { AutosaveRecoveryPanel } from "./components/AutosaveRecoveryPanel";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { GenerateBar } from "./components/GenerateBar";
import { WelcomePanel } from "./components/WelcomePanel";
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
import { SCENARIOS, randomScenarioId } from "./lib/scenarios";
import { UI_PREF_KEYS, readStoredBoolean, writeStoredBoolean } from "./lib/uiPrefs";
import { useWorldStore } from "./state/worldStore";

type DialogId = "export" | "help" | null;

function AppShell() {
  useAppPipeline();
  const [dialog, setDialog] = useState<DialogId>(null);
  const [welcomeOpen, setWelcomeOpen] = useState<boolean>(() => {
    const onboarded = readStoredBoolean(UI_PREF_KEYS.onboarded, false);
    return !onboarded && !useWorldStore.getState().restoredFromAutosave;
  });
  const scenarioId = useWorldStore((state) => state.scenarioId);
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

  const finishWelcome = () => {
    writeStoredBoolean(UI_PREF_KEYS.onboarded, true);
    setWelcomeOpen(false);
  };
  const pickScenario = (id: string) => {
    useWorldStore.getState().applyScenario(id);
    finishWelcome();
  };
  const randomScenario = () => {
    pickScenario(randomScenarioId(scenarioId));
  };

  return (
    <div className="app">
      <TopBar onOpenExport={openExport} onOpenHelp={openHelp} />
      <GenerateBar onOpenScenario={() => setWelcomeOpen(true)} onOpenExport={openExport} />
      <AutosaveRecoveryPanel />
      <main className="layout">
        <ParamPanel />
        <MapStage />
        <StylePanel />
      </main>
      <StatusBar />
      <ExportDialog open={dialog === "export"} onClose={closeDialog} />
      <HelpDialog open={dialog === "help"} onClose={closeDialog} />
      <WelcomePanel
        open={welcomeOpen}
        scenarios={SCENARIOS}
        currentScenarioId={scenarioId}
        onPick={pickScenario}
        onRandom={randomScenario}
        onSkip={finishWelcome}
      />
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
