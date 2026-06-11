// Single "cron" tool — all schedule operations dispatched via `action` parameter.
// Merged from 6 separate tools to reduce model selection ambiguity.
// Inspired by openclaw's cron tool design.

import { z } from "zod/v4";
import type { ToolContext, ToolSource } from "../types.ts";
import type { ToolRegistry } from "../registry.ts";
import type { SchedulerStoreOps } from "../../scheduler/store-ops.ts";
import type { SchedulerTrigger } from "../../scheduler/trigger.ts";

const CronActionSchema = z.enum(["add", "list", "update", "remove", "run"]);

export function registerSchedulerTools(
  registry: ToolRegistry,
  deps: { storeOps: SchedulerStoreOps; getTrigger: () => SchedulerTrigger },
): void {
  const { storeOps, getTrigger } = deps;

  registry.register({
    name: "cron",
    description: [
      "Manage scheduled tasks: reminders, cron jobs, delayed follow-ups, recurring work, timers.",
      "Do NOT emulate scheduling with sleep, polling, or any other workaround — always use this tool.",
      "",
      "Actions:",
      '- add: Create a new scheduled task. Supports one-shot ("at"), recurring interval ("every"), and cron expression ("cron").',
      "- list: List all scheduled tasks.",
      "- update: Update a scheduled task's name, message, schedule, or enabled status.",
      "- remove: Delete a scheduled task by id.",
      "- run: Trigger an immediate execution of a scheduled task.",
      "",
      'Schedule types for "add":',
      '- kind="at", at="<ISO timestamp>" — one-shot at a specific time. Auto-deleted after execution. Example: { kind:"at", at:"2026-06-10T08:05:00Z" }',
      '- kind="every", everyMs=<milliseconds> — recurring at fixed interval. Example: { kind:"every", everyMs:300000 } for every 5 minutes.',
      '- kind="cron", cronExpr="<expression>", timezone="<IANA>" — cron schedule. Example: { kind:"cron", cronExpr:"0 9 * * *", timezone:"Asia/Shanghai" } for daily at 9am.',
    ].join("\n"),
    inputSchema: z.object({
      action: CronActionSchema,
      // --- add fields ---
      name: z.string().min(1).optional().describe("Task name (for add)"),
      message: z.string().min(1).optional().describe("Message/prompt to send when task fires (for add/update)"),
      kind: z.enum(["at", "every", "cron"]).optional().describe("Schedule type (for add)"),
      at: z.string().optional().describe('ISO timestamp for one-shot, e.g. "2026-06-10T08:05:00Z" (kind="at")'),
      everyMs: z.number().int().min(1000).optional().describe("Interval in ms (kind='every')"),
      cronExpr: z.string().optional().describe("Cron expression like '0 9 * * *' (kind='cron')"),
      timezone: z.string().optional().describe("IANA timezone, e.g. 'Asia/Shanghai' (default UTC)"),
      // --- update/remove/run fields ---
      id: z.string().min(1).optional().describe("Schedule id (for update/remove/run)"),
      enabled: z.boolean().optional().describe("Enable or disable (for update)"),
    }),
    execute: async (input, ctx) => {
      switch (input.action) {
        case "add": {
          if ((ctx as ToolContext).source === "schedule_turn" as ToolSource) {
            throw new Error("不允许在定时任务执行中创建新的定时任务");
          }
          return storeOps.create({
            name: input.name ?? "unnamed",
            message: input.message ?? "",
            cronExpr: input.cronExpr,
            at: input.at,
            everyMs: input.everyMs,
            timezone: input.timezone,
          });
        }
        case "list":
          return storeOps.list();
        case "update": {
          if (!input.id) throw new Error("id is required for update");
          if (input.enabled !== undefined) {
            return storeOps.setEnabled(input.id, input.enabled);
          }
          const patch: Record<string, unknown> = {};
          if (input.name) patch.name = input.name;
          if (input.message) patch.message = input.message;
          if (input.cronExpr) patch.cronExpr = input.cronExpr;
          if (input.timezone) patch.timezone = input.timezone;
          if (input.everyMs) patch.everyMs = input.everyMs;
          if (input.at) patch.at = input.at;
          return storeOps.update(input.id, patch);
        }
        case "remove": {
          if (!input.id) throw new Error("id is required for remove");
          await storeOps.delete(input.id);
          return { deleted: input.id };
        }
        case "run": {
          if (!input.id) throw new Error("id is required for run");
          return getTrigger().runNow(input.id);
        }
        default:
          throw new Error(`Unknown action: ${input.action}`);
      }
    },
  });
}
