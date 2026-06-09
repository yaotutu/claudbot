// Service container: per-instance wiring of stores, registry, runner, gateway helpers.

import type { RuntimeConfig } from "../config/schema.ts";
import { loadConfig, type LoadedConfig } from "../config/loader.ts";
import { runtimePaths, type RuntimePaths } from "../config/paths.ts";
import { SessionStore } from "../sessions/store.ts";
import { createClaudebotSessionStore } from "../sessions/adapter.ts";
import { RuntimeStateStore } from "./state.ts";
import { AgentProfileStore } from "../agent/profile.ts";
import { MemoryStore } from "../memory/store.ts";
import { SchedulerStore } from "../scheduler/store.ts";
import { SchedulerService } from "../scheduler/service.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { registerSchedulerTools } from "../tools/builtin/scheduler.ts";
import { registerMemoryTools } from "../tools/builtin/memory.ts";
import { registerAgentFileTools } from "../tools/builtin/agent-files.ts";
import { ClaudeRunner, makeRealQueryFactory, type QueryFactory } from "../agent/runner.ts";
import { getSessionInfo, renameSession, deleteSession } from "@anthropic-ai/claude-agent-sdk";
import type { SessionStore as SDKSessionStore, SDKSessionInfo } from "@anthropic-ai/claude-agent-sdk";

export type SdkSessionsFacade = {
  store: SDKSessionStore;
  list: (projectKey: string) => Promise<Array<{ sessionId: string; mtime: number }>>;
  info: (sessionId: string) => Promise<SDKSessionInfo | undefined>;
  rename: (sessionId: string, title: string) => Promise<void>;
  remove: (sessionId: string) => Promise<void>;
};

export type ServiceContainer = {
  config: RuntimeConfig;
  paths: RuntimePaths;
  sessions: SessionStore;
  runtimeState: RuntimeStateStore;
  profile: AgentProfileStore;
  memory: MemoryStore;
  schedulerStore: SchedulerStore;
  scheduler: SchedulerService;
  toolRegistry: ToolRegistry;
  queryFactory: QueryFactory;
  sdkSessions: SdkSessionsFacade;
  makeRunner: (source: "user_turn" | "schedule_turn", sessionId?: string, scheduleRunId?: string) => ClaudeRunner;
};

export type ServiceDeps = {
  /** Pre-loaded config + source. Takes precedence over `config` if both are set. */
  loaded?: LoadedConfig;
  /** Legacy test-injection path: just hand-build a config. Source is recorded
   *  as "defaults". Prefer `loaded` in new code. */
  config?: RuntimeConfig;
  queryFactory?: QueryFactory;
  paths?: RuntimePaths;
};

export async function buildServices(deps: ServiceDeps = {}): Promise<ServiceContainer> {
  const loaded: LoadedConfig = deps.loaded
    ?? (deps.config
        ? { config: deps.config, source: { kind: "defaults" } }
        : await loadConfig());
  const config = loaded.config;
  const paths = deps.paths ?? runtimePaths(config);
  const sessions = new SessionStore(paths.sessionsDir);
  const runtimeState = new RuntimeStateStore(paths.runtimeStateFile);
  const profile = new AgentProfileStore({
    userFile: paths.userFile,
    soulFile: paths.soulFile,
    memoryFile: paths.memoryFile,
  });
  await profile.init();
  const memory = new MemoryStore(paths.memoryFile);
  const schedulerStore = new SchedulerStore(paths.schedulesFile, paths.runsFile);

  // Build the tool registry. The registry depends on the SchedulerService for
  // the schedule_* tools, and the scheduler's executor depends on the
  // queryFactory, which depends on the registry. We break the cycle by:
  //   1. Building a placeholder SchedulerService that we'll swap out below.
  //   2. Building the registry with the placeholder.
  //   3. Building the real queryFactory closed over the real registry.
  //   4. Building the real SchedulerService that uses the real queryFactory.
  //   5. Pointing the placeholder → real (the registry holds a reference).
  const placeholderScheduler: SchedulerService = new SchedulerService(schedulerStore, async () => {
    throw new Error("placeholder scheduler invoked before real one was wired");
  });
  const toolRegistry = buildToolRegistry(config, paths.toolAuditFile, {
    scheduler: placeholderScheduler,
    memory,
    profile,
  });
  const sessionStore = createClaudebotSessionStore({ sessionsDir: paths.sessionsDir });
  const sdkSessions: SdkSessionsFacade = {
    store: sessionStore,
    list: (projectKey: string) => sessionStore.listSessions!(projectKey),
    info: async (sessionId: string) => {
      return getSessionInfo(sessionId, { sessionStore });
    },
    rename: async (sessionId: string, title: string) => {
      await renameSession(sessionId, title, { sessionStore });
    },
    remove: async (sessionId: string) => {
      await deleteSession(sessionId, { sessionStore });
    },
  };
  const queryFactory = deps.queryFactory ?? makeRealQueryFactory(toolRegistry, config, paths.sdkConfigDir, sessionStore);
  const realScheduler = new SchedulerService(schedulerStore, async (sched, run) => {
    return runScheduledTurn(sched, run, config, toolRegistry, paths, queryFactory);
  });
  // Re-point the registry's scheduler reference to the real one.
  (toolRegistry as unknown as { scheduler: SchedulerService }).scheduler = realScheduler;

  const makeRunner = (source: "user_turn" | "schedule_turn", sessionId?: string, scheduleRunId?: string): ClaudeRunner => {
    return new ClaudeRunner(
      {
        config,
        registry: toolRegistry,
        promptInputs: {
          home: paths.home,
          workspacePath: paths.workspace,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          source,
          sessionId,
          scheduleRunId,
          userFile: paths.userFile,
          soulFile: paths.soulFile,
        },
      },
      queryFactory,
    );
  };
  return {
    config,
    paths,
    sessions,
    runtimeState,
    profile,
    memory,
    schedulerStore,
    scheduler: realScheduler,
    toolRegistry,
    queryFactory,
    sdkSessions,
    makeRunner,
  };
}

function buildToolRegistry(
  config: RuntimeConfig,
  auditPath: string,
  services: { scheduler: SchedulerService; memory: MemoryStore; profile: AgentProfileStore },
): ToolRegistry {
  const permissions = {
    defaultPolicy: config.tools.permissions.default,
    overrides: config.tools.permissions.overrides,
  };
  const registry = new ToolRegistry(permissions, auditPath);
  registerSchedulerTools(registry, services);
  registerMemoryTools(registry, services);
  registerAgentFileTools(registry, services);
  return registry;
}

async function runScheduledTurn(
  sched: { id: string; message: string; timezone: string },
  run: { id: string; startedAt: string },
  config: RuntimeConfig,
  toolRegistry: ToolRegistry,
  paths: RuntimePaths,
  queryFactory: QueryFactory,
): Promise<string> {
  // Dispatch a real turn against the last-active session. The runner
  // streams via the same queryFactory used for user turns; the SDK
  // session store adapter folds the result into the session's .jsonl
  // automatically (the runner passes `resumeSessionId: target`).
  const state = await readRuntimeStateOrEmpty(paths.runtimeStateFile);
  const target = state.lastActiveSessionId;
  if (!target) {
    return `[schedule ${sched.id}] skipped: no active session`;
  }
  const prompt = `[schedule ${sched.id}] ${sched.message}`;
  const runner = new ClaudeRunner(
    {
      config,
      registry: toolRegistry,
      promptInputs: {
        source: "schedule_turn",
        home: paths.home,
        workspacePath: paths.workspace,
        timezone: sched.timezone,
        sessionId: target,
        scheduleRunId: run.id,
        userFile: paths.userFile,
        soulFile: paths.soulFile,
      },
    },
    queryFactory,
  );
  let result = "";
  for await (const ev of runner.run({ prompt, resumeSessionId: target })) {
    if (ev.type === "text_delta") result += ev.text;
    if (ev.type === "turn_done") result = ev.result || result;
  }
  return result || `[schedule ${sched.id}] (no output)`;
}

async function readRuntimeStateOrEmpty(path: string): Promise<{ lastActiveSessionId: string }> {
  try {
    const f = Bun.file(path);
    if (!(await f.exists())) return { lastActiveSessionId: "" };
    return await f.json() as { lastActiveSessionId: string };
  } catch {
    return { lastActiveSessionId: "" };
  }
}
