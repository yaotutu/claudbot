# Runtime 模块说明

`src/runtime/` 是服务装配层，把配置、各存储、工具注册表、runner 和 scheduler 触发器线性拼装成 `ServiceContainer`。本模块不实现业务逻辑，只负责依赖注入与生命周期编排。

## 关键入口

- `services.ts`: `buildServices` 是唯一装配入口；装配顺序线性（Store → StoreOps → Registry → queryFactory → Trigger），无循环依赖。`makeRunner` 返回一次性 runner 工厂，`runScheduledTurn` 用 `runOnceTurn` 跑定时任务。
- `state.ts`: `createRuntimeStateStore` 持久化「最后活跃 session」。

## 数据流

`server.ts` 调 `buildServices` 得到 `ServiceContainer`，再启动 gateway、channel registry 和 scheduler 触发循环。定时任务到点 → `runScheduledTurn` → `runOnceTurn` 跑一次性 session → 清理临时目录。

## 修改注意

- 新增服务必须加入 `ServiceContainer` 类型并在 `buildServices` 线性装配，避免循环依赖。
- 不要在此处读写业务数据，交给具体模块的 store/service。
- 优先函数式 closure，不要新增 class。

## 测试

```bash
bun test tests/scheduler.test.ts tests/gateway.test.ts --timeout 30000
bun run typecheck
```
