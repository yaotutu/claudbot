import { z } from "zod/v4";
import type { ToolRegistry } from "../registry.ts";
import type { SchedulerService } from "../../scheduler/service.ts";

const TimezoneSchema = z.string().min(1);

export function registerSchedulerTools(registry: ToolRegistry, deps: { scheduler: SchedulerService }): void {
  const { scheduler } = deps;

  registry.register({
    name: "schedule_create",
    description: "Create a new cron schedule. Returns the created schedule record.",
    inputSchema: z.object({
      name: z.string().min(1),
      cronExpr: z.string().min(1),
      timezone: TimezoneSchema,
      message: z.string().min(1),
    }),
    execute: async (input) => scheduler.create(input),
  });

  registry.register({
    name: "schedule_list",
    description: "List all configured schedules.",
    inputSchema: z.object({}),
    execute: async () => scheduler.list(),
  });

  registry.register({
    name: "schedule_update",
    description: "Update a schedule's name, cron expression, timezone, or message.",
    inputSchema: z.object({
      id: z.string().min(1),
      name: z.string().min(1).optional(),
      cronExpr: z.string().min(1).optional(),
      timezone: TimezoneSchema.optional(),
      message: z.string().min(1).optional(),
    }),
    execute: async (input) => scheduler.update(input.id, input),
  });

  registry.register({
    name: "schedule_delete",
    description: "Delete a schedule by id.",
    inputSchema: z.object({ id: z.string().min(1) }),
    execute: async (input) => scheduler.delete(input.id),
  });

  registry.register({
    name: "schedule_set_enabled",
    description: "Enable or disable a schedule.",
    inputSchema: z.object({ id: z.string().min(1), enabled: z.boolean() }),
    execute: async (input) => scheduler.setEnabled(input.id, input.enabled),
  });

  registry.register({
    name: "schedule_run_now",
    description: "Trigger an immediate run of a schedule. Respects the running lock.",
    inputSchema: z.object({ id: z.string().min(1) }),
    execute: async (input) => scheduler.runNow(input.id),
  });
}
