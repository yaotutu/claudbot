import type { ThreadActivity, ThreadMessage } from "@/lib/claudebot-types";

import type { ClaudebotChatSummary, ClaudebotSessionItem, ClaudebotUIMessage } from "./types";

export function toClaudebotChats(sessions: ClaudebotSessionItem[]): ClaudebotChatSummary[] {
  return sessions.map((session) => ({
    key: session.id,
    id: session.id,
    title: displaySessionTitle(session),
    preview: session.preview,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    status: session.status,
    messageCount: session.messageCount,
  }));
}

export function toClaudebotMessages(messages: ThreadMessage[]): ClaudebotUIMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    createdAt: message.createdAt,
    isStreaming: message.metadata?.streaming === true,
    isError: message.metadata?.error === true,
    activities: activitiesFromMetadata(message),
  }));
}

export function displaySessionTitle(session: ClaudebotSessionItem): string {
  const title = session.title.trim();
  if (title) return title;
  const preview = session.preview.replace(/\s+/g, " ").trim();
  if (!preview) return "New chat";
  return preview.length > 60 ? `${preview.slice(0, 57)}...` : preview;
}

export function formatModelLabel(model: string, providerModel: string): string {
  return providerModel.length > 0 ? `${model} -> ${providerModel}` : model;
}

function activitiesFromMetadata(message: ThreadMessage): ThreadActivity[] {
  const metadataActivities = message.metadata?.activities;
  if (Array.isArray(metadataActivities)) {
    return metadataActivities.filter(isThreadActivity);
  }

  const runId = typeof message.metadata?.runId === "string" ? message.metadata.runId : message.id;
  const activities: ThreadActivity[] = [];
  if (typeof message.metadata?.thinking === "string" && message.metadata.thinking.trim()) {
    const timestamp = message.createdAt;
    activities.push({
      id: `thinking-${runId}`,
      kind: "thinking",
      runId,
      text: message.metadata.thinking,
      status: "complete",
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  const toolCalls = message.metadata?.toolCalls;
  if (Array.isArray(toolCalls)) {
    for (const tool of toolCalls) {
      const toolId = readStringField(tool, "id");
      const name = readStringField(tool, "name") || "Tool";
      const timestamp = message.createdAt;
      activities.push({
        id: `tool-${toolId || `${runId}-${activities.length}`}`,
        kind: "tool",
        runId,
        toolId: toolId || `${runId}-${activities.length}`,
        name,
        phase: "end",
        input: readUnknownField(tool, "input"),
        status: "complete",
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
  }

  return activities;
}

function isThreadActivity(value: unknown): value is ThreadActivity {
  if (!value || typeof value !== "object") return false;
  const activity = value as Record<string, unknown>;
  const status = activity.status;
  return typeof activity.id === "string"
    && (activity.kind === "thinking" || activity.kind === "tool" || activity.kind === "status")
    && (status === "running" || status === "complete" || status === "error");
}

function readStringField(value: unknown, field: string): string {
  if (!value || typeof value !== "object") return "";
  const current = (value as Record<string, unknown>)[field];
  return typeof current === "string" ? current : "";
}

function readUnknownField(value: unknown, field: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[field];
}
