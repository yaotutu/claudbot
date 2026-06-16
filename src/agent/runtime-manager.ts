import type { SDKUserMessage, SessionStore } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeConfig } from "../config/schema.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolContextRef } from "../tools/types.ts";
import { createClaudebotSdkMcpServer } from "../tools/sdk-mcp-server.ts";
import { buildSystemPrompt, type PromptInputs } from "./prompt.ts";
import { buildBaseSdkOptions } from "./sdk-options.ts";
import { createAsyncInputQueue, type AsyncInputQueue } from "./input-queue.ts";
import { normalizeSdkMessage } from "./runner.ts";
import type { NormalizedEvent, SdkMessage } from "./events.ts";

export type RuntimeStatus = "idle" | "running" | "cancelling" | "failed" | "closed";

export type AgentRuntimeQuery = {
  stream: AsyncIterable<unknown>;
  interrupt(): Promise<void>;
  close(): void;
};

export type AgentRuntimeQueryFactory = (args: {
  input: AsyncIterable<SDKUserMessage>;
  options: Record<string, unknown>;
}) => Promise<AgentRuntimeQuery>;

export type AgentRuntimeManagerDeps = {
  config: RuntimeConfig;
  registry: ToolRegistry;
  sdkConfigDir: string;
  sessionStore: SessionStore;
  promptInputs: Omit<PromptInputs, "now" | "source" | "sessionId" | "scheduleRunId" | "toolPrompts">;
  queryFactory?: AgentRuntimeQueryFactory;
};

type AgentRuntime = {
  sessionId: string;
  inputQueue: AsyncInputQueue<SDKUserMessage>;
  query: AgentRuntimeQuery;
  contextRef: ToolContextRef;
  status: RuntimeStatus;
  activeRunId?: string;
  activeSink?: (event: NormalizedEvent) => void | Promise<void>;
  events: NormalizedEvent[];
  waiters: Array<(event: NormalizedEvent) => void>;
  lastUsedAt: number;
};

export function createAgentRuntimeManager(deps: AgentRuntimeManagerDeps) {
  const runtimes = new Map<string, AgentRuntime>();
  const pendingRuntimes = new Map<string, Promise<AgentRuntime>>();
  const queryFactory = deps.queryFactory ?? createRealRuntimeQueryFactory();

  async function getOrCreate(sessionId: string, resumeSessionId?: string): Promise<AgentRuntime> {
    const existing = runtimes.get(sessionId);
    if (existing && existing.status !== "closed") return existing;
    const pending = pendingRuntimes.get(sessionId);
    if (pending) return pending;

    const creating = createRuntime(sessionId, resumeSessionId).finally(() => pendingRuntimes.delete(sessionId));
    pendingRuntimes.set(sessionId, creating);
    return creating;
  }

  async function createRuntime(sessionId: string, resumeSessionId?: string): Promise<AgentRuntime> {
    const inputQueue = createAsyncInputQueue<SDKUserMessage>();
    const contextRef: ToolContextRef = { current: makeContext(sessionId) };
    const nativeServer = createClaudebotSdkMcpServer(deps.registry, contextRef);
    const systemPrompt = await buildSystemPrompt({
      ...deps.promptInputs,
      source: "user_turn",
      sessionId,
      toolPrompts: deps.registry.getPromptSections(),
    });
    const options = {
      ...buildBaseSdkOptions(deps.config, deps.sdkConfigDir, nativeServer),
      systemPrompt,
      sessionStore: deps.sessionStore,
      ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    };
    const query = await queryFactory({ input: inputQueue.iterable, options });
    const runtime: AgentRuntime = {
      sessionId,
      inputQueue,
      query,
      contextRef,
      status: "idle",
      events: [],
      waiters: [],
      lastUsedAt: Date.now(),
    };
    runtimes.set(sessionId, runtime);
    void pump(runtime);
    return runtime;
  }

  function makeContext(sessionId: string) {
    return {
      source: "user_turn" as const,
      home: deps.promptInputs.home,
      workspacePath: deps.promptInputs.workspacePath,
      timezone: deps.promptInputs.timezone,
      sessionId,
      services: null,
    };
  }

  async function pump(runtime: AgentRuntime): Promise<void> {
    try {
      let lastSessionId: string | undefined = runtime.sessionId;
      for await (const raw of runtime.query.stream) {
        const msg = raw as SdkMessage;
        if (msg.session_id) lastSessionId = msg.session_id;
        for (const event of normalizeSdkMessage(msg, lastSessionId)) await publish(runtime, event);
      }
      if (runtime.status !== "closed") {
        runtime.status = "closed";
        await publish(runtime, { type: "error", message: "agent runtime closed", sessionId: lastSessionId });
      }
    } catch (err) {
      runtime.status = "failed";
      await publish(runtime, { type: "error", message: err instanceof Error ? err.message : String(err), sessionId: runtime.sessionId });
    }
  }

  async function publish(runtime: AgentRuntime, event: NormalizedEvent): Promise<void> {
    runtime.events.push(event);
    await runtime.activeSink?.(event);
    const waiters = runtime.waiters.splice(0);
    for (const waiter of waiters) waiter(event);
  }

  async function runTurn(args: {
    sessionId: string;
    content: string;
    runId?: string;
    resumeSessionId?: string;
    onEvent?: (event: NormalizedEvent) => void | Promise<void>;
  }): Promise<{ runId: string; events: NormalizedEvent[] }> {
    const runtime = await getOrCreate(args.sessionId, args.resumeSessionId);
    if (runtime.status === "running" || runtime.status === "cancelling") throw new Error(`session already running: ${args.sessionId}`);

    const runId = args.runId ?? crypto.randomUUID();
    runtime.status = "running";
    runtime.activeRunId = runId;
    runtime.activeSink = args.onEvent;
    runtime.contextRef.current = makeContext(args.sessionId);
    const startIndex = runtime.events.length;
    runtime.inputQueue.push({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: args.content },
    });

    while (true) {
      const existing = runtime.events.slice(startIndex).find((event) => event.type === "turn_done" || event.type === "error");
      if (existing) break;
      await new Promise<void>((resolve) => runtime.waiters.push(() => resolve()));
    }

    if (runtime.status === "running" || runtime.status === "cancelling") runtime.status = "idle";
    runtime.activeRunId = undefined;
    runtime.activeSink = undefined;
    runtime.lastUsedAt = Date.now();
    return { runId, events: runtime.events.slice(startIndex) };
  }

  async function cancel(sessionId: string): Promise<void> {
    const runtime = runtimes.get(sessionId);
    if (!runtime) return;
    runtime.status = "cancelling";
    await runtime.query.interrupt();
  }

  function closeSession(sessionId: string): void {
    const runtime = runtimes.get(sessionId);
    if (!runtime) return;
    runtime.status = "closed";
    runtime.inputQueue.close();
    runtime.query.close();
    runtimes.delete(sessionId);
  }

  function closeIdle(now = Date.now(), ttlMs = 20 * 60 * 1000): void {
    for (const [sessionId, runtime] of runtimes) {
      if (runtime.status === "idle" && now - runtime.lastUsedAt >= ttlMs) closeSession(sessionId);
    }
  }

  function closeAll(): void {
    for (const sessionId of [...runtimes.keys()]) closeSession(sessionId);
  }

  function remapSession(fromSessionId: string, toSessionId: string): void {
    if (fromSessionId === toSessionId) return;
    const runtime = runtimes.get(fromSessionId);
    if (!runtime) return;
    if (runtimes.has(toSessionId)) throw new Error(`runtime already exists for session: ${toSessionId}`);
    runtimes.delete(fromSessionId);
    runtime.sessionId = toSessionId;
    runtime.contextRef.current = makeContext(toSessionId);
    runtimes.set(toSessionId, runtime);
  }

  return {
    runTurn,
    cancel,
    closeSession,
    closeIdle,
    closeAll,
    remapSession,
    get activeCount() {
      return runtimes.size;
    },
  };
}

function createRealRuntimeQueryFactory(): AgentRuntimeQueryFactory {
  return async ({ input, options }) => {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const sdkQuery = query({ prompt: input, options: options as never });
    return {
      stream: sdkQuery,
      interrupt: () => sdkQuery.interrupt(),
      close: () => sdkQuery.close(),
    };
  };
}
