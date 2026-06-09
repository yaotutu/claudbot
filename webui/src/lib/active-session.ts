// Pick the session to auto-select on app boot.
//
// Order of preference:
//   1. `lastActiveSessionId` if it still resolves to a real session
//   2. otherwise the first session in the list (caller is expected to pass
//      them sorted by `updatedAt` desc — `useSessions` does this already)
//   3. otherwise null (no sessions at all → show the empty state)

import type { ChatSummary } from "./types";

export function pickInitialActiveSession(
  sessions: ChatSummary[],
  lastActiveSessionId: string | null,
): string | null {
  if (sessions.length === 0) return null;
  if (lastActiveSessionId) {
    const match = sessions.find((s) => s.chatId === lastActiveSessionId);
    if (match) return match.key;
  }
  return sessions[0].key;
}
