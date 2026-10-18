/**
 * Global keyboard shortcuts. Editable inputs are never hijacked except for
 * Escape (which closes overlays / cancels river drawing).
 */
import { useEffect, useRef } from "react";

import { focusMapCanvas } from "../lib/focus";
import { TOOL_SHORTCUTS } from "../lib/shortcuts";
import { isEditableTarget } from "../lib/utils";
import { useViewStore } from "../state/viewStore";
import { useWorldStore } from "../state/worldStore";

export interface ShortcutHandlers {
  onOpenHelp: () => void;
  onOpenExport: () => void;
  closeOverlays: () => boolean;
}

export function useShortcuts(handlers: ShortcutHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const world = useWorldStore.getState();
      const view = useViewStore.getState();
      const editable = isEditableTarget(event.target);
      const key = event.key;
      const lower = key.length === 1 ? key.toLowerCase() : key;
      const mod = event.ctrlKey || event.metaKey;

      // Escape always works, in priority order: dialogs → rename → placement →
      // place selection → river drafting.
      if (key === "Escape") {
        const closed = handlersRef.current.closeOverlays();
        if (closed) return;
        if (world.placeRename) {
          world.cancelPlaceRename();
          focusMapCanvas();
          return;
        }
        if (world.placeTool.armed) {
          world.disarmPlacement();
          focusMapCanvas();
          return;
        }
        if (world.selectedPlace) {
          world.selectPlace(null);
          focusMapCanvas();
          return;
        }
        if (world.riverDraft.points.length > 0) {
          world.clearRiverDraft();
          world.pushToast("info", "已取消河道绘制");
          focusMapCanvas();
        }
        return;
      }

      if (editable) return;

      if (mod) {
        if (lower === "z") {
          event.preventDefault();
          if (event.shiftKey) world.redo();
          else world.undo();
          return;
        }
        if (lower === "y") {
          event.preventDefault();
          world.redo();
          return;
        }
        if (key === "Enter") {
          event.preventDefault();
          world.requestGeneration("now");
          return;
        }
        return;
      }

      const toolShortcut = TOOL_SHORTCUTS[lower];
      if (toolShortcut) {
        event.preventDefault();
        world.setTool(toolShortcut);
        return;
      }

      switch (lower) {
        case "f":
          event.preventDefault();
          view.fit();
          break;
        case "0":
          event.preventDefault();
          view.oneToOne();
          break;
        case "+":
        case "=":
          event.preventDefault();
          view.zoomBy(1.25);
          break;
        case "-":
        case "_":
          event.preventDefault();
          view.zoomBy(0.8);
          break;
        case "?":
          event.preventDefault();
          handlersRef.current.onOpenHelp();
          break;
        case "Enter":
          if (world.riverDraft.points.length >= 2) {
            event.preventDefault();
            world.commitRiverDraft();
          }
          break;
        case "Backspace":
          if (world.riverDraft.points.length > 0) {
            event.preventDefault();
            world.undoRiverPoint();
          }
          break;
        case "Delete":
          if (world.selectedPlace) {
            event.preventDefault();
            world.deletePlace(world.selectedPlace.id, world.selectedPlace.entity);
          }
          break;
        default:
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
