import { createHash } from "node:crypto";
import { ensureDir, writeTextAtomic } from "../utils/fs.ts";

type AgentFiles = {
  userFile: string;
  soulFile: string;
};

export type AgentFileName = "user.md" | "soul.md";

const defaults: Record<AgentFileName, string> = {
  "user.md": "# User\n\nDescribe the user this assistant serves.\n",
  "soul.md": "# Soul\n\nDescribe this assistant's enduring identity, values, and behavior.\n",
};

export class AgentProfileStore {
  constructor(private readonly files: AgentFiles) {}

  async init(): Promise<void> {
    for (const name of ["user.md", "soul.md"] as const) {
      const path = this.pathFor(name);
      await ensureDir(path.split("/").slice(0, -1).join("/"));
      if (!(await Bun.file(path).exists())) {
        await writeTextAtomic(path, defaults[name]);
      }
    }
  }

  async readFile(name: AgentFileName): Promise<{ content: string; version: string }> {
    const content = await Bun.file(this.pathFor(name)).text();
    return { content, version: this.version(content) };
  }

  async updateFile(name: AgentFileName, content: string, expectedVersion: string): Promise<{ version: string }> {
    const current = await this.readFile(name);
    if (current.version !== expectedVersion) throw new Error("version conflict");
    await writeTextAtomic(this.pathFor(name), content);
    return { version: this.version(content) };
  }

  pathFor(name: AgentFileName): string {
    if (name === "user.md") return this.files.userFile;
    return this.files.soulFile;
  }

  private version(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }
}
