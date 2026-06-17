import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { ensureDir, writeTextAtomic } from "../utils/fs.ts";
import type {
  MemoryEventRecord,
  MemoryMarkdownPaths,
  MemoryReadableFile,
  MemorySearchHit,
  MemorySearchOptions,
  VersionedText,
} from "./types.ts";

const DEFAULT_MEMORY = "# Memory\n\nLong-term project context, decisions, and stable background live here.\n";

export async function initMemoryMarkdownStore(paths: MemoryMarkdownPaths): Promise<void> {
  await ensureDir(paths.memoryDir);
  if (!(await Bun.file(paths.longTermFile).exists())) {
    await writeTextAtomic(paths.longTermFile, DEFAULT_MEMORY);
  }
  if (!(await Bun.file(paths.eventsFile).exists())) {
    await writeTextAtomic(paths.eventsFile, "");
  }
}

export async function readMemoryFile(paths: MemoryMarkdownPaths, name: MemoryReadableFile): Promise<VersionedText> {
  const content = await readFile(resolveReadablePath(paths, name), "utf8");
  return { content, version: version(content) };
}

export async function appendMemoryEvent(paths: MemoryMarkdownPaths, record: MemoryEventRecord): Promise<void> {
  await ensureDir(paths.memoryDir);
  await appendFile(paths.eventsFile, `${JSON.stringify(record)}\n`, "utf8");
}

export async function searchMemoryText(
  paths: MemoryMarkdownPaths,
  query: string,
  options: MemorySearchOptions = {},
): Promise<MemorySearchHit[]> {
  const maxResults = options.maxResults ?? 20;
  const q = query.toLowerCase();
  const hits: MemorySearchHit[] = [];
  for (const file of collectSearchFiles(paths, options.scope ?? "all")) {
    if (hits.length >= maxResults) break;
    if (!(await Bun.file(file.absolute).exists())) continue;
    const lines = (await readFile(file.absolute, "utf8")).split(/\r?\n/);
    for (let i = 0; i < lines.length && hits.length < maxResults; i += 1) {
      if (!lines[i].toLowerCase().includes(q)) continue;
      hits.push({ path: file.relative, line: i + 1, snippet: lines[i].trim(), source: file.source });
    }
  }
  return hits;
}

function resolveReadablePath(paths: MemoryMarkdownPaths, name: MemoryReadableFile): string {
  if (name === "user.md") return paths.userFile;
  if (name === "soul.md") return paths.soulFile;
  return paths.longTermFile;
}

function collectSearchFiles(paths: MemoryMarkdownPaths, scope: MemorySearchOptions["scope"]): MemorySearchHitFile[] {
  const files: MemorySearchHitFile[] = [];
  if (scope === "all" || scope === "profile") {
    files.push(
      { absolute: paths.userFile, relative: "user.md", source: "profile" },
      { absolute: paths.soulFile, relative: "soul.md", source: "profile" },
    );
  }
  if (scope === "all" || scope === "long_term") {
    files.push({ absolute: paths.longTermFile, relative: "memory/MEMORY.md", source: "long_term" });
  }
  if (scope === "all" || scope === "events") {
    files.push({ absolute: paths.eventsFile, relative: "memory/memory_events.jsonl", source: "events" });
  }
  return files;
}

function version(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

type MemorySearchHitFile = {
  absolute: string;
  relative: string;
  source: MemorySearchHit["source"];
};
