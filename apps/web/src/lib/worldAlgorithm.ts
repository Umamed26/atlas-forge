/**
 * World algorithm version adapter (v0.5 "commercial-grade generation").
 *
 * core owns `WorldDocument.algorithmVersion` and `WorldParams.terrainModel`
 * (additive). Until the finalized types arrive we access them through a cast so
 * the UI can already label classic/plates worlds and offer the one-click
 * upgrade (with undo).
 */
import type { WorldDocument, WorldParams } from "@atlas/core";

export type AlgorithmKind = "classic" | "plates";

export interface AlgorithmInfo {
  kind: AlgorithmKind;
  version: number;
  label: string;
  hint: string;
}

interface AlgorithmCarrier {
  algorithmVersion?: number;
  params: WorldParams & { terrainModel?: string };
}

const PLATES_VERSION = 2;

export function readAlgorithm(document: WorldDocument): AlgorithmInfo {
  const carrier = document as unknown as AlgorithmCarrier;
  const version =
    typeof carrier.algorithmVersion === "number" ? carrier.algorithmVersion : 1;
  const terrainModel = carrier.params?.terrainModel;
  // The badge reports the TERRAIN MODEL, not the pipeline version: v0.5 worlds
  // use the proven fBm terrain by default with the modern climate/river
  // pipeline, and the plate model is opt-in.
  const plates = terrainModel === "plates";
  if (plates) {
    return {
      kind: "plates",
      version: Math.max(version, PLATES_VERSION),
      label: "板块地形",
      hint: "板块构造驱动的山系地形（实验性，可在生成条一键切回经典）。",
    };
  }
  return version >= PLATES_VERSION
    ? {
        kind: "classic",
        version,
        label: "经典地形",
        hint: "fBm 大陆骨架 + v0.5 因果气候 / Stratler 河网；可试用板块地形。",
      }
    : {
        kind: "classic",
        version,
        label: "经典算法",
        hint: "v0.4 世界的原貌（逐字节兼容）；可升级到 v0.5 地形。",
      };
}

/** Old JSON (no version) opens in classic mode with an explicit fbm terrain model. */
export function isLegacyDocument(document: WorldDocument): boolean {
  const carrier = document as unknown as AlgorithmCarrier;
  return readAlgorithm(document).kind === "classic" && carrier.algorithmVersion === undefined;
}

/** Force the classic fbm terrain model on legacy documents (keeps their look). */
export function withClassicTerrainModel(document: WorldDocument): WorldDocument {
  const carrier = document as unknown as AlgorithmCarrier;
  if (carrier.algorithmVersion !== undefined) return document;
  return {
    ...document,
    params: {
      ...document.params,
      terrainModel: "fbm",
      stageSeeds: document.params.stageSeeds,
    },
  } as unknown as WorldDocument;
}

/** Upgrade a world to the plates algorithm (one undoable document change). */
export function withPlatesAlgorithm(document: WorldDocument): WorldDocument {
  const carrier = document as unknown as AlgorithmCarrier;
  return {
    ...document,
    algorithmVersion: Math.max(carrier.algorithmVersion ?? 1, PLATES_VERSION),
    params: { ...document.params, terrainModel: "plates" },
  } as unknown as WorldDocument;
}

export function isPlatesDocument(document: WorldDocument): boolean {
  return readAlgorithm(document).kind === "plates";
}
