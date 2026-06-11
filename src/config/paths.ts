import { join } from "node:path";
import type { RuntimeConfig } from "./schema.ts";

export type RuntimePaths = {
  home: string;
  workspace: string;
  agentDir: string;
  userFile: string;
  soulFile: string;
  memoryFile: string;
  sessionsDir: string;
  schedulerDir: string;
  schedulesFile: string;
  runsFile: string;
  webuiDir: string;
  runtimeStateFile: string;
  mediaDir: string;
  auditDir: string;
  toolAuditFile: string;
  sdkConfigDir: string;
};

export function runtimePaths(config: RuntimeConfig): RuntimePaths {
  const home = config.home;
  return {
    home,
    workspace: config.workspace.path,
    agentDir: join(home, "agent"),
    userFile: join(home, "agent", "user.md"),
    soulFile: join(home, "agent", "soul.md"),
    memoryFile: join(home, "agent", "memory.json"),
    sessionsDir: join(home, "sessions"),
    schedulerDir: join(home, "scheduler"),
    schedulesFile: join(home, "scheduler", "schedules.json"),
    runsFile: join(home, "scheduler", "runs.json"),
    webuiDir: join(home, "webui"),
    runtimeStateFile: join(home, "webui", "runtime_state.json"),
    mediaDir: join(home, "media"),
    auditDir: join(home, "audit"),
    toolAuditFile: join(home, "audit", "tools.jsonl"),
    sdkConfigDir: join(home, "sdk-config"),
  };
}
