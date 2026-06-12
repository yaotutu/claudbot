import { describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readFileSync } from "node:fs";
import { ToolRegistry } from "../src/tools/registry.ts";
import { createClaudebotSdkMcpServer } from "../src/tools/sdk-mcp-server.ts";
import type { ToolContext } from "../src/tools/types.ts";

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    source: "user_turn",
    home: "/tmp",
    workspacePath: "/tmp/ws",
    timezone: "UTC",
    services: null,
    ...overrides,
  };
}

describe("tool registry", () => {
  test("validates and executes a tool", async () => {
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    registry.register({
      name: "echo",
      description: "echo",
      inputSchema: z.object({ text: z.string() }),
      execute: async (input) => ({ text: input.text }),
    });
    const result = await registry.execute("echo", { text: "ok" }, makeCtx());
    expect(result).toEqual({ text: "ok" });
  });

  test("denies a denied tool", async () => {
    const registry = new ToolRegistry({ defaultPolicy: "deny", overrides: {} });
    registry.register({
      name: "echo",
      description: "echo",
      inputSchema: z.object({ text: z.string() }),
      execute: async () => ({ text: "no" }),
    });
    await expect(registry.execute("echo", { text: "ok" }, makeCtx())).rejects.toThrow("denied");
  });

  test("confirm policy is denied in MVP", async () => {
    const registry = new ToolRegistry({ defaultPolicy: "confirm", overrides: {} });
    registry.register({
      name: "echo",
      description: "echo",
      inputSchema: z.object({ text: z.string() }),
      execute: async () => ({ text: "x" }),
    });
    await expect(registry.execute("echo", { text: "ok" }, makeCtx())).rejects.toThrow(/denied|confirm/i);
  });

  test("unknown tool returns a structured error", async () => {
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    await expect(registry.execute("nope", {}, makeCtx())).rejects.toThrow("unknown tool");
  });

  test("invalid input reports validation failure", async () => {
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    registry.register({
      name: "echo",
      description: "echo",
      inputSchema: z.object({ text: z.string() }),
      execute: async () => ({ text: "x" }),
    });
    await expect(registry.execute("echo", { text: 123 }, makeCtx())).rejects.toThrow();
  });

  test("audit log records success and failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "claudebot-audit-"));
    const auditPath = join(dir, "tools.jsonl");
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} }, auditPath);
    registry.register({
      name: "good",
      description: "ok",
      inputSchema: z.object({ x: z.number() }),
      execute: async () => ({ ok: true }),
    });
    registry.register({
      name: "bad",
      description: "fails",
      inputSchema: z.object({ x: z.number() }),
      execute: async () => { throw new Error("boom"); },
    });
    await registry.execute("good", { x: 1 }, makeCtx());
    await expect(registry.execute("bad", { x: 2 }, makeCtx())).rejects.toThrow("boom");
    const raw = readFileSync(auditPath, "utf8");
    const lines = raw.trim().split("\n").map((l) => JSON.parse(l) as { toolName: string; status: string });
    const names = lines.map((l) => l.toolName);
    const statuses = lines.map((l) => l.status);
    expect(names).toContain("good");
    expect(names).toContain("bad");
    expect(statuses).toContain("succeeded");
    expect(statuses).toContain("failed");
  });

  test("SDK MCP server exposes native tools in-process", () => {
    const registry = new ToolRegistry({ defaultPolicy: "allow", overrides: {} });
    registry.register({
      name: "echo",
      description: "echo",
      inputSchema: z.object({ text: z.string() }),
      execute: async ({ text }) => ({ text }),
    });
    const server = createClaudebotSdkMcpServer(registry, makeCtx());
    expect(server).toBeDefined();
    expect(typeof server).toBe("object");
  });
});
