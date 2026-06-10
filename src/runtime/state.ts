import { readJson, writeJsonAtomic } from "../utils/fs.ts";

export type RuntimeState = {
  lastActiveSessionId: string;
  lastActiveAt: string;
  lastActiveReason: string;
};

const emptyState: RuntimeState = {
  lastActiveSessionId: "",
  lastActiveAt: "",
  lastActiveReason: "",
};

export class RuntimeStateStore {
  constructor(private readonly path: string) {}

  async get(): Promise<RuntimeState> {
    return readJson<RuntimeState>(this.path, emptyState);
  }

  async setLastActiveSession(sessionId: string, reason: "user_open" | "user_switch" | "user_message" | "stale_reset"): Promise<void> {
    await writeJsonAtomic(this.path, {
      lastActiveSessionId: sessionId,
      lastActiveAt: new Date().toISOString(),
      lastActiveReason: reason,
    });
  }

  async recordAssistantAppend(_sessionId: string): Promise<void> {
    return;
  }
}
