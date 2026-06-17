import { ensureDir } from "../utils/fs.ts";
import { dirname } from "node:path";

export type ToolAuditRecord = {
  toolName: string;
  status: "started" | "succeeded" | "failed" | "denied";
  source: string;
  at: string;
  inputSummary?: string;
  error?: string;
  sessionId?: string;
  scheduleRunId?: string;
};

export type ToolAuditLog = {
  append(record: ToolAuditRecord): Promise<void>;
};

export function createToolAuditLog(path: string): ToolAuditLog {
  return {
    async append(record) {
      await ensureDir(dirname(path));
      const line = `${JSON.stringify(record)}\n`;
      // Read-modify-write. Single-process MVP: no concurrent appenders.
      const file = Bun.file(path);
      const existing = (await file.exists()) ? await file.text() : "";
      await Bun.write(path, existing + line);
    },
  };
}
