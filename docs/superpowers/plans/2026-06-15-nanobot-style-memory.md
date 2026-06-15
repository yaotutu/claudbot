# Nanobot Style Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将旧 `memory.json` CRUD 记忆替换为 Claudebot 原生的 Markdown 长期记忆 projector。

**Architecture:** `sessions/<sessionId>/main.jsonl` 是唯一原始会话数据源。Memory 模块不复制聊天记录，只读取 session transcript，维护自己的处理状态和派生结果：`memory/MEMORY.md`、`memory/memory_events.jsonl`、`memory/.git`。旧 `memory.json` 不迁移、不兼容，初始化时直接删除。

**Tech Stack:** Bun、TypeScript ESM、`bun:test`、Zod v4、Claude Agent SDK native tools、React/Vite WebUI、Chromium CDP 点击验证。

---

## Final Model

```text
<home>/sessions/<sessionId>/main.jsonl          # 唯一原始聊天记录
<home>/memory/MEMORY.md                        # 长期记忆派生结果
<home>/memory/memory_events.jsonl              # memory 模块事件流水
<home>/memory/memory_state.json                # Dream 扫描 session transcript 的 offset 状态
<home>/memory/.git                             # memory 文件 diff / rollback
```

第一版不做：

- `memory.json` 迁移或兼容。
- `memory/chats/<sessionId>.jsonl` 第二套聊天记录。
- skills 读写或 `skills/*/SKILL.md` 生成。
- embedding、SQLite/FTS、active-memory 子 agent。

## Implemented Tasks

- [x] Runtime paths 增加 `longTermMemoryFile`、`memoryEventsFile`、`memoryStateFile`、`deprecatedMemoryJsonFile`。
- [x] `AgentProfileStore` 收缩为只管理 `user.md` 和 `soul.md`。
- [x] 删除旧 `MemoryStore` JSON CRUD。
- [x] 新增 `src/memory/markdown-store.ts`，初始化 `MEMORY.md` / `memory_events.jsonl`，删除旧 `memory.json`，支持 read/search/event append。
- [x] 新增 `src/memory/dream.ts`，实现受控 `DreamPatchPlan` 应用器；`runMemoryDream` 会扫描 `sessions/<sessionId>/main.jsonl` 的新增行，提取显式记忆请求，并合并 pending candidates 到 `MEMORY.md`。
- [x] 新增 `src/memory/git-store.ts`，支持 init、commit、log、diff、revert。
- [x] 重写 memory tools：`memory_read`、`memory_search`、`memory_append_note`、`memory_dream`、`memory_log`、`memory_diff`、`memory_revert`。
- [x] System prompt 注入 `memory/MEMORY.md`，默认 24,000 字符预算。
- [x] HTTP API 增加 `/api/memory/status`、`/api/memory/files`、`/api/memory/dream`、`/api/memory/commits`、diff、revert。
- [x] `/api/agent/files` 不再返回 `memory.json`。
- [x] WebUI Settings 展示 Memory 状态和 `Run Dream` dry-run 反馈。
- [x] 用真实 Chromium CDP 验证 Settings/Search/Skills/New chat/发送消息/remap。

## Notes

- `memory_append_note` 只写 `memory_events.jsonl` 的 `candidate` 事件，不修改 `MEMORY.md`。
- `memory_dream` 第一版只抽取显式记忆请求，例如 `请记住：...`、`记住：...`、`memory: ...`、`remember: ...`。普通聊天不会自动入长期记忆。
- `memory_state.json` 只记录每个 session 已扫描到的行数，不记录聊天内容，不是第二套 session log。
- Skills 后续如果要做，应作为独立 projector：读取同一份 session transcript，输出自己的 `skills/*` 结果，不由 Memory 模块直接管理。

## 后续 TODO

- [ ] 设计并实现周期 Dream。周期 Dream 负责扫描历史 session transcript，发现隐式但可能稳定的用户偏好、项目事实和长期约定。
- [ ] 周期 Dream 第一版不要直接写入 `MEMORY.md`。隐式发现只能先生成 `candidate` 事件，进入 pending 区，避免模型误判污染长期记忆。
- [ ] 在 WebUI Settings 或 memory tool 中提供 candidate 处理入口，至少支持查看、应用、忽略。只有被确认应用的 candidate 才能晋升写入 `MEMORY.md`。
- [ ] 保持显式记忆和周期 Dream 的边界：用户明确说 `记住：...` 时可以在当前回合后立即写入；周期 Dream 产出的 candidate 不能被显式记忆触发顺手应用。
