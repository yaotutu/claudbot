// Bootstrap adapter: claudebot's /webui/bootstrap returns a different shape
// (no token, no ws_path), so we synthesize the BootstrapResponse shape that
// the rest of the copied nanobot code expects.

import type { BootstrapResponse } from "./types";

/**
 * Fetch /webui/bootstrap. Claudebot has no auth secret — the gateway is
 * local-only for the MVP. We synthesize a BootstrapResponse so the copied
 * UI code can call into it without a separate code path.
 */
export async function fetchBootstrap(
  baseUrl: string = "",
  _secret: string = "",
  timeoutMs?: number,
): Promise<BootstrapResponse> {
  const controller = new AbortController();
  const t = timeoutMs && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null;
  try {
    const res = await fetch(`${baseUrl}/webui/bootstrap`, {
      method: "GET",
      credentials: "same-origin",
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`bootstrap failed: HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      config?: { claudeCode?: { model?: string } };
      lastActiveSessionId?: string;
      sessions?: unknown[];
    };
    return {
      token: "",
      ws_path: "/ws",
      ws_url: null,
      expires_in: 86_400,
      model_name: body.config?.claudeCode?.model ?? "glm-5.1",
    };
  } finally {
    if (t) clearTimeout(t);
  }
}

/** Derive a WebSocket URL from the current window location. */
export function deriveWsUrl(
  wsPath: string,
  _token: string,
  wsUrl?: string | null,
): string {
  if (wsUrl && /^wss?:\/\//i.test(wsUrl)) return wsUrl;
  const path = wsPath && wsPath.startsWith("/") ? wsPath : `/${wsPath || ""}`;
  if (typeof window === "undefined") {
    return `ws://127.0.0.1:18790${path}`;
  }
  if (window.location.port === "5173") {
    const host = window.location.hostname.includes(":")
      ? `[${window.location.hostname}]`
      : window.location.hostname;
    return `ws://${host}:18790${path}`;
  }
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}${path}`;
}

/* No-op secret storage — claudebot has no auth secret for the local MVP. */
export function loadSavedSecret(): string { return ""; }
export function saveSecret(_secret: string): void { /* no-op */ }
export function clearSavedSecret(): void { /* no-op */ }
