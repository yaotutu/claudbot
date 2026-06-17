# Claudebot UI 适配层

本目录负责把 Nanobot WebUI 的页面体验迁移到 Claudebot WebUI，但不改变 Claudebot 后端协议。

## 模块边界

- 可以复用 Nanobot 的布局、视觉密度、交互结构和 UI 组件写法。
- 不允许引入 Nanobot 的 `ClientProvider`、`useSessions`、`useNanobotStream`、token 认证、旧 HTTP/WS 路由或后端兼容协议。
- 数据入口只能来自 Claudebot 原生边界：`claudebot-api.ts`、`claudebot-ws.ts`、`useClaudebotSessions.ts`、`useClaudebotThread.ts`。
- 如果 Nanobot 页面逻辑需要的数据在 Claudebot 协议中不存在，应在本目录降级为本地 UI 状态、占位反馈或隐藏高级动作，而不是反向修改后端协议。

## 关键入口

- `ClaudebotShell.tsx`: 页面主壳，组合侧边栏、线程区、任务/设置/搜索/技能面板。
- `ClaudebotSidebar.tsx`: Nanobot 风格侧边栏、会话分组和会话动作。
- `ClaudebotThread.tsx`: Nanobot 风格线程区、空态、消息流、运行态 activity timeline 和 composer。
- `adapter.ts`: 把 Claudebot 原生 session/message 转为 UI view model。
- `types.ts`: 本目录内部使用的 UI 类型。

## 运行态展示

聊天过程中的思考、工具调用和状态反馈来自 `useClaudebotThread.ts` 消费 Claudebot 原生 WebSocket 帧：

- `run.thinking`: 合并为当前 run 的 `thinking` activity。
- `run.tool`: 按工具调用 id upsert 为 `tool` activity，展示工具名、阶段、输入和输出摘要。
- `run.status`: upsert 为 `status` activity，并同步底部运行中状态文案。
- `chat.cancel`: composer 在 streaming 时显示 `Stop generating`，点击后通过原生客户端发送取消帧。

这里不引入 Nanobot 的 `useNanobotStream`。后续如果迁移 Nanobot 的 `AgentActivityCluster` 视觉，也应继续使用上述 Claudebot activity view model 作为输入。

## 测试方式

- 小范围：`cd webui && bun run test -- src/tests/app-native-layout.test.tsx`
- WebUI 全量：`cd webui && bun run test`
- 构建：`cd webui && bun run lint && bun run build`
- 用户可见行为必须再用 CDP 真实点击验证。

## 修改注意事项

保持本目录是前端 UI 适配层。任何看起来需要“兼容 Nanobot 协议”的需求，都应先尝试改组件 props、view model 或本地交互状态。
