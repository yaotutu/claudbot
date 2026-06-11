import { readFile, stat } from "node:fs/promises";

export type UIMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  metadata: Record<string, unknown>;
};

type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature?: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content?: unknown; is_error?: boolean }
  | { type: string; [k: string]: unknown };

type Entry = {
  type: string;
  uuid?: string;
  timestamp?: string;
  message?: { role?: string; content?: ContentBlock[] | string };
};

export function flattenContent(content: ContentBlock[] | string | undefined): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text") {
      parts.push((block as { text: string }).text);
    } else if (block.type === "tool_use") {
      const tb = block as { name: string };
      parts.push(`[tool:${tb.name}]`);
    }
  }
  return parts.map((p) => p.trim()).filter((p) => p.length > 0).join(" ");
}

export function extractMetadata(content: ContentBlock[] | string | undefined): Record<string, unknown> {
  if (!content || typeof content === "string") return {};
  const meta: Record<string, unknown> = {};
  const toolCalls: Array<{ id: string; name: string; input: unknown }> = [];
  const thinkings: string[] = [];
  for (const block of content) {
    if (block.type === "tool_use") {
      const tb = block as { id: string; name: string; input: unknown };
      toolCalls.push({ id: tb.id, name: tb.name, input: tb.input });
    } else if (block.type === "thinking") {
      const tb = block as { thinking: string };
      thinkings.push(tb.thinking);
    }
  }
  if (toolCalls.length > 0) meta.toolCalls = toolCalls;
  if (thinkings.length > 0) meta.thinking = thinkings.join("\n");
  return meta;
}

export async function parseJsonlToUIMessages(filePath: string): Promise<UIMessage[]> {
  const text = await readFile(filePath, "utf8");
  const lines = text.split("\n").filter((l) => l.length > 0);

  // Compute mtime once for timestamp fallback
  let mtimeIso: string | null = null;
  try {
    const st = await stat(filePath);
    mtimeIso = st.mtime.toISOString();
  } catch {
    // ignore; fallback handled inline
  }

  const out: UIMessage[] = [];
  for (const line of lines) {
    let entry: Entry;
    try {
      entry = JSON.parse(line) as Entry;
    } catch {
      continue; // skip malformed lines (the SDK may write partial markers)
    }
    if (entry.type !== "user" && entry.type !== "assistant" && entry.type !== "system") continue;
    if (!entry.message) continue;

    const content = entry.message?.content;
    const id = entry.uuid ?? crypto.randomUUID();
    const createdAt = entry.timestamp ?? mtimeIso ?? new Date().toISOString();
    const role = entry.type as "user" | "assistant" | "system";

    out.push({
      id,
      role,
      content: flattenContent(content),
      createdAt,
      metadata: extractMetadata(content),
    });
  }
  return out;
}
