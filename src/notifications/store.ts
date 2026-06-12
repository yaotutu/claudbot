import { readJson, writeJsonAtomic } from "../utils/fs.ts";
import type { CreateNotificationInput, NotificationRecord } from "./types.ts";

type NotificationsFile = { notifications: NotificationRecord[] };

export type NotificationStore = {
  list: () => Promise<NotificationRecord[]>;
  create: (input: CreateNotificationInput) => Promise<NotificationRecord>;
  markAllRead: () => Promise<number>;
};

export function createNotificationStore(path: string): NotificationStore {
  const list = async (): Promise<NotificationRecord[]> => {
    const file = await readJson<NotificationsFile>(path, { notifications: [] });
    return file.notifications;
  };

  const create = async (input: CreateNotificationInput): Promise<NotificationRecord> => {
    const notification: NotificationRecord = {
      ...input,
      id: `notif_${crypto.randomUUID()}`,
      createdAt: new Date().toISOString(),
      readAt: null,
    };
    const notifications = await list();
    notifications.push(notification);
    await writeJsonAtomic(path, { notifications });
    return notification;
  };

  const markAllRead = async (): Promise<number> => {
    const notifications = await list();
    const readAt = new Date().toISOString();
    let updated = 0;
    const next = notifications.map((notification) => {
      if (notification.readAt) return notification;
      updated += 1;
      return { ...notification, readAt };
    });
    if (updated > 0) await writeJsonAtomic(path, { notifications: next });
    return updated;
  };

  return { list, create, markAllRead };
}
