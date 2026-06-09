// ClaudeRunner: thin wrapper around @anthropic-ai/claude-agent-sdk query() that
// normalizes the streaming event format into the gateway's wire format.

import { createClaudebotSdkMcpServer } from "../tools/sdk-adapter.ts";
import type { ToolContext } from "../tools/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { buildSystemPrompt, type PromptInputs } from "./prompt.ts";
import type { AssistantContent, NormalizedEvent, SdkMessage, UserContent } from "./events.ts";
import type { RuntimeConfig } from "../config/schema.ts";

export type ClaudeRunnerDeps = {
  config: RuntimeConfig;
  registry: ToolRegistry;
  promptInputs: Omit<PromptInputs, "now">;
};

export type RunOptions = {
  prompt: string;
  resumeSessionId?: string;
};

export type QueryFactory = (args: {
  prompt: string;
  resumeSessionId?: string;
  systemPrompt: string;
  toolContext: ToolContext;
}) => AsyncIterable<unknown>;

export class ClaudeRunner {
  constructor(
    private readonly deps: ClaudeRunnerDeps,
    private readonly queryFactory: QueryFactory,
  ) {}

  async *run(opts: RunOptions): AsyncGenerator<NormalizedEvent> {
    const toolContext: ToolContext = {
      source: this.deps.promptInputs.source,
      home: this.deps.promptInputs.home,
      workspacePath: this.deps.promptInputs.workspacePath,
      timezone: this.deps.promptInputs.timezone,
      sessionId: this.deps.promptInputs.sessionId,
      scheduleRunId: this.deps.promptInputs.scheduleRunId,
      services: null,
    };
    const systemPrompt = await buildSystemPrompt(this.deps.promptInputs);
    const stream = this.queryFactory({
      prompt: opts.prompt,
      resumeSessionId: opts.resumeSessionId,
      systemPrompt,
      toolContext,
    });
    let lastSessionId: string | undefined;
    try {
      for await (const raw of stream) {
        const msg = raw as SdkMessage;
        if (msg.session_id) lastSessionId = msg.session_id;
        for (const ev of normalize(msg, lastSessionId)) {
          // For text/thinking deltas, slice the content into small chunks and
          // yield them with a tiny pause so the UI can paint incrementally.
          // The Claude Agent SDK returns the whole content in one block for
          // non-Anthropic endpoints (e.g. BigModel/glm-5.1), so without this
          // every "stream" lands as a single frame and the UI flashes the
          // final answer instead of typing it out.
          yield* maybeChunk(ev);
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      yield { type: "error", message, sessionId: lastSessionId };
    }
  }

  // Expose for the gateway to build a real SDK-backed query factory.
  buildToolContext(): ToolContext {
    return {
      source: this.deps.promptInputs.source,
      home: this.deps.promptInputs.home,
      workspacePath: this.deps.promptInputs.workspacePath,
      timezone: this.deps.promptInputs.timezone,
      sessionId: this.deps.promptInputs.sessionId,
      scheduleRunId: this.deps.promptInputs.scheduleRunId,
      services: null,
    };
  }
}

export function makeRealQueryFactory(
  registry: ToolRegistry,
  config: RuntimeConfig,
): QueryFactory {
  return async function* ({ prompt, resumeSessionId, systemPrompt, toolContext }) {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const mcpServer = createClaudebotSdkMcpServer(registry, toolContext);
    const stream = query({
      prompt,
      options: {
        model: config.claudeCode.model,
        systemPrompt,
        permissionMode: config.claudeCode.permissionMode,
        maxTurns: config.claudeCode.maxTurns,
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        mcpServers: { claudebot: mcpServer },
      },
    });
    for await (const msg of stream) yield msg;
  };
}

// --- Normalization --------------------------------------------------------

function normalize(msg: SdkMessage, fallbackSessionId?: string): NormalizedEvent[] {
  const sid = msg.session_id || fallbackSessionId;
  switch (msg.type) {
    case "assistant": {
      const content = msg.message?.content || msg.content || [];
      return content.flatMap((c) => assistantContentToEvent(c, sid));
    }
    case "user": {
      const content = msg.message?.content || msg.content || [];
      const out: NormalizedEvent[] = [];
      for (const c of content) {
        if (c.type === "tool_result") {
          out.push({
            type: "tool_result",
            id: c.tool_use_id,
            output: c.content,
            isError: !!c.is_error,
            sessionId: sid,
          });
        }
      }
      return out;
    }
    case "result": {
      return [
        {
          type: "turn_done",
          sessionId: sid || "",
          isError: !!msg.is_error,
          result: msg.result || "",
          totalCostUsd: msg.total_cost_usd,
        },
      ];
    }
    case "system": {
      if (msg.subtype === "thinking_tokens") return []; // noisy; ignore
      if (msg.subtype === "init") return [{ type: "status", status: "session_init", sessionId: sid }];
      return [];
    }
    case "error": {
      return [{ type: "error", message: msg.error || "unknown error", sessionId: sid }];
    }
    default:
      return [];
  }
}

function assistantContentToEvent(c: AssistantContent | UserContent, sid?: string): NormalizedEvent[] {
  if (c.type === "text") return [{ type: "text_delta", text: c.text, sessionId: sid }];
  if (c.type === "thinking") return [{ type: "thinking_delta", thinking: c.thinking, sessionId: sid }];
  if (c.type === "tool_use") return [{ type: "tool_start", id: c.id, name: c.name, input: c.input, sessionId: sid }];
  return [];
}

/**
 * For non-Anthropic endpoints, the Claude Agent SDK returns the entire
 * assistant content in one block (verified for glm-5.1: one ~136-char
 * thinking chunk, one ~9-char text chunk, all in a single assistant
 * message). Without intervention the UI flashes the final answer instead
 * of typing it out.
 *
 * We slice text/thinking deltas into small chunks (~6 chars) and yield
 * them with a tiny pause. The downstream client gets many small frames
 * and can re-render incrementally.
 */
const STREAM_CHUNK_SIZE = 6;
const STREAM_CHUNK_PAUSE_MS = 12;

async function* maybeChunk(ev: NormalizedEvent): AsyncGenerator<NormalizedEvent> {
  if (ev.type === "text_delta" && ev.text.length > STREAM_CHUNK_SIZE) {
    yield* chunkText(ev.text, STREAM_CHUNK_SIZE, STREAM_CHUNK_PAUSE_MS, (text) => ({
      type: "text_delta",
      text,
      sessionId: ev.sessionId,
    }));
    return;
  }
  if (ev.type === "thinking_delta" && ev.thinking.length > STREAM_CHUNK_SIZE) {
    yield* chunkText(ev.thinking, STREAM_CHUNK_SIZE, STREAM_CHUNK_PAUSE_MS, (text) => ({
      type: "thinking_delta",
      thinking: text,
      sessionId: ev.sessionId,
    }));
    return;
  }
  yield ev;
}

async function* chunkText(
  text: string,
  size: number,
  pauseMs: number,
  make: (chunk: string) => NormalizedEvent,
): AsyncGenerator<NormalizedEvent> {
  for (let i = 0; i < text.length; i += size) {
    yield make(text.slice(i, i + size));
    if (i + size < text.length && pauseMs > 0) {
      await new Promise((r) => setTimeout(r, pauseMs));
    }
  }
}
