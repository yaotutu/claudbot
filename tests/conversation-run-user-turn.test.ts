import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { buildServices } from "../src/runtime/services.ts";
import { resolveRuntimeConfig } from "../src/config/loader.ts";
import { runtimePaths } from "../src/config/paths.ts";
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
  return { services };
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
});
