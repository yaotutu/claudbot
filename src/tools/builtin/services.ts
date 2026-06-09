import type { SchedulerService } from "../../scheduler/service.ts";
import type { MemoryStore } from "../../memory/store.ts";
import type { AgentProfileStore } from "../../agent/profile.ts";

export type BuiltinServices = {
  scheduler: SchedulerService;
  memory: MemoryStore;
  profile: AgentProfileStore;
};
