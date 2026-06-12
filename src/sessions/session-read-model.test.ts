import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendSessionJsonlEntry } from "./jsonl-store.ts";
import { buildSessionSummary, listSessionSummaries, readThreadMessages } from "./session-read-model.ts";

describe("session read model", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "claudebot-read-model-"));
  });

  test("buildSessionSummary derives title, preview, timestamps, and message count from JSONL", async () => {
    await appendSessionJsonlEntry(dir, "s1", {
      type: "user",
      uuid: "u1",
      timestamp: "2026-06-10T09:59:40.000Z",
      message: { role: "user", content: [{ type: "text", text: "hello world" }] },
    });
    await appendSessionJsonlEntry(dir, "s1", {
      type: "assistant",
      uuid: "a1",
      timestamp: "2026-06-10T09:59:45.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    });

    const summary = await buildSessionSummary(dir, "s1");

    expect(summary).toMatchObject({
      id: "s1",
      title: "hello world",
      preview: "hello world",
      createdAt: "2026-06-10T09:59:40.000Z",
      messageCount: 2,
      status: "persisted",
    });
    expect(typeof summary.updatedAt).toBe("string");
  });

  test("custom-title JSONL entries override generated titles", async () => {
    await appendSessionJsonlEntry(dir, "s1", {
      type: "user",
      uuid: "u1",
      timestamp: "2026-06-10T09:59:40.000Z",
      message: { role: "user", content: "hello world" },
    });
    await appendSessionJsonlEntry(dir, "s1", {
      type: "custom-title",
      uuid: "t1",
      timestamp: "2026-06-10T10:00:00.000Z",
      customTitle: "Renamed title",
      sessionId: "s1",
    });

    const summary = await buildSessionSummary(dir, "s1");

    expect(summary.title).toBe("Renamed title");
    expect(summary.preview).toBe("hello world");
    expect(summary.messageCount).toBe(1);
  });

  test("listSessionSummaries reads all JSONL sessions by recency", async () => {
    await appendSessionJsonlEntry(dir, "older", { type: "user", uuid: "u1", message: { role: "user", content: "old" } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await appendSessionJsonlEntry(dir, "newer", { type: "user", uuid: "u2", message: { role: "user", content: "new" } });

    const summaries = await listSessionSummaries(dir);

    expect(summaries.map((row) => row.id)).toEqual(["newer", "older"]);
  });

  test("readThreadMessages parses visible messages from JSONL", async () => {
    await appendSessionJsonlEntry(dir, "s1", {
      type: "user",
      uuid: "u1",
      timestamp: "2026-06-10T09:59:40.000Z",
      message: { role: "user", content: "hello" },
    });

    const messages = await readThreadMessages(dir, "s1");

    expect(messages).toEqual([{ id: "u1", role: "user", content: "hello", createdAt: "2026-06-10T09:59:40.000Z", metadata: {} }]);
  });
});
