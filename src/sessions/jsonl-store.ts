import { appendFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export type JsonlEntry = {
  type: string;
  uuid?: string;
  timestamp?: string;
  [key: string]: unknown;
};

export type SessionFile = {
  sessionId: string;
  filePath: string;
  mtime: number;
};

export function sessionDir(sessionsDir: string, sessionId: string): string {
  return join(sessionsDir, sessionId);
}

export function sessionMainFile(sessionsDir: string, sessionId: string): string {
  return join(sessionDir(sessionsDir, sessionId), "main.jsonl");
}

export async function sessionExists(sessionsDir: string, sessionId: string): Promise<boolean> {
  return Bun.file(sessionMainFile(sessionsDir, sessionId)).exists();
}

export async function appendSessionJsonlEntry(
  sessionsDir: string,
  sessionId: string,
  entry: JsonlEntry,
): Promise<void> {
  const file = sessionMainFile(sessionsDir, sessionId);
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
}

export async function readSessionJsonl(sessionsDir: string, sessionId: string): Promise<JsonlEntry[]> {
  let raw: string;
  try {
    raw = await readFile(sessionMainFile(sessionsDir, sessionId), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const rows: JsonlEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (isRecord(parsed) && typeof parsed.type === "string") rows.push(parsed as JsonlEntry);
    } catch {
      // Ignore malformed partial lines; the SDK transcript is append-oriented.
    }
  }
  return rows;
}

export async function listSessionFiles(sessionsDir: string): Promise<SessionFile[]> {
  let entries: string[];
  try {
    entries = await readdir(sessionsDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const files: SessionFile[] = [];
  for (const sessionId of entries) {
    const filePath = sessionMainFile(sessionsDir, sessionId);
    if (!(await Bun.file(filePath).exists())) continue;
    const st = await stat(filePath);
    files.push({ sessionId, filePath, mtime: st.mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files;
}

export async function deleteSession(sessionsDir: string, sessionId: string): Promise<void> {
  await rm(sessionDir(sessionsDir, sessionId), { recursive: true, force: true });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
