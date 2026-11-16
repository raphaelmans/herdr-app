// Run with: node --test mods/pull-requests/github.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, explain, mark, matches, blocks, readMemory, trimMemory, forAccount, emptyMemory, pullRequestsArgs, repositoriesArgs, PULL_REQUEST_LISTS } from "./github.js";

test("parse returns the value gh printed", () => {
  assert.deepEqual(parse({ code: 0, stdout: '["a","b"]\n', stderr: "" }), ["a", "b"]);
  assert.equal(parse({ code: 0, stdout: "", stderr: "" }), null);
});

test("parse throws what gh said last", () => {
  assert.throws(() => parse({ code: 1, stdout: "", stderr: "warning\ngh: Not Found (HTTP 404)\n" }), /Not Found \(HTTP 404\)/);
  assert.throws(() => parse({ code: 0, stdout: "not json", stderr: "" }), /not json/);
});

test("explain names a missing or signed-out gh", () => {
  assert.match(explain(new Error("sh: gh: command not found")), /isn't on this computer/);
  assert.match(explain(new Error("To get started with GitHub CLI, please run:  gh auth login")), /isn't signed in/);
  assert.equal(explain(new Error("HTTP 502")), "HTTP 502");
});

test("mark: merged and closed win over draft and review", () => {
  assert.equal(mark({ state: "MERGED", draft: true, review: "APPROVED" }), "merged");
  assert.equal(mark({ state: "CLOSED", review: "APPROVED" }), "closed");
  assert.equal(mark({ state: "OPEN", draft: true, review: "REVIEW_REQUIRED" }), "draft");
  assert.equal(mark({ state: "OPEN", review: "CHANGES_REQUESTED" }), "changes");
  assert.equal(mark({ state: "OPEN", review: "" }), "open");
});

test("matches needs every word", () => {
  assert.equal(matches("fix cache", "Fix the cache key"), true);
  assert.equal(matches("fix queue", "Fix the cache key"), false);
  assert.equal(matches("  ", "anything"), true);
});

test("blocks keeps a code fence whole", () => {
  assert.deepEqual(blocks("one\n\ntwo\n```\na\n\nb\n```\nthree"), ["one", "two\n```\na\n\nb\n```", "three"]);
});

test("the pull request query orders by update and names the states", () => {
  const args = pullRequestsArgs("acme", "site", "closed");
  const query = args.find((a) => a.startsWith("query="));
  assert.match(query, /states: \[CLOSED, MERGED\]/);
  assert.match(query, /UPDATED_AT/);
  assert.ok(args.includes("owner=acme") && args.includes("name=site"));
  assert.match(repositoriesArgs("a b")[1], /orgs\/a%20b\/repos/);
});

test("memory: unreadable text starts empty, lists are dropped oldest first", () => {
  assert.deepEqual(readMemory("{"), emptyMemory());
  const memory = emptyMemory();
  for (let n = 0; n < PULL_REQUEST_LISTS + 3; n++) memory.pullRequests[`k${n}`] = { at: n, items: [] };
  trimMemory(memory);
  assert.equal(Object.keys(memory.pullRequests).length, PULL_REQUEST_LISTS);
  assert.equal(memory.pullRequests.k0, undefined);
  assert.ok(memory.pullRequests[`k${PULL_REQUEST_LISTS + 2}`]);
});

test("memory: another account starts empty", () => {
  const memory = { ...emptyMemory(), account: "one", organizations: { at: 1, items: ["acme"] } };
  assert.equal(forAccount(memory, "one", 5).organizations.items[0], "acme");
  const next = forAccount(memory, "two", 6);
  assert.equal(next.account, "two");
  assert.equal(next.organizations, null);
  assert.equal(next.accountAt, 6);
});
