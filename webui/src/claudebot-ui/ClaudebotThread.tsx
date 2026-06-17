import {
  Activity,
  AlertCircle,
  Brain,
  CheckCircle2,
  Menu,
  MoreHorizontal,
  Wrench,
} from "lucide-react";

import { cn } from "@/lib/utils";
import type { ThreadActivity } from "@/lib/claudebot-types";

import { ClaudebotComposer } from "./ClaudebotComposer";
import type { ClaudebotChatSummary, ClaudebotUIMessage } from "./types";

type ClaudebotThreadProps = {
  activeSession: ClaudebotChatSummary | null;
  messages: ClaudebotUIMessage[];
  activities: ThreadActivity[];
  runStatus: string | null;
  loading: boolean;
  streaming: boolean;
  disabled: boolean;
  modelLabel: string;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  onSend: (content: string) => void;
  onCancel: () => void;
  onNewChat: () => void;
  hasSession: boolean;
};

export function ClaudebotThread({
  activeSession,
  messages,
  activities,
  runStatus,
  loading,
  streaming,
  disabled,
  modelLabel,
  sidebarCollapsed,
  onToggleSidebar,
  onSend,
  onCancel,
  onNewChat,
  hasSession,
}: ClaudebotThreadProps) {
  const hasMessages = messages.length > 0;

  return (
    <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border/35 px-4">
        {sidebarCollapsed ? (
          <button
            type="button"
            aria-label="Expand sidebar"
            onClick={onToggleSidebar}
            className="grid h-9 w-9 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Menu className="h-4 w-4" />
          </button>
        ) : null}
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-foreground">
            {activeSession?.title ?? "New chat"}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {activeSession?.status === "draft" ? "Draft conversation" : modelLabel}
          </div>
        </div>
        <button
          type="button"
          aria-label="Conversation options"
          className="grid h-9 w-9 place-items-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </header>

      <section className="relative min-h-0 flex-1 overflow-hidden">
        <div className="absolute inset-0 overflow-y-auto px-4">
          {loading ? (
            <div className="mx-auto flex h-full max-w-3xl items-center justify-center text-sm text-muted-foreground">
              Loading conversation...
            </div>
          ) : !hasMessages ? (
            <div className="mx-auto flex h-full max-w-4xl flex-col items-center justify-center pb-32 text-center">
              <h1 className="max-w-[34rem] text-balance text-[34px] font-normal leading-[1.08] tracking-normal text-foreground sm:text-[48px] sm:leading-tight">
                What can I help you ship today?
              </h1>
              <p className="mt-4 max-w-[30rem] text-[14px] leading-6 text-muted-foreground">
                Start a new Claudebot run in this workspace.
              </p>
              <ClaudebotComposer
                hero
                disabled={disabled}
                streaming={streaming}
                modelLabel={modelLabel}
                onSend={onSend}
                onStop={onCancel}
                onNewChat={onNewChat}
                hasSession={hasSession}
              />
            </div>
          ) : (
            <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col py-8">
              <div className="flex flex-1 flex-col">
                {messages.map((message, index) => (
                  <MessageRow key={message.id} message={message} previousRole={messages[index - 1]?.role ?? null} />
                ))}
                <ActivityTimeline activities={activities} />
                {streaming ? <StreamingRow label={runStatus ?? "Claudebot is working"} /> : null}
              </div>
              <div className="h-36" aria-hidden />
            </div>
          )}
        </div>
      </section>

      {hasMessages ? (
        <div className="shrink-0 bg-gradient-to-t from-background via-background to-background/0 pt-8">
          <ClaudebotComposer
            disabled={disabled}
            streaming={streaming}
            modelLabel={modelLabel}
            onSend={onSend}
            onStop={onCancel}
            onNewChat={onNewChat}
            hasSession={hasSession}
          />
        </div>
      ) : null}
    </main>
  );
}

function MessageRow({ message, previousRole }: { message: ClaudebotUIMessage; previousRole: ClaudebotUIMessage["role"] | null }) {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const dense = previousRole === message.role && !isUser;

  if (isSystem) {
    return (
      <div className="my-3 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-[13px] leading-6 text-destructive">
        {message.content}
      </div>
    );
  }

  return (
    <article
      className={cn(
        "animate-in fade-in-0 slide-in-from-bottom-1 duration-300",
        dense ? "mt-2" : "mt-5",
        isUser ? "ml-auto flex max-w-[min(85%,36rem)] flex-col items-end" : "w-full",
      )}
    >
      {isUser ? (
        <div className="rounded-[18px] bg-secondary/75 px-4 py-2 text-left text-[16px] leading-[1.75] whitespace-pre-wrap break-words">
          {message.content}
        </div>
      ) : (
        <div
          className={cn(
            "text-[15px] leading-[var(--cjk-line-height)] text-foreground",
            message.isError && "text-destructive",
          )}
        >
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
          <ActivityTimeline activities={message.activities} />
          {message.isStreaming ? (
            <div className="mt-2 text-[12px] text-muted-foreground">Streaming...</div>
          ) : null}
        </div>
      )}
    </article>
  );
}

function ActivityTimeline({ activities }: { activities: ThreadActivity[] }) {
  if (activities.length === 0) return null;

  return (
    <section
      aria-label="Run activity"
      className="mt-5 flex w-full flex-col gap-2 text-[13px]"
    >
      {activities.map((activity) => (
        <ActivityCard key={activity.id} activity={activity} />
      ))}
    </section>
  );
}

function ActivityCard({ activity }: { activity: ThreadActivity }) {
  if (activity.kind === "thinking") {
    return (
      <details
        open={activity.status === "running"}
        className={activityCardClass(activity.status)}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 marker:hidden">
          <Brain className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 font-medium">Thinking</span>
          <ActivityStatusBadge status={activity.status} />
        </summary>
        {activity.text.trim() ? (
          <p className="border-t border-border/50 px-3 py-2 text-[12.5px] leading-5 text-muted-foreground whitespace-pre-wrap">
            {activity.text}
          </p>
        ) : null}
      </details>
    );
  }

  if (activity.kind === "tool") {
    return (
      <details
        open={activity.status === "running" || activity.status === "error"}
        className={activityCardClass(activity.status)}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 marker:hidden">
          <Wrench className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate font-medium">{activity.name}</span>
          <span className="shrink-0 text-[11px] capitalize text-muted-foreground">{activity.phase}</span>
          <ActivityStatusBadge status={activity.status} />
        </summary>
        <div className="space-y-2 border-t border-border/50 px-3 py-2">
          {activity.input !== undefined ? (
            <ActivityPayload label="Input" value={activity.input} />
          ) : null}
          {activity.output !== undefined ? (
            <ActivityPayload label={activity.status === "error" ? "Error" : "Output"} value={activity.output} />
          ) : null}
        </div>
      </details>
    );
  }

  return (
    <div className={activityCardClass(activity.status)}>
      <div className="flex items-center gap-2 px-3 py-2">
        <Activity className="h-4 w-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{activity.text}</span>
        {activity.mcpServers?.length ? (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {activity.mcpServers.length} MCP
          </span>
        ) : null}
        <ActivityStatusBadge status={activity.status} />
      </div>
    </div>
  );
}

function ActivityPayload({ label, value }: { label: string; value: unknown }) {
  const text = summarizeActivityValue(value);
  if (!text) return null;
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground/70">
        {label}
      </div>
      <pre className="max-h-36 overflow-auto rounded-lg bg-muted/55 px-2.5 py-2 text-[11.5px] leading-5 text-muted-foreground whitespace-pre-wrap break-words">
        {text}
      </pre>
    </div>
  );
}

function ActivityStatusBadge({ status }: { status: ThreadActivity["status"] }) {
  const Icon = status === "error" ? AlertCircle : status === "complete" ? CheckCircle2 : Activity;
  const label = status === "error" ? "Error" : status === "complete" ? "Done" : "Running";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        status === "error"
          ? "bg-destructive/10 text-destructive"
          : status === "complete"
            ? "bg-emerald-500/10 text-emerald-700"
            : "bg-muted text-muted-foreground",
      )}
    >
      <Icon className="h-3 w-3" aria-hidden />
      {label}
    </span>
  );
}

function activityCardClass(status: ThreadActivity["status"]): string {
  return cn(
    "overflow-hidden rounded-xl border bg-background/80 shadow-sm",
    status === "error" ? "border-destructive/25" : "border-border/65",
  );
}

function summarizeActivityValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return truncateActivityText(value);
  try {
    return truncateActivityText(JSON.stringify(value, null, 2));
  } catch {
    return truncateActivityText(String(value));
  }
}

function truncateActivityText(value: string): string {
  const clean = value.trim();
  return clean.length > 700 ? `${clean.slice(0, 697)}...` : clean;
}

function StreamingRow({ label }: { label: string }) {
  return (
    <div className="mt-5 flex items-center gap-2 text-[13px] text-muted-foreground">
      <span className="h-2 w-2 animate-pulse rounded-full bg-foreground/55" />
      {label}
    </div>
  );
}
