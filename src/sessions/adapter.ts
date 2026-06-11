import { appendFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

export type ClaudebotSessionStoreOptions = {
  sessionsDir: string;
};

function pathFor(sessionsDir: string, key: SessionKey): string {
  const sessionDir = join(sessionsDir, key.sessionId);
  if (!key.subpath) return join(sessionDir, "main.jsonl");
  return join(sessionDir, `${key.subpath}.jsonl`);
}

function sessionDirFor(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, sessionId);
}

/**
 * Check whether a session has a main.jsonl file on disk (i.e. was actually
 * created by the SDK and mirrored by the adapter). Old-format `sess_*.json`
 * files return false — they are not valid SDK sessions.
 */
export async function sessionExists(sessionsDir: string, sessionId: string): Promise<boolean> {
  const mainFile = join(sessionsDir, sessionId, "main.jsonl");
  try {
    const f = Bun.file(mainFile);
    return await f.exists();
  } catch {
    return false;
  }
}

export function createClaudebotSessionStore(
  opts: ClaudebotSessionStoreOptions,
): SessionStore {
  return {
    async append(key, entries) {
      if (entries.length === 0) return;
      const file = pathFor(opts.sessionsDir, key);
      await mkdir(dirname(file), { recursive: true });
      const lines = entries.map((e) => JSON.stringify(e) + "\n").join("");
      await appendFile(file, lines, "utf8");
    },

    async load(key) {
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

    async listSessions(projectKey) {
      // projectKey is accepted for SDK contract compliance. Claudebot uses
      // a single projectKey ("claudebot"); if multi-tenancy is ever added,
      // a per-session .project sidecar would be needed to scope properly.
      const _projectKey = projectKey; // intentionally unused
      const root = opts.sessionsDir;
      let entries: string[];
      try {
        entries = await readdir(root);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      const out: Array<{ sessionId: string; mtime: number }> = [];
      for (const sessionId of entries) {
        const mainFile = pathFor(root, { projectKey, sessionId });
        const f = Bun.file(mainFile);
        if (!(await f.exists())) continue;
        const st = await stat(mainFile);
        out.push({ sessionId, mtime: st.mtimeMs });
      }
      out.sort((a, b) => b.mtime - a.mtime);
      return out;
    },

    async delete(key) {
      if (key.subpath) {
        const file = pathFor(opts.sessionsDir, key);
        try {
          await rm(file);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
        return;
      }
      const dir = sessionDirFor(opts.sessionsDir, key.sessionId);
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    },

    async listSubkeys(key) {
      // Layout invariant: subkeys always live under <sessionDir>/subagents/<id>.jsonl.
      // The pathFor() function encodes this; we read that directory directly
      // rather than scanning the whole session tree.
      const subagentsDir = join(sessionDirFor(opts.sessionsDir, key.sessionId), "subagents");
      let files: string[];
      try {
        files = await readdir(subagentsDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      return files
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => `subagents/${f.slice(0, -".jsonl".length)}`);
    },
  };
}
