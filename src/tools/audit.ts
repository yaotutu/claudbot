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

export class ToolAuditLog {
  constructor(private readonly path: string) {}

  async append(record: ToolAuditRecord): Promise<void> {
    await ensureDir(dirname(this.path));
    const line = `${JSON.stringify(record)}\n`;
    // Read-modify-write. Single-process MVP: no concurrent appenders.
    const file = Bun.file(this.path);
    const existing = (await file.exists()) ? await file.text() : "";
    await Bun.write(this.path, existing + line);
  }
}
