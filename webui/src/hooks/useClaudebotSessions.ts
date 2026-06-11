import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { DraftSession, ServerFrame, SessionSummary } from "@/lib/claudebot-types";

type SessionItem = SessionSummary | DraftSession;

type FrameClient = {
  onFrame: (handler: (frame: ServerFrame) => void) => () => void;
  activateSession?: (sessionId: string | null) => void;
};

export type UseClaudebotSessionsOptions = {
  initialSessions: SessionSummary[];
  activeSessionId: string | null;
  client: FrameClient;
  deleteSession: (sessionId: string) => Promise<boolean>;
  renameSession: (sessionId: string, title: string) => Promise<void>;
};

export function useClaudebotSessions(options: UseClaudebotSessionsOptions) {
  const initialStateRef = useRef<{ sessions: SessionItem[]; activeSessionId: string | null } | null>(null);
  if (!initialStateRef.current) {
    if (!options.activeSessionId && options.initialSessions.length === 0) {
      const draft = createDraftRecord();
      initialStateRef.current = { sessions: [draft], activeSessionId: draft.id };
    } else {
      initialStateRef.current = {
        sessions: options.initialSessions,
        activeSessionId: options.activeSessionId || options.initialSessions[0]?.id || null,
      };
    }
  }

  const [sessions, setSessions] = useState<SessionItem[]>(initialStateRef.current.sessions);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(initialStateRef.current.activeSessionId);

  useEffect(() => {
    return options.client.onFrame((frame) => {
      if (frame.type === "session.created") {
        setSessions((current) => {
          const withoutDraft = current.filter((session) => session.id !== frame.draftId && session.id !== frame.session.id);
          return [frame.session, ...withoutDraft];
        });
        if (frame.draftId) {
          setActiveSessionId((current) => current === frame.draftId ? frame.session.id : current);
        }
        return;
      }
      if (frame.type === "session.updated") {
        if ("session" in frame) {
          setSessions((current) => replaceOrPrepend(current, frame.session));
        }
        return;
      }
      if (frame.type === "message.appended") {
        setSessions((current) => current.map((session) => {
          if (session.id !== frame.sessionId) return session;
          return {
            ...session,
            preview: frame.message.content.slice(0, 160),
            updatedAt: frame.message.createdAt,
          };
        }));
      }
    });
  }, [options.client]);

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeSessionId) ?? null,
    [activeSessionId, sessions],
  );

  const createDraftSession = useCallback(() => {
    const draft = createDraftRecord();
    setSessions((current) => [draft, ...current]);
    setActiveSessionId(draft.id);
    options.client.activateSession?.(null);
    return draft.id;
  }, [options.client]);

  const selectSession = useCallback((sessionId: string | null) => {
    setActiveSessionId(sessionId);
    const session = sessions.find((item) => item.id === sessionId);
    options.client.activateSession?.(session?.status === "persisted" ? session.id : null);
  }, [options.client, sessions]);

  const deleteSession = useCallback(async (sessionId: string) => {
    const session = sessions.find((item) => item.id === sessionId);
    if (session?.status === "persisted") {
      await options.deleteSession(sessionId);
    }
    setSessions((current) => current.filter((item) => item.id !== sessionId));
    setActiveSessionId((current) => current === sessionId ? null : current);
  }, [options, sessions]);

  const renameSession = useCallback(async (sessionId: string, title: string) => {
    const session = sessions.find((item) => item.id === sessionId);
    if (session?.status === "persisted") {
      await options.renameSession(sessionId, title);
    }
    setSessions((current) => current.map((item) => item.id === sessionId ? { ...item, title } : item));
  }, [options, sessions]);

  return {
    sessions,
    activeSessionId,
    activeSession,
    createDraftSession,
    selectSession,
    deleteSession,
    renameSession,
  };
}

function createDraftRecord(): DraftSession {
  const now = new Date().toISOString();
  return {
    id: `draft-${crypto.randomUUID()}`,
    title: "New chat",
    preview: "",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    status: "draft",
  };
}

function replaceOrPrepend(items: SessionItem[], session: SessionSummary): SessionItem[] {
  const index = items.findIndex((item) => item.id === session.id);
  if (index === -1) return [session, ...items];
  const next = items.slice();
  next[index] = session;
  return next;
}
