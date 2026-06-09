export type SessionMessageRole = "user" | "assistant" | "system";

export type SessionMessage = {
  id: string;
  role: SessionMessageRole;
  content: string;
  createdAt: string;
  metadata: Record<string, unknown>;
};

export type SessionRecord = {
  id: string;
  title: string;
  preview: string;
  claudeSessionId: string;
  createdAt: string;
  updatedAt: string;
  messages: SessionMessage[];
};
