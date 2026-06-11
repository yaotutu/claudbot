import { useCallback, useEffect, useRef, useState } from "react";

import type { ServerFrame, ThreadMessage } from "@/lib/claudebot-types";

type FrameClient = {
  onFrame: (handler: (frame: ServerFrame) => void) => () => void;
  onStatus?: (handler: (status: string) => void) => () => void;
  sendMessage: (input: { sessionId?: string; draftId?: string; content: string }) => void;
};

export type UseClaudebotThreadOptions = {
  sessionId: string | null;
  sessionStatus: "persisted" | "draft" | null;
  client: FrameClient;
  fetchMessages: (sessionId: string) => Promise<ThreadMessage[]>;
};

export function useClaudebotThread(options: UseClaudebotThreadOptions) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const effectiveSessionIdRef = useRef(options.sessionId);
  const activeAssistantIdRef = useRef<string | null>(null);

  useEffect(() => {
    effectiveSessionIdRef.current = options.sessionId;
    activeAssistantIdRef.current = null;
    setStreaming(false);
    if (!options.sessionId || options.sessionStatus !== "persisted") {
      setMessages([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    options.fetchMessages(options.sessionId)
      .then((rows) => {
        if (!cancelled) setMessages(rows);
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
        return;
      }
      if (frame.type === "run.started" && frame.sessionId === effectiveSessionIdRef.current) {
        setStreaming(true);
        activeAssistantIdRef.current = `assistant-${frame.runId}`;
        return;
      }
      if (frame.type === "run.delta" && frame.sessionId === effectiveSessionIdRef.current) {
        setStreaming(true);
        const assistantId = activeAssistantIdRef.current ?? `assistant-${frame.runId}`;
        activeAssistantIdRef.current = assistantId;
        setMessages((current) => appendAssistantDelta(current, assistantId, frame.text));
        return;
      }
      if (frame.type === "message.appended" && frame.sessionId === effectiveSessionIdRef.current) {
        setMessages((current) => current.some((message) => message.id === frame.message.id) ? current : [...current, frame.message]);
        return;
      }
      if (frame.type === "run.completed" && frame.sessionId === effectiveSessionIdRef.current) {
        setStreaming(false);
        activeAssistantIdRef.current = null;
      }
    });
  }, [options.client]);

  useEffect(() => {
    if (!options.client.onStatus) return;
    return options.client.onStatus((status) => {
      if (status === "closed" || status === "error") {
        setStreaming(false);
        activeAssistantIdRef.current = null;
      }
    });
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

  return { messages, loading, streaming, send };
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
