import { readJson, writeJsonAtomic } from "../utils/fs.ts";

export type RuntimeState = {
  lastActiveSessionId: string;
  lastActiveAt: string;
  lastActiveReason: string;
};

export type LastActiveReason =
  | "user_open"
  | "user_switch"
  | "user_message"
  | "stale_reset";

const emptyState: RuntimeState = {
  lastActiveSessionId: "",
  lastActiveAt: "",
  lastActiveReason: "",
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
}
