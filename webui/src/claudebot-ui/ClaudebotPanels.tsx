import { X } from "lucide-react";

import type { RuntimeInfo } from "@/lib/claudebot-types";
import { cn } from "@/lib/utils";

import type { ClaudebotUtilityPanel } from "./types";

type ClaudebotPanelsProps = {
  panel: Exclude<ClaudebotUtilityPanel, "tasks" | null>;
  runtime: RuntimeInfo;
  onClose: () => void;
};

export function ClaudebotPanels({ panel, runtime, onClose }: ClaudebotPanelsProps) {
  return (
    <div className="absolute inset-y-4 right-4 z-40 flex w-[min(420px,calc(100vw-2rem))] flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border/60 px-4">
        <h2 className="text-sm font-semibold">{panelTitle(panel)}</h2>
        <button
          type="button"
          aria-label="Close panel"
          onClick={onClose}
          className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 text-sm">
        {panel === "settings" ? <SettingsPanel runtime={runtime} /> : null}
        {panel === "search" ? <PlaceholderPanel title="Search" body="会话搜索暂未接入。当前迁移阶段先复用 Nanobot 的入口和反馈，再按 Claudebot 原生协议补搜索索引。" /> : null}
        {panel === "skills" ? <PlaceholderPanel title="Skills" body="技能目录暂未接入。后续只会通过 Claudebot 原生 API 暴露 skills，不兼容 Nanobot 的旧接口。" /> : null}
      </div>
    </div>
  );
}

function SettingsPanel({ runtime }: { runtime: RuntimeInfo }) {
  const rows = [
    ["Model", runtime.providerModel.length > 0 ? `${runtime.model} -> ${runtime.providerModel}` : runtime.model],
    ["Workspace", runtime.workspace],
    ["Home", runtime.home],
    ["Gateway", `${runtime.gateway.host}:${runtime.gateway.port}`],
    ["Permission", runtime.permissionMode],
  ] as const;
  return (
    <div>
      <div className="mb-4">
        <h3 className="text-base font-semibold">运行状态</h3>
        <p className="mt-1 text-[13px] leading-6 text-muted-foreground">
          Claudebot runtime is connected through the native WebUI protocol.
        </p>
      </div>
      <dl className="grid gap-2">
        {rows.map(([label, value]) => (
          <div key={label} className={cn("rounded-xl border border-border/60 bg-background px-3 py-2")}>
            <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</dt>
            <dd className="mt-1 truncate text-[13px]" title={value}>{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function PlaceholderPanel({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <h3 className="text-base font-semibold">{title}</h3>
      <p className="mt-3 text-[13px] leading-6 text-muted-foreground">{body}</p>
    </div>
  );
}

function panelTitle(panel: Exclude<ClaudebotUtilityPanel, "tasks" | null>): string {
  if (panel === "settings") return "Settings";
  if (panel === "search") return "Search";
  return "Skills";
}
