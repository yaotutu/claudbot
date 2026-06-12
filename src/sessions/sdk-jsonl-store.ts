import { appendFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import type { SessionKey, SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

export type SdkJsonlSessionStoreOptions = {
  sessionsDir: string;
};

function pathFor(sessionsDir: string, key: SessionKey): string {
  const sessionDir = join(sessionsDir, key.sessionId);
  if (!key.subpath) return join(sessionDir, "main.jsonl");
  return join(sessionDir, `${key.subpath}.jsonl`);
}

export function createSdkJsonlSessionStore(
  opts: SdkJsonlSessionStoreOptions,
): SessionStore {
  return {
    async append(key, entries) {
      if (entries.length === 0) return;
      const file = pathFor(opts.sessionsDir, key);
      await mkdir(dirname(file), { recursive: true });
      const lines = entries.map((entry) => JSON.stringify(entry) + "\n").join("");
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
        if (!(await Bun.file(mainFile).exists())) continue;
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
      await rm(join(opts.sessionsDir, key.sessionId), { recursive: true, force: true });
    },

    async listSubkeys(key) {
      const subagentsDir = join(opts.sessionsDir, key.sessionId, "subagents");
      let files: string[];
      try {
        files = await readdir(subagentsDir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw err;
      }
      return files
        .filter((file) => file.endsWith(".jsonl"))
        .map((file) => `subagents/${file.slice(0, -".jsonl".length)}`);
    },
  };
}
