import { describe, expect, test } from "bun:test";
import { appendActivity, finalizeActivities } from "../src/shared/activity-reducer.ts";
import type { ThreadActivity } from "../src/shared/webui-protocol.ts";

describe("activity reducer", () => {
  test("accumulates thinking deltas into one activity", () => {
    let acts: ThreadActivity[] = [];
    acts = appendActivity(acts, "r1", { kind: "thinking", text: "Hello" });
    acts = appendActivity(acts, "r1", { kind: "thinking", text: " world" });
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ id: "thinking-r1", kind: "thinking", text: "Hello world", status: "running" });
  });

  test("upserts tool activity across start and end phases", () => {
    let acts: ThreadActivity[] = [];
    acts = appendActivity(acts, "r1", { kind: "tool", tool: { phase: "start", id: "t1", name: "Read", input: { x: 1 } } });
    acts = appendActivity(acts, "r1", { kind: "tool", tool: { phase: "end", id: "t1", output: "ok" } });
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ id: "tool-t1", kind: "tool", name: "Read", status: "complete", output: "ok", input: { x: 1 } });
  });

  test("marks a tool error phase as error status", () => {
    let acts: ThreadActivity[] = [];
    acts = appendActivity(acts, "r1", { kind: "tool", tool: { phase: "error", id: "t1", name: "Write", isError: true } });
    expect(acts[0]).toMatchObject({ status: "error" });
  });

  test("upserts a single status activity per run, updating its text", () => {
    let acts: ThreadActivity[] = [];
    acts = appendActivity(acts, "r1", { kind: "status", text: "Working", mcpServers: [{ name: "claudebot", status: "connected" }] });
    acts = appendActivity(acts, "r1", { kind: "status", text: "API retry 1/3" });
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ id: "status-r1", kind: "status", text: "API retry 1/3", status: "running" });
  });

  test("finalize marks running activities complete", () => {
    let acts: ThreadActivity[] = [];
    acts = appendActivity(acts, "r1", { kind: "thinking", text: "x" });
    acts = appendActivity(acts, "r1", { kind: "tool", tool: { phase: "start", id: "t1", name: "Read" } });
    const done = finalizeActivities(acts, "complete");
    expect(done.every((a) => a.status !== "running")).toBe(true);
  });

  test("finalize accepts a boolean status (true => error, false => complete)", () => {
    let acts: ThreadActivity[] = [];
    acts = appendActivity(acts, "r1", { kind: "thinking", text: "x" });
    expect(finalizeActivities(acts, true)[0]).toMatchObject({ status: "error" });
    expect(finalizeActivities(acts, false)[0]).toMatchObject({ status: "complete" });
  });

  test("isolates activities by runId", () => {
    let acts: ThreadActivity[] = [];
    acts = appendActivity(acts, "r1", { kind: "thinking", text: "a" });
    acts = appendActivity(acts, "r2", { kind: "thinking", text: "b" });
    expect(acts).toHaveLength(2);
    expect(acts.map((a) => a.id).sort()).toEqual(["thinking-r1", "thinking-r2"]);
  });
});
