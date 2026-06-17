# Scheduler 模块说明

`src/scheduler/` 运行 cron / 一次性 / 间隔定时任务，到点触发一次性 agent turn，结果通过 notifier 送出。本模块只管调度与执行记录，不定义工具协议。

## 关键入口

- `store.ts`: `createSchedulerStore` 持久化 jobs 与每次 run 记录。
- `store-ops.ts`: `createStoreOps` 封装 CRUD，供工具与触发器共用。
- `trigger.ts`: `createSchedulerTrigger` 定时循环，到点调 executor（在 `services.ts` 闭包内接到 `runScheduledTurn`）。
- `notify.ts`: notifier 接口与 noop 实现；真实投递由 `server.ts` 接到 WebUI 通知。
- `types.ts`: `ScheduleRecord`、`ScheduleRunRecord`、`ScheduleKind`。

## 数据流

trigger tick → 命中 job → `runScheduledTurn`（建一次性 session、跑完清理）→ notifier.deliver → WebUI 通知。手动 `schedule_run_now` 工具直接调 trigger。

## 修改注意

- 定时任务执行 session 是一次性的，执行后必须清理，不能出现在 sidebar。
- 改调度逻辑同步更新 `tests/scheduler.test.ts`。

## 测试

```bash
bun test tests/scheduler.test.ts --timeout 30000
```
