import { useState } from "react";
import { Sparkles } from "lucide-react";

export function ThreadArea({ messages, loading, streaming, disabled, onSend, onNewChat, hasSession }: {
  messages: Array<{ id: string; role: string; content: string }>;
  loading: boolean;
  streaming: boolean;
  disabled: boolean;
  onSend: (content: string) => void;
  onNewChat: () => void;
  hasSession: boolean;
}) {
  const [value, setValue] = useState("");
  const submit = () => {
    const text = value.trim();
    if (!text) return;
    if (!hasSession) onNewChat();
    onSend(text);
    setValue("");
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-8 py-8">
        {loading ? <div className="text-sm text-muted-foreground">Loading...</div> : null}
        {messages.length === 0 ? (
          <div className="flex h-full items-center justify-center text-center">
            <h1 className="text-5xl font-semibold tracking-normal">What are we building today?</h1>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-5">
            {messages.map((message) => (
              <div key={message.id} className={message.role === "user" ? "self-end rounded-2xl bg-muted px-4 py-3" : "self-start leading-7"}>
                {message.content}
              </div>
            ))}
            {streaming ? <div className="text-sm text-muted-foreground">Streaming...</div> : null}
          </div>
        )}
      </div>
      <div className="shrink-0 px-8 pb-6">
        <div className="mx-auto flex max-w-4xl items-end gap-3 rounded-3xl border border-border bg-background p-3 shadow-lg">
          <textarea
            className="min-h-20 flex-1 resize-none bg-transparent px-2 py-2 text-sm outline-none"
            placeholder="Ask anything..."
            value={value}
            disabled={disabled}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
          <button aria-label="Send message" className="flex h-10 w-10 items-center justify-center rounded-full bg-foreground text-background" onClick={submit} disabled={disabled || !value.trim()}>
            <Sparkles size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
