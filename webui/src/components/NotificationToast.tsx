import type { NotificationRecord } from "@/lib/claudebot-types";

export function NotificationToast({ notification, onOpen, onClose }: { notification: NotificationRecord; onOpen: () => void; onClose: () => void }) {
  return (
    <div role="status" className="absolute right-5 top-16 z-30 w-[360px] rounded-lg border border-border bg-popover p-4 text-sm shadow-xl">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium">{notification.title}</div>
          <div className="mt-1 line-clamp-3 text-xs leading-5 text-muted-foreground">{notification.content}</div>
        </div>
        <button className="shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted" onClick={onClose}>Close</button>
      </div>
      <button className="mt-3 rounded-md border border-border px-2 py-1 text-xs" onClick={onOpen}>Open Tasks</button>
    </div>
  );
}
