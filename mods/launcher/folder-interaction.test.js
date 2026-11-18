// node --experimental-vm-modules --test mods/launcher/folder-interaction.test.js
// Host-state regression tests; native input dispatch is checked in the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function harness(extra = {}) {
  const context = vm.createContext({ console });
  const jobs = [], requests = [], commands = [], bindings = [];
  let checking = true, app, active;
  const cx = {
    notify() {}, stop_propagation() {}, bind_keys(items) { bindings.push(...items); },
    focus_handle: () => ({ focus() { if (active) active.events.blur?.({}, cx); active = null; } }),
    spawn(fn) { const task = Promise.resolve().then(() => fn(cx)); jobs.push(task); },
    sleep: async () => {},
  };
  const input = { new: ({ value = "" } = {}) => ({
    events: {}, value: () => value, set_value(next) { value = next; }, set_selected_range() {},
    set_auto_grow() {}, on(event, fn) { this.events[event] = fn; },
    focus() { if (active !== this) { active?.events.blur?.({}, cx); active = this; this.events.focus?.({}, cx); } },
  }) };
  const host = {
    checking: () => checking, focused: () => ({ cwd: "/repo", space: "space" }),
    spaces: () => [{ id: "space", machine: "remote" }], panes: () => [],
    appHome: () => "/config", home: () => "/home/test", shared: () => null, props: () => ({ overlay: "launcher", ...extra }),
    exec: (command, args, options) => new Promise(resolve => requests.push({ command, args, options, resolve })),
    closeOverlay: id => commands.push(["close", id]), run: (...args) => commands.push(args),
    knownAgents() {}, notify() {}, openOverlay() {}, pickFolder() {}, readTextFile() {}, setShared() {}, theme() {}, writeTextFile() {},
  };
  const modules = {
    "gpui-kit": { View: class {}, div() {}, svg() {}, image() {} },
    "gpui-base": { v_flex() {}, h_flex() {}, InputState: input, TextareaState: input, Input: {}, Textarea: {}, Popup: {}, ScrollHandle: { new: () => ({ scroll_to_item() {} }) } },
    "herdr": host, "fs/promises": { exists: async () => false },
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
  app = new main.namespace.default(); app.init({}, cx);
  app.cfg = { program: "terminal", programs: {}, worktree: {} };
  checking = false;
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const type = async value => { app.folder.set_value(value); app.folder.events.change({}, cx); await tick(); };
  const key = key => app.key({ key, modifiers: {} }, cx);
  const reply = async (request, stdout) => { request.resolve({ code: 0, stdout, stderr: "" }); await tick(); };
  app.folder.focus(); await tick();
  return { app, requests, commands, bindings, type, key, reply, tick, flush: () => Promise.all(jobs) };
}

test("a late directory result cannot replace newer text or reopen dismissed suggestions", async () => {
  const h = await harness();
  await h.type("do"); const older = h.requests.at(-1);
  await h.type("src/"); const newest = h.requests.at(-1);
  await h.reply(newest, "components\0");
  await h.reply(older, "documents\0");
  assert.equal(h.app.folderMatches[0].value, "src/components/");
  await h.type("lib/"); const dismissed = h.requests.at(-1);
  h.key("escape");
  await h.reply(dismissed, "internal\0");
  assert.equal(h.app.folderOpen, false);
  assert.equal(h.app.folderFocused, true);
  assert.equal(h.app.folderMatches.length, 0);
  assert.equal(h.commands.length, 0);
  await h.reply(h.requests[0], "repo\0"); await h.flush();
});

test("arrows and Tab complete a path without cycling the program or launching it", async () => {
  const h = await harness();
  await h.type("s"); await h.reply(h.requests.at(-1), "scripts\0src\0");
  h.key("down"); h.key("tab"); await h.tick();
  assert.equal(h.app.folder.value(), "src/");
  assert.equal(h.app.current().key, "terminal");
  assert.equal(h.commands.length, 0);
  assert.equal(h.requests.at(-1).options.cwd, "/repo");
  assert.equal(h.requests.at(-1).options.on, "remote");
  await h.reply(h.requests.at(-1), "components\0");
  h.key("escape"); assert.equal(h.app.folderFocused, true);
  h.key("escape"); assert.equal(h.app.folderFocused, false);
  h.key("escape"); assert.equal(h.commands[0][0], "close");
  assert.ok(h.bindings.some(binding => binding.keystroke === "tab" && binding.context === "LauncherFolder"));
  await h.reply(h.requests[0], "repo\0"); await h.flush();
});

test("a split starts in its edited folder, and in the tab's folder when untouched", async () => {
  const h = await harness({ place: "right" });
  h.app.folder.set_value("~/other");
  h.app.start({ ...{ notify() {}, stop_propagation() {}, sleep: async () => {} }, spawn: fn => fn({ notify() {} }) });
  await h.tick();
  const resolve = h.requests.find(r => r.args?.[3] === "~/other");
  assert.ok(resolve, "the folder typed is resolved first");
  await h.reply(resolve, "/home/test/other\n");
  const split = h.commands.find(c => c[0] === "pane.split");
  assert.equal(split[1].direction, "right");
  assert.equal(split[1].argv.slice(0, 2).join(" "), "sh -c");
  assert.equal(split[1].argv[4], "/home/test/other");

  const plain = await harness({ place: "down" });
  plain.app.start({ notify() {}, stop_propagation() {}, spawn() { throw new Error("nothing to look up"); } });
  const direct = plain.commands.find(c => c[0] === "pane.split");
  assert.equal(direct[1].direction, "down");
  assert.equal(direct[1].argv, undefined);
});
