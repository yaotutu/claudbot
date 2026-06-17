# Gateway 模块说明

`src/gateway/` 是 HTTP + WebSocket 入口，把 WebUI / channel 请求接到运行时服务。本模块只处理协议帧与路由，不持有业务状态。

## 关键入口

- `http.ts`: HTTP 路由（bootstrap、sessions、schedules、profile、MCP、channel webhook）。
- `websocket.ts`: `makeWsHandlers` 处理 WS open / message / close 与广播。
- `protocol.ts`: WS 帧的编解码约定（实际帧类型在 `shared/webui-protocol.ts`）。

## 数据流

浏览器 → `/ws`（交互帧 `chat.send` / `chat.cancel` / `session.activate`）或 HTTP（REST）→ gateway 分发到 `services`（对话走 `runUserTurn`）→ 回送 `ServerFrame` 流。

## 修改注意

- 新增帧类型必须在 `shared/webui-protocol.ts` 的 `ClientFrame` / `ServerFrame` 定义，并在前后端同步处理。
- gateway 当前无认证，不要暴露到不可信网络。
- 改路由同步更新 `tests/gateway.test.ts`。

## 测试

```bash
bun test tests/gateway.test.ts --timeout 30000
```
