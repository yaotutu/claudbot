import { join } from "node:path";
import { ensureDir } from "../utils/fs.ts";
import type { MemoryCommitSummary, MemoryMarkdownPaths } from "./types.ts";

export type MemoryGitInitResult = { available: boolean; reason?: string };
export type MemoryCommitResult = { available: boolean; sha: string; message: string; reason?: string };

export async function initMemoryGitStore(paths: MemoryMarkdownPaths): Promise<MemoryGitInitResult> {
  await ensureDir(paths.memoryDir);
  const initialized = await runGit(paths.memoryDir, ["rev-parse", "--is-inside-work-tree"]);
  if (!initialized.ok) {
    const init = await runGit(paths.memoryDir, ["init"]);
    if (!init.ok) return { available: false, reason: init.stderr || init.stdout };
  }
  await runGit(paths.memoryDir, ["config", "user.name", "Claudebot Memory"]);
  await runGit(paths.memoryDir, ["config", "user.email", "memory@claudebot.local"]);
  await Bun.write(join(paths.memoryDir, ".gitignore"), "!.gitignore\n!MEMORY.md\n!memory_events.jsonl\n!memory_state.json\n");
  await runGit(paths.memoryDir, ["add", ...await existingMemoryGitFiles(paths)]);
  return { available: true };
}

export async function commitMemoryChanges(paths: MemoryMarkdownPaths, message: string): Promise<MemoryCommitResult> {
  const init = await initMemoryGitStore(paths);
  if (!init.available) return { available: false, sha: "", message, reason: init.reason };
  await runGit(paths.memoryDir, ["add", ...await existingMemoryGitFiles(paths)]);
  const diff = await runGit(paths.memoryDir, ["diff", "--cached", "--quiet"]);
  if (diff.ok) {
    const latest = await latestCommit(paths.memoryDir);
    return { available: true, sha: latest, message: "no changes" };
  }
  const commit = await runGit(paths.memoryDir, ["commit", "-m", message]);
  if (!commit.ok) return { available: false, sha: "", message, reason: commit.stderr || commit.stdout };
  return { available: true, sha: await latestCommit(paths.memoryDir), message };
}

export async function listMemoryCommits(paths: MemoryMarkdownPaths, limit = 20): Promise<MemoryCommitSummary[]> {
  const result = await runGit(paths.memoryDir, ["log", `--max-count=${limit}`, "--format=%H%x1f%cI%x1f%s"]);
  if (!result.ok || !result.stdout.trim()) return [];
  return result.stdout.trim().split("\n").map((line) => {
    const [sha, createdAt, message] = line.split("\x1f");
    return { sha, createdAt, message };
  });
}

export async function showMemoryCommitDiff(paths: MemoryMarkdownPaths, sha: string): Promise<string> {
  const result = await runGit(paths.memoryDir, ["show", "--format=", sha]);
  if (!result.ok) throw new Error(result.stderr || result.stdout || `git show failed: ${sha}`);
  return result.stdout;
}

export async function revertMemoryCommit(paths: MemoryMarkdownPaths, sha: string): Promise<MemoryCommitResult> {
  const result = await runGit(paths.memoryDir, ["revert", "--no-edit", sha]);
  if (!result.ok) return { available: false, sha: "", message: `revert ${sha}`, reason: result.stderr || result.stdout };
  return { available: true, sha: await latestCommit(paths.memoryDir), message: `revert ${sha}` };
}

async function latestCommit(cwd: string): Promise<string> {
  const result = await runGit(cwd, ["rev-parse", "HEAD"]);
  return result.ok ? result.stdout.trim() : "";
}

async function existingMemoryGitFiles(paths: MemoryMarkdownPaths): Promise<string[]> {
  const files: Array<[string, string]> = [
    ["MEMORY.md", paths.longTermFile],
    ["memory_events.jsonl", paths.eventsFile],
    ["memory_state.json", paths.stateFile],
    [".gitignore", join(paths.memoryDir, ".gitignore")],
  ];
  const existing: string[] = [];
  for (const [relative, absolute] of files) {
    if (await Bun.file(absolute).exists()) existing.push(relative);
  }
  return existing;
}

async function runGit(cwd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout, stderr };
}
