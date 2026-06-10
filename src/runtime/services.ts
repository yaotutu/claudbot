// Service container: per-instance wiring of stores, registry, runner, gateway helpers.
//
// Assembly order is linear — no circular dependencies:
//   Store → StoreOps → Registry → queryFactory → Trigger

import { join } from "node:path";
import type { RuntimeConfig } from "../config/schema.ts";
import { loadConfig, type LoadedConfig } from "../config/loader.ts";
import { runtimePaths, type RuntimePaths } from "../config/paths.ts";
import { SessionStore } from "../sessions/store.ts";
import { createClaudebotSessionStore } from "../sessions/adapter.ts";
import { RuntimeStateStore } from "./state.ts";
import { AgentProfileStore } from "../agent/profile.ts";
import { MemoryStore } from "../memory/store.ts";
import { SchedulerStore } from "../scheduler/store.ts";
import { createStoreOps, type SchedulerStoreOps } from "../scheduler/store-ops.ts";
import { createSchedulerTrigger, type SchedulerTrigger } from "../scheduler/trigger.ts";
import { createNoopNotifier, type ScheduleNotifier } from "../scheduler/notify.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { registerSchedulerTools } from "../tools/builtin/scheduler.ts";
import { registerMemoryTools } from "../tools/builtin/memory.ts";
import { registerAgentFileTools } from "../tools/builtin/agent-files.ts";
import { ClaudeRunner, makeRealQueryFactory, type QueryFactory } from "../agent/runner.ts";
import { sessionExists } from "../sessions/adapter.ts";
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
  storeOps: SchedulerStoreOps;
  notifier: ScheduleNotifier;
  trigger: SchedulerTrigger;
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

  // Validate lastActiveSessionId on startup. If it points to a session that
  // doesn't exist in the new adapter format (e.g. old sess_*.json or a
  // phantom UUID from a failed run), clear it so the first user message
  // creates a fresh session instead of trying to resume a ghost.
  const initState = await runtimeState.get();
  if (initState.lastActiveSessionId) {
    const exists = await sessionExists(paths.sessionsDir, initState.lastActiveSessionId);
    if (!exists) {
      await runtimeState.setLastActiveSession("", "stale_reset");
      console.log(
        `[init] cleared stale lastActiveSessionId: ${initState.lastActiveSessionId} (no main.jsonl found)`,
      );
    }
  }

  // --- Linear assembly: Store → StoreOps → Registry → queryFactory → Trigger ---

  // 1. CRUD layer (no executor dependency)
  const storeOps = createStoreOps(schedulerStore);

  // 1b. Notification — starts as no-op; server.ts wires real delivery after WS handlers are ready.
  const notifier = createNoopNotifier();

  // 2. Lazy trigger reference — populated after queryFactory is built.
  //    Only `schedule_run_now` tool needs the trigger; CRUD tools use storeOps directly.
  let triggerRef: SchedulerTrigger | undefined;
  const getTrigger = (): SchedulerTrigger => {
    if (!triggerRef) throw new Error("scheduler trigger not yet initialized");
    return triggerRef;
  };

  // 3. Tool registry (storeOps + getTrigger — no cycle)
  const toolRegistry = buildToolRegistry(config, paths.toolAuditFile, {
    storeOps,
    getTrigger,
    memory,
    profile,
  });

  // 4. Session store + SDK sessions facade
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

  // 5. Query factory (uses registry — no cycle)
  const queryFactory = deps.queryFactory ?? makeRealQueryFactory(toolRegistry, config, paths.sdkConfigDir, sessionStore);

  // 6. Trigger (uses store + executor that closes over queryFactory — no cycle)
  triggerRef = createSchedulerTrigger(schedulerStore, async (sched, run) => {
    return runScheduledTurn(sched, run, config, toolRegistry, paths, queryFactory, notifier);
  });

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
    storeOps,
    notifier,
    trigger: triggerRef,
    toolRegistry,
    queryFactory,
    sdkSessions,
    makeRunner,
  };
}

function buildToolRegistry(
  config: RuntimeConfig,
  auditPath: string,
  services: { storeOps: SchedulerStoreOps; getTrigger: () => SchedulerTrigger; memory: MemoryStore; profile: AgentProfileStore },
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
  sched: { id: string; name: string; message: string; timezone: string },
  run: { id: string; startedAt: string },
  config: RuntimeConfig,
  toolRegistry: ToolRegistry,
  paths: RuntimePaths,
  queryFactory: QueryFactory,
  notifier: ScheduleNotifier,
): Promise<string> {
  // Create a new one-off session — do NOT resume any existing session.
  // The scheduled task executes in the background; the result is delivered
  // to the user via notifier.deliver. The execution session is cleaned up
  // after completion so it never appears in the sidebar.
  const prompt = `[定时任务 ${sched.name}] ${sched.message}`;
  const runner = new ClaudeRunner(
    {
      config,
      registry: toolRegistry,
      promptInputs: {
        source: "schedule_turn",
        home: paths.home,
        workspacePath: paths.workspace,
        timezone: sched.timezone,
        sessionId: `sched-${run.id}`,
        scheduleRunId: run.id,
        userFile: paths.userFile,
        soulFile: paths.soulFile,
      },
    },
    queryFactory,
  );
  let result = "";
  let execSessionId: string | undefined;
  for await (const ev of runner.run({ prompt })) {
    if (ev.type === "text_delta") result += ev.text;
    if (ev.type === "turn_done") {
      result = ev.result || result;
      if (ev.sessionId) execSessionId = ev.sessionId;
    }
  }
  const finalResult = result || `[定时任务 ${sched.name}] (no output)`;

  // Deliver result — notifier is a no-op until server.ts wires it.
  await notifier.deliver({
    scheduleId: sched.id,
    scheduleName: sched.name,
    status: "succeeded",
    result: finalResult,
  }).catch((err) => {
    console.error("[scheduler] notifier.deliver failed:", err instanceof Error ? err.message : err);
  });

  // Clean up the execution session — it's a background session that
  // should never appear in the user's sidebar.
  if (execSessionId) {
    const sessionDir = join(paths.sessionsDir, execSessionId);
    try {
      const { rm } = await import("node:fs/promises");
      await rm(sessionDir, { recursive: true, force: true });
    } catch {
      // Non-critical — best effort cleanup
    }
  }

  return finalResult;
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
