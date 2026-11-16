// node --experimental-vm-modules --test mods/config/worktrunk.test.js
// Exercise the real switch and its consumers in an isolated app home.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import vm from "node:vm";

const source = dirname(fileURLToPath(import.meta.url));
const repo = join(source, "../..");
const exists = async (path) => { try { await fs.access(path); return true; } catch { return false; } };
// The person may keep it on locally; fixtures always start from the off default.
const worktrunkSource = async () => join(repo, await exists(join(repo, "mods-disabled/worktrunk/mod.json")) ? "mods-disabled/worktrunk" : "mods/worktrunk");

function element() {
  const node = { nodes: [], attrs: {}, events: {} };
  let proxy;
  proxy = new Proxy(node, { get(target, key) {
    if (key === "when") return (on, fn) => on ? fn(proxy) : proxy;
    if (key === "child") return (child) => { node.nodes.push(child); return proxy; };
    if (key === "children") return (children) => { node.nodes.push(...children); return proxy; };
    if (String(key).startsWith("on_")) return (...args) => { node.events[key] = args.at(-1); return proxy; };
    if (key in target) return target[key];
    return (...args) => { node.attrs[key] = args; return proxy; };
  } });
  return proxy;
}
const flat = (node) => node && typeof node === "object" ? [node, ...node.nodes.flatMap(flat)] : [node];
const textOf = (node) => flat(node).filter((n) => typeof n === "string").join(" ");
const hasId = (node, id) => flat(node).some((n) => n?.attrs?.id?.[0] === id);
const input = { new: ({ value = "" } = {}) => ({ on() {}, value: () => value, set_value(v) { value = v; }, focus() {}, set_auto_grow() {} }) };

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "herdr-worktrunk-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(join(root, "mods/config"), { recursive: true });
  await fs.mkdir(join(root, "layouts"));
  await fs.mkdir(join(root, "mods-disabled/worktrunk"), { recursive: true });
  const worktrunk = await worktrunkSource();
  for (const file of ["main.js", "mod.json"]) await fs.copyFile(join(worktrunk, file), join(root, "mods-disabled/worktrunk", file));
  await fs.writeFile(join(root, "launcher.json"), "{}");
  const config = join(root, "worktrunk.toml");
  const original = '[commit.generation]\ncommand = "old-writer"\n';
  await fs.writeFile(config, original);
  const w = { root, config, original, shared: {}, calls: [], commands: [], notices: [], changes: [], tasks: [] };
  const report = (text) => ({ user: { path: config, exists: true, config: { commit: { generation: { command: JSON.parse(text.match(/^command = (.+)$/m)[1]) } } } } });
  const result = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const exec = async (command, args = [], options) => {
    w.calls.push({ command, args, options });
    if (command === "wt") {
      if (args[0] === "config" && args[1] === "show") return result(JSON.stringify(report(await fs.readFile(config, "utf8"))));
      if (args[0] === "config") return result("main");
      if (args[0] === "list") return result(JSON.stringify(w.worktrees ?? [{ branch: "main", path: root, kind: "worktree", is_main: true }]));
      if (args[0] === "switch") return result(JSON.stringify({ path: root, branch: args.at(-1) }));
      throw new Error(`Unexpected wt command: ${args}`);
    }
    if (command === "sh" && args[1].includes('mv "$1" "$2"')) {
      await fs.mkdir(dirname(args[4]), { recursive: true });
      await fs.rename(args[3], args[4]);
    } else if (command === "sh" && args[1].includes('wt --config "$tmp"')) {
      await w.duringValidation?.();
      return result(JSON.stringify(report(args[3])));
    } else if (command === "sh" && args[1].includes('printf %s "$2" > "$1"')) {
      await fs.writeFile(args[3], args[4]);
    }
    return result();
  };
  const theme = new Proxy({}, { get: () => "#888888" });
  const herdr = {
    appHome: () => root, home: () => root, checking: () => false,
    shared: (key) => w.shared[key], setShared: (key, value) => { w.shared[key] = value; },
    readTextFile: async (path) => await exists(path) ? fs.readFile(path, "utf8") : null,
    writeTextFile: (path, text) => fs.writeFile(path, text), exec,
    knownAgents: async () => [], keys: () => [], theme: () => theme, settings: () => ({}),
    props: () => ({}), focused: () => ({ space: "space", pane: "pane", cwd: root }),
    spaces: () => [{ id: "space", active: true, tabs: [] }], panes: () => [],
    notify: (notice) => w.notices.push(notice), closeOverlay() {}, openOverlay() {}, pickFolder() {},
    run: (name, args) => w.commands.push({ name, args }),
  };
  const ui = {
    View: class {}, div: element, svg: element, image: element, h_flex: element, v_flex: element,
    ScrollHandle: { new: () => ({ scroll_to_item() {} }) }, InputState: input, TextareaState: input,
    Input: { new: element }, Textarea: { new: element }, Popup: { new: element }, Button: { new: element },
  };
  const context = vm.createContext({ console });
  const modules = new Map();
  const synthetic = (name, values) => new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value);
  }, { context, identifier: name });
  const externals = new Map([
    ["herdr", synthetic("herdr", herdr)], ["gpui-kit", synthetic("gpui-kit", ui)],
    ["gpui-base", synthetic("gpui-base", ui)], ["fs/promises", synthetic("fs/promises", { ...fs, exists })],
  ]);
  const get = (path) => {
    if (!modules.has(path)) modules.set(path, fs.readFile(path, "utf8").then((text) => new vm.SourceTextModule(text, { context, identifier: path })));
    return modules.get(path);
  };
  w.load = async (path) => {
    const mod = await get(join(repo, path));
    if (mod.status === "unlinked") await mod.link((name, from) => externals.get(name) ?? get(join(dirname(from.identifier), name)));
    if (mod.status === "linked") await mod.evaluate();
    return mod.namespace;
  };
  w.cx = { notify() {}, stop_propagation() {}, bind_keys() {}, timer: { every() {}, after() {} },
    focus_handle: () => ({ focus() {} }), spawn(fn) { w.tasks.push(Promise.resolve().then(() => fn(w.cx))); } };
  w.flush = async () => { while (w.tasks.length) await Promise.all(w.tasks.splice(0)); };
  w.host = { self: "config", handle: w.cx.focus_handle(), changed: (name) => w.changes.push(name), show: (key) => { w.page = key; } };
  w.turnOn = () => fs.rename(join(root, "mods-disabled/worktrunk"), join(root, "mods/worktrunk"));
  w.turnOff = () => fs.rename(join(root, "mods/worktrunk"), join(root, "mods-disabled/worktrunk"));
  return w;
}

test("fresh machines stay off even with stale enabled and Writer preferences", async (t) => {
  const w = await fixture(t);
  Object.assign(w.shared, { "worktrunk.enabled": true, "worktrunk.follows": true, writer: { command: "new-writer" } });
  const { default: Worktrunk, follow } = await w.load("mods/config/worktrunk.js");
  const page = new Worktrunk(w.host);
  follow(w.cx);
  page.start(w.cx);
  await w.flush();
  assert.equal(w.shared["worktrunk.enabled"], false);
  assert.equal(w.shared["worktrunk.follows"], true);
  assert.match(textOf(page.render({})), /Worktrunk is off/);
  page.key({ key: "m" }, w.cx);
  assert.equal(w.page, "mods");
  assert.equal(w.calls.length, 0);
  assert.equal(await fs.readFile(w.config, "utf8"), w.original);
});

test("the Mods switch moves Worktrunk and updates Launcher controls and operations", async (t) => {
  const w = await fixture(t);
  const Mods = (await w.load("mods/config/mods.js")).default;
  const mods = new Mods(w.host);
  await mods.scan();
  assert.equal(mods.mods.find((m) => m.name === "worktrunk").enabled, false);
  mods.toggle(mods.mods.find((m) => m.name === "worktrunk"), w.cx);
  await w.flush();
  assert.equal(await exists(join(w.root, "mods/worktrunk/mod.json")), true);
  assert.equal(w.shared["worktrunk.enabled"], true);

  const Launcher = (await w.load("mods/launcher/main.js")).default;
  const launcher = new Launcher();
  launcher.init({}, w.cx);
  await w.flush();
  assert.equal(hasId(launcher.render(w.cx), "wt"), true);
  launcher.toggleWorktree(w.cx);
  await w.flush();
  assert.equal(launcher.wt, true);
  assert.equal(launcher.list[0].branch, "main");
  assert.equal(await launcher.worktree({ branch: "main" }, { name: "Terminal" }, null, {}), "");
  assert.equal(w.commands.at(-1).name, "tab.new");

  mods.toggle(mods.mods.find((m) => m.name === "worktrunk"), w.cx);
  await w.flush();
  assert.equal(w.shared["worktrunk.enabled"], false);
  assert.equal(hasId(launcher.render(w.cx), "wt"), false);
  const calls = w.calls.length;
  assert.match(await launcher.worktree({ branch: "main" }, {}, null, {}), /Worktrunk is off/);
  launcher.load(w.cx);
  await w.flush();
  assert.equal(w.calls.length, calls);
  // The next key leaves a worktree field hidden by the switch; it cannot launch accidentally.
  const commands = w.commands.length;
  launcher.key({ key: "enter", modifiers: {} }, w.cx);
  assert.equal(launcher.wt, false);
  assert.equal(w.commands.length, commands);
  launcher.toggleWorktree(w.cx);
  assert.equal(launcher.wt, false);
  launcher.start(w.cx, { key: "terminal", name: "Terminal", terminal: true, installed: true });
  assert.equal(w.commands.at(-1).name, "tab.new");
  assert.deepEqual(w.changes, ["worktrunk", "worktrunk"]);
});

test("Launcher defaults off independently of Config and ignores a stale enabled cache", async (t) => {
  const w = await fixture(t);
  w.shared["worktrunk.enabled"] = true;
  const Launcher = (await w.load("mods/launcher/main.js")).default;
  const launcher = new Launcher();
  launcher.init({}, w.cx);
  assert.equal(launcher.canWorktree(), false);
  await w.flush();
  assert.equal(launcher.canWorktree(), false);
  assert.equal(hasId(launcher.render(w.cx), "wt"), false);
  launcher.key({ key: "w", modifiers: { control: true } }, w.cx);
  await w.flush();
  assert.equal(launcher.wt, false);
  assert.equal(w.calls.some((c) => c.command === "wt"), false);
});

test("Launcher reads schema 2 worktrees, bare branches and empty repositories", async (t) => {
  const w = await fixture(t);
  await w.turnOn();
  w.worktrees = { schema: 2, repo: { default_branch: "main" }, items: [
    { branch: "main", worktree: { path: w.root, main: true, current: false } },
    { branch: "feature", worktree: { path: `${w.root}.feature`, main: false, current: true } },
    { branch: "unopened" },
    { worktree: { path: `${w.root}.detached`, detached: true } },
  ] };
  const Launcher = (await w.load("mods/launcher/main.js")).default;
  const launcher = new Launcher();
  launcher.init({}, w.cx);
  await w.flush();
  launcher.toggleWorktree(w.cx);
  await w.flush();
  assert.equal(launcher.listError, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(launcher.list)), [
    { branch: "main", path: w.root, main: true, here: false },
    { branch: "feature", path: `${w.root}.feature`, main: false, here: true },
    { branch: "unopened", path: null, main: false, here: false },
  ]);
  w.worktrees.items = [];
  launcher.load(w.cx);
  await w.flush();
  assert.equal(launcher.list.length, 0);
});

test("a failed folder move keeps the switch and the existing preference intact", async (t) => {
  const w = await fixture(t);
  await w.turnOn();
  await fs.mkdir(join(w.root, "mods-disabled/worktrunk"));
  const Mods = (await w.load("mods/config/mods.js")).default;
  const mods = new Mods(w.host);
  await mods.scan();
  mods.toggle(mods.mods.find((m) => m.name === "worktrunk" && m.enabled), w.cx);
  await w.flush();
  assert.equal(w.shared["worktrunk.enabled"], true);
  assert.equal(w.changes.length, 0);
  assert.match(w.notices.at(-1).body, /already exists/);
  assert.equal(await exists(join(w.root, "mods/worktrunk/mod.json")), true);
});

test("Writer sync resumes when on and cannot write after Worktrunk is turned off", async (t) => {
  const w = await fixture(t);
  w.shared["worktrunk.follows"] = true;
  w.shared.writer = { command: "new-writer" };
  const { follow } = await w.load("mods/config/worktrunk.js");
  await w.turnOn();
  follow(w.cx);
  await w.flush();
  assert.match(await fs.readFile(w.config, "utf8"), /new-writer/);
  await fs.writeFile(w.config, w.original);
  w.duringValidation = w.turnOff;
  follow(w.cx);
  await w.flush();
  assert.equal(await fs.readFile(w.config, "utf8"), w.original);
  assert.match(w.notices.at(-1).body, /Worktrunk is off/);
  const calls = w.calls.length;
  follow(w.cx);
  await w.flush();
  assert.equal(w.calls.length, calls);
});

test("only the optional Worktrunk mod requires wt", async () => {
  const spec = async (path) => JSON.parse(await fs.readFile(join(repo, path, "mod.json"), "utf8")).spec;
  const worktrunk = JSON.parse(await fs.readFile(join(await worktrunkSource(), "mod.json"), "utf8"));
  assert.deepEqual(worktrunk.spec.needs, ["wt"]);
  for (const name of ["config", "launcher"]) assert.equal(JSON.stringify(await spec(`mods/${name}`)).includes('"wt"'), false);
});

test("native renderer accepts the Worktrunk off page and its Mods row", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "herdr-worktrunk-render-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const file of ["worktrunk.js", "mods.js", "ui.js", "toml.js"]) await fs.copyFile(join(source, file), join(root, file));
  await fs.writeFile(join(root, "mod.json"), '{"place":"none"}');
  await fs.writeFile(join(root, "main.js"), `
import { View } from "gpui-kit";
import { v_flex } from "gpui-base";
import { theme } from "herdr";
import Worktrunk from "./worktrunk.js";
import Mods from "./mods.js";
export default class Fixture extends View {
  init(_p, cx) {
    const host = { self: "config", handle: cx.focus_handle(), show() {} };
    this.page = new Worktrunk(host); this.page.enabled = false;
    this.mods = new Mods(host);
    this.mods.mods = [{ name: "worktrunk", title: "Worktrunk", enabled: false, group: "ours", keys: [], layouts: [], openedBy: [], about: "Worktrees in the Launcher and Config" }];
  }
  render() { return v_flex().w(780).h(500).child(this.page.render(theme())).child(this.mods.render(theme())); }
}`);
  const check = spawnSync("herdr-app", ["check", root], { encoding: "utf8", timeout: 30_000 });
  assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
});
