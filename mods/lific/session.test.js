// node --experimental-vm-modules --test mods/lific/session.test.js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const boot = 'exec "${SHELL:-/bin/zsh}" -lic "$1"';
const ok = (data) => ({ code: 0, stdout: typeof data === "string" ? data : JSON.stringify(data), stderr: "" });
const turn = (status = "idle", number = 1) => ({ reason: "status", ended: true, turn: number, status });
const receipt = (wait) => ({ started: true, turn: 0, wait });
const terminal = (address) => ({ address, state: "live", keep: false, pid: 81,
  labels: { "lific.session": "1", "lific.agent": "claude", "lific.pid": "81" },
  argv: ["sh", "-c", boot, "sh", "claude"], status: { app: "claude-code", state: "idle" }, foreground: { argv: ["claude"] } });

async function harness() {
  const state = { all: [terminal("t1")], panes: [], shared: {}, calls: [], actions: [], waits: [], screen: "" };
  const host = {
    home: () => "/test", spaces: () => [{ id: "remote/work", machine: "remote", active: true }, { id: "work" }],
    terminals: () => state.all, panes: () => state.panes, shared: (k) => state.shared[k],
    setShared: (k, v) => { state.shared[k] = v; }, run: (...args) => state.actions.push(structuredClone(args)),
    closeOverlay: (id) => state.actions.push(["close", id]), props: () => ({ overlay: "board" }),
    checking() {}, focused() {}, nextCommand() {}, notify() {}, theme() {},
    exec: async (program, args) => {
      state.calls.push([program, ...args]);
      if (program === "mkdir") return ok("");
      assert.equal(program, "hc");
      switch (args[0]) {
        case "get": return ok(state.all.find(t => t.address === args[1]) ?? null);
        case "keep": state.all[0].keep = false; state.onKeep?.(); return ok({});
        case "run": return ok({ address: "t1" });
        case "label": return ok({});
        case "wait": assert.ok(state.waits.length); return ok(state.waits.shift());
        case "send": return state.reply ?? ok(receipt(turn()));
        case "read": return ok(state.screen);
        default: throw new Error("Unexpected hc " + args[0]);
      }
    },
  };
  const stubs = { herdr: host, "gpui-kit": { View: class {}, div() {}, svg() {} },
    "gpui-base": { v_flex() {}, h_flex() {}, ScrollHandle: {}, Scrollbar: {}, InputState: {}, Input: {}, TextareaState: {}, Textarea: {}, TextView: {} },
    "./icons.js": { icon() {}, lucideSvg() {} } };
  const context = vm.createContext({});
  async function load(file) {
    const module = new vm.SourceTextModule(await readFile(new URL(file, import.meta.url), "utf8"), { context });
    await module.link((name) => {
      const stub = stubs[name];
      return new vm.SyntheticModule(Object.keys(stub), function () {
        for (const [key, value] of Object.entries(stub)) this.setExport(key, value);
      }, { context });
    });
    await module.evaluate();
    return module.namespace;
  }
  const session = await load("./session.js");
  stubs["./session.js"] = session;
  return { state, session, board: async () => new (await load("./main.js")).default() };
}

test("a new local session has its own tab and is selectable before a trust prompt", async () => {
  const { session, state } = await harness();
  assert.equal(await session.start({ agent: "claude", command: "claude" }), "t1");
  const launch = state.calls.find((c) => c[1] === "run");
  assert.ok(!launch.includes("--keep"));
  assert.deepEqual(state.calls.find((c) => c[1] === "label"), ["hc", "label", "t1", "lific.pid=81", "herdr.space=work", "herdr.tab=lific-t1", "--json"]);
  assert.equal(session.current().address, "t1");
  state.waits.push(turn("blocked", 0));
  await assert.rejects(session.ready("t1"), /trust prompt/);
  session.show("t1");
  state.panes.push({ terminal: "t1", pane: "p1" });
  session.show("t1");
  assert.deepEqual(state.actions, [["terminal.peek", { terminal: "t1" }], ["pane.focus", { pane: "p1" }]]);
});

test("T selects a live terminal or a new session on the next request; t opens the selection", async () => {
  const { session, state, board } = await harness();
  state.all.push(terminal("t2"));
  const view = await board();
  Object.assign(view, { size: { height: 480 }, handle: { focus() {} }, sessionScroll: { scroll_to_item() {} } });
  const cx = { stop_propagation() {}, notify() {} };
  const key = (key, shift = false) => view.keys({ key, modifiers: { shift } }, cx);
  key("t", true); key("j"); key("enter");
  assert.equal(session.current().address, "t2");
  key("t");
  assert.deepEqual(state.actions, [["close", "board"], ["terminal.peek", { terminal: "t2" }]]);
  key("t", true); key("g", true); key("enter");
  assert.equal(session.current(), null);
  assert.equal(state.shared["lific.session"], "new");
  key("t", true); key("k"); key("escape");
  assert.equal(session.current(), null);
});

test("delivery turns off recovery and rechecks the process before sending", async () => {
  const { state, session } = await harness();
  const t = state.all[0];
  t.keep = true;
  state.onKeep = () => { t.pid++; };
  await assert.rejects(session.ask("t1", "request", () => assert.fail()), { notSent: true });
  assert.deepEqual(state.calls.map((c) => c[1]), ["get", "keep", "get"]);
  assert.equal(session.sessions().length, 0);
});

test("the first request waits for Herdr to finish adopting a fast-starting agent", async () => {
  const { state, session } = await harness();
  state.all[0].labels["herdr.tab"] = "lific-t1";
  const cx = { async sleep() {
    assert.equal(state.calls.filter((c) => c[1] === "send").length, 0);
    state.all[0].keep = true;
    state.panes.push({ terminal: "t1", pane: "p1" });
  } };
  assert.equal(await session.ask("t1", "request", () => {}, cx), "done");
  assert.deepEqual(state.calls.map((c) => c[1]), ["get", "get", "keep", "get", "send"]);
});

test("recovered shells, different foreground agents and working agents receive no request", async () => {
  const { state, session } = await harness();
  for (const override of [
    { argv: ["/bin/zsh", "-l"] }, { pid: 99 }, { foreground: { argv: ["/bin/sh"] } },
    { status: null }, { status: { app: "codex", state: "idle" } }, { status: { app: "claude-code", state: "working" } },
  ]) {
    state.all = [{ ...terminal("t1"), ...override }];
    await assert.rejects(session.ask("t1", "request", () => assert.fail()), { notSent: true });
  }
  assert.ok(!state.calls.some((c) => c[1] === "send"));
});

test("a stale OpenCode recipe and its already-running terminal cannot supply personal tools", async () => {
  const { state, session } = await harness();
  const unsafe = 'OPENCODE_CONFIG_CONTENT=\'{}\' opencode';
  state.all = [{ ...terminal("t1"), argv: ["sh", "-c", boot, "sh", unsafe],
    labels: { "lific.session": "1" }, status: { app: "opencode", state: "idle" } }];
  assert.equal(session.current(), null);
  await assert.rejects(session.start({ agent: "opencode", command: unsafe }), /update the OpenCode recipe/);
  assert.equal(state.calls.length, 0);
});

test("one send survives check-ins and finishes only for its own turn", async () => {
  const { session, state } = await harness();
  state.reply = ok(receipt({ reason: "timeout", ended: false, turn: 0 }));
  state.waits.push({ reason: "message", ended: false, turn: 0 }, turn("done"));
  let sends = 0;
  assert.equal(await session.ask("t1", "request", () => sends++), "done");
  assert.equal(sends, 1);
  assert.deepEqual(state.calls.map((c) => c[1]), ["get", "send", "wait", "wait"]);
  assert.ok(state.calls[1].includes("--if"));
});

test("blocked, exited, uncertain and failed turns have distinct outcomes", async () => {
  const { session, state } = await harness();
  state.reply = ok(receipt(turn("blocked")));
  assert.equal(await session.ask("t1", "request", () => {}), "blocked");
  for (const [reply, error] of [
    [receipt({ reason: "exit", ended: true, exit_code: 0 }), /exited/],
    [receipt(turn("error")), /reported error/], [receipt(turn("idle", 2)), /confirm how/],
    [{ started: false, turn: 0 }, /Delivery was not confirmed/],
  ]) {
    state.reply = ok(reply);
    await assert.rejects(session.ask("t1", "request", () => {}), error);
  }
  state.reply = { code: 1, stderr: '{"error":{"kind":"status_mismatch","message":"busy"}}', stdout: "" };
  await assert.rejects(session.ask("t1", "request", () => {}), { notSent: true });
});

test("a read-only answer and old issue IDs cannot move the board", async () => {
  const { state, session } = await harness();
  const old = session.request("Update OLD-3", "OLD"), now = session.request("What is blocked?", "NEW");
  assert.notEqual(old.marker, now.marker);
  state.screen = old.marker + " OLD-3\n" + now.text + "\nNEW-2 is blocked.";
  assert.equal(await session.changedIssue("t1", now.marker), null);
  state.screen += "\n" + now.marker + " NEW-17\n";
  assert.equal(await session.changedIssue("t1", now.marker), "NEW-17");
});
