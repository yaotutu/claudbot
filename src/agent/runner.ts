// ClaudeRunner: thin wrapper around @anthropic-ai/claude-agent-sdk query() that
// normalizes the streaming event format into the gateway's wire format.

import { createClaudebotSdkMcpServer } from "../tools/sdk-mcp-server.ts";
import type { ToolContext } from "../tools/types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import { buildSystemPrompt, type PromptInputs } from "./prompt.ts";
import type { AssistantContent, NormalizedEvent, SdkMessage, UserContent } from "./events.ts";
import type { RuntimeConfig } from "../config/schema.ts";
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";

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
    const systemPrompt = await buildSystemPrompt({
      ...this.deps.promptInputs,
      toolPrompts: this.deps.registry.getPromptSections(),
    });
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
          yield ev;
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
  sdkConfigDir: string,
  sessionStore: SessionStore,
): QueryFactory {
  return async function* ({ prompt, resumeSessionId, systemPrompt, toolContext }) {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const mcpServer = createClaudebotSdkMcpServer(registry, toolContext);
    // The SDK's `Options.env` is the only way to point the Claude Code
    // subprocess at a non-Anthropic endpoint — it has no direct `baseUrl`/
    // `apiKey` fields. We translate our config into the env vars the
    // subprocess reads, and spread `process.env` first so the subprocess
    // still has PATH, HOME, etc. Config wins over process.env when set.
    // We set both ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN because the
    // Claude Code CLI checks the AUTH_TOKEN variant when the base URL is
    // a non-Anthropic host (proxy / OpenAI-compat / BigModel etc.) and
    // 401s otherwise — even though the proxy itself would accept either.
    // CLAUDE_CONFIG_DIR pins the SDK subprocess to a claudebot-owned
    // config directory so its session storage lives under our home
    // directory rather than the user's default ~/.claude.
    const env: Record<string, string | undefined> = {
      ...process.env,
      CLAUDE_CONFIG_DIR: sdkConfigDir,
      ...(config.claudeCode.baseUrl ? { ANTHROPIC_BASE_URL: config.claudeCode.baseUrl } : {}),
      ...(config.claudeCode.apiKey
        ? {
            ANTHROPIC_API_KEY: config.claudeCode.apiKey,
            ANTHROPIC_AUTH_TOKEN: config.claudeCode.apiKey,
          }
        : {}),
    };
    const stream = query({
      prompt,
      options: {
        model: config.claudeCode.model,
        systemPrompt,
        permissionMode: config.claudeCode.permissionMode,
        maxTurns: config.claudeCode.maxTurns,
        env,
        ...(resumeSessionId ? { resume: resumeSessionId } : {}),
        mcpServers: { claudebot: mcpServer },
        sessionStore,
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
