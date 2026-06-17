export type MemoryMarkdownPaths = {
  userFile: string;
  soulFile: string;
  memoryDir: string;
  longTermFile: string;
  eventsFile: string;
  stateFile: string;
  sessionsDir: string;
};

export type VersionedText = {
  content: string;
  version: string;
};

export type MemoryReadableFile = "user.md" | "soul.md" | "memory/MEMORY.md";
export type MemoryEditableFile = MemoryReadableFile;

export type MemoryEventRecord = Record<string, unknown> & {
  type: string;
  createdAt: string;
};

export type MemorySearchScope = "all" | "profile" | "long_term" | "events";

export type MemorySearchOptions = {
  maxResults?: number;
  scope?: MemorySearchScope;
};

export type MemorySearchHit = {
  path: string;
  line: number;
  snippet: string;
  source: MemorySearchScope;
};

export type DreamPatchPlan = {
  summary: string;
  updates: DreamPatchUpdate[];
  skipped: Array<{
    reason: "transient" | "duplicate" | "public_knowledge" | "sensitive" | "low_signal";
    content: string;
  }>;
};

export type DreamPatchUpdate = {
  target: MemoryEditableFile;
  operation: "append" | "replace_section" | "delete_lines";
  rationale: string;
  content?: string;
  match?: string;
};

export type MemoryCommitSummary = {
  sha: string;
  message: string;
  createdAt: string;
};

export type MemoryDreamState = {
  sessions: Record<string, { lineCount: number; updatedAt: string }>;
};
