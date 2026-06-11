// Direct runner spike: drive ClaudeRunner end-to-end with the real queryFactory,
// without going through the WS layer. Used to isolate whether the WebUI
// contract is right independently of any gateway/WS bugs.

import { resolveRuntimeConfig } from "../config/loader.ts";
import { runtimePaths } from "../config/paths.ts";
import { ToolRegistry } from "../tools/registry.ts";
import { ClaudeRunner, makeRealQueryFactory } from "../agent/runner.ts";

const config = await resolveRuntimeConfig({});
const paths = runtimePaths(config);
const registry = new ToolRegistry(
  { defaultPolicy: config.tools.permissions.default, overrides: config.tools.permissions.overrides },
  paths.toolAuditFile,
);
const runner = new ClaudeRunner(
  {
    config,
    registry,
    promptInputs: {
      home: paths.home,
      workspacePath: paths.workspace,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      source: "user_turn",
      userFile: paths.userFile,
      soulFile: paths.soulFile,
    },
  },
  makeRealQueryFactory(registry, config, "/tmp/claudebot-spike-sdk", {
    async append() {},
    async load() { return []; },
    async listSessions() { return []; },
    async delete() {},
    async listSubkeys() { return []; },
  }),
);

console.error("[runner-spike] starting");
try {
  for await (const ev of runner.run({ prompt: "Say just the word 'pong' and nothing else." })) {
    console.log(JSON.stringify(ev));
  }
  console.error("[runner-spike] done");
} catch (e) {
  console.error("[runner-spike] threw:", e);
}
