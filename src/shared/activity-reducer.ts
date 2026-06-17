// Shared, immutable activity reducer used by BOTH the backend (persisting a run's
// activities onto the final message metadata) and the WebUI (accumulating live
// run.* frames into the thread view). Frontend imports this file cross-package
// via the same `../../../src/shared/...` path used for webui-protocol.ts.
//
// The output shape is the contract — frontend tests assert exact `id`/`kind`
// values, so keep `thinking-${runId}`, `tool-${toolId}`, `status-${runId}`.

import type {
  RuntimeMcpServerStatus,
  ThreadActivity,
  ThreadActivityStatus,
  ToolFrame,
} from "./webui-protocol.ts";

export type ActivityInput =
  | { kind: "thinking"; text: string }
  | { kind: "tool"; tool: ToolFrame }
  | { kind: "status"; text: string; mcpServers?: RuntimeMcpServerStatus[] };

export type ActivityFinalStatus = Extract<ThreadActivityStatus, "complete" | "error">;

/** Append or upsert a single activity into an immutable activity list. */
export function appendActivity(
  activities: ThreadActivity[],
  runId: string,
  input: ActivityInput,
  timestamp: string = new Date().toISOString(),
): ThreadActivity[] {
  if (input.kind === "thinking") return appendThinking(activities, runId, input.text, timestamp);
  if (input.kind === "tool") return upsertTool(activities, runId, input.tool, timestamp);
  return upsertStatus(activities, runId, input.text, input.mcpServers, timestamp);
}

/** Mark every still-running activity as complete or error. */
export function finalizeActivities(
  activities: ThreadActivity[],
  status: ActivityFinalStatus | boolean,
  timestamp: string = new Date().toISOString(),
): ThreadActivity[] {
  const finalStatus = typeof status === "boolean" ? (status ? "error" : "complete") : status;
  return activities.map((activity) => activity.status === "running"
    ? { ...activity, status: finalStatus, updatedAt: timestamp }
    : activity);
}

function appendThinking(
  activities: ThreadActivity[],
  runId: string,
  text: string,
  timestamp: string,
): ThreadActivity[] {
  const id = `thinking-${runId}`;
  const index = activities.findIndex((activity) => activity.id === id);
  if (index === -1) {
    return [...activities, {
      id,
      kind: "thinking",
      runId,
      text,
      status: "running",
      createdAt: timestamp,
      updatedAt: timestamp,
    }];
  }
  const next = activities.slice();
  const current = next[index];
  if (current.kind !== "thinking") return activities;
  next[index] = { ...current, text: `${current.text}${text}`, status: "running", updatedAt: timestamp };
  return next;
}

function upsertTool(
  activities: ThreadActivity[],
  runId: string,
  tool: ToolFrame,
  timestamp: string,
): ThreadActivity[] {
  const id = `tool-${tool.id}`;
  const status: ThreadActivityStatus = tool.phase === "error" || tool.isError ? "error" : tool.phase === "end" ? "complete" : "running";
  const index = activities.findIndex((activity) => activity.id === id);
  if (index === -1) {
    return [...activities, {
      id,
      kind: "tool",
      runId,
      toolId: tool.id,
      name: tool.name?.trim() || "Tool",
      phase: tool.phase,
      input: tool.input,
      output: tool.output,
      isError: tool.isError,
      status,
      createdAt: timestamp,
      updatedAt: timestamp,
    }];
  }
  const next = activities.slice();
  const current = next[index];
  if (current.kind !== "tool") return activities;
  next[index] = {
    ...current,
    name: tool.name?.trim() || current.name,
    phase: tool.phase,
    input: tool.input ?? current.input,
    output: tool.output ?? current.output,
    isError: tool.isError ?? current.isError,
    status,
    updatedAt: timestamp,
  };
  return next;
}

function upsertStatus(
  activities: ThreadActivity[],
  runId: string,
  text: string,
  mcpServers: RuntimeMcpServerStatus[] | undefined,
  timestamp: string,
): ThreadActivity[] {
  const id = `status-${runId}`;
  const index = activities.findIndex((activity) => activity.id === id);
  if (index === -1) {
    return [...activities, {
      id,
      kind: "status",
      runId,
      text,
      status: "running",
      mcpServers,
      createdAt: timestamp,
      updatedAt: timestamp,
    }];
  }
  const next = activities.slice();
  const current = next[index];
  if (current.kind !== "status") return activities;
  next[index] = { ...current, text, status: "running", mcpServers, updatedAt: timestamp };
  return next;
}
