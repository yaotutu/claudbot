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

export type AgentProfileStore = {
  init(): Promise<void>;
  readFile(name: AgentFileName): Promise<{ content: string; version: string }>;
  updateFile(name: AgentFileName, content: string, expectedVersion: string): Promise<{ version: string }>;
  pathFor(name: AgentFileName): string;
};

export function createAgentProfileStore(files: AgentFiles): AgentProfileStore {
  const pathFor = (name: AgentFileName): string => (name === "user.md" ? files.userFile : files.soulFile);
  const version = (content: string): string => createHash("sha256").update(content).digest("hex");
  const readFile = async (name: AgentFileName): Promise<{ content: string; version: string }> => {
    const content = await Bun.file(pathFor(name)).text();
    return { content, version: version(content) };
  };
  return {
    async init() {
      for (const name of ["user.md", "soul.md"] as const) {
        const path = pathFor(name);
        await ensureDir(path.split("/").slice(0, -1).join("/"));
        if (!(await Bun.file(path).exists())) {
          await writeTextAtomic(path, defaults[name]);
        }
      }
    },
    readFile,
    async updateFile(name, content, expectedVersion) {
      const current = await readFile(name);
      if (current.version !== expectedVersion) throw new Error("version conflict");
      await writeTextAtomic(pathFor(name), content);
      return { version: version(content) };
    },
    pathFor,
  };
}
