// node --experimental-vm-modules --test mods/agent-fork/session.test.js
// Host calls are isolated: no real agent is launched or messaged by these tests.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

const catalog = [
  { key: "codex", name: "Codex", run: ["codex", "--no-daemon"], installed: true },
  { key: "claude", name: "Claude Code", run: ["claude"], installed: true },
  { key: "pi", name: "Pi", run: ["pi"], installed: true },
];
const id = "12345678-1234-1234-1234-123456789abc";
const ok = (value) => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
const clone = (value) => JSON.parse(JSON.stringify(value));

async function harness({ key = "codex", on = null, status = "idle", exec: override, sourceKey, entries = catalog } = {}) {
  const prefix = on ? on + "/" : "";
  const pane = { pane: prefix + "p1", terminal: prefix + "t1", tab: prefix + "tab1", cwd: "/work",
    program: { key, name: key, agent: true } };
  const terminal = { state: "live", status: { app: key, state: status },
    foreground: { name: key, argv: [key], pid: 100, cwd: "/work" } };
  const calls = [], state = { pane, terminal, shared: {}, files: {}, props: {} };
  const host = {
    appHome: () => "/app home", home: () => "/home/me",
    panes: () => state.pane ? [state.pane] : [],
    spaces: () => [{ id: "space1", machine: on, tabs: [{ id: pane.tab }] }],
    knownAgents: async () => entries,
    readTextFile: async (path, options) => { calls.push({ read: path, options }); return state.files[path] ?? null; },
    exec: async (command, args, options) => {
      const call = { command, args: clone(args), options: clone(options) };
      calls.push(call);
      const overridden = await override?.(call);
      if (overridden) return overridden;
      if (command === "hc" && args[0] === "get") return ok(state.terminal);
      if (command === "hc" && args[0] === "send") return ok({ turn: 1, started: true });
      if (command === "env") return ok({ pane: prefix + "p2", terminal: prefix + "t2" });
      if (command === "lsof") return ok("/sessions/rollout-2026-11-16-" + id + ".jsonl");
      if (command === "sh") return ok("/home/remote");
      if (command === "claude") return ok("backgrounded · copy123");
      throw new Error("Unexpected command " + command);
    },
    checking: () => true, focused: () => ({ pane: "other-pane", space: "other-space" }),
    props: () => state.props, shared: (key) => state.shared[key],
    closeOverlay: (id) => calls.push({ close: id }),
    openOverlay: (value) => calls.push({ open: clone(value) }),
    run: (command, args) => calls.push({ run: command, args: clone(args) }),
    notify: (value) => calls.push({ notify: value }),
    setShared() {}, writeTextFile() {}, pickFolder() {}, theme: () => ({}),
  };
  const context = vm.createContext({});
  const stubs = {
    herdr: host,
    "gpui-kit": { View: class {}, div() {}, svg() {}, image() {} },
    "gpui-base": { v_flex() {}, h_flex() {}, InputState: {}, Input: {}, TextareaState: {}, Textarea: {}, ScrollHandle: {} },
  };
  async function load(path) {
    const mod = new vm.SourceTextModule(await readFile(new URL(path, import.meta.url), "utf8"), { context });
    await mod.link((specifier) => {
      const stub = stubs[specifier];
      return new vm.SyntheticModule(Object.keys(stub), function () {
        for (const [key, value] of Object.entries(stub)) this.setExport(key, value);
      }, { context });
    });
    await mod.evaluate();
    return mod.namespace;
  }
  const session = await load("./session.js");
  const reference = { pane: pane.pane, terminal: pane.terminal, key: sourceKey ?? key };
  const source = () => session.inspect(reference);
  const target = (key, extra = {}) => {
    const agent = entries.find((a) => a.key === key);
    return { ...agent, argv: [...agent.run], ...extra };
  };
  return { session, state, calls, source, target, load };
}

test("detects actual executable aliases without matching titles or prompt text", async () => {
  const { session } = await harness();
  assert.equal(session.detectAgent({}, { foreground: { argv: ["/bin/codex.exe"] } }, catalog).key, "codex");
  assert.equal(session.detectAgent({}, { foreground: { argv: ["zsh", "codex"], name: "zsh" }, title: "claude" }, catalog), null);
  assert.equal(session.detectAgent({}, { status: { app: "new-cli" } }, catalog).key, "new-cli");
});

test("rejects a source replaced or changed while the picker was open", async () => {
  const h = await harness();
  h.state.pane.terminal = "t99";
  await assert.rejects(h.source(), /no longer available/);
  h.state.pane.terminal = "t1";
  h.state.terminal.foreground = { name: "claude", argv: ["claude"] };
  await assert.rejects(h.source(), /source agent changed/);
  h.state.terminal.state = "finished";
  await assert.rejects(h.source(), /finished/);
  assert.equal(h.calls.some((c) => c.command === "env"), false);
});

test("same Codex uses the exact session, chosen options, prompt and no daemon", async () => {
  const h = await harness();
  const result = await h.session.start(await h.source(), h.target("codex", {
    argv: ["codex", "-m", "chosen-model", "-c", 'model_reasoning_effort="high"'], task: "Investigate the other approach"
  }));
  const split = JSON.parse(h.calls.find((c) => c.command === "env").args[4]);
  assert.equal(split.pane, "p1");
  assert.deepEqual(split.argv, ["codex", "-m", "chosen-model", "-c", 'model_reasoning_effort="high"', "--no-daemon", "fork", id, "Investigate the other approach"]);
  assert.equal(result.guessed, false);
  assert.equal(h.calls.some((c) => c.command === "hc" && c.args[0] === "send"), false);
});

test("missing session identity preserves the explicit latest-session warning", async () => {
  const h = await harness({ exec: (c) => c.command === "lsof" ? ok("") : null });
  const result = await h.session.start(await h.source(), h.target("codex"));
  assert.equal(result.guessed, true);
  assert.ok(JSON.parse(h.calls.find((c) => c.command === "env").args[4]).argv.includes("--last"));
});

test("Claude copies then attaches with chosen model and effort", async () => {
  const h = await harness({ key: "claude" });
  h.state.files["/home/me/.claude/sessions/100.json"] = JSON.stringify({ sessionId: "session1", cwd: "/source folder" });
  await h.session.start(await h.source(), h.target("claude", { argv: ["claude", "--model", "chosen", "--effort", "high"] }));
  const bg = h.calls.find((c) => c.command === "claude");
  assert.deepEqual(bg.args, ["--model", "chosen", "--effort", "high", "--bg", "--resume", "session1"]);
  assert.equal(bg.options.cwd, "/source folder");
  assert.deepEqual(JSON.parse(h.calls.find((c) => c.command === "env").args[4]).argv, ["claude", "attach", "copy123"]);
});

test("another CLI opens blank, then requests context via native hc send to the source", async () => {
  const h = await harness({ status: "working" });
  h.state.pane.title = "Herdr Fork work";
  const result = await h.session.start(await h.source(), h.target("pi", { argv: ["pi", "--model", "chosen"], task: "Focus on the UI" }));
  const commands = h.calls.filter((c) => c.command);
  const launchAt = commands.findIndex((c) => c.command === "env");
  const sendAt = commands.findIndex((c) => c.command === "hc" && c.args[0] === "send");
  assert.ok(sendAt > launchAt);
  assert.deepEqual(JSON.parse(commands[launchAt].args[4]).argv, ["pi", "--model", "chosen"]);
  assert.equal(commands[sendAt].args[1], "t1");
  assert.match(commands[sendAt].args[2], /hc send 't2'/);
  assert.match(commands[sendAt].args[2], /hc wait 't2'/);
  assert.match(commands[sendAt].args[2], /Focus on the UI/);
  assert.ok(commands[sendAt].args[2].includes('<herdr-message from="t1" name="Herdr Fork work" agent="Codex">\nSUMMARY\n</herdr-message>'));
  assert.ok(commands[sendAt].args[2].includes(`hc send t1 '<herdr-message from="t2">your reply</herdr-message>'`));
  assert.equal(commands[sendAt].args.includes("--force"), false);
  assert.equal(commands.some((c) => c.args[0] === "read" || c.args[0] === "keys"), false);
  assert.equal(result.handover, true);
});

test("remote handover uses app addresses for commands and local addresses in the source's instructions", async () => {
  const h = await harness({ key: "claude", on: "work-server" });
  await h.session.start(await h.source(), h.target("codex", { argv: ["codex"] }));
  const split = JSON.parse(h.calls.find((c) => c.command === "env").args[4]);
  assert.equal(split.pane, "work-server/p1");
  assert.ok(split.argv.includes("--no-daemon"));
  const send = h.calls.find((c) => c.command === "hc" && c.args[0] === "send");
  assert.equal(send.args[1], "work-server/t1");
  assert.match(send.args[2], /hc send 't2'/);
  assert.ok(send.args[2].includes('<herdr-message from="t1" name="Claude Code" agent="Claude Code">\nSUMMARY\n</herdr-message>'));
  assert.ok(send.args[2].includes(`hc send t1 '<herdr-message from="t2">your reply</herdr-message>'`));
  assert.doesNotMatch(send.args[2], /work-server\//);
});

test("unsupported native fork and blocked source create no new terminal", async () => {
  const unsupported = await harness({ key: "pi" });
  await assert.rejects(unsupported.session.start(await unsupported.source(), unsupported.target("pi")), /No native fork recipe/);
  assert.equal(unsupported.calls.some((c) => c.command === "env"), false);
  const blocked = await harness({ status: "blocked" });
  await assert.rejects(blocked.session.start(await blocked.source(), blocked.target("claude")), /needs attention/);
  assert.equal(blocked.calls.some((c) => c.command === "env"), false);
});

test("launch failure sends nothing; send failure reports the created receiver without retrying", async () => {
  const fail = { code: 1, stdout: "", stderr: '{"error":{"message":"test failure"}}' };
  const launch = await harness({ exec: (c) => c.command === "env" ? fail : null });
  await assert.rejects(launch.session.start(await launch.source(), launch.target("claude")), /test failure/);
  assert.equal(launch.calls.some((c) => c.command === "hc" && c.args[0] === "send"), false);
  const send = await harness({ exec: (c) => c.command === "hc" && c.args[0] === "send" ? fail : null });
  await assert.rejects(send.session.start(await send.source(), send.target("claude")), /open in t2.*not confirmed/);
  assert.equal(send.calls.filter((c) => c.command === "hc" && c.args[0] === "send").length, 1);
});

async function launcher(h, fork = { pane: "p1", terminal: "t1", key: "codex", name: "Codex", canFork: true }) {
  const { default: Launcher } = await h.load("../launcher/main.js");
  return Object.assign(new Launcher(), {
    fork, agents: catalog, picked: fork?.key, search: null, cfg: { program: "terminal", programs: {} },
    on: null, files: [], message: { value: () => "Next direction" }, catalog: {}, own: {}, pane: "p1",
  });
}
const cx = { notify() {} };

test("fork reuses the shortlist, omits shells, defaults to source, and forwards the chosen agent", async () => {
  const h = await harness(), ui = await launcher(h);
  h.state.shared["agents.shortlist"] = ["codex", "pi"];
  assert.deepEqual(clone(ui.programs().map((a) => a.key)), ["codex", "pi"]);
  assert.equal(ui.current().key, "codex");
  h.state.shared["agents.shortlist"] = ["not-installed"];
  assert.equal(ui.programs().length, 3);
  ui.pick("pi", cx);
  ui.start(cx);
  const opened = h.calls.find((c) => c.open).open;
  assert.equal(opened.mod, "agent-fork");
  assert.equal(opened.props.source.terminal, "t1");
  assert.equal(opened.props.target.key, "pi");
  assert.equal(opened.props.target.task, "Next direction");
  assert.equal(h.calls.some((c) => c.run), false);
});

test("unsupported fork stays in picker; cancelling and ordinary launcher keep their behavior", async () => {
  const h = await harness(), ui = await launcher(h, { pane: "p1", terminal: "t1", key: "pi", name: "Pi", canFork: false });
  ui.start(cx);
  assert.match(ui.error, /No native fork recipe/);
  assert.equal(h.calls.some((c) => c.open), false);
  ui.close();
  assert.equal(h.calls.some((c) => c.run || c.command), false);
  const regular = await launcher(h, null);
  h.state.props = { place: "right" };
  assert.equal(regular.programs()[0].terminal, true);
  regular.start(cx);
  assert.equal(h.calls.find((c) => c.run).run, "pane.split");
});
