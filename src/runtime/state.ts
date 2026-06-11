import { readJson, writeJsonAtomic } from "../utils/fs.ts";

export type RuntimeState = {
  lastActiveSessionId: string;
  lastActiveAt: string;
  lastActiveReason: string;
  inboxSessionId: string;
  inboxUpdatedAt: string;
};

export type LastActiveReason =
  | "user_open"
  | "user_switch"
  | "user_message"
  | "stale_reset"
  | "schedule_delivery_stale_reset"
  | "schedule_delivery_fallback";

const emptyState: RuntimeState = {
  lastActiveSessionId: "",
  lastActiveAt: "",
  lastActiveReason: "",
  inboxSessionId: "",
  inboxUpdatedAt: "",
};

export class RuntimeStateStore {
  constructor(private readonly path: string) {}

  async get(): Promise<RuntimeState> {
    const state = await readJson<Partial<RuntimeState>>(this.path, emptyState);
    return { ...emptyState, ...state };
  }

  async setLastActiveSession(sessionId: string, reason: LastActiveReason): Promise<void> {
    const current = await this.get();
    await writeJsonAtomic(this.path, {
      ...current,
      lastActiveSessionId: sessionId,
      lastActiveAt: new Date().toISOString(),
      lastActiveReason: reason,
    });
  }

  async setInboxSession(sessionId: string): Promise<void> {
    const current = await this.get();
    await writeJsonAtomic(this.path, {
      ...current,
      inboxSessionId: sessionId,
      inboxUpdatedAt: new Date().toISOString(),
    });
  }

  async recordAssistantAppend(_sessionId: string): Promise<void> {
    return;
  }
}
