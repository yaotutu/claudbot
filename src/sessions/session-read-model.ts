import { stat } from "node:fs/promises";

import { parseJsonlToUIMessages, type UIMessage } from "./jsonl-parser.ts";
import { listSessionFiles, readSessionJsonl, sessionMainFile, type JsonlEntry } from "./jsonl-store.ts";

export type SessionSummary = {
  id: string;
  title: string;
  preview: string;
  createdAt: string | null;
  updatedAt: string | null;
  messageCount: number;
  status: "persisted";
};

type SessionLineInfo = {
  messageCount: number;
  firstTimestamp: string | null;
  firstUserText: string;
  customTitle: string;
  summaryTitle: string;
};

export async function listSessionSummaries(sessionsDir: string): Promise<SessionSummary[]> {
  const files = await listSessionFiles(sessionsDir);
  return Promise.all(files.map((file) => buildSessionSummary(sessionsDir, file.sessionId, file.mtime)));
}

export async function buildSessionSummary(
  sessionsDir: string,
  sessionId: string,
  knownMtime?: number,
): Promise<SessionSummary> {
  const entries = await readSessionJsonl(sessionsDir, sessionId);
  const info = summarizeEntries(entries);
  const title = info.customTitle || info.summaryTitle || info.firstUserText || "New chat";
  const mtime = knownMtime ?? await readMtime(sessionsDir, sessionId);
  return {
    id: sessionId,
    title,
    preview: info.firstUserText,
    createdAt: info.firstTimestamp,
    updatedAt: mtime ? new Date(mtime).toISOString() : null,
    messageCount: info.messageCount,
    status: "persisted",
  };
}

export async function readThreadMessages(sessionsDir: string, sessionId: string): Promise<UIMessage[]> {
  const file = sessionMainFile(sessionsDir, sessionId);
  if (!(await Bun.file(file).exists())) return [];
  return parseJsonlToUIMessages(file);
}

export function summarizeEntries(entries: JsonlEntry[]): SessionLineInfo {
  const out: SessionLineInfo = {
    messageCount: 0,
    firstTimestamp: null,
    firstUserText: "",
    customTitle: "",
    summaryTitle: "",
  };
  for (const entry of entries) {
    if (entry.type === "custom-title" && typeof entry.customTitle === "string") {
      out.customTitle = entry.customTitle.trim();
      continue;
    }
    if ((entry.type === "summary" || entry.type === "session-summary") && typeof entry.summary === "string") {
      out.summaryTitle = entry.summary.trim();
      continue;
    }
    if (entry.type !== "user" && entry.type !== "assistant" && entry.type !== "system") continue;
    out.messageCount += 1;
    if (!out.firstTimestamp && typeof entry.timestamp === "string") {
      out.firstTimestamp = entry.timestamp;
    }
    if (!out.firstUserText && entry.type === "user" && isRecord(entry.message)) {
      out.firstUserText = flattenWireContent(entry.message.content);
    }
  }
  return out;
}

function flattenWireContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      return "";
    })
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(" ");
}

async function readMtime(sessionsDir: string, sessionId: string): Promise<number | null> {
  try {
    return (await stat(sessionMainFile(sessionsDir, sessionId))).mtimeMs;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
