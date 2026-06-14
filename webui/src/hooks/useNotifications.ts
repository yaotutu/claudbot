import { useCallback, useEffect, useState } from "react";

import { fetchNotifications, markNotificationsRead } from "@/lib/claudebot-api";
import type { NotificationRecord, ServerFrame } from "@/lib/claudebot-types";

type NotificationsClient = {
  onFrame: (handler: (frame: ServerFrame) => void) => () => void;
};

export function useNotifications(client: NotificationsClient) {
  const [notifications, setNotifications] = useState<NotificationRecord[]>([]);
  const [toast, setToast] = useState<NotificationRecord | null>(null);

  const refreshNotifications = useCallback(async () => {
    const rows = await fetchNotifications();
    setNotifications((current) => {
      const currentById = new Map(current.map((item) => [item.id, item]));
      return rows.map((row) => {
        const currentRow = currentById.get(row.id);
        return currentRow?.readAt && !row.readAt ? { ...row, readAt: currentRow.readAt } : row;
      });
    });
  }, []);

  useEffect(() => {
    void refreshNotifications();
  }, [refreshNotifications]);

  useEffect(() => {
    return client.onFrame((frame) => {
      if (frame.type !== "notification.created") return;
      setNotifications((current) => [frame.notification, ...current.filter((item) => item.id !== frame.notification.id)]);
      setToast(frame.notification);
    });
  }, [client]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 8000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const unreadNotificationCount = notifications.filter((notification) => !notification.readAt).length;

  const markAllReadOptimistic = useCallback(() => {
    if (unreadNotificationCount === 0) return;
    setNotifications((current) => current.map((notification) => notification.readAt ? notification : { ...notification, readAt: new Date().toISOString() }));
    void markNotificationsRead().catch(() => refreshNotifications());
  }, [refreshNotifications, unreadNotificationCount]);

  return {
    notifications,
    setNotifications,
    toast,
    setToast,
    refreshNotifications,
    unreadNotificationCount,
    markAllReadOptimistic,
  };
}
