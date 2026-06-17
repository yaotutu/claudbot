import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshCw, Server, ShieldCheck } from "lucide-react";

import { fetchMcpConfig, fetchSessionMcpStatus, reconnectMcpServer } from "@/lib/claudebot-api";
import type { RuntimeMcpServerStatus, WebuiMcpConfig, WebuiMcpServerConfig, WebuiMcpSessionStatus } from "@/lib/claudebot-types";
import { cn } from "@/lib/utils";

type McpPanelProps = {
  activeSessionId: string | null;
};

export function McpPanel({ activeSessionId }: McpPanelProps) {
  const [config, setConfig] = useState<WebuiMcpConfig | null>(null);
  const [sessionStatus, setSessionStatus] = useState<WebuiMcpSessionStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [reconnecting, setReconnecting] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const [nextConfig, nextStatus] = await Promise.all([
        fetchMcpConfig(),
        activeSessionId ? fetchSessionMcpStatus(activeSessionId) : Promise.resolve(null),
      ]);
      setConfig(nextConfig);
      setSessionStatus(nextStatus);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [activeSessionId]);

  useEffect(() => {
    let cancelled = false;
    setBusy(true);
    setError("");
    void Promise.all([
      fetchMcpConfig(),
      activeSessionId ? fetchSessionMcpStatus(activeSessionId) : Promise.resolve(null),
    ])
      .then(([nextConfig, nextStatus]) => {
        if (cancelled) return;
        setConfig(nextConfig);
        setSessionStatus(nextStatus);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  const statusByName = useMemo(() => {
    const rows = new Map<string, RuntimeMcpServerStatus>();
    for (const server of sessionStatus?.servers ?? []) rows.set(server.name, server);
    return rows;
  }, [sessionStatus]);

  const canReconnect = Boolean(activeSessionId && sessionStatus && sessionStatus.runtimeStatus !== "not_started");

  const reconnect = async (serverName: string) => {
    if (!activeSessionId || !canReconnect) return;
    setReconnecting(serverName);
    setError("");
    try {
      setSessionStatus(await reconnectMcpServer(activeSessionId, serverName));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setReconnecting(null);
    }
  };

  return (
    <div>
      <div className="mb-4 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold">MCP servers</h3>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
            <StatusBadge label={config?.strict ? "strict" : "permissive"} tone={config?.strict ? "good" : "neutral"} />
            <span>{sessionStatus ? `runtime ${sessionStatus.runtimeStatus}` : "no active runtime"}</span>
          </div>
        </div>
        <button
          type="button"
          aria-label="Refresh MCP status"
          onClick={() => void refresh()}
          disabled={busy}
          className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RefreshCw className={cn("h-4 w-4", busy && "animate-spin")} />
        </button>
      </div>

      {error ? <div className="mb-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] leading-5 text-destructive">{error}</div> : null}

      {busy && !config ? <div className="rounded-lg border border-border/70 bg-background px-3 py-3 text-[13px] text-muted-foreground">Loading MCP status...</div> : null}
      {!busy && config?.servers.length === 0 ? (
        <div className="rounded-lg border border-border/70 bg-background px-3 py-3 text-[13px] text-muted-foreground">未配置 MCP server</div>
      ) : null}

      <div className="space-y-3">
        {config?.servers.map((server) => (
          <McpServerRow
            key={server.name}
            server={server}
            status={statusByName.get(server.name) ?? null}
            reconnecting={reconnecting === server.name}
            reconnectDisabled={!canReconnect || Boolean(reconnecting)}
            onReconnect={() => void reconnect(server.name)}
          />
        ))}
      </div>
    </div>
  );
}

function McpServerRow({
  server,
  status,
  reconnecting,
  reconnectDisabled,
  onReconnect,
}: {
  server: WebuiMcpServerConfig;
  status: RuntimeMcpServerStatus | null;
  reconnecting: boolean;
  reconnectDisabled: boolean;
  onReconnect: () => void;
}) {
  const toolNames = extractToolNames(status);
  const metadata = [
    server.command ? `command ${server.command}` : null,
    server.url ? server.url : null,
    server.timeout === undefined ? null : `timeout ${server.timeout}ms`,
    server.alwaysLoad ? "alwaysLoad" : null,
  ].filter((item): item is string => Boolean(item));

  return (
    <section className="rounded-lg border border-border/70 bg-background px-3 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-2">
            <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="truncate text-[13px] font-semibold" title={server.name}>{server.name}</div>
            <StatusBadge label={server.type} tone="neutral" />
          </div>
          {metadata.length > 0 ? (
            <div className="mt-2 space-y-1 text-[12px] leading-5 text-muted-foreground">
              {metadata.map((item) => <div key={item} className="truncate" title={item}>{item}</div>)}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-2">
          <StatusBadge label={status?.status ?? "not loaded"} tone={statusTone(status?.status)} />
          <button
            type="button"
            aria-label={`Reconnect ${server.name}`}
            onClick={onReconnect}
            disabled={reconnectDisabled}
            className="rounded-md border border-border px-2 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-45"
          >
            {reconnecting ? "Reconnecting" : "Reconnect"}
          </button>
        </div>
      </div>

      <KeyList title="env" keys={server.envKeys} />
      <KeyList title="headers" keys={server.headerKeys} />
      <KeyList title="args" keys={server.args} />

      {toolNames.length > 0 ? (
        <div className="mt-3 border-t border-border/60 pt-3">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase text-muted-foreground">
            <ShieldCheck className="h-3.5 w-3.5" />
            Tools
          </div>
          <div className="flex flex-wrap gap-1.5">
            {toolNames.map((tool) => (
              <span key={tool} className="max-w-full truncate rounded-md bg-muted px-2 py-1 text-[12px]" title={tool}>{tool}</span>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function KeyList({ title, keys }: { title: string; keys?: string[] }) {
  if (!keys?.length) return null;
  return (
    <div className="mt-3">
      <div className="mb-1 text-[11px] font-medium uppercase text-muted-foreground">{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {keys.map((key) => (
          <span key={key} className="max-w-full truncate rounded-md border border-border/70 px-2 py-1 text-[12px] text-muted-foreground" title={key}>{key}</span>
        ))}
      </div>
    </div>
  );
}

function StatusBadge({ label, tone }: { label: string; tone: "good" | "error" | "neutral" }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center rounded-md px-1.5 py-0.5 text-[11px] font-medium",
        tone === "good" && "bg-emerald-500/12 text-emerald-700 dark:text-emerald-300",
        tone === "error" && "bg-destructive/12 text-destructive",
        tone === "neutral" && "bg-muted text-muted-foreground",
      )}
      title={label}
    >
      <span className="truncate">{label}</span>
    </span>
  );
}

function statusTone(status?: string): "good" | "error" | "neutral" {
  if (status === "connected") return "good";
  if (status === "failed" || status === "error" || status === "disconnected") return "error";
  return "neutral";
}

function extractToolNames(status: RuntimeMcpServerStatus | null): string[] {
  const tools = status?.tools;
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    if (typeof tool === "string" && tool.trim().length > 0) return [tool];
    if (isRecord(tool) && typeof tool.name === "string" && tool.name.trim().length > 0) return [tool.name];
    return [];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
