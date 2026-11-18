// node --experimental-vm-modules --test mods-disabled/jira/sign-in.test.js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const ok = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" });
const tick = () => new Promise((resolve) => setImmediate(resolve));

async function board() {
  const waits = [], refresh = [], notices = [], overlays = [];
  const host = {
    hc: async (args) => {
      if (args[0] === "run") return ok({ address: "t7" });
      assert.deepEqual(Array.from(args), ["wait", "t7", "--json", "--timeout", "20"]);
      return new Promise((resolve) => waits.push(resolve));
    },
    notify: (notice) => notices.push(notice), openOverlay: (o) => overlays.push(o),
    checking() {}, closeOverlay() {}, exec() {}, focused() {}, nextCommand() {}, panes() {}, props() {}, run() {}, setShared() {}, spaces() {}, theme() {},
  };
  const modules = { herdr: host, "gpui-kit": { View: class {}, div() {}, svg() {} },
    "gpui-base": { v_flex() {}, h_flex() {}, ScrollHandle: {}, VirtualListScrollHandle: {}, v_virtual_list() {}, Scrollbar: {}, InputState: {}, Input: {}, TextView: {}, Popup: {} },
    "./acli.js": {} };
  const context = vm.createContext({});
  const mod = new vm.SourceTextModule(await readFile(new URL("./main.js", import.meta.url), "utf8"), { context });
  await mod.link((name) => {
    const stub = modules[name];
    return new vm.SyntheticModule(Object.keys(stub), function () {
      for (const [key, value] of Object.entries(stub)) this.setExport(key, value);
    }, { context });
  });
  await mod.evaluate();
  const view = new mod.namespace.default();
  view.counts = {};
  view.chooseProject = () => {};
  const read = (key, value) => async ({ force }) => { refresh.push([key, force]); return value; };
  view.source = { SIGN_IN: "fixture", me: read("me", {}), projects: read("projects", []), openMine: read("counts", {}) };
  let job;
  const cx = { notify() {}, spawn(fn) { job = fn(cx); } };
  view.signIn(cx);
  await tick();
  return { view, waits, refresh, notices, overlays, job };
}

test("Jira waits through a timeout and a message, then reloads the account and projects after exit", async () => {
  const b = await board();
  assert.equal(b.overlays[0].layout.content.terminal, "t7");
  for (const reason of ["timeout", "message"]) {
    b.waits.shift()(ok({ reason, ended: false }));
    await tick();
    assert.equal(b.view.signingIn, true);
    assert.equal(b.refresh.length, 0);
  }
  b.waits.shift()(ok({ reason: "exit", ended: true, exit_code: 0 }));
  await b.job;
  assert.equal(b.view.signingIn, false);
  assert.deepEqual(b.refresh, [["counts", true], ["me", true], ["projects", true]]);
  assert.equal(b.notices.length, 0);
});

test("Jira refreshes when its own auto-removed sign-in terminal has already exited", async () => {
  const b = await board();
  b.waits.shift()({ code: 3, stderr: '{"error":{"kind":"not_found"}}', stdout: "" });
  await b.job;
  assert.equal(b.refresh.length, 3);
  assert.equal(b.notices.length, 0);
});

test("a failed core wait leaves the sign-in action available and reports the failure", async () => {
  const b = await board();
  b.waits.shift()({ code: 1, stderr: "connection refused", stdout: "" });
  await b.job;
  assert.equal(b.view.signingIn, false);
  assert.equal(b.refresh.length, 0);
  assert.match(b.notices[0].body, /connection refused/);
});
