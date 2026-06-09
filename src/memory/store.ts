import { newId } from "../utils/id.ts";
import { readJson, writeJsonAtomic } from "../utils/fs.ts";
import type { MemoryEntry, MemoryFile } from "./types.ts";

function now(): string {
  return new Date().toISOString();
}

export class MemoryStore {
  constructor(private readonly path: string) {}

  async read(): Promise<MemoryFile> {
    return readJson<MemoryFile>(this.path, { entries: [] });
  }

  async write(file: MemoryFile): Promise<void> {
    await writeJsonAtomic(this.path, file);
  }

  async create(input: Pick<MemoryEntry, "content" | "tags" | "source" | "confidence">): Promise<MemoryEntry> {
    const file = await this.read();
    const time = now();
    const entry: MemoryEntry = { id: newId("mem"), createdAt: time, updatedAt: time, ...input };
    file.entries.push(entry);
    await this.write(file);
    return entry;
  }

  async search(query: string): Promise<MemoryEntry[]> {
    const q = query.toLowerCase();
    const file = await this.read();
    return file.entries.filter((entry) =>
      entry.content.toLowerCase().includes(q) ||
      entry.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  }

  async get(id: string): Promise<MemoryEntry | null> {
    const file = await this.read();
    return file.entries.find((e) => e.id === id) || null;
  }

  async update(id: string, patch: Partial<Pick<MemoryEntry, "content" | "tags" | "source" | "confidence">>): Promise<MemoryEntry> {
    const file = await this.read();
    const idx = file.entries.findIndex((e) => e.id === id);
    if (idx < 0) throw new Error(`memory entry not found: ${id}`);
    file.entries[idx] = { ...file.entries[idx], ...patch, updatedAt: now() };
    await this.write(file);
    return file.entries[idx];
  }

  async delete(id: string): Promise<void> {
    const file = await this.read();
    const before = file.entries.length;
    file.entries = file.entries.filter((e) => e.id !== id);
    if (file.entries.length === before) throw new Error(`memory entry not found: ${id}`);
    await this.write(file);
  }
}
