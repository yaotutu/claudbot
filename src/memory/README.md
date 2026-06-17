# Memory 模块说明

`src/memory/` 实现 Markdown 长期记忆：profile 文本、长期记忆 `MEMORY.md`、事件流，以及 dream（从事件候选提炼并 patch 记忆）。本模块只管记忆存储与提炼，不定义记忆工具协议（工具在 `tools/builtin/memory.ts`）。

## 关键入口

- `markdown-store.ts`: `initMemoryMarkdownStore`、`readMemoryFile`、`appendMemoryEvent`、`searchMemoryText`。
- `dream.ts`: `runMemoryDream` 从事件候选生成 patch plan 并应用。
- `git-store.ts`: 记忆文件的 git 审计（commit / log / diff）。
- `intent.ts`: `detectMemoryIntent` 保守判断用户是否要求记住。
- `types.ts`: `MemoryMarkdownPaths`、`DreamPatchPlan` 等。

## 数据流

用户明确要求记忆 → `runUserTurn` 后 `maybeRunExplicitMemoryDreamAfterTurn` 触发 dream → patch 写入 `MEMORY.md` + 事件流 → 可选 git 提交。

## 修改注意

- 不兼容旧 `memory.json`；记忆只存 Markdown。
- 改 patch 逻辑同步更新 `tests/agent-profile-memory.test.ts`。

## 测试

```bash
bun test tests/agent-profile-memory.test.ts --timeout 30000
```
