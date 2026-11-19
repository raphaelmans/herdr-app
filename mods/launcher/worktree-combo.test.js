// node --experimental-vm-modules --test mods/launcher/worktree-combo.test.js
// Host-state tests of the worktree combo box; drawing and native input are checked in the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function harness(place, extra = {}) {
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
    appHome: () => "/config", home: () => "/home/test", props: () => ({ overlay: "launcher", place, ...extra }),
    shared: key => (key === "worktrunk.enabled" ? true : null),
    exec: (command, args, options) => new Promise((resolve, reject) => requests.push({ command, args, options, resolve, reject })),
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

test("from a worktree, the main checkout is offered right under a new branch and opens a tab there", async () => {
  const h = await harness();
  const app = await h.open();
  // wt lists the worktree you are in first.
  await h.answer({ code: 0, stdout: JSON.stringify([["feat", "/wt/feat", false, true], ["main", "/repo", true, false], ["other", null, false, false]]), stderr: "" });
  assert.deepEqual(plain(app.opts.map(w => w.branch).slice(1)), ["main", "feat", "other"]);
  app.move("down", h.cx);
  assert.equal(app.opts[app.at].branch, "main");
  app.start(h.cx); await h.tick(); await h.tick();
  const made = h.requests.find(r => r.command === "wt" && r.args[0] === "switch");
  assert.deepEqual(plain(made.args), ["switch", "--no-cd", "--format", "json", "main"]);
  made.resolve({ code: 0, stdout: JSON.stringify({ action: "existing", path: "/repo", branch: "main" }), stderr: "" });
  await h.tick(); await h.tick();
  const tab = h.commands.find(c => c[0] === "tab.new");
  assert.equal(tab[1].folder, "/repo");
});

test("a universe worktree uses the launcher's starting folder and opens in the named space", async () => {
  const h = await harness("tab", { targetSpaceName: "universe", startingFolder: "~" });
  const app = await h.open();
  app.cfg.worktree.open = "space";
  assert.equal(app.canChooseWorktreeDestination(), false);
  const folder = h.requests.find(r => r.args[3] === "~");
  folder.resolve({ code: 0, stdout: "/home/test\n" });
  await h.tick();
  const list = h.requests.find(r => r.command === "sh" && r.args[1].includes("wt list"));
  assert.equal(list.options.cwd, "/home/test");
  await h.answer({ code: 0, stdout: LISTED, stderr: "" });
  await h.type(app, "feat");
  app.start(h.cx);
  await h.tick();
  const checkout = h.requests.find(r => r.command === "wt" && r.args[0] === "switch");
  checkout.resolve({ code: 0, stdout: JSON.stringify({ path: "/wt/feat", branch: "feat" }) });
  await h.tick();
  assert.deepEqual(plain(h.commands), [
    ["space.new", { machine: "remote", name: "universe", tab: "feat", folder: "/wt/feat" }],
    ["close", "launcher"],
  ]);
});

test("a folder that is gone says so, and a full path typed over it is read without it", async () => {
  const h = await harness();
  const app = await h.open();
  const spawnFailed = new Error("`herdr.exec`: cannot run sh: No such file or directory (os error 2)");
  for (const r of h.requests) r.reject(spawnFailed);
  await h.tick(); await h.tick();
  assert.equal(app.list, null);
  assert.equal(app.listError, "No folder at /repo. Set the folder above (⌃F).");
  const from = h.requests.length;
  app.folder.set_value("/elsewhere");
  const settling = app.settle(h.cx);
  await h.tick();
  const resolve = h.requests.slice(from).find(r => r.command === "sh");
  assert.equal(resolve.options.cwd, undefined); // not the folder that is gone
  resolve.resolve({ code: 0, stdout: "/elsewhere\n", stderr: "" });
  assert.equal(await settling, "/elsewhere");
  assert.equal(app.cwd, "/elsewhere");
});

test("a newer folder wins over a slow home lookup, including when the old lookup fails", async () => {
  for (const failed of [false, true]) {
    const h = await harness("tab", { startingFolder: "~" });
    const app = await h.open();
    const home = h.requests.find(r => r.args[3] === "~");
    app.folder.set_value("/other");
    const settling = app.settle(h.cx);
    h.requests.find(r => r.args[3] === "/other").resolve({ code: 0, stdout: "/other\n" });
    await settling;
    if (failed) home.reject(new Error("no longer connected"));
    else home.resolve({ code: 0, stdout: "/home/test\n" });
    await h.tick();
    const reads = h.requests.filter(r => r.command === "sh" && r.args[1].includes("wt list"));
    assert.deepEqual(reads.map(r => r.options.cwd), ["/other"]);
    assert.equal(app.cwd, "/other");
    assert.equal(app.error, "");
    app.folder.set_value("");
    assert.equal(await app.settle(h.cx), null);
    assert.equal(app.cwd, "/repo");
  }
});

test("confirming an edited folder shows its branches before starting a worktree", async () => {
  const h = await harness();
  const app = await h.open();
  await h.answer({ code: 0, stdout: LISTED, stderr: "" });
  app.move("down", h.cx);
  assert.equal(app.opts[app.at].branch, "main");
  app.folder.set_value("/other");
  app.start(h.cx);
  await h.tick();
  h.requests.find(r => r.args[3] === "/other").resolve({ code: 0, stdout: "/other\n" });
  await h.tick();
  assert.equal(app.cwd, "/other");
  assert.equal(app.busy, false);
  assert.equal(h.commands.length, 0);
  assert.equal(h.requests.some(r => r.command === "wt" && r.args[0] === "switch"), false);
  await h.answer({ code: 0, stdout: JSON.stringify([["trunk", "/other", true, true]]), stderr: "" });
  app.move("down", h.cx);
  app.start(h.cx);
  await h.tick();
  const checkout = h.requests.find(r => r.command === "wt" && r.args[0] === "switch");
  assert.equal(checkout.options.cwd, "/other");
  assert.equal(checkout.args.at(-1), "trunk");
});
