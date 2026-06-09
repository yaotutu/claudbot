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
  const queryFactory = deps.queryFactory ?? makeRealQueryFactory(toolRegistry, config, paths.sdkConfigDir, sessionStore);
  const realScheduler = new SchedulerService(schedulerStore, async (sched, run) => {
    return runScheduledTurn(sched, run, sessions, paths, queryFactory);
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
  sessions: SessionStore,
  paths: RuntimePaths,
  _qf: QueryFactory,
): Promise<string> {
  // For MVP, the schedule executor is a stub: the schedule "completes" by
  // recording its own message as the result. A real implementation would
  // dispatch a one-off ClaudeRunner.run() against the same queryFactory
  // and stream the final result back to the scheduler.
  const state = await readRuntimeStateOrEmpty(paths.runtimeStateFile);
  const target = state.lastActiveSessionId;
  if (!target) return `[schedule ${sched.id}] skipped: no active session`;
  const session = await sessions.get(target);
  if (!session) return `[schedule ${sched.id}] skipped: session ${target} not found`;
  const result = `[schedule ${sched.id}] ${sched.message}`;
  await sessions.appendMessage(session.id, {
    role: "system",
    content: result,
    metadata: { kind: "schedule_delivery", scheduleId: sched.id, runId: run.id },
  });
  return result;
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
