import { join } from "node:path";
import { ensureDir, readJson, writeJsonAtomic } from "../utils/fs.ts";
import { newId } from "../utils/id.ts";
import type { SessionMessage, SessionRecord } from "./types.ts";

function now(): string {
  return new Date().toISOString();
}

export class SessionStore {
  constructor(private readonly dir: string) {}

  async create(title = "New chat", id = newId("sess")): Promise<SessionRecord> {
    await ensureDir(this.dir);
    const time = now();
    const record: SessionRecord = {
      id,
      title,
      preview: "",
      claudeSessionId: "",
      createdAt: time,
      updatedAt: time,
      messages: [],
    };
    await this.save(record);
    return record;
  }

  async get(id: string): Promise<SessionRecord | null> {
    return readJson<SessionRecord | null>(this.pathFor(id), null);
  }

  async getOrCreateInbox(): Promise<SessionRecord> {
    return (await this.get("inbox")) || this.create("Inbox", "inbox");
  }

  async save(record: SessionRecord): Promise<void> {
    record.updatedAt = now();
    await writeJsonAtomic(this.pathFor(record.id), record);
  }

  async appendMessage(sessionId: string, message: Omit<SessionMessage, "id" | "createdAt">): Promise<SessionRecord> {
    const record = (await this.get(sessionId)) || (sessionId === "inbox" ? await this.getOrCreateInbox() : await this.create("New chat", sessionId));
    record.messages.push({
      id: newId("msg"),
      createdAt: now(),
      ...message,
    });
    record.preview = message.content.slice(0, 120);
    await this.save(record);
    return record;
  }

  async list(): Promise<SessionRecord[]> {
    const { readdir } = await import("node:fs/promises");
    await ensureDir(this.dir);
    const files = await readdir(this.dir);
    const out: SessionRecord[] = [];
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -5);
      const rec = await this.get(id);
      if (rec) out.push(rec);
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    return out;
  }

  async delete(id: string): Promise<void> {
    const { unlink } = await import("node:fs/promises");
    try {
      await unlink(this.pathFor(id));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  pathFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }
}
