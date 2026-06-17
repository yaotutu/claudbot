import { useMemo, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Brain,
  CalendarClock,
  Menu,
  MoreHorizontal,
  Pin,
  PinOff,
  Search,
  Settings,
  SquarePen,
  Trash2,
  Pencil,
} from "lucide-react";

import { cn } from "@/lib/utils";

import type { ClaudebotChatSummary, ClaudebotUtilityPanel } from "./types";

type ClaudebotSidebarProps = {
  sessions: ClaudebotChatSummary[];
  activeKey: string | null;
  collapsed: boolean;
  activeUtility: ClaudebotUtilityPanel;
  notificationCount: number;
  connectionLabel: string;
  onCollapse: () => void;
  onExpand: () => void;
  onNewChat: () => void;
  onSelect: (key: string) => void;
  onOpenPanel: (panel: Exclude<ClaudebotUtilityPanel, null>) => void;
  onRename: (key: string, title: string) => Promise<void>;
  onDelete: (key: string) => Promise<void>;
};

type ChatGroup = {
  id: string;
  label: string;
  sessions: ClaudebotChatSummary[];
};

export function ClaudebotSidebar({
  sessions,
  activeKey,
  collapsed,
  activeUtility,
  notificationCount,
  connectionLabel,
  onCollapse,
  onExpand,
  onNewChat,
  onSelect,
  onOpenPanel,
  onRename,
  onDelete,
}: ClaudebotSidebarProps) {
  const [pinnedKeys, setPinnedKeys] = useState<string[]>([]);
  const [archivedKeys, setArchivedKeys] = useState<string[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const groups = useMemo(
    () => groupChats(sessions, pinnedKeys, archivedKeys, showArchived),
    [archivedKeys, pinnedKeys, sessions, showArchived],
  );
  const archivedCount = archivedKeys.length;

  const togglePinned = (key: string) => {
    setPinnedKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : [key, ...current]);
    setMenuKey(null);
  };
  const toggleArchived = (key: string) => {
    setArchivedKeys((current) => current.includes(key) ? current.filter((item) => item !== key) : [key, ...current]);
    setMenuKey(null);
  };
  const renameChat = (chat: ClaudebotChatSummary) => {
    setMenuKey(null);
    const next = window.prompt("Rename chat", chat.title);
    if (next && next.trim()) void onRename(chat.key, next.trim());
  };
  const deleteChat = (key: string) => {
    setMenuKey(null);
    void onDelete(key);
  };

  return (
    <aside
      className={cn(
        "flex h-full shrink-0 flex-col border-r border-sidebar-border/60 bg-sidebar text-sidebar-foreground transition-[width] duration-300 ease-out",
        collapsed ? "w-14" : "w-[292px]",
      )}
    >
      <div className={cn("flex items-center px-3 pb-2.5 pt-3", collapsed ? "justify-center" : "justify-between")}>
        <button
          type="button"
          aria-label={collapsed ? "Expand sidebar" : "Claudebot home"}
          onClick={collapsed ? onExpand : undefined}
          className={cn(
            "flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-xl transition-colors",
            collapsed ? "hover:bg-sidebar-accent/75" : "pointer-events-none",
          )}
        >
          <img
            src="/brand/claudebot_logo.webp"
            alt=""
            className="h-8 w-8 select-none rounded-lg object-cover"
            draggable={false}
          />
        </button>
        {!collapsed ? (
          <button
            type="button"
            aria-label="Collapse sidebar"
            onClick={onCollapse}
            className="grid h-8 w-8 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-sidebar-accent/75 hover:text-sidebar-foreground"
          >
            <Menu className="h-4 w-4" />
          </button>
        ) : null}
      </div>

      <div className={cn("space-y-1.5 px-2 pb-2", collapsed && "flex flex-col items-center px-0")}>
        <SidebarAction collapsed={collapsed} label="New chat" icon={<SquarePen className="h-4 w-4" />} onClick={onNewChat} />
        <SidebarAction collapsed={collapsed} label="Search" icon={<Search className="h-4 w-4" />} onClick={() => onOpenPanel("search")} active={activeUtility === "search"} />
        <SidebarAction collapsed={collapsed} label="Skills" icon={<Brain className="h-4 w-4" />} onClick={() => onOpenPanel("skills")} active={activeUtility === "skills"} />
        <SidebarAction
          collapsed={collapsed}
          label="Tasks"
          icon={<CalendarClock className="h-4 w-4" />}
          onClick={() => onOpenPanel("tasks")}
          active={activeUtility === "tasks"}
          badge={notificationCount}
        />
        {archivedCount > 0 ? (
          <SidebarAction
            collapsed={collapsed}
            label={showArchived ? "Hide archived" : "Show archived"}
            icon={<Archive className="h-4 w-4" />}
            onClick={() => setShowArchived((value) => !value)}
          />
        ) : null}
      </div>

      <div className={cn("min-h-0 flex-1 overflow-hidden transition-opacity", collapsed && "pointer-events-none opacity-0")}>
        {!collapsed ? (
          <div className="h-full min-h-0 overflow-y-auto px-2 py-1.5">
            {groups.length === 0 ? (
              <div className="px-3 py-6 text-[12px] leading-5 text-muted-foreground/80">No conversations yet</div>
            ) : (
              <div className="space-y-3">
                {groups.map((group) => (
                  <section key={group.id} aria-label={group.label}>
                    <div className="px-2 pb-1 text-[12px] font-medium text-muted-foreground/65">{group.label}</div>
                    <ul className="space-y-0.5">
                      {group.sessions.map((chat) => {
                        const active = chat.key === activeKey;
                        const pinned = pinnedKeys.includes(chat.key);
                        const archived = archivedKeys.includes(chat.key);
                        return (
                          <li key={chat.key} className="relative min-w-0">
                            <div
                              className={cn(
                                "group flex min-h-8 min-w-0 max-w-full items-center gap-2 rounded-xl px-2 text-[13px] transition-colors",
                                active
                                  ? "bg-sidebar-accent/70 text-sidebar-accent-foreground shadow-[inset_0_0_0_1px_hsl(var(--sidebar-border)/0.28)]"
                                  : "text-sidebar-foreground/82 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground",
                              )}
                            >
                              <button
                                type="button"
                                onClick={() => onSelect(chat.key)}
                                title={chat.title}
                                className="min-w-0 flex-1 overflow-hidden py-1.5 text-left"
                              >
                                <span className="block w-full truncate font-medium leading-5">{chat.title}</span>
                                {chat.preview && chat.preview !== chat.title ? (
                                  <span className="block w-full truncate text-[11.5px] leading-4 text-muted-foreground/72">
                                    {chat.preview}
                                  </span>
                                ) : null}
                              </button>
                              <button
                                type="button"
                                aria-label={`Actions for ${chat.title}`}
                                onClick={() => setMenuKey((current) => current === chat.key ? null : chat.key)}
                                className={cn(
                                  "grid h-6 w-6 shrink-0 place-items-center rounded-md text-muted-foreground/75 opacity-45 transition-opacity",
                                  "hover:bg-sidebar-accent hover:text-sidebar-foreground group-hover:opacity-100 focus-visible:opacity-100",
                                  active && "opacity-100",
                                )}
                              >
                                <MoreHorizontal className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            {menuKey === chat.key ? (
                              <div className="absolute right-1 top-8 z-30 w-36 rounded-xl border border-border bg-popover p-1 text-[12px] shadow-xl">
                                <SessionMenuButton icon={pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />} label={pinned ? "Unpin" : "Pin"} onClick={() => togglePinned(chat.key)} />
                                <SessionMenuButton icon={<Pencil className="h-3.5 w-3.5" />} label="Rename" onClick={() => renameChat(chat)} />
                                <SessionMenuButton icon={archived ? <ArchiveRestore className="h-3.5 w-3.5" /> : <Archive className="h-3.5 w-3.5" />} label={archived ? "Unarchive" : "Archive"} onClick={() => toggleArchived(chat.key)} />
                                <SessionMenuButton destructive icon={<Trash2 className="h-3.5 w-3.5" />} label="Delete" onClick={() => deleteChat(chat.key)} />
                              </div>
                            ) : null}
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>

      <div className="border-t border-sidebar-border/60 px-2 py-2.5">
        <SidebarAction collapsed={collapsed} label="Settings" icon={<Settings className="h-4 w-4" />} onClick={() => onOpenPanel("settings")} active={activeUtility === "settings"} />
        {!collapsed ? <div className="px-3 py-2 text-[12px] text-muted-foreground">{connectionLabel}</div> : null}
      </div>
    </aside>
  );
}

function SidebarAction({
  collapsed,
  label,
  icon,
  onClick,
  active = false,
  badge = 0,
}: {
  collapsed: boolean;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  badge?: number;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? "page" : undefined}
      title={collapsed ? label : undefined}
      onClick={onClick}
      className={cn(
        "group h-8 min-w-0 gap-2 overflow-hidden rounded-full font-medium text-sidebar-foreground/85 transition-[width,padding,border-radius,color,background-color] duration-300 ease-out hover:bg-sidebar-accent/75 hover:text-sidebar-foreground",
        collapsed ? "flex w-9 items-center justify-center rounded-xl px-0" : "flex w-full items-center justify-start px-3 text-[12.5px]",
        active && "bg-sidebar-accent text-sidebar-foreground shadow-[inset_0_0_0_1px_hsl(var(--sidebar-border)/0.55)]",
      )}
    >
      <span className="flex shrink-0 items-center justify-center" aria-hidden>{icon}</span>
      {!collapsed ? <span className="min-w-0 flex-1 truncate text-left">{label}</span> : null}
      {!collapsed && badge > 0 ? (
        <span className="min-w-5 rounded-full bg-foreground px-1.5 py-0.5 text-center text-[11px] leading-none text-background">
          {badge}
        </span>
      ) : null}
    </button>
  );
}

function SessionMenuButton({
  icon,
  label,
  onClick,
  destructive = false,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "grid w-full grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted",
        destructive && "text-destructive hover:text-destructive",
      )}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  );
}

function groupChats(
  sessions: ClaudebotChatSummary[],
  pinnedKeys: string[],
  archivedKeys: string[],
  showArchived: boolean,
): ChatGroup[] {
  const pinned = new Set(pinnedKeys);
  const archived = new Set(archivedKeys);
  const buckets = new Map<string, ClaudebotChatSummary[]>();
  const pinnedSessions: ClaudebotChatSummary[] = [];
  const archivedSessions: ClaudebotChatSummary[] = [];

  for (const session of sessions) {
    if (archived.has(session.key)) {
      if (showArchived) archivedSessions.push(session);
      continue;
    }
    if (pinned.has(session.key)) {
      pinnedSessions.push(session);
      continue;
    }
    const label = dateBucketLabel(session.updatedAt ?? session.createdAt);
    const rows = buckets.get(label) ?? [];
    rows.push(session);
    buckets.set(label, rows);
  }

  const groups: ChatGroup[] = [];
  if (pinnedSessions.length > 0) groups.push({ id: "pinned", label: "Pinned", sessions: pinnedSessions });
  for (const label of ["Today", "Yesterday", "Earlier"]) {
    const rows = buckets.get(label);
    if (rows?.length) groups.push({ id: label.toLowerCase(), label, sessions: rows });
  }
  if (archivedSessions.length > 0) groups.push({ id: "archived", label: "Archived", sessions: archivedSessions });
  return groups;
}

function dateBucketLabel(value: string | null): "Today" | "Yesterday" | "Earlier" {
  if (!value) return "Today";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return "Today";
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startYesterday = startToday - 24 * 60 * 60 * 1000;
  if (time >= startToday) return "Today";
  if (time >= startYesterday) return "Yesterday";
  return "Earlier";
}
