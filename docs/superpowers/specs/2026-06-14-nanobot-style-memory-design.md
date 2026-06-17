# Claudebot Nanobot 风格记忆系统重构设计

## 目标

把当前 MVP 的 `memory.json` 结构化 CRUD 记忆，重构为更接近 nanobot 的 Markdown 真源记忆系统。新系统以人类可读文件为长期事实来源，以 Dream 合并器做事实抽取、路由、去重、修正和删除，以 Git 记录自动改写历史。

本设计优先解决四个问题：

- 记忆内容要能被用户直接阅读、审计和回滚。
- 用户偏好、agent 行为规则、项目上下文和可复用技能必须有清晰边界。
- 已合并的会话历史不应反复占用主对话上下文。
- 记忆工具提示要使用最新的 `ToolPrompt` 注册机制，而不是回到全局 prompt 硬编码。

## 明确取舍

- 废弃 `memory.json` 作为主记忆存储。
- 不保留 `memory.json` 的兼容写入路径。
- 允许一次性迁移旧 `memory.json.entries`，迁移后不再读写该文件。
- 第一版不做 embedding、向量库、SQLite FTS、QMD、active-memory 子 agent 或 wiki 知识库。
- 第一版搜索使用本地 Markdown/JSONL 文本搜索，后续可替换为更强索引。
- Dream 合并器第一版可以由用户显式工具触发和后台阈值触发，不要求每轮自动运行。
- 新实现优先使用函数式模块。已有 class 不需要为本功能做无关全局重构，但新 memory 模块不新增复杂 class 继承体系。

## 新实例布局

当前布局：

```text
<home>/
  agent/
    user.md
    soul.md
    memory.json
```

目标布局：

```text
<home>/
  agent/
    user.md
    soul.md
    memory/
      MEMORY.md
      history.jsonl
      chats/
        <sdkSessionId>.jsonl
    skills/
      <skill-name>/
        SKILL.md
```

文件职责：

- `user.md`：用户身份、稳定偏好、语言、长度、语气、习惯和个人属性。
- `soul.md`：agent 行为规则、工具使用策略、交互边界、长期 guardrails。
- `memory/MEMORY.md`：项目背景、架构、战略决策、基础设施概览和长期上下文。
- `memory/history.jsonl`：Dream 输入、输出、跳过原因、应用结果、commit sha 等审计记录。
- `memory/chats/<sdkSessionId>.jsonl`：会话级事实抽取、中间摘要或短期候选。
- `skills/<skill-name>/SKILL.md`：重复出现的可复用流程、命令、步骤和示例。

`memory.json` 迁移策略：

- 如果旧文件存在且包含 `{ entries: [...] }`，启动时将其渲染为 `memory/MEMORY.md` 中的 `## Imported legacy memory` 小节。
- 每条旧 entry 转为一条 Markdown bullet，保留 source、tags、confidence 和时间信息的简短括注。
- 迁移完成后写入 `memory/history.jsonl` 的 `legacy_import` 记录。
- 迁移后运行时不再创建或更新 `memory.json`。旧文件可以留在磁盘上作为历史残留，但不再出现在工具和 HTTP 主接口里。

## 架构边界

### Profile

`AgentProfileStore` 只管理：

```ts
type AgentFileName = "user.md" | "soul.md";
```

它负责初始化、读取和带版本更新 profile 文件。`memory.json` 从 allow-list 移除。`agent_file_read` 和 `agent_file_update` 也只允许 `user.md`、`soul.md`。

### Memory Markdown Store

新增 `src/memory/markdown-store.ts`，提供纯文件操作能力：

```ts
type MemoryMarkdownPaths = {
  agentDir: string;
  userFile: string;
  soulFile: string;
  memoryDir: string;
  longTermFile: string;
  historyFile: string;
  chatsDir: string;
  skillsDir: string;
};

function initMemoryMarkdownStore(paths: MemoryMarkdownPaths): Promise<void>;
function readMemoryFiles(paths: MemoryMarkdownPaths): Promise<MemoryFilesSnapshot>;
function readMemoryFile(paths: MemoryMarkdownPaths, name: MemoryReadableFile): Promise<VersionedText>;
function updateMemoryFile(paths: MemoryMarkdownPaths, name: MemoryEditableFile, content: string, expectedVersion: string): Promise<VersionedText>;
function appendMemoryHistory(paths: MemoryMarkdownPaths, record: MemoryHistoryRecord): Promise<void>;
function appendChatMemory(paths: MemoryMarkdownPaths, sessionId: string, record: ChatMemoryRecord): Promise<void>;
function searchMemoryText(paths: MemoryMarkdownPaths, query: string, options?: MemorySearchOptions): Promise<MemorySearchHit[]>;
```

第一版搜索范围：

- `user.md`
- `soul.md`
- `memory/MEMORY.md`
- `memory/history.jsonl`
- `memory/chats/*.jsonl`
- `skills/*/SKILL.md`

搜索实现为大小写不敏感 substring，返回 path、line、snippet、source。接口要与实现解耦，后续可以替换为索引搜索。

### Memory Git Store

新增 `src/memory/git-store.ts`，提供记忆文件版本化能力：

```ts
function initMemoryGitStore(paths: MemoryMarkdownPaths): Promise<MemoryGitInitResult>;
function commitMemoryChanges(paths: MemoryMarkdownPaths, message: string): Promise<MemoryCommitResult>;
function listMemoryCommits(paths: MemoryMarkdownPaths, limit?: number): Promise<MemoryCommitSummary[]>;
function showMemoryCommitDiff(paths: MemoryMarkdownPaths, sha: string): Promise<string>;
function revertMemoryCommit(paths: MemoryMarkdownPaths, sha: string): Promise<MemoryCommitResult>;
```

Git 仓库位置为 `<home>/agent/.git`，只跟踪记忆相关文件。`.gitignore` 默认忽略所有内容，再显式允许：

```text
!user.md
!soul.md
!memory/
!memory/MEMORY.md
!memory/history.jsonl
!memory/chats/
!memory/chats/*.jsonl
!skills/
!skills/*/
!skills/*/SKILL.md
!.gitignore
```

如果 `<home>/agent` 已经处于外部 git 仓库内，第一版仍然初始化 agent-local git 仓库，因为 `<home>` 是 Claudebot 自有数据目录，不是用户代码仓库。初始化失败时，记忆功能继续可用，但 Settings 和工具结果必须显示 `gitAudit: unavailable`。

### Dream 合并器

新增 `src/memory/dream.ts`。Dream 是维护流程，不是普通聊天回复。它读取未合并会话片段和当前记忆文件，生成受控 patch plan，再由运行时代码应用。

Dream 输入：

- 当前 `user.md`
- 当前 `soul.md`
- 当前 `memory/MEMORY.md`
- 已有 skills 列表和每个 `SKILL.md` 摘要
- 当前 session 未合并 JSONL 片段
- 最近 `memory/chats/<sessionId>.jsonl` 候选

Dream 输出必须是 JSON patch plan，不允许模型直接自由写文件：

```ts
type DreamPatchPlan = {
  summary: string;
  updates: Array<{
    target: "user.md" | "soul.md" | "memory/MEMORY.md" | `skills/${string}/SKILL.md`;
    operation: "append" | "replace_section" | "delete_lines" | "create_skill" | "update_skill";
    rationale: string;
    content?: string;
    match?: string;
  }>;
  skipped: Array<{
    reason: "transient" | "duplicate" | "public_knowledge" | "sensitive" | "low_signal";
    content: string;
  }>;
};
```

应用规则：

- 所有 target 必须落在允许路径内。
- `user.md` 不能写项目配置、命令、URL 或技术细节。
- `soul.md` 不能写用户事实。
- `memory/MEMORY.md` 保留战略背景和长期上下文，不写一次性命令步骤。
- 具体命令、API 参数、流程步骤进入 `skills/*/SKILL.md`。
- 冲突事实优先替换旧内容，不追加相互矛盾的条目。
- 同一事实不能跨文件重复保存。
- 应用成功后写 `history.jsonl`，再 Git commit。

Dream prompt 主要借鉴 nanobot 的规则：MECE 分类、SNIP 筛选、纠正覆盖、删除陈旧内容、把重复流程迁移到 skill。

## Session 合并状态

当前 session transcript 由 SDK JSONL mirror 拥有，不能重新引入 app-layer message store。为记录 Dream 进度，每个 SDK session 增加 sidecar 文件：

```text
<home>/sessions/<sdkSessionId>/memory_state.json
```

格式：

```json
{
  "version": 1,
  "lastConsolidatedLine": 0,
  "lastDreamAt": null,
  "lastDreamCommit": null,
  "lastDreamError": null
}
```

Dream 只读取 `main.jsonl` 中 `lastConsolidatedLine` 之后的新行。成功应用并提交后，更新 offset。失败时不推进 offset，记录 `lastDreamError`。

## 工具设计

重写 `registerMemoryTools`，删除 JSON entry CRUD 作为主接口。第一版注册：

- `memory_read`
- `memory_search`
- `memory_append_note`
- `memory_dream`
- `memory_log`
- `memory_diff`
- `memory_revert`

### `memory_read`

读取受控记忆文件或片段。

输入：

```ts
{
  path: "user.md" | "soul.md" | "memory/MEMORY.md" | `skills/${string}/SKILL.md`;
  fromLine?: number;
  lineCount?: number;
}
```

### `memory_search`

搜索 Markdown/JSONL 记忆文本。

输入：

```ts
{
  query: string;
  maxResults?: number;
  scope?: "all" | "profile" | "long_term" | "history" | "skills";
}
```

### `memory_append_note`

追加短期候选事实。它不直接改长期文件，默认写入当前 session 的 `memory/chats/<sessionId>.jsonl`，或写入 `history.jsonl` 的候选事件。

### `memory_dream`

触发 Dream 合并当前 session 或全局候选。

输入：

```ts
{
  scope?: "current_session" | "all_pending";
  dryRun?: boolean;
}
```

`dryRun` 返回 patch plan 但不写文件。

### Git 审计工具

- `memory_log` 返回最近 commit。
- `memory_diff` 返回某个 commit 的 diff。
- `memory_revert` revert 某个 memory commit，并产生新的 revert commit。

## ToolPrompt 注入

最新代码已经支持 `ToolPrompt`，因此 Memory 的系统说明放在 `registerMemoryTools` 的 prompt section 中，priority 建议为 `10`。

内容包含：

- 记忆只保存 durable facts。
- 文件路由规则：`user.md`、`soul.md`、`memory/MEMORY.md`、`skills/*/SKILL.md`。
- 不保存临时聊天细节、猜测、普通公共知识和敏感秘密。
- 搜索旧记忆后再追加，优先修正而非复制。
- 使用 `memory_dream` 做合并，不直接绕过 Dream 改长期记忆。

`agent_file_*` 的 prompt 也要更新，明确 profile 工具只处理 `user.md` 和 `soul.md`，不要再提 `memory.json`。

## Prompt Builder

`buildSystemPrompt` 增加 long-term memory 输入：

```ts
type PromptInputs = {
  userFile: string;
  soulFile: string;
  longTermMemoryFile?: string;
  toolPrompts?: ToolPrompt[];
};
```

系统提示注入顺序：

```text
# Claudebot runtime context
# Tools
# User profile (user.md)
# Soul (soul.md)
# Long-term memory (memory/MEMORY.md)
```

第一版对 `memory/MEMORY.md` 做字符预算截断，默认最多注入 24,000 字符。被截断时在提示中追加说明，提醒模型可用 `memory_read` 或 `memory_search` 获取完整内容。

## HTTP 和 WebUI

新增 HTTP API：

- `GET /api/memory/status`
- `GET /api/memory/files`
- `GET /api/memory/files/:name`
- `POST /api/memory/dream`
- `GET /api/memory/commits`
- `GET /api/memory/commits/:sha/diff`
- `POST /api/memory/commits/:sha/revert`

`/api/agent/files` 不再返回 `memory.json`，只返回 `user.md` 和 `soul.md`。

WebUI 第一版只扩展 Settings，不做完整记忆编辑器。Settings 展示：

- Memory home/path。
- `MEMORY.md` 是否存在和大小。
- 最近 Dream 时间。
- 当前 active session 未合并行数。
- 最近 memory commit。
- Git 审计是否可用。
- `Run Dream` 按钮和 dry-run/error/success 状态。

Search 和 Skills 入口继续保留可见反馈，不和本次记忆重构耦合。

## 触发策略

第一版支持三种触发：

1. 用户明确说“记住”“整理记忆”“总结到长期记忆”时，模型可调用 `memory_append_note` 或 `memory_dream`。
2. 单个 session 新增 JSONL 行数超过阈值时，后台可触发 `memory_dream(scope=current_session)`。默认阈值 20 行。
3. Scheduler 可注册周期 Dream sweep。默认先不自动创建周期任务，后续通过配置启用。

后台 Dream 不能把失败吞掉。失败写入 session `memory_state.json`，并在 Settings 中可见。

## 配置

新增配置字段：

```ts
memory: {
  enabled: boolean;
  injectLongTermMaxChars: number;
  dream: {
    enabled: boolean;
    autoRunAfterUnmergedLines: number;
    model?: string;
  };
  git: {
    enabled: boolean;
  };
}
```

默认值：

```json
{
  "memory": {
    "enabled": true,
    "injectLongTermMaxChars": 24000,
    "dream": {
      "enabled": true,
      "autoRunAfterUnmergedLines": 20
    },
    "git": {
      "enabled": true
    }
  }
}
```

## 错误处理

- Markdown 文件缺失：启动时自动创建默认文件。
- 旧 `memory.json` 非法：跳过迁移，写 `history.jsonl` 错误记录，不阻止启动。
- Dream 输出不是合法 JSON：返回工具错误，不写任何文件，不推进 offset。
- Dream patch target 越界：拒绝整个 plan。
- Git 初始化或 commit 失败：记忆文件仍写入，但状态标记为 `gitAudit: unavailable` 或 `commitFailed`。
- WebUI 手动 Dream 失败：Settings 显示错误，不静默失败。
- 后台 Dream 失败：写入 `memory_state.json.lastDreamError` 和日志。

## 测试要求

后端单元测试：

- 初始化新 Markdown 记忆结构。
- 迁移合法 `memory.json.entries` 到 `memory/MEMORY.md`。
- 非法 `memory.json` 不阻止启动且记录错误。
- `AgentProfileStore` 不再允许 `memory.json`。
- `memory_read`、`memory_search`、`memory_append_note`、`memory_dream(dryRun)`。
- Dream patch plan 校验：合法应用、越界拒绝、冲突不推进 offset。
- `memory_state.json` 只在成功 Dream 后推进 `lastConsolidatedLine`。
- Git init、commit、log、diff、revert。
- `ToolRegistry.getPromptSections()` 包含新的 Memory prompt，且不再出现旧 JSON CRUD 指令。

WebUI 测试：

- Settings 打开后显示 Memory 状态。
- Run Dream 按钮有 loading、success、error 状态。
- 记忆状态接口失败时显示错误反馈。

真实 Chromium CDP 验证：

- 页面启动。
- Settings/Search/Skills 入口都有反馈。
- New chat 创建 draft。
- 发送一条短消息。
- 手动 Run Dream 后 Settings 状态更新，或在模型不可用时显示错误状态。
- 验证后关闭本轮打开的标签页和启动的 gateway/Vite 进程。

## 分阶段实施

### 阶段 1：存储模型

- 扩展 `runtimePaths`，增加 `memoryDir`、`longTermMemoryFile`、`memoryHistoryFile`、`memoryChatsDir`、`skillsDir`。
- 新增 Markdown memory store。
- 初始化 `memory/MEMORY.md`、`memory/history.jsonl`、`memory/chats/`、`skills/`。
- 实现 `memory.json` 一次性迁移。
- 修改 `AgentProfileStore` 和 HTTP agent files allow-list，移除 `memory.json`。

### 阶段 2：工具和 prompt

- 重写 `registerMemoryTools`。
- 更新 Memory `ToolPrompt`。
- 更新 agent-file `ToolPrompt`。
- `buildSystemPrompt` 注入 `memory/MEMORY.md`。
- 更新相关测试。

### 阶段 3：Dream 和 Git 审计

- 实现 session `memory_state.json`。
- 实现 Dream dry-run 和 apply。
- 实现 GitStore。
- `memory_dream` 成功后写 history、commit、推进 offset。

### 阶段 4：WebUI 和后台触发

- 新增 HTTP memory status/API。
- Settings 展示 Memory 状态和 Run Dream。
- 增加阈值后台 Dream 触发。
- 完成 WebUI 单测、构建和 CDP 点击验证。

## 非目标

- 不实现 vector search。
- 不实现 openclaw active-memory。
- 不实现 memory-wiki。
- 不做旧 nanobot 数据兼容。
- 不把会话消息重新存入 app-layer session JSON。
- 不在第一版提供完整 Markdown 编辑器。

