# claudebot WebUI

这是 claudebot 的浏览器前端，使用 Vite、React 18、TypeScript 和 Tailwind 3 构建。它通过当前 claudebot 原生 REST/WebSocket 契约连接 gateway，不依赖旧 adapter 或其他运行时。

## 目录

```text
webui/            WebUI 源码
webui/src/        React/TypeScript 源码
webui/dist/       生产构建输出，运行时由 src/server.ts 直接服务
```

## 首次安装

从仓库根目录安装运行时依赖：

```bash
bun install
```

WebUI 是独立 package，需要进入 `webui/` 安装一次前端依赖：

```bash
cd webui
bun install
cd ..
```

## 开发模式

最常用方式是在仓库根目录同时启动 gateway 和 WebUI：

```bash
bun run dev
```

然后打开：

```text
http://127.0.0.1:5173
```

`bun run dev` 会启动两个进程：

- gateway: `http://127.0.0.1:18790`
- Vite WebUI: `http://127.0.0.1:5173`

如果只调试 WebUI，也可以分开启动：

```bash
# 终端 1：仓库根目录
bun run dev:server

# 终端 2：仓库根目录
bun run dev:webui
```

如果 gateway 不在默认端口，给 Vite 指定代理目标：

```bash
cd webui
CLAUDEBOT_API_URL=http://127.0.0.1:9000 bun run dev
```

## 生产构建与启动

先构建 WebUI：

```bash
cd webui
bun run build
cd ..
```

再从仓库根目录启动运行时：

```bash
bun run start
```

构建产物写入 `webui/dist/`。`src/server.ts` 会在 gateway 同一端口服务 `index.html`、`assets/`、`brand/` 和 API/WS。

默认访问地址：

```text
http://127.0.0.1:18790
```

## 配置

运行时配置由根目录的 `src/config/schema.ts` 定义，加载顺序如下：

1. `CLAUDEBOT_CONFIG` 指向的 JSON 文件
2. `$CLAUDEBOT_HOME/config.json`
3. 如果目标配置不存在，运行时会自动创建一份 starter config，并在启动日志里提示你编辑它
4. 如果创建失败，或已有配置文件 JSON 无法解析，才退回 schema 默认值

默认 home 是 `~/.claudebot`，常用配置路径是：

```text
~/.claudebot/config.json
```

根目录提供了 `config.example.json`。可以按需复制内容到自己的实例配置文件中，再替换模型、API 地址、密钥和端口。

Claude Code 模型配置分两层：

```json
{
  "claudeCode": {
    "baseUrl": "https://open.bigmodel.cn/api/anthropic",
    "apiKey": "your-key",
    "model": "sonnet",
    "providerModel": "glm-4.7"
  }
}
```

`claudeCode.model` 必须是 Claude Code 认识的 `haiku`、`sonnet` 或 `opus`。实际供应商模型写在 `providerModel`；运行时会自动注入对应的 `ANTHROPIC_DEFAULT_*_MODEL` 环境变量，例如 `sonnet -> glm-4.7`。不要把 `glm-*` 直接写进 `claudeCode.model`。

已知坑：BigModel 走 Anthropic 兼容协议时也必须这样配。`model: "glm-5.1"` 是错误写法，问题不在协议，而在 Claude Code SDK 的模型别名层；正确形态是 `model: "sonnet"` 搭配 `providerModel: "glm-..."`。切换供应商模型时只改 `providerModel`，不要新增硬编码兼容逻辑。

## 常用命令

```bash
cd webui
bun run dev       # Vite dev server
bun run build     # tsc + vite build
bun run test      # Vitest
bun run lint      # ESLint，warning 也会失败
```

## 局域网访问

gateway 当前没有认证。只在可信网络中把 `gateway.host` 设为 `0.0.0.0`，不要把本地开发实例暴露到不可信网络。
