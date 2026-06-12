import { randomUUID } from "node:crypto";

import type { RuntimeStateStore } from "../runtime/state.ts";
import { appendSessionJsonlEntry, deleteSession, sessionExists } from "./jsonl-store.ts";
import { buildSessionSummary, listSessionSummaries, readThreadMessages, type SessionSummary } from "./session-read-model.ts";
import type { UIMessage } from "./jsonl-parser.ts";

export type ClaudebotSessionService = {
  exists: (sessionId: string) => Promise<boolean>;
  listSummaries: () => Promise<SessionSummary[]>;
  getSummary: (sessionId: string) => Promise<SessionSummary>;
  readMessages: (sessionId: string) => Promise<UIMessage[]>;
  rename: (sessionId: string, title: string) => Promise<void>;
  remove: (sessionId: string) => Promise<void>;
  activate: (sessionId: string | null) => Promise<string | null>;
  getActiveSessionId: () => Promise<string | null>;
  clearStaleActiveSession: () => Promise<void>;
  resolveResumeSessionId: (sessionId: string | null) => Promise<string | undefined>;
};

export type SessionServiceOptions = {
  sessionsDir: string;
  runtimeState: RuntimeStateStore;
};

export function createSessionService(options: SessionServiceOptions): ClaudebotSessionService {
  const exists = (sessionId: string) => sessionExists(options.sessionsDir, sessionId);

  return {
    exists,
    listSummaries: () => listSessionSummaries(options.sessionsDir),
    getSummary: (sessionId: string) => buildSessionSummary(options.sessionsDir, sessionId),
    readMessages: (sessionId: string) => readThreadMessages(options.sessionsDir, sessionId),

    async rename(sessionId, title) {
      const trimmed = title.trim();
      if (!trimmed) throw new Error("title required");
      if (!(await exists(sessionId))) throw new Error(`session not found: ${sessionId}`);
      await appendSessionJsonlEntry(options.sessionsDir, sessionId, {
        type: "custom-title",
        customTitle: trimmed,
        sessionId,
        uuid: randomUUID(),
        timestamp: new Date().toISOString(),
      });
    },

    async remove(sessionId) {
      await deleteSession(options.sessionsDir, sessionId);
      const state = await options.runtimeState.get();
      if (state.lastActiveSessionId === sessionId) {
        await options.runtimeState.setLastActiveSession("", "stale_reset");
      }
    },

    async activate(sessionId) {
      if (!sessionId) {
        await options.runtimeState.setLastActiveSession("", "user_switch");
        return null;
      }
      const activeId = await exists(sessionId) ? sessionId : "";
      await options.runtimeState.setLastActiveSession(activeId, activeId ? "user_open" : "stale_reset");
      return activeId || null;
    },

    async getActiveSessionId() {
      const state = await options.runtimeState.get();
      return state.lastActiveSessionId || null;
    },

    async clearStaleActiveSession() {
      const state = await options.runtimeState.get();
      if (!state.lastActiveSessionId) return;
      if (!(await exists(state.lastActiveSessionId))) {
        await options.runtimeState.setLastActiveSession("", "stale_reset");
      }
    },

    async resolveResumeSessionId(sessionId) {
      const candidate = sessionId || (await options.runtimeState.get()).lastActiveSessionId || "";
      if (!candidate) return undefined;
      if (await exists(candidate)) return candidate;
      await options.runtimeState.setLastActiveSession("", "stale_reset");
      return undefined;
    },
  };
}
