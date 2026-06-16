import type { RuntimeInfo } from "@/lib/claudebot-types";

export function InfoPanel({ panel, runtime, onClose }: { panel: "settings" | "search" | "skills"; runtime: RuntimeInfo; onClose: () => void }) {
  const modelLabel = formatModelLabel(runtime);
  return (
    <div className="absolute right-5 top-16 z-20 w-[360px] rounded-lg border border-border bg-popover p-4 text-sm shadow-xl">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">{panel === "settings" ? "运行状态" : panel === "search" ? "Search" : "Skills"}</h2>
        <button className="rounded-md px-2 py-1 text-muted-foreground hover:bg-muted" onClick={onClose}>Close</button>
      </div>
      {panel === "settings" ? (
        <dl className="grid gap-2 text-xs">
          <InfoRow label="Model" value={modelLabel} />
          <InfoRow label="Workspace" value={runtime.workspace} />
          <InfoRow label="Home" value={runtime.home} />
          <InfoRow label="Gateway" value={`${runtime.gateway.host}:${runtime.gateway.port}`} />
          <InfoRow label="Permission" value={runtime.permissionMode} />
        </dl>
      ) : panel === "search" ? (
        <p className="text-muted-foreground">会话搜索暂未接入。当前重构阶段先保证原生会话、消息流和运行状态稳定。</p>
      ) : (
        <p className="text-muted-foreground">技能目录暂未接入。当前可用能力由 claudebot 运行时和内置工具提供。</p>
      )}
    </div>
  );
}

function formatModelLabel(runtime: RuntimeInfo): string {
  return runtime.providerModel.length > 0 ? `${runtime.model} -> ${runtime.providerModel}` : runtime.model;
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate" title={value}>{value}</dd>
    </div>
  );
}
