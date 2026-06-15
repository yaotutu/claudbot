import { join } from "node:path";
import type { RuntimeConfig } from "./schema.ts";

export type RuntimePaths = {
  home: string;
  configFile: string;
  workspace: string;
  profileDir: string;
  userFile: string;
  soulFile: string;
  memoryDir: string;
  memoryFile: string;
  sessionsDir: string;
  schedulesDir: string;
  schedulesFile: string;
  scheduleRunsDir: string;
  webuiDir: string;
  runtimeStateFile: string;
  notificationsFile: string;
  channelBindingsFile: string;
  mediaDir: string;
  logsDir: string;
  auditDir: string;
  toolAuditFile: string;
  claudeDir: string;
  sdkConfigDir: string;
};

export function runtimePaths(config: RuntimeConfig): RuntimePaths {
  const home = config.home;
  return {
    home,
    configFile: join(home, "config.json"),
    workspace: config.workspace.path,
    profileDir: join(home, "profile"),
    userFile: join(home, "profile", "user.md"),
    soulFile: join(home, "profile", "soul.md"),
    memoryDir: join(home, "memory"),
    memoryFile: join(home, "memory", "memory.json"),
    sessionsDir: join(home, "sessions"),
    schedulesDir: join(home, "schedules"),
    schedulesFile: join(home, "schedules", "jobs.json"),
    scheduleRunsDir: join(home, "schedules", "runs"),
    webuiDir: join(home, "webui"),
    runtimeStateFile: join(home, "webui", "runtime_state.json"),
    notificationsFile: join(home, "webui", "notifications.json"),
    channelBindingsFile: join(home, "channels", "channel-bindings.json"),
    mediaDir: join(home, "media"),
    logsDir: join(home, "logs"),
    auditDir: join(home, "audit"),
    toolAuditFile: join(home, "audit", "tools.jsonl"),
    claudeDir: join(home, "claude"),
    sdkConfigDir: join(home, "claude", "config"),
  };
}
