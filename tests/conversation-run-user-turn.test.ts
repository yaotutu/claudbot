import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { buildServices } from "../src/runtime/services.ts";
import { resolveRuntimeConfig } from "../src/config/loader.ts";
import { runtimePaths } from "../src/config/paths.ts";
import { readSessionJsonl } from "../src/sessions/jsonl-store.ts";
import type { QueryFactory } from "../src/agent/runner.ts";
import type { SdkMessage } from "../src/agent/events.ts";
import { runUserTurn } from "../src/conversation/run-user-turn.ts";
import type { ConversationEvent } from "../src/conversation/types.ts";

function makeRecordingQueryFactory(events: SdkMessage[]): QueryFactory & { calls: Array<{ prompt: string; resumeSessionId?: string }> } {
  const calls: Array<{ prompt: string; resumeSessionId?: string }> = [];
  const factory: QueryFactory = async function* (args) {
    calls.push({ prompt: args.prompt, resumeSessionId: args.resumeSessionId });
    for (const event of events) yield event;
  };
  return Object.assign(factory, { calls });
}

async function makeServices(queryFactory: QueryFactory) {
  const dir = await mkdtemp(join(tmpdir(), "claudebot-conversation-"));
  const config = resolveRuntimeConfig({ home: dir }, {});
  const paths = runtimePaths(config);
  const services = await buildServices({ config, paths, queryFactory });
  return { services, paths };
}

describe("conversation runUserTurn", () => {
  test("runs a user turn through a sink without requiring a WebSocket", async () => {
    const init = JSON.parse(readFileSync("tests/fixtures/sdk-events/01-init.json", "utf8")) as SdkMessage;
    const text = JSON.parse(readFileSync("tests/fixtures/sdk-events/05-text-assistant.json", "utf8")) as SdkMessage;
    const result = JSON.parse(readFileSync("tests/fixtures/sdk-events/07-result-success.json", "utf8")) as SdkMessage;
    const factory = makeRecordingQueryFactory([init, text, result]);
    const { services } = await makeServices(factory);
    const events: ConversationEvent[] = [];

    const output = await runUserTurn(
      services,
      { source: "webui", sessionId: null, draftId: "draft-1", content: "ping" },
      { send: (event) => { events.push(event); } },
    );

    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "session.created",
      "run.status",
      "run.delta",
      "run.completed",
      "message.appended",
    ]);
    expect(events.find((event) => event.type === "session.created")).toMatchObject({
      draftId: "draft-1",
      session: { title: "ping" },
    });
    expect(output).toMatchObject({ isError: false, result: expect.any(String) });
    expect(output.sessionId).toBeTruthy();
    expect(factory.calls).toEqual([{ prompt: "ping", resumeSessionId: undefined }]);
  });

  test("persists run activity on final message metadata and session JSONL", async () => {
    const sessionId = "sdk-activity";
    const factory = makeRecordingQueryFactory([
      {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        mcp_servers: [{ name: "claudebot", status: "connected" }],
      },
      {
        type: "assistant",
        session_id: sessionId,
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Need to search memory." },
            { type: "tool_use", id: "tool-1", name: "mcp__claudebot__memory_search", input: { query: "activity" } },
          ],
        },
      },
      {
        type: "user",
        session_id: sessionId,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "[]", is_error: false }],
        },
      },
      {
        type: "assistant",
        session_id: sessionId,
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      },
      { type: "result", session_id: sessionId, is_error: false, result: "done" },
    ] as SdkMessage[]);
    const { services, paths } = await makeServices(factory);
    const events: ConversationEvent[] = [];

    await runUserTurn(
      services,
      { source: "webui", sessionId: null, draftId: "draft-activity", content: "test activity" },
      { send: (event) => { events.push(event); } },
    );

    const finalMessage = events.find((event) => event.type === "message.appended");
    expect(finalMessage).toMatchObject({
      type: "message.appended",
      message: {
        role: "assistant",
        content: "done",
        metadata: {
          runId: expect.any(String),
          activities: [
            expect.objectContaining({ kind: "status", text: "session_init", status: "complete" }),
            expect.objectContaining({ kind: "thinking", text: "Need to search memory.", status: "complete" }),
            expect.objectContaining({ kind: "tool", name: "mcp__claudebot__memory_search", status: "complete" }),
          ],
        },
      },
    });

    const entries = await readSessionJsonl(paths.sessionsDir, sessionId);
    expect(entries.at(-1)).toMatchObject({
      type: "claudebot-run-activity",
      sessionId,
      runId: expect.any(String),
      activities: [
        expect.objectContaining({ kind: "status", text: "session_init", status: "complete" }),
        expect.objectContaining({ kind: "thinking", text: "Need to search memory.", status: "complete" }),
        expect.objectContaining({ kind: "tool", name: "mcp__claudebot__memory_search", status: "complete" }),
      ],
    });
  });
});
