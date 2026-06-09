import { mkdir, readFile, readdir, rm, writeFile, appendFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

export type ClaudebotSessionStoreOptions = {
  sessionsDir: string;
};

/**
 * Translates SessionKey -> filesystem path:
 *   <sessionsDir>/<sessionId>/main.jsonl           (no subpath)
 *   <sessionsDir>/<sessionId>/subagents/<id>.jsonl (subpath: "subagents/agent-<id>")
 */
function pathFor(sessionsDir: string, key: SessionKey): string {
  const sessionDir = join(sessionsDir, key.sessionId);
  if (!key.subpath) return join(sessionDir, "main.jsonl");
  return join(sessionDir, `${key.subpath}.jsonl`);
}

function sessionDirFor(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, sessionId);
}

export function createClaudebotSessionStore(
  opts: ClaudebotSessionStoreOptions,
): SessionStore {
  return {
    async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
      if (entries.length === 0) return;
      const file = pathFor(opts.sessionsDir, key);
      await mkdir(dirname(file), { recursive: true });
      const lines = entries.map((e) => JSON.stringify(e) + "\n").join("");
      await appendFile(file, lines, "utf8");
    },

    async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
      const file = pathFor(opts.sessionsDir, key);
      let raw: string;
      try {
        raw = await readFile(file, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
      return raw
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as SessionStoreEntry);
    },
  };
}
