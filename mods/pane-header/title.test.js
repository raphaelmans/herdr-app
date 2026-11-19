// node --test mods/pane-header/title.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentTitle } from "./title.js";

const claude = { name: "Claude Code", key: "claude-code" };
const grok = { name: "Grok", key: "grok" };

test("an agent's own title, without its status glyph", () => {
  assert.equal(agentTitle("✳ Rollout flags removal", claude), "Rollout flags removal");
  assert.equal(agentTitle("Paper design p-2-0 logo variations", claude), "Paper design p-2-0 logo variations");
});

test("a title wrapped in spinner, status and program name", () => {
  assert.equal(agentTitle("⠹ - Waiting for response… - Generate and attach logo variation image… - grok", grok), "Generate and attach logo variation image…");
});

test("titles that tell nothing", () => {
  assert.equal(agentTitle("", claude), "");
  assert.equal(agentTitle("✳ Claude Code", claude), "");
  assert.equal(agentTitle("grok", grok), "");
  assert.equal(agentTitle("~/Documents/Coding", claude), "");
  assert.equal(agentTitle("raphael@mac: ~", claude), "");
});
