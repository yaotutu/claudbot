import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";

import { cn } from "@/lib/utils";

type ClaudebotComposerProps = {
  disabled: boolean;
  streaming: boolean;
  modelLabel: string;
  onSend: (content: string) => void;
  onStop: () => void;
  onNewChat: () => void;
  hasSession: boolean;
  hero?: boolean;
};

export function ClaudebotComposer({
  disabled,
  streaming,
  modelLabel,
  onSend,
  onStop,
  onNewChat,
  hasSession,
  hero = false,
}: ClaudebotComposerProps) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(180, Math.max(72, el.scrollHeight))}px`;
  }, [value]);

  const submit = useCallback(() => {
    const text = value.trim();
    if (!text || disabled || streaming) return;
    if (!hasSession) onNewChat();
    onSend(text);
    setValue("");
  }, [disabled, hasSession, onNewChat, onSend, streaming, value]);

  return (
    <form
      className={cn(
        "mx-auto w-full max-w-4xl px-4",
        hero ? "mt-8" : "pb-5",
      )}
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div
        className={cn(
          "overflow-hidden rounded-[28px] border border-border/80 bg-background shadow-[0_18px_60px_-34px_rgb(0_0_0/0.55)]",
          "transition-shadow focus-within:shadow-[0_22px_70px_-36px_rgb(0_0_0/0.62)]",
        )}
      >
        <textarea
          ref={textareaRef}
          id="claudebot-composer-message"
          name="message"
          aria-label="Message"
          className="block min-h-[72px] w-full resize-none bg-transparent px-5 pt-4 text-[15px] leading-6 outline-none placeholder:text-muted-foreground/72"
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
        <div className="flex min-h-12 items-center justify-between gap-3 px-3 pb-3">
          <button
            type="button"
            className="inline-flex h-8 max-w-[62%] items-center gap-2 truncate rounded-full border border-border/70 px-3 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
            title={modelLabel}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden />
            <span className="truncate">{modelLabel}</span>
          </button>
          <button
            type={streaming ? "button" : "submit"}
            aria-label={streaming ? "Stop generating" : "Send message"}
            disabled={disabled || (!streaming && !value.trim())}
            onClick={streaming ? onStop : undefined}
            className={cn(
              "grid h-9 w-9 shrink-0 place-items-center rounded-full transition-colors",
              streaming
                ? "bg-muted text-foreground"
                : "bg-foreground text-background hover:bg-foreground/90",
              (disabled || (!streaming && !value.trim())) && "cursor-not-allowed opacity-45",
            )}
          >
            {streaming ? <Square className="h-3.5 w-3.5 fill-current" /> : <ArrowUp className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </form>
  );
}
