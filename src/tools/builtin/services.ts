import type { SchedulerStoreOps } from "../../scheduler/store-ops.ts";
import type { SchedulerTrigger } from "../../scheduler/trigger.ts";
import type { AgentProfileStore } from "../../agent/profile.ts";
import type { MemoryMarkdownPaths } from "../../memory/types.ts";

export type BuiltinServices = {
  storeOps: SchedulerStoreOps;
  getTrigger: () => SchedulerTrigger;
  memoryPaths: MemoryMarkdownPaths;
  profile: AgentProfileStore;
};
