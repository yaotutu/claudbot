// Service container: per-instance wiring of stores, registry, runner, gateway helpers.

import { resolveRuntimeConfig } from "../config/loader.ts";
import type { RuntimeConfig } from "../config/schema.ts";
import { runtimePaths, type RuntimePaths } from "../config/paths.ts";
import { SessionStore } from "../sessions/store.ts";
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
import { loadConfig } from "../config/loader.ts";

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
  config?: RuntimeConfig;
  queryFactory?: QueryFactory;
  paths?: RuntimePaths;
};

export async function buildServices(deps: ServiceDeps = {}): Promise<ServiceContainer> {
  const config = deps.config ?? await loadConfig();
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
  const queryFactory = deps.queryFactory ?? makeDefaultQueryFactory(config, paths.toolAuditFile);
  const scheduler = new SchedulerService(schedulerStore, async (sched, run) => {
    const ctx = { source: "schedule_turn" as const, home: paths.home, workspacePath: paths.workspace, timezone: config.gateway.host ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC", sessionId: undefined, scheduleRunId: run.id, services: null };
    return runScheduledTurn(sched, run, config, paths, ctx, queryFactory);
  });
  const toolRegistry = buildToolRegistry(config, paths.toolAuditFile, { scheduler, memory, profile });
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
  return { config, paths, sessions, runtimeState, profile, memory, schedulerStore, scheduler, toolRegistry, queryFactory, makeRunner };
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

function makeDefaultQueryFactory(config: RuntimeConfig, _auditPath: string): QueryFactory {
  return makeRealQueryFactory.bind(null) as unknown as QueryFactory;
}

async function runScheduledTurn(
  sched: { id: string; message: string; timezone: string },
  run: { id: string; startedAt: string },
  _config: RuntimeConfig,
  paths: RuntimePaths,
  _ctx: { source: "schedule_turn"; home: string; workspacePath: string; timezone: string; sessionId?: string; scheduleRunId?: string; services: unknown },
  _qf: QueryFactory,
): Promise<string> {
  // For MVP, the schedule executor is a stub: the schedule "completes" by
  // recording its own message as the result. A real implementation would
  // dispatch a one-off ClaudeRunner.run() against the same queryFactory
  // and stream the final result back to the scheduler.
  // Wiring ClaudeRunner from inside this closure would require the runner
  // factory; for now we return a synthetic result so the scheduler lifecycle
  // (run record, lastStatus, nextRunAt advancement) is exercised end-to-end.
  const state = await readRuntimeStateOrEmpty(paths.runtimeStateFile);
  const target = state.lastActiveSessionId || "inbox";
  const sessions = new SessionStore(paths.sessionsDir);
  const session = (await sessions.get(target)) || (await sessions.getOrCreateInbox());
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
