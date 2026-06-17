export type MemoryIntent =
  | { type: "none" }
  | { type: "explicit"; content: string }
  | { type: "blocked"; reason: "reminder" | "secret" | "ephemeral"; content: string };

const explicitPatterns = [
  /^帮我记住[：:，,\s]*(.+)$/i,
  /^请记住[：:，,\s]*(.+)$/i,
  /^以后你要记住[：:，,\s]*(.+)$/i,
  /^记住[：:，,\s]*(.+)$/i,
  /^memory[：:\s]+(.+)$/i,
  /^remember[：:\s]+(.+)$/i,
];

const reminderPattern = /提醒|闹钟|日程|开会|会议|今天|明天|后天|上午|下午|晚上|\d+\s*[点:]|\d{1,2}:\d{2}/i;
const secretPattern = /token|api\s*key|apikey|secret|password|passwd|密码|验证码|银行卡|身份证|私钥|private\s*key/i;
const ephemeralPattern = /临时|暂时|这次|本轮|当前对话|这段对话/;

export function detectMemoryIntent(text: string): MemoryIntent {
  const content = extractExplicitContent(text.trim());
  if (!content) return { type: "none" };
  if (secretPattern.test(content)) return { type: "blocked", reason: "secret", content };
  if (reminderPattern.test(content)) return { type: "blocked", reason: "reminder", content };
  if (ephemeralPattern.test(content)) return { type: "blocked", reason: "ephemeral", content };
  return { type: "explicit", content };
}

function extractExplicitContent(text: string): string | null {
  for (const pattern of explicitPatterns) {
    const match = text.match(pattern);
    const content = match?.[1]?.trim();
    if (content) return content;
  }
  return null;
}
