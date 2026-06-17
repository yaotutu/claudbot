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
  return Array.isArray(metadataActivities) ? metadataActivities.filter(isThreadActivity) : [];
}

function isThreadActivity(value: unknown): value is ThreadActivity {
  if (!value || typeof value !== "object") return false;
  const activity = value as Record<string, unknown>;
  const status = activity.status;
  return typeof activity.id === "string"
    && (activity.kind === "thinking" || activity.kind === "tool" || activity.kind === "status")
    && (status === "running" || status === "complete" || status === "error");
}
