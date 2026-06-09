export type MemoryEntry = {
  id: string;
  content: string;
  tags: string[];
  source: string;
  confidence: number;
  createdAt: string;
  updatedAt: string;
};

export type MemoryFile = {
  entries: MemoryEntry[];
};
