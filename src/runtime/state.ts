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

export type RuntimeStateStore = {
  get(): Promise<RuntimeState>;
  setLastActiveSession(sessionId: string, reason: LastActiveReason): Promise<void>;
};

export function createRuntimeStateStore(path: string): RuntimeStateStore {
  const get = async (): Promise<RuntimeState> => {
    const state = await readJson<Partial<RuntimeState>>(path, emptyState);
    return { ...emptyState, ...state };
  };
  return {
    get,
    async setLastActiveSession(sessionId, reason) {
      const current = await get();
      await writeJsonAtomic(path, {
        ...current,
        lastActiveSessionId: sessionId,
        lastActiveAt: new Date().toISOString(),
        lastActiveReason: reason,
      });
    },
  };
}
