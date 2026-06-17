import { useCallback, useEffect, useRef, useState } from "react";

import type {
  RuntimeMcpServerStatus,
  ServerFrame,
  ThreadActivity,
  ThreadActivityStatus,
  ThreadMessage,
  ToolFrame,
} from "@/lib/claudebot-types";

type FrameClient = {
  onFrame: (handler: (frame: ServerFrame) => void) => () => void;
  onStatus?: (handler: (status: string) => void) => () => void;
  sendMessage: (input: { sessionId?: string; draftId?: string; content: string }) => void;
  cancel?: (sessionId: string) => void;
};

export type UseClaudebotThreadOptions = {
  sessionId: string | null;
  sessionStatus: "persisted" | "draft" | null;
  client: FrameClient;
  fetchMessages: (sessionId: string) => Promise<ThreadMessage[]>;
};

export function useClaudebotThread(options: UseClaudebotThreadOptions) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [activities, setActivities] = useState<ThreadActivity[]>([]);
  const [runStatus, setRunStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const effectiveSessionIdRef = useRef(options.sessionId);
  const activeAssistantIdRef = useRef<string | null>(null);
  const activeRunIdRef = useRef<string | null>(null);
  const runActivitiesRef = useRef<Record<string, ThreadActivity[]>>({});
  const remappedSessionIdRef = useRef<string | null>(null);

  const updateRunActivities = useCallback((runId: string, update: (current: ThreadActivity[]) => ThreadActivity[]) => {
    const next = update(runActivitiesRef.current[runId] ?? []);
    runActivitiesRef.current = { ...runActivitiesRef.current, [runId]: next };
    if (activeRunIdRef.current === runId) setActivities(next);
    return next;
  }, []);

  useEffect(() => {
    const previousSessionId = effectiveSessionIdRef.current;
    const isSameSession = previousSessionId === options.sessionId;
    const isRemappedSession = Boolean(options.sessionId && remappedSessionIdRef.current === options.sessionId);
    effectiveSessionIdRef.current = options.sessionId;
    if (!isRemappedSession) {
      activeAssistantIdRef.current = null;
      activeRunIdRef.current = null;
      runActivitiesRef.current = {};
      setStreaming(false);
      setActivities([]);
      setRunStatus(null);
    }
    if (!options.sessionId) {
      runActivitiesRef.current = {};
      setMessages([]);
      setActivities([]);
      setRunStatus(null);
      setLoading(false);
      return;
    }
    if (options.sessionStatus === "draft") {
      if (!isSameSession) setMessages([]);
      setLoading(false);
      return;
    }
    if (options.sessionStatus !== "persisted") {
      runActivitiesRef.current = {};
      setMessages([]);
      setActivities([]);
      setRunStatus(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    options.fetchMessages(options.sessionId)
      .then((rows) => {
        if (cancelled) return;
        setMessages((current) => isRemappedSession ? mergeFetchedMessages(current, rows) : rows);
        if (isRemappedSession) remappedSessionIdRef.current = null;
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [options.sessionId, options.sessionStatus, options.fetchMessages]);

  useEffect(() => {
    return options.client.onFrame((frame) => {
      if (frame.type === "session.created" && frame.draftId === effectiveSessionIdRef.current) {
        effectiveSessionIdRef.current = frame.session.id;
        remappedSessionIdRef.current = frame.session.id;
        return;
      }
      if (frame.type === "run.started" && frame.sessionId === effectiveSessionIdRef.current) {
        setStreaming(true);
        setRunStatus("Working...");
        setActivities([]);
        runActivitiesRef.current = { ...runActivitiesRef.current, [frame.runId]: [] };
        activeRunIdRef.current = frame.runId;
        activeAssistantIdRef.current = `assistant-${frame.runId}`;
        return;
      }
      if (frame.type === "run.thinking" && frame.sessionId === effectiveSessionIdRef.current) {
        setStreaming(true);
        activeRunIdRef.current = frame.runId;
        setRunStatus("Thinking...");
        updateRunActivities(frame.runId, (current) => appendThinkingActivity(current, frame.runId, frame.text));
        return;
      }
      if (frame.type === "run.tool" && frame.sessionId === effectiveSessionIdRef.current) {
        setStreaming(true);
        activeRunIdRef.current = frame.runId;
        setRunStatus(toolStatusLabel(frame.tool));
        updateRunActivities(frame.runId, (current) => upsertToolActivity(current, frame.runId, frame.tool));
        return;
      }
      if (frame.type === "run.status" && frame.sessionId === effectiveSessionIdRef.current) {
        const statusText = formatRunStatus(frame);
        setRunStatus(statusText);
        if (!frame.runId) return;
        const runId = frame.runId;
        activeRunIdRef.current = runId;
        updateRunActivities(runId, (current) => upsertStatusActivity(current, {
          runId,
          text: statusText,
          status: "running",
          mcpServers: frame.mcpServers,
        }));
        return;
      }
      if (frame.type === "run.delta" && frame.sessionId === effectiveSessionIdRef.current) {
        setStreaming(true);
        activeRunIdRef.current = frame.runId;
        const assistantId = activeAssistantIdRef.current ?? `assistant-${frame.runId}`;
        activeAssistantIdRef.current = assistantId;
        setMessages((current) => appendAssistantDelta(current, assistantId, frame.text));
        return;
      }
      if (frame.type === "message.appended" && frame.sessionId === effectiveSessionIdRef.current) {
        const streamingAssistantId = activeAssistantIdRef.current;
        setMessages((current) => appendOrReplaceFinalMessage(current, frame.message, streamingAssistantId));
        if (frame.message.role !== "user") {
          setStreaming(false);
          setRunStatus(null);
          setActivities([]);
          activeAssistantIdRef.current = null;
          activeRunIdRef.current = null;
        }
        return;
      }
      if (frame.type === "run.completed" && frame.sessionId === effectiveSessionIdRef.current) {
        updateRunActivities(
          frame.runId,
          (current) => finalizedRunActivities(current, frame.isError ? "error" : "complete"),
        );
        setStreaming(false);
        setRunStatus(null);
        setActivities([]);
        activeRunIdRef.current = null;
      }
      if (frame.type === "run.error" && frame.sessionId === effectiveSessionIdRef.current) {
        const runId = frame.runId ?? activeRunIdRef.current;
        const errorActivities = runId ? updateRunActivities(
          runId,
          (current) => finalizedRunActivities(current, "error"),
        ) : [];
        setStreaming(false);
        setRunStatus(null);
        activeAssistantIdRef.current = null;
        activeRunIdRef.current = null;
        setActivities([]);
        setMessages((current) => [...current, {
          id: `error-${frame.runId ?? crypto.randomUUID()}`,
          role: "system",
          content: frame.message,
          createdAt: new Date().toISOString(),
          metadata: { error: true, ...(runId ? { runId, activities: errorActivities } : {}) },
        }]);
      }
    });
  }, [options.client, updateRunActivities]);

  useEffect(() => {
    if (!options.client.onStatus) return;
    return options.client.onStatus((status) => {
      if (status === "closed" || status === "error") {
        setStreaming(false);
        setRunStatus(null);
        setActivities([]);
        activeAssistantIdRef.current = null;
        activeRunIdRef.current = null;
      }
    });
  }, [options.client]);

  const cancel = useCallback(() => {
    const sessionId = effectiveSessionIdRef.current;
    if (!sessionId) return;
    options.client.cancel?.(sessionId);
    setStreaming(false);
    setRunStatus(null);
    setActivities([]);
    activeAssistantIdRef.current = null;
    activeRunIdRef.current = null;
  }, [options.client]);

  const send = useCallback((content: string) => {
    const trimmed = content.trim();
    if (!trimmed || !options.sessionId) return;
    const now = new Date().toISOString();
    setMessages((current) => [...current, { id: `local-user-${crypto.randomUUID()}`, role: "user", content: trimmed, createdAt: now, metadata: {} }]);
    if (options.sessionStatus === "draft") {
      options.client.sendMessage({ draftId: options.sessionId, content: trimmed });
    } else {
      options.client.sendMessage({ sessionId: options.sessionId, content: trimmed });
    }
  }, [options.client, options.sessionId, options.sessionStatus]);

  return { messages, activities, runStatus, loading, streaming, send, cancel };
}

function finalizedRunActivities(
  activities: ThreadActivity[],
  status: Extract<ThreadActivityStatus, "complete" | "error">,
): ThreadActivity[] {
  const timestamp = nowIso();
  return activities.map((activity) => activity.status === "running"
    ? { ...activity, status, updatedAt: timestamp }
    : activity);
}

function nowIso(): string {
  return new Date().toISOString();
}

function appendThinkingActivity(
  activities: ThreadActivity[],
  runId: string,
  text: string,
): ThreadActivity[] {
  const id = `thinking-${runId}`;
  const timestamp = nowIso();
  const index = activities.findIndex((activity) => activity.id === id);
  if (index === -1) {
    return [...activities, {
      id,
      kind: "thinking",
      runId,
      text,
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
    }];
  }
  const next = activities.slice();
  const current = next[index];
  if (current.kind !== "thinking") return activities;
  next[index] = {
    ...current,
    text: `${current.text}${text}`,
    status: "running",
    updatedAt: timestamp,
  };
  return next;
}

function upsertToolActivity(
  activities: ThreadActivity[],
  runId: string,
  tool: ToolFrame,
): ThreadActivity[] {
  const id = `tool-${tool.id}`;
  const timestamp = nowIso();
  const status = tool.phase === "error" || tool.isError ? "error" : tool.phase === "end" ? "complete" : "running";
  const index = activities.findIndex((activity) => activity.id === id);
  if (index === -1) {
    return [...activities, {
      id,
      kind: "tool",
      runId,
      toolId: tool.id,
      name: tool.name?.trim() || "Tool",
      phase: tool.phase,
      input: tool.input,
      output: tool.output,
      isError: tool.isError,
      status,
      createdAt: timestamp,
      updatedAt: timestamp,
    }];
  }
  const next = activities.slice();
  const current = next[index];
  if (current.kind !== "tool") return activities;
  next[index] = {
    ...current,
    name: tool.name?.trim() || current.name,
    phase: tool.phase,
    input: tool.input ?? current.input,
    output: tool.output ?? current.output,
    isError: tool.isError ?? current.isError,
    status,
    updatedAt: timestamp,
  };
  return next;
}

function upsertStatusActivity(
  activities: ThreadActivity[],
  input: {
    runId: string;
    text: string;
    status: ThreadActivityStatus;
    mcpServers?: RuntimeMcpServerStatus[];
  },
): ThreadActivity[] {
  const id = `status-${input.runId ?? "global"}`;
  const timestamp = nowIso();
  const index = activities.findIndex((activity) => activity.id === id);
  if (index === -1) {
    return [...activities, {
      id,
      kind: "status",
      runId: input.runId,
      text: input.text,
      status: input.status,
      mcpServers: input.mcpServers,
      createdAt: timestamp,
      updatedAt: timestamp,
    }];
  }
  const next = activities.slice();
  const current = next[index];
  if (current.kind !== "status") return activities;
  next[index] = {
    ...current,
    text: input.text,
    status: input.status,
    mcpServers: input.mcpServers,
    updatedAt: timestamp,
  };
  return next;
}

function toolStatusLabel(tool: ToolFrame): string {
  const name = tool.name?.trim() || "tool";
  if (tool.phase === "start") return `Running ${name}`;
  if (tool.phase === "error" || tool.isError) return `${name} failed`;
  return `${name} completed`;
}

function formatRunStatus(frame: Extract<ServerFrame, { type: "run.status" }>): string {
  if (frame.status !== "api_error") return frame.status;
  const retry = frame.retryAttempt && frame.maxRetries ? ` ${frame.retryAttempt}/${frame.maxRetries}` : "";
  return `API retry${retry}: ${frame.message || "request failed"}`;
}

function appendAssistantDelta(messages: ThreadMessage[], id: string, delta: string): ThreadMessage[] {
  const index = messages.findIndex((message) => message.id === id);
  if (index === -1) {
    return [...messages, { id, role: "assistant", content: delta, createdAt: new Date().toISOString(), metadata: { streaming: true } }];
  }
  const next = messages.slice();
  next[index] = { ...next[index], content: `${next[index].content}${delta}` };
  return next;
}

function mergeFetchedMessages(current: ThreadMessage[], fetched: ThreadMessage[]): ThreadMessage[] {
  if (current.length === 0) return fetched;
  if (fetched.length === 0) return current;
  const seen = new Set(current.map((message) => message.id));
  const merged = current.slice();
  for (const message of fetched) {
    if (!seen.has(message.id)) merged.push(message);
  }
  return merged;
}

function appendOrReplaceFinalMessage(messages: ThreadMessage[], message: ThreadMessage, streamingAssistantId: string | null): ThreadMessage[] {
  if (messages.some((item) => item.id === message.id)) return messages;
  if (streamingAssistantId) {
    const index = messages.findIndex((item) => item.id === streamingAssistantId);
    if (index !== -1) {
      const next = messages.slice();
      next[index] = message;
      return next;
    }
  }
  return [...messages, message];
}
