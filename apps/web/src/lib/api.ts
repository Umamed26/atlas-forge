/** Node backend health probe + server status store sync. */
import { isDesktop } from "./desktopBridge";
import { useWorldStore } from "../state/worldStore";

export interface ServerHealth {
  online: boolean;
  latencyMs: number | null;
  maxSize: number | null;
}

interface HealthPayload {
  ok?: boolean;
  capabilities?: { maxRenderSize?: number };
}

export async function fetchServerHealth(timeoutMs = 3000): Promise<ServerHealth> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  try {
    const response = await fetch("/api/health", {
      signal: controller.signal,
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const latencyMs = performance.now() - startedAt;
    if (!response.ok) {
      return { online: false, latencyMs, maxSize: null };
    }
    let maxSize: number | null = null;
    try {
      const payload = (await response.json()) as HealthPayload;
      const candidate = payload.capabilities?.maxRenderSize;
      if (typeof candidate === "number" && Number.isFinite(candidate)) maxSize = candidate;
    } catch {
      // health responded but body was not JSON: still consider it online
    }
    return { online: true, latencyMs, maxSize };
  } catch {
    return { online: false, latencyMs: null, maxSize: null };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe the API and mirror the result into the world store. */
export async function refreshServerStatus(): Promise<ServerHealth> {
  if (isDesktop()) {
    // The Electron shell has no HTTP server: probing `/api/health` under the
    // packaged `app://` origin would 404 (and pollute the renderer console).
    // Desktop exports go through IPC instead — mark the status explicitly.
    useWorldStore
      .getState()
      .setServerStatus({ phase: "desktop", latencyMs: null, maxSize: null });
    return { online: false, latencyMs: null, maxSize: null };
  }
  const health = await fetchServerHealth();
  useWorldStore.getState().setServerStatus({
    phase: health.online ? "online" : "offline",
    latencyMs: health.latencyMs,
    maxSize: health.maxSize,
  });
  return health;
}
