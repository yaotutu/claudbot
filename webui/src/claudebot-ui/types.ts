import type { DraftSession, SessionSummary, ThreadActivity, ThreadMessage } from "@/lib/claudebot-types";

export type ClaudebotSessionItem = SessionSummary | DraftSession;

export type ClaudebotChatSummary = {
  key: string;
  id: string;
  title: string;
  preview: string;
  createdAt: string | null;
  updatedAt: string | null;
  status: "persisted" | "draft";
  messageCount: number;
};

export type ClaudebotUIMessage = {
  id: string;
  role: ThreadMessage["role"];
  content: string;
  createdAt: string;
  isStreaming: boolean;
  isError: boolean;
  activities: ThreadActivity[];
};

export type ClaudebotUtilityPanel = "settings" | "search" | "skills" | "tasks" | null;
