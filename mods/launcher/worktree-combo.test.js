// node --experimental-vm-modules --test mods/launcher/worktree-combo.test.js
// Host-state tests of the worktree combo box; drawing and native input are checked in the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function harness(place) {
  const context = vm.createContext({ console, Date });
  const requests = [], commands = [];
  let active;
  const cx = {
    notify() {}, stop_propagation() {}, bind_keys() {},
    focus_handle: () => ({ focus() { if (active) active.events.blur?.({}, cx); active = null; } }),
    spawn(fn) { Promise.resolve().then(() => fn(cx)); },
    sleep: async () => {},
  };
  const input = { new: ({ value = "" } = {}) => ({
    events: {}, value: () => value, set_value(next) { value = next; }, set_selected_range() {},
    set_auto_grow() {}, on(event, fn) { this.events[event] = fn; },
    focus() { if (active !== this) { active?.events.blur?.({}, cx); active = this; this.events.focus?.({}, cx); } },
  }) };
  const host = {
    checking: () => true, focused: () => ({ cwd: "/repo", space: "space" }),
    spaces: () => [{ id: "space", machine: "remote", tabs: [] }], panes: () => [],
    appHome: () => "/config", home: () => "/home/test", props: () => ({ overlay: "launcher", place }),
    shared: key => (key === "worktrunk.enabled" ? true : null),
    exec: (command, args, options) => new Promise(resolve => requests.push({ command, args, options, resolve })),
    closeOverlay: id => commands.push(["close", id]), run: (...args) => commands.push(args),
    knownAgents() {}, notify() {}, openOverlay() {}, pickFolder() {}, readTextFile() {}, setShared() {}, theme() {}, writeTextFile() {},
  };
  const modules = {
    "gpui-kit": { View: class {}, div() {}, svg() {}, image() {} },
    "gpui-base": { v_flex() {}, h_flex() {}, InputState: input, TextareaState: input, Input: {}, Textarea: {}, Popup: {}, ScrollHandle: { new: () => ({ scroll_to_item() {} }) } },
    "herdr": host, "fs/promises": { exists: async () => true },
  };
  const main = new vm.SourceTextModule(await readFile(new URL("./main.js", import.meta.url), "utf8"), { context });
  await main.link(async name => {
    if (name === "./folders.js") return new vm.SourceTextModule(await readFile(new URL(name, import.meta.url), "utf8"), { context });
    const exports = modules[name];
    assert.ok(exports, `Unexpected dependency ${name}`);
    return new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await main.evaluate();
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const open = async () => {
    const app = new main.namespace.default(); app.init({}, cx);
    app.cfg = { program: "terminal", programs: {}, worktree: { base: "default", open: "tab" } };
    app.worktrunkReady = true;
    app.toggleWorktree(cx); await tick();
    return app;
  };
  const type = async (app, value) => { app.input.set_value(value); app.input.events.change({}, cx); await tick(); };
  // The read of the list (sh), answered; the default-branch read (wt) alongside it.
  const answer = async (reply, from = 0) => {
    for (const r of requests.slice(from)) {
      if (r.command === "wt" && r.args[0] === "switch") continue;
      if (r.command === "wt") r.resolve({ code: 0, stdout: "main\n", stderr: "" });
      else if (r.command === "sh" && r.args[1].includes("wt list")) r.resolve(reply);
    }
    await tick(); await tick();
  };
  return { cx, requests, commands, open, type, answer, tick };
}

// Values made inside the mod's VM context, as this context's own for deepEqual.
const plain = value => JSON.parse(JSON.stringify(value));
const LISTED = JSON.stringify([["main", "/repo", true, true], ["feat", "/wt/feat", false, false], ["feat-2", null, false, false]]);

test("the list is read once the combo box is wanted, narrowed by typing, and an exact branch comes first", async () => {
  const h = await harness();
  const app = await h.open();
  assert.equal(app.list, undefined);
  assert.equal(app.combo, true);
  assert.equal(app.opts[0].generated, true); // a new branch can start before the list lands
  await h.answer({ code: 0, stdout: LISTED, stderr: "" });
  assert.deepEqual(plain(app.list.map(w => w.branch)), ["main", "feat", "feat-2"]);
  assert.equal(app.reading, false);
  assert.equal(app.defaultBranch, "main");
  await h.type(app, "feat-2");
  assert.deepEqual(plain(app.opts.map(w => w.branch)), ["feat-2"]);
  await h.type(app, "fea");
  assert.deepEqual(plain(app.opts.map(w => [w.branch, Boolean(w.typed)])), [["fea", true], ["feat", false], ["feat-2", false]]);
  await h.type(app, "feat");
  assert.deepEqual(plain(app.opts.map(w => w.branch)), ["feat", "feat-2"]);
});

test("a click puts the branch in the field and closes the popup without starting; Escape closes the popup first", async () => {
  const h = await harness();
  const app = await h.open();
  await h.answer({ code: 0, stdout: LISTED, stderr: "" });
  await h.type(app, "fea");
  app.choose(2, h.cx); await h.tick();
  assert.equal(app.input.value(), "feat-2");
  assert.equal(app.combo, false);
  assert.equal(app.opts[app.at].branch, "feat-2");
  assert.equal(h.commands.length, 0);
  app.move("down", h.cx);
  assert.equal(app.combo, true);
  app.key({ key: "escape", modifiers: {} }, h.cx);
  assert.equal(app.combo, false);
  assert.equal(app.inputFocused, true);
  assert.equal(app.input.value(), "feat-2");
  assert.equal(h.commands.length, 0);
});

test("a kept read is shown at once the next time, and read again only past its age", async () => {
  const h = await harness();
  const first = await h.open();
  await h.answer({ code: 0, stdout: LISTED, stderr: "" });
  assert.equal(first.list.length, 3);
  const from = h.requests.length;
  const again = await h.open();
  assert.equal(again.list.length, 3); // kept: shown with no read
  assert.equal(again.reading, false);
  assert.equal(h.requests.length, from);
  // Past its age it is still shown at once, and a fresh read replaces it.
  const now = Date.now;
  Date.now = () => now() + 60_000;
  try {
    const later = await h.open();
    assert.equal(later.list.length, 3);
    assert.equal(later.reading, true);
    await h.answer({ code: 0, stdout: JSON.stringify([["main", "/repo", true, true]]), stderr: "" }, from);
    assert.deepEqual(plain(later.list.map(w => w.branch)), ["main"]);
    assert.equal(later.reading, false);
  } finally { Date.now = now; }
});

test("a folder in no repository says so and offers repositories instead of a branch", async () => {
  const h = await harness();
  const app = await h.open();
  await h.type(app, "post for me integration");
  await h.answer({ code: 1, stdout: "", stderr: "fatal: not a git repository (or any of the parent directories): .git" });
  assert.equal(app.list, null);
  assert.equal(app.listError, "No Git repository at /repo.");
  assert.deepEqual(plain(app.repos), []);
  assert.equal(app.opts.length, 0);
  app.start(h.cx); await h.tick();
  assert.equal(app.error, "No Git repository at /repo.");
  assert.equal(h.commands.length, 0);
  assert.equal(app.input.value(), "post for me integration");
});

test("a split takes a worktree too: a plain terminal is started in the one chosen", async () => {
  const h = await harness("right");
  const app = await h.open();
  assert.equal(app.wt, true);
  await h.answer({ code: 0, stdout: LISTED, stderr: "" });
  await h.type(app, "feat");
  app.start(h.cx); await h.tick(); await h.tick();
  const made = h.requests.find(r => r.command === "wt" && r.args[0] === "switch");
  assert.deepEqual(plain(made.args), ["switch", "--no-cd", "--format", "json", "feat"]);
  made.resolve({ code: 0, stdout: JSON.stringify({ path: "/wt/feat", branch: "feat" }), stderr: "" });
  await h.tick(); await h.tick();
  const split = h.commands.find(c => c[0] === "pane.split");
  assert.equal(split[1].direction, "right");
  assert.deepEqual(plain(split[1].argv.slice(0, 2).concat(split[1].argv.slice(3))), ["sh", "-c", "sh", "/wt/feat"]);
  assert.ok(h.commands.some(c => c[0] === "close"));
});
