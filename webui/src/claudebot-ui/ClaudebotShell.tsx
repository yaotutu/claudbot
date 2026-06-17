import { useMemo, useState, type ReactNode } from "react";

import type { ConnectionStatus } from "@/lib/claudebot-ws";
import type { RuntimeInfo, ThreadActivity, ThreadMessage } from "@/lib/claudebot-types";

import { formatModelLabel, toClaudebotChats, toClaudebotMessages } from "./adapter";
import { ClaudebotPanels } from "./ClaudebotPanels";
import { ClaudebotSidebar } from "./ClaudebotSidebar";
import { ClaudebotThread } from "./ClaudebotThread";
import type { ClaudebotSessionItem, ClaudebotUtilityPanel } from "./types";

type ClaudebotShellProps = {
  runtime: RuntimeInfo;
  connectionStatus: ConnectionStatus;
  panel: ClaudebotUtilityPanel;
  sessions: ClaudebotSessionItem[];
  activeSessionId: string | null;
  messages: ThreadMessage[];
  activities: ThreadActivity[];
  runStatus: string | null;
  loading: boolean;
  streaming: boolean;
  notificationCount: number;
  tasksPanel: ReactNode;
  notificationToast: ReactNode;
  onPanelChange: (panel: ClaudebotUtilityPanel) => void;
  onOpenTasks: () => void;
  onNewChat: () => void;
  onSelectSession: (sessionId: string) => void;
  onRenameSession: (sessionId: string, title: string) => Promise<void>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onSend: (content: string) => void;
  onCancel: () => void;
};

export function ClaudebotShell({
  runtime,
  connectionStatus,
  panel,
  sessions,
  activeSessionId,
  messages,
  activities,
  runStatus,
  loading,
  streaming,
  notificationCount,
  tasksPanel,
  notificationToast,
  onPanelChange,
  onOpenTasks,
  onNewChat,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onSend,
  onCancel,
}: ClaudebotShellProps) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const modelLabel = formatModelLabel(runtime.model, runtime.providerModel);
  const chats = useMemo(() => toClaudebotChats(sessions), [sessions]);
  const uiMessages = useMemo(() => toClaudebotMessages(messages), [messages]);
  const activeSession = chats.find((chat) => chat.key === activeSessionId) ?? null;
  const disabled = !activeSessionId;

  return (
    <div className="flex h-full w-full overflow-hidden bg-background text-foreground">
      <ClaudebotSidebar
        sessions={chats}
        activeKey={activeSessionId}
        collapsed={sidebarCollapsed}
        activeUtility={panel}
        notificationCount={notificationCount}
        connectionLabel={connectionStatus === "open" ? "Connected" : connectionStatus}
        onCollapse={() => setSidebarCollapsed(true)}
        onExpand={() => setSidebarCollapsed(false)}
        onNewChat={onNewChat}
        onSelect={onSelectSession}
        onOpenPanel={(nextPanel) => {
          if (nextPanel === "tasks") {
            onOpenTasks();
            return;
          }
          onPanelChange(nextPanel);
        }}
        onRename={onRenameSession}
        onDelete={onDeleteSession}
      />
      <div className="relative flex min-w-0 flex-1 overflow-hidden">
        <ClaudebotThread
          activeSession={activeSession}
          messages={uiMessages}
          activities={activities}
          runStatus={runStatus}
          loading={loading}
          streaming={streaming}
          disabled={disabled}
          modelLabel={modelLabel}
          sidebarCollapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed((value) => !value)}
          onSend={onSend}
          onCancel={onCancel}
          onNewChat={onNewChat}
          hasSession={Boolean(activeSessionId)}
        />
        {panel === "tasks" ? tasksPanel : null}
        {panel && panel !== "tasks" ? (
          <ClaudebotPanels panel={panel} runtime={runtime} onClose={() => onPanelChange(null)} />
        ) : null}
        {notificationToast}
      </div>
    </div>
  );
}
