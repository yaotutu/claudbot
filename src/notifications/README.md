# Notifications 模块说明

`src/notifications/` 存储并派发产品通知（主要是定时任务结果），供 WebUI Tasks 面板消费。本模块只管通知记录，不产生通知内容。

## 关键入口

- `store.ts`: `createNotificationStore` 持久化通知列表（`webui/notifications.json`）。
- `types.ts`: `NotificationRecord`。

## 数据流

scheduler notifier → `deliverScheduleResultToNotification`（`scheduler/notify.ts`）→ 写入 notification store → WS 广播 `notification.created` → WebUI Tasks 面板。

## 修改注意

- 通知是产品通知，不是聊天消息；不要把它写进 session。
- 改存储同步更新对应 channel / scheduler 测试。

## 测试

通知行为由 `tests/gateway.test.ts`、`tests/scheduler.test.ts` 间接覆盖。
