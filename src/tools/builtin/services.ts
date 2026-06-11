import type { SchedulerStoreOps } from "../../scheduler/store-ops.ts";
import type { SchedulerTrigger } from "../../scheduler/trigger.ts";
import type { MemoryStore } from "../../memory/store.ts";
import type { AgentProfileStore } from "../../agent/profile.ts";

export type BuiltinServices = {
  storeOps: SchedulerStoreOps;
  getTrigger: () => SchedulerTrigger;
  memory: MemoryStore;
  profile: AgentProfileStore;
};
