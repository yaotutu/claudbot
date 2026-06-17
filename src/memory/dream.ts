import { readFile } from "node:fs/promises";
import { appendMemoryEvent } from "./markdown-store.ts";
import { writeTextAtomic } from "../utils/fs.ts";
import { commitMemoryChanges } from "./git-store.ts";
import { detectMemoryIntent } from "./intent.ts";
import { listSessionFiles } from "../sessions/jsonl-store.ts";
import type { DreamPatchPlan, MemoryDreamState, MemoryMarkdownPaths, MemoryReadableFile } from "./types.ts";

export type DreamApplyResult = {
  dryRun: boolean;
  applied: number;
  summary: string;
};

export async function applyDreamPatchPlan(
  paths: MemoryMarkdownPaths,
  plan: DreamPatchPlan,
  options: { dryRun: boolean },
): Promise<DreamApplyResult> {
  validatePlan(plan);
  if (!options.dryRun) {
    for (const update of plan.updates) {
      await applyUpdate(paths, update.target, update.operation, update.content, update.match);
    }
    await appendMemoryEvent(paths, {
      type: "dream_apply",
      summary: plan.summary,
      applied: plan.updates.length,
      skipped: plan.skipped.length,
      createdAt: new Date().toISOString(),
    });
  }
  return { dryRun: options.dryRun, applied: plan.updates.length, summary: plan.summary };
}

export async function runMemoryDream(
  _paths: MemoryMarkdownPaths,
  input: { dryRun?: boolean; sessionId?: string; includeEventCandidates?: boolean } = {},
): Promise<DreamApplyResult> {
  const paths = _paths;
  const dryRun = input.dryRun ?? false;
  const includeEventCandidates = input.includeEventCandidates ?? true;
  const scan = await scanSessionCandidates(paths, input.sessionId);
  if (!dryRun && scan.candidates.length > 0) {
    for (const candidate of scan.candidates) {
      await appendMemoryEvent(paths, {
        type: "candidate",
        id: candidate.id,
        sessionId: candidate.sessionId,
        content: candidate.content,
        source: "session_scan",
        createdAt: new Date().toISOString(),
      });
    }
    await writeTextAtomic(paths.stateFile, `${JSON.stringify(scan.nextState, null, 2)}\n`);
  }
  const eventCandidates = includeEventCandidates ? await pendingCandidates(paths) : [];
  const candidates = dryRun
    ? mergeCandidates(eventCandidates, scan.candidates)
    : includeEventCandidates ? await pendingCandidates(paths) : scan.candidates;
  if (candidates.length === 0) return { dryRun, applied: 0, summary: "No pending candidates" };
  if (dryRun) return { dryRun, applied: candidates.length, summary: `Would consolidate ${candidates.length} candidate(s)` };

  const current = await readFile(paths.longTermFile, "utf8");
  const bullets = candidates.map((candidate) => `- ${candidate.content}`).join("\n");
  const heading = "## Candidate notes";
  const next = current.includes(heading)
    ? `${current.trimEnd()}\n${bullets}\n`
    : `${current.trimEnd()}\n\n${heading}\n\n${bullets}\n`;
  await writeTextAtomic(paths.longTermFile, next);
  const commit = await commitMemoryChanges(paths, `memory: consolidate ${candidates.length} candidate(s)`);
  await appendMemoryEvent(paths, {
    type: "dream_apply",
    summary: `Consolidated ${candidates.length} candidate(s)`,
    candidateIds: candidates.map((candidate) => candidate.id),
    commit: commit.sha || null,
    createdAt: new Date().toISOString(),
  });
  return { dryRun, applied: candidates.length, summary: `Consolidated ${candidates.length} candidate(s)` };
}

export async function collectPendingMemoryCandidates(paths: MemoryMarkdownPaths): Promise<Array<{ id: string; content: string }>> {
  const scan = await scanSessionCandidates(paths);
  return mergeCandidates(await pendingCandidates(paths), scan.candidates);
}

async function pendingCandidates(paths: MemoryMarkdownPaths): Promise<Array<{ id: string; content: string }>> {
  const file = Bun.file(paths.eventsFile);
  if (!(await file.exists())) return [];
  const rows = (await file.text()).split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line) as Record<string, unknown>]; } catch { return []; }
  });
  const applied = new Set<string>();
  for (const row of rows) {
    if (row.type !== "dream_apply" || !Array.isArray(row.candidateIds)) continue;
    for (const id of row.candidateIds) applied.add(String(id));
  }
  return mergeCandidates(rows.flatMap((row) => {
    if (row.type !== "candidate" || typeof row.content !== "string") return [];
    const id = typeof row.id === "string" ? row.id : row.content;
    if (applied.has(id)) return [];
    return [{ id, content: row.content }];
  }));
}

async function scanSessionCandidates(paths: MemoryMarkdownPaths, onlySessionId?: string): Promise<{ candidates: SessionMemoryCandidate[]; nextState: MemoryDreamState }> {
  const state = await readDreamState(paths.stateFile);
  const nextState: MemoryDreamState = { sessions: { ...state.sessions } };
  const candidates: SessionMemoryCandidate[] = [];
  const sessions = (await listSessionFiles(paths.sessionsDir))
    .filter((session) => !onlySessionId || session.sessionId === onlySessionId);
  for (const session of sessions) {
    const known = state.sessions[session.sessionId]?.lineCount ?? 0;
    const lines = (await readFile(session.filePath, "utf8")).split(/\r?\n/).filter((line) => line.length > 0);
    const nextLineCount = lines.length;
    for (let i = known; i < lines.length; i += 1) {
      const content = extractExplicitMemoryRequest(lines[i]);
      if (!content) continue;
      candidates.push({
        id: `session_${session.sessionId}_${i + 1}`,
        sessionId: session.sessionId,
        content,
      });
    }
    nextState.sessions[session.sessionId] = { lineCount: nextLineCount, updatedAt: new Date().toISOString() };
  }
  return { candidates, nextState };
}

async function readDreamState(path: string): Promise<MemoryDreamState> {
  const file = Bun.file(path);
  if (!(await file.exists())) return { sessions: {} };
  try {
    const parsed = JSON.parse(await file.text()) as Partial<MemoryDreamState>;
    return parsed && typeof parsed.sessions === "object" && parsed.sessions !== null
      ? { sessions: parsed.sessions as MemoryDreamState["sessions"] }
      : { sessions: {} };
  } catch {
    return { sessions: {} };
  }
}

function extractExplicitMemoryRequest(line: string): string | null {
  let entry: Record<string, unknown>;
  try { entry = JSON.parse(line) as Record<string, unknown>; } catch { return null; }
  if (entry.type !== "user" || !isRecord(entry.message)) return null;
  const text = flattenMessageContent(entry.message.content).trim();
  if (!text) return null;
  const intent = detectMemoryIntent(text);
  return intent.type === "explicit" ? intent.content : null;
}

function flattenMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.flatMap((block) => {
    if (!isRecord(block) || block.type !== "text" || typeof block.text !== "string") return [];
    return [block.text];
  }).join(" ");
}

function mergeCandidates(...groups: Array<Array<{ id: string; content: string }>>): Array<{ id: string; content: string }> {
  const seen = new Set<string>();
  const merged: Array<{ id: string; content: string }> = [];
  for (const candidate of groups.flat()) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    merged.push(candidate);
  }
  return merged;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type SessionMemoryCandidate = {
  id: string;
  sessionId: string;
  content: string;
};

async function applyUpdate(
  paths: MemoryMarkdownPaths,
  target: MemoryReadableFile,
  operation: "append" | "replace_section" | "delete_lines",
  content?: string,
  match?: string,
): Promise<void> {
  const file = pathFor(paths, target);
  const current = await readFile(file, "utf8");
  if (operation === "append") {
    await writeTextAtomic(file, `${current.trimEnd()}\n${content ?? ""}`);
    return;
  }
  if (!match) throw new Error(`${operation} requires match`);
  if (!current.includes(match)) throw new Error(`match not found in ${target}`);
  const next = operation === "replace_section"
    ? current.replace(match, content ?? "")
    : current.replace(match, "");
  await writeTextAtomic(file, next);
}

function validatePlan(plan: DreamPatchPlan): void {
  for (const update of plan.updates) {
    if (!["user.md", "soul.md", "memory/MEMORY.md"].includes(update.target)) {
      throw new Error(`invalid memory target: ${update.target}`);
    }
    if (update.operation === "append" && !update.content) {
      throw new Error("append requires content");
    }
  }
}

function pathFor(paths: MemoryMarkdownPaths, target: MemoryReadableFile): string {
  if (target === "user.md") return paths.userFile;
  if (target === "soul.md") return paths.soulFile;
  return paths.longTermFile;
}
