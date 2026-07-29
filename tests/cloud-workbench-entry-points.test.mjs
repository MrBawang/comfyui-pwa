import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const workbenchSource = await readFile(new URL("../web/src/components/workbench.tsx", import.meta.url), "utf8");
const chatSource = await readFile(new URL("../web/src/components/chat-page.tsx", import.meta.url), "utf8");

test("an empty workflow library offers a direct Modal catalog sync", () => {
  assert.match(workbenchSource, /同步现有工作流/);
  assert.match(workbenchSource, /void syncStoredWorkflows\(\)/);
  assert.match(workbenchSource, /从 luminaflow-studio 同步/);
});

test("first-use chat exposes Workers AI chat and prompt actions", () => {
  assert.match(chatSource, /开始聊天/);
  assert.match(chatSource, /生成提示词/);
  assert.match(chatSource, /createThread\(\{ mode: "chat", providerId: "workers-ai" \}\)/);
  assert.match(chatSource, /createThread\(\{ mode: "prompt", providerId: "workers-ai" \}\)/);
});

test("an existing conversation can switch between configured providers", () => {
  assert.match(chatSource, /async function changeActiveProvider/);
  assert.match(chatSource, /method: "PATCH"/);
  assert.match(chatSource, /aria-label="当前会话模型"/);
  assert.doesNotMatch(chatSource, /Modal Qwen 保持关闭/);
});
