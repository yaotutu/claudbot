// Service container: per-instance wiring of stores, registry, runner, gateway helpers.
//
// Assembly order is linear — no circular dependencies:
//   Store → StoreOps → Registry → queryFactory → Trigger

import { join } from "node:path";
import type { RuntimeConfig } from "../config/schema.ts";
import { loadConfig, type LoadedConfig } from "../config/loader.ts";
import { runtimePaths, type RuntimePaths } from "../config/paths.ts";
import { createSdkJsonlSessionStore } from "../sessions/sdk-jsonl-store.ts";
import { createSessionService, type ClaudebotSessionService } from "../sessions/session-service.ts";
import { RuntimeStateStore } from "./state.ts";
import { AgentProfileStore } from "../agent/profile.ts";
import { MemoryStore } from "../memory/store.ts";
import { SchedulerStore } from "../scheduler/store.ts";
import { createStoreOps, type SchedulerStoreOps } from "../scheduler/store-ops.ts";
import { createSchedulerTrigger, type SchedulerTrigger } from "../scheduler/trigger.ts";
import { createNoopNotifier, type ScheduleNotifier } from "../scheduler/notify.ts";
import { createNotificationStore, type NotificationStore } from "../notifications/store.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { registerSchedulerTools } from "../tools/builtin/scheduler.ts";
import { registerMemoryTools } from "../tools/builtin/memory.ts";
import { registerAgentFileTools } from "../tools/builtin/agent-files.ts";
import { ClaudeRunner, makeRealQueryFactory, type QueryFactory } from "../agent/runner.ts";
import type { SessionStore as SDKSessionStore } from "@anthropic-ai/claude-agent-sdk";

export type ServiceContainer = {
  config: RuntimeConfig;
  paths: RuntimePaths;
  runtimeState: RuntimeStateStore;
  profile: AgentProfileStore;
  memory: MemoryStore;
  schedulerStore: SchedulerStore;
  notificationStore: NotificationStore;
  storeOps: SchedulerStoreOps;
  notifier: ScheduleNotifier;
  trigger: SchedulerTrigger;
  toolRegistry: ToolRegistry;
  queryFactory: QueryFactory;
  sdkSessionStore: SDKSessionStore;
  sessions: ClaudebotSessionService;
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
  const runtimeState = new RuntimeStateStore(paths.runtimeStateFile);
  const profile = new AgentProfileStore({
    userFile: paths.userFile,
    soulFile: paths.soulFile,
    memoryFile: paths.memoryFile,
  });
  await profile.init();
  const memory = new MemoryStore(paths.memoryFile);
  const schedulerStore = new SchedulerStore(paths.schedulesFile, paths.runsFile);
  const notificationStore = createNotificationStore(paths.notificationsFile);
  const sessions = createSessionService({ sessionsDir: paths.sessionsDir, runtimeState });
  await sessions.clearStaleActiveSession();

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

  // 4. SDK transcript mirror store. Business session reads go through `sessions`.
  const sdkSessionStore = createSdkJsonlSessionStore({ sessionsDir: paths.sessionsDir });

  // 5. Query factory (uses registry — no cycle)
  const queryFactory = deps.queryFactory ?? makeRealQueryFactory(toolRegistry, config, paths.sdkConfigDir, sdkSessionStore);

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
    runtimeState,
    profile,
    memory,
    schedulerStore,
    notificationStore,
    storeOps,
    notifier,
    trigger: triggerRef,
    toolRegistry,
    queryFactory,
    sdkSessionStore,
    sessions,
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
  let failedMessage = "";
  let execSessionId: string | undefined;
  for await (const ev of runner.run({ prompt })) {
    if (ev.type === "text_delta") result += ev.text;
    if (ev.type === "turn_done") {
      result = ev.result || result;
      if (ev.sessionId) execSessionId = ev.sessionId;
      if (ev.isError) failedMessage = ev.result || "scheduled turn failed";
    }
    if (ev.type === "error") {
      failedMessage = ev.message;
      if (ev.sessionId) execSessionId = ev.sessionId;
    }
  }
  if (failedMessage) {
    await notifier.deliver({
      scheduleId: sched.id,
      scheduleName: sched.name,
      runId: run.id,
      status: "failed",
      result: failedMessage,
    }).catch((err) => {
      console.error("[scheduler] notifier.deliver failed:", err instanceof Error ? err.message : err);
    });
    throw new Error(failedMessage);
  }
  const finalResult = result || `[定时任务 ${sched.name}] (no output)`;

  // Deliver result — notifier is a no-op until server.ts wires it.
  await notifier.deliver({
    scheduleId: sched.id,
    scheduleName: sched.name,
    runId: run.id,
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
