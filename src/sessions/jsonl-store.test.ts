import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendSessionJsonlEntry,
  deleteSession,
  listSessionFiles,
  readSessionJsonl,
  sessionExists,
  sessionMainFile,
} from "./jsonl-store.ts";

describe("jsonl session store", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claudebot-jsonl-"));
  });

  test("appendSessionJsonlEntry writes main.jsonl and readSessionJsonl reads it back", async () => {
    await appendSessionJsonlEntry(dir, "s1", { type: "user", uuid: "u1", message: { role: "user", content: "hi" } });
    await appendSessionJsonlEntry(dir, "s1", { type: "assistant", uuid: "a1", message: { role: "assistant", content: "hello" } });

    expect(sessionMainFile(dir, "s1")).toBe(join(dir, "s1", "main.jsonl"));
    expect(await sessionExists(dir, "s1")).toBe(true);
    expect(await readSessionJsonl(dir, "s1")).toEqual([
      { type: "user", uuid: "u1", message: { role: "user", content: "hi" } },
      { type: "assistant", uuid: "a1", message: { role: "assistant", content: "hello" } },
    ]);
  });

  test("listSessionFiles returns sessions with main.jsonl sorted by recency", async () => {
    await appendSessionJsonlEntry(dir, "older", { type: "user", uuid: "u1" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await appendSessionJsonlEntry(dir, "newer", { type: "user", uuid: "u2" });
    await appendSessionJsonlEntry(dir, "newer", { type: "assistant", uuid: "a2" });

    const rows = await listSessionFiles(dir);

    expect(rows.map((row) => row.sessionId)).toEqual(["newer", "older"]);
    expect(rows[0]?.mtime).toBeGreaterThanOrEqual(rows[1]?.mtime ?? 0);
  });

  test("deleteSession removes the whole session directory", async () => {
    await appendSessionJsonlEntry(dir, "s1", { type: "user", uuid: "u1" });
    await deleteSession(dir, "s1");

    expect(await sessionExists(dir, "s1")).toBe(false);
    expect(await readSessionJsonl(dir, "s1")).toEqual([]);
  });
});
