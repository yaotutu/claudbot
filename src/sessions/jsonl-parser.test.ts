import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseJsonlToUIMessages, flattenContent, extractMetadata } from "./jsonl-parser.ts";

describe("flattenContent", () => {
  test("concatenates text blocks in order", () => {
    const content = [
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ];
    expect(flattenContent(content)).toBe("Hello world");
  });

  test("serializes tool_use as [tool:name] summary", () => {
    const content = [
      { type: "text", text: "I'll check. " },
      { type: "tool_use", id: "t1", name: "Read", input: { file: "/etc/hosts" } },
      { type: "text", text: "Done." },
    ];
    expect(flattenContent(content)).toBe("I'll check. [tool:Read] Done.");
  });

  test("returns empty string for empty content", () => {
    expect(flattenContent([])).toBe("");
  });
});

describe("extractMetadata", () => {
  test("captures tool_use ids + names", () => {
    const content = [
      { type: "tool_use", id: "t1", name: "Read", input: { file: "/x" } },
      { type: "tool_use", id: "t2", name: "Bash", input: { cmd: "ls" } },
    ];
    expect(extractMetadata(content)).toEqual({
      toolCalls: [
        { id: "t1", name: "Read", input: { file: "/x" } },
        { id: "t2", name: "Bash", input: { cmd: "ls" } },
      ],
    });
  });

  test("captures thinking blocks when present", () => {
    const content = [{ type: "thinking", thinking: "let me think..." }];
    expect(extractMetadata(content)).toEqual({ thinking: "let me think..." });
  });

  test("returns empty object when no tool_use or thinking", () => {
    expect(extractMetadata([{ type: "text", text: "hi" }])).toEqual({});
  });
});

describe("parseJsonlToUIMessages", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "claudebot-parser-"));
  });

  async function writeJsonl(name: string, lines: string[]) {
    const file = join(dir, name);
    await Bun.write(file, lines.join("\n") + "\n");
    return file;
  }

  test("parses user and assistant messages, ignoring non-message types", async () => {
    const file = await writeJsonl("transcript.jsonl", [
      JSON.stringify({ type: "user", uuid: "u1", timestamp: "2026-06-09T10:00:00Z", message: { role: "user", content: "hi" } }),
      JSON.stringify({ type: "assistant", uuid: "a1", timestamp: "2026-06-09T10:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } }),
      JSON.stringify({ type: "system", subtype: "init", uuid: "i1", timestamp: "2026-06-09T09:59:59Z" }),
      JSON.stringify({ type: "summary", uuid: "sm1", summary: "auto-summary" }),
    ]);
    const out = await parseJsonlToUIMessages(file);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ id: "u1", role: "user", content: "hi", createdAt: "2026-06-09T10:00:00Z" });
    expect(out[1]).toMatchObject({ id: "a1", role: "assistant", content: "hello", createdAt: "2026-06-09T10:00:01Z" });
  });

  test("falls back to file mtime when timestamp is missing", async () => {
    const file = await writeJsonl("no-ts.jsonl", [
      JSON.stringify({ type: "user", uuid: "u1", message: { role: "user", content: "hi" } }),
    ]);
    const out = await parseJsonlToUIMessages(file);
    expect(out).toHaveLength(1);
    expect(out[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("captures toolCalls in metadata for assistant messages", async () => {
    const file = await writeJsonl("tool.jsonl", [
      JSON.stringify({
        type: "assistant",
        uuid: "a1",
        timestamp: "2026-06-09T10:00:00Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "checking" },
            { type: "tool_use", id: "t1", name: "Read", input: { path: "/x" } },
          ],
        },
      }),
    ]);
    const out = await parseJsonlToUIMessages(file);
    expect(out[0].content).toBe("checking [tool:Read]");
    expect(out[0].metadata).toEqual({ toolCalls: [{ id: "t1", name: "Read", input: { path: "/x" } }] });
  });

  test("skips assistant records that only contain thinking blocks", async () => {
    const file = await writeJsonl("thinking-only.jsonl", [
      JSON.stringify({
        type: "assistant",
        uuid: "a-thinking",
        timestamp: "2026-06-09T10:00:00Z",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden reasoning" }] },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "a-text",
        timestamp: "2026-06-09T10:00:01Z",
        message: { role: "assistant", content: [{ type: "text", text: "visible" }] },
      }),
    ]);

    const out = await parseJsonlToUIMessages(file);

    expect(out.map((message) => message.id)).toEqual(["a-text"]);
    expect(out[0].content).toBe("visible");
  });

  test("returns [] for an empty file", async () => {
    const file = await writeJsonl("empty.jsonl", []);
    const out = await parseJsonlToUIMessages(file);
    expect(out).toEqual([]);
  });
});
