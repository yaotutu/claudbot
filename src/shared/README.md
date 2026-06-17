# Shared 模块说明

`src/shared/` 是前后端共享契约层。WebUI 通过相对路径 `../../../src/shared/*.ts` 跨包 import 这里的类型与纯函数。本模块不得依赖任何后端运行时或前端 DOM 类型，只定义中性契约。

## 关键文件

- `webui-protocol.ts`: WS / HTTP 协议类型（`ClientFrame`、`ServerFrame`、`ThreadMessage`、`ThreadActivity`、`ScheduleRecord`、`RuntimeInfo`、`WebuiBootstrap` 等）+ `WEBUI_PROTOCOL_VERSION`。
- `activity-reducer.ts`: `appendActivity` / `finalizeActivities` 纯函数 reducer，后端持久化与前端实时累积共用同一份逻辑。

## 修改注意

- 新增帧 / 字段必须前后端同步，并更新 `webui/src/tests/shared-protocol.test.ts`。
- reducer 输出形状（`thinking-${runId}` / `tool-${toolId}` / `status-${runId}`）是契约，前端测试断言精确 id，改动需同步。
- 保持无副作用、无运行时依赖，确保前端 Vite 能跨包 bundle。
