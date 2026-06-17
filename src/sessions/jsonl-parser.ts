import { readFile, stat } from "node:fs/promises";

import type { ThreadActivity } from "../shared/webui-protocol.ts";

export type UIMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  metadata: Record<string, unknown>;
};

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

type Entry = {
  type: string;
  uuid?: string;
  timestamp?: string;
  message?: { role?: string; content?: ContentBlock[] | string };
  runId?: string;
  activities?: unknown;
};

type PendingRunActivity = {
  runId?: string;
  timestamp?: string;
  activities: ThreadActivity[];
};

export function flattenContent(content: ContentBlock[] | string | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push((block as { text: string }).text);
    } else if (block.type === "tool_use") {
      const tb = block as { name: string };
      parts.push(`[tool:${tb.name}]`);
    }
  }
  return parts.map((p) => p.trim()).filter((p) => p.length > 0).join(" ");
}

export function extractMetadata(content: ContentBlock[] | string | undefined): Record<string, unknown> {
  if (!content || typeof content === "string") return {};
  const meta: Record<string, unknown> = {};
  const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
  const thinkings: string[] = [];
  for (const block of content) {
    if (block.type === "tool_use") {
      const tb = block as { id: string; name: string; input: unknown };
      toolCalls.push({ id: tb.id, name: tb.name, input: tb.input });
    } else if (block.type === "thinking") {
      const tb = block as { thinking: string };
      thinkings.push(tb.thinking);
    }
  }
  if (toolCalls.length > 0) meta.toolCalls = toolCalls;
  if (thinkings.length > 0) meta.thinking = thinkings.join("\n");
  return meta;
}

export async function parseJsonlToUIMessages(filePath: string): Promise<UIMessage[]> {
  const text = await readFile(filePath, "utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);

  // Compute mtime once for timestamp fallback
  let mtimeIso: string | null = null;
  try {
    const st = await stat(filePath);
    mtimeIso = st.mtime.toISOString();
  } catch {
    // ignore; fallback handled inline
  }

  const out: UIMessage[] = [];
  const pendingActivities: PendingRunActivity[] = [];
  for (const line of lines) {
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue; // skip malformed lines (the SDK may write partial markers)
    }
    if (entry.type === "claudebot-run-activity") {
      const activities = Array.isArray(entry.activities) ? entry.activities.filter(isThreadActivity) : [];
      if (activities.length > 0) {
        pendingActivities.push({ runId: entry.runId, timestamp: entry.timestamp, activities });
      }
      continue;
    }
    if (entry.type !== "user" && entry.type !== "assistant" && entry.type !== "system") continue;
    if (!entry.message) continue;

    const content = entry.message?.content;
    const id = entry.uuid ?? crypto.randomUUID();
    const createdAt = entry.timestamp ?? mtimeIso ?? new Date().toISOString();
    const role = entry.type as "user" | "assistant" | "system";
    if (isToolTransportRecord(role, content)) continue;
    const visibleContent = flattenContent(content);
    if (role !== "user" && visibleContent.length === 0) continue;

    out.push({
      id,
      role,
      content: visibleContent,
      createdAt,
      metadata: extractMetadata(content),
    });
  }
  for (const activity of pendingActivities) {
    attachRunActivity(out, activity);
  }
  return out;
}

function isToolTransportRecord(role: UIMessage["role"], content: ContentBlock[] | string | undefined): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  if (content.some((block) => block.type === "text" && typeof block.text === "string" && block.text.trim().length > 0)) {
    return false;
  }
  if (role === "assistant") {
    return content.some((block) => block.type === "tool_use");
  }
  if (role === "user") {
    return content.some((block) => block.type === "tool_result");
  }
  return false;
}

function attachRunActivity(messages: UIMessage[], entry: PendingRunActivity): void {
  const messageIndex = findActivityTargetMessageIndex(messages, entry.timestamp);
  if (messageIndex === -1) return;
  const message = messages[messageIndex];
  const existingActivities = Array.isArray(message.metadata.activities)
    ? message.metadata.activities.filter(isThreadActivity)
    : [];
  messages[messageIndex] = {
    ...message,
    metadata: {
      ...message.metadata,
      ...(typeof entry.runId === "string" ? { runId: entry.runId } : {}),
      activities: [...existingActivities, ...entry.activities],
    },
  };
}

function findActivityTargetMessageIndex(messages: UIMessage[], activityTimestamp?: string): number {
  const activityTime = activityTimestamp ? Date.parse(activityTimestamp) : Number.NaN;
  if (Number.isFinite(activityTime)) {
    let bestIndex = -1;
    let bestTime = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index];
      if (message.role === "user") continue;
      const messageTime = Date.parse(message.createdAt);
      if (!Number.isFinite(messageTime) || messageTime > activityTime || messageTime < bestTime) continue;
      bestIndex = index;
      bestTime = messageTime;
    }
    if (bestIndex !== -1) return bestIndex;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role !== "user") return index;
  }
  return -1;
}

function isThreadActivity(value: unknown): value is ThreadActivity {
  if (!value || typeof value !== "object") return false;
  const activity = value as Record<string, unknown>;
  const status = activity.status;
  if (status !== "running" && status !== "complete" && status !== "error") return false;
  if (typeof activity.id !== "string" || typeof activity.runId !== "string") return false;
  if (activity.kind === "thinking") return typeof activity.text === "string";
  if (activity.kind === "tool") {
    return typeof activity.toolId === "string"
      && typeof activity.name === "string"
      && (activity.phase === "start" || activity.phase === "end" || activity.phase === "error");
  }
  if (activity.kind === "status") return typeof activity.text === "string";
  return false;
}
