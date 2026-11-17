// Run: node --experimental-vm-modules --test mods/spaces-sections/hidden.test.js
// Exercise the actual mods against one live model, without sending input to
// the person's window or running terminals. Herdr checks native rendering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

function element(type) {
  const node = { type, nodes: [], events: {}, attrs: {} };
  let proxy;
  proxy = new Proxy(node, { get(target, key) {
    if (key in target) return target[key];
    if (key === "when") return (condition, fn) => condition ? fn(proxy) : proxy;
    if (key === "child") return (child) => { node.nodes.push(child); return proxy; };
    if (key === "children") return (children) => { node.nodes.push(...children); return proxy; };
    if (String(key).startsWith("on_")) return (...args) => { node.events[key] = args.at(-1); return proxy; };
    return (...args) => { node.attrs[key] = args; return proxy; };
  } });
  return proxy;
}
const flat = (node) => Array.isArray(node) ? node.flatMap(flat) : node && typeof node === "object" ? [node, ...node.nodes.flatMap(flat)] : [node];
const textOf = (node) => flat(node).filter((x) => typeof x === "string").join(" ");
const byId = (node, id) => flat(node).find((x) => x?.attrs?.id?.[0] === id);
const cx = { notify() {}, stop_propagation() {}, spawn() {}, bind_keys() {}, timer: { every() {}, after() {} }, focus_handle: () => ({ focus() {} }) };
const space = (id, machine = null) => ({ id, machine, name: id, tabs: [{ id: `${id}-tab`, name: `${id} work`, index: 1, panes: 2 }], folder: `/${id}` });
const agent = (address, id, status = "working", more = {}) => ({ address, space: id, space_name: id, tab: `${id}-tab`, pane: `${address}-pane`, title: `${id} task`, status, seq: 1, program: { name: "Agent", agent: true }, ...more });

function world() {
  const w = {
    spaces: [space("a"), space("b"), space("c"), space("remote/a", "remote")],
    agents: [agent("t1", "a"), agent("t2", "b", "blocked", { pinned: true }), agent("t3", "c"), agent("remote/t1", "remote/a", "done")],
    terminals: [], panes: [], props: {}, commands: [], closed: [], order: [],
    focus: { space: "a", tab: "a-tab", terminal: "t1", agent: "t1" },
    shared: { layout: "mine", "spaces.sections": { v: 1, sections: [
      { id: "normal", name: "Backlog", machine: null, members: ["a"], folded: false },
      { id: "hidden:", name: "Hidden", hidden: true, machine: null, members: ["b"], folded: false },
      { id: "hidden:remote", name: "Hidden", hidden: true, machine: "remote", members: ["remote/a"], folded: true },
    ] } },
  };
  w.spaces[0].active = true;
  w.terminals = w.agents.map((a) => ({ address: a.address, state: "live", labels: { "herdr.space": a.space.split("/").at(-1) } }));
  w.panes = w.agents.map((a) => ({ pane: a.pane, tab: a.tab, terminal: a.address, title: a.title, program: a.program, status: a.status }));
  return w;
}
const restore = (w) => { for (const s of w.shared["spaces.sections"].sections) if (s.hidden) s.members = []; };

async function load(name, w) {
  const source = await readFile(new URL(`../${name}/main.js`, import.meta.url), "utf8");
  const memory = new Map();
  const context = vm.createContext({ console, localStorage: { getItem: (k) => memory.get(k), setItem: (k, v) => memory.set(k, v), removeItem: (k) => memory.delete(k) } });
  const herdr = {
    spaces: () => w.spaces, agents: () => w.agents, terminals: () => w.terminals, panes: () => w.panes,
    shared: (k) => w.shared[k], setShared: (k, v) => { w.shared[k] = v; }, focused: () => w.focus,
    props: () => w.props, run: (name, args) => w.commands.push({ name, args }),
    closeOverlay: (id) => w.closed.push(id), setAgentOrder: (order) => { w.order = [...order]; },
    machines: () => [{ name: null, layout: "ready" }, { name: "remote", layout: "ready" }],
    layout: () => ({ id: "sidebar", size: { px: 268 } }),
    theme: () => new Proxy({}, { get: () => "#888888" }), window: () => ({ platform: "macos" }), keys: () => [],
  };
  const elements = { View: class {}, div: () => element("div"), svg: () => element("svg"), image: () => element("image"), v_flex: () => element("column"), h_flex: () => element("row") };
  const mod = new vm.SourceTextModule(source, { context });
  await mod.link((specifier) => {
    const match = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)].filter((m) => m[2] === specifier);
    const names = [...new Set(match.flatMap((m) => m[1].split(",").map((n) => n.trim())))];
    return new vm.SyntheticModule(names, function () { for (const n of names) this.setExport(n, (specifier === "herdr" ? herdr[n] : elements[n]) ?? (() => {})); }, { context });
  });
  await mod.evaluate();
  return new mod.namespace.default();
}

function prepareSidebar(sidebar, w) {
  Object.assign(sidebar, { shown: new Set(w.spaces.map((s) => s.id)), git: {}, born: {}, picked: new Set(), visible: [], pressed: null, over: null, numbers: new Map() });
  return sidebar;
}

test("Hidden is available when empty, keeps its state, and restores without ending work", async () => {
  const w = world();
  w.shared["spaces.sections"].sections = [];
  const sidebar = prepareSidebar(await load("spaces-sections", w), w);
  assert.match(textOf(sidebar.sectioned([], {}, false)), /Hidden/);
  w.props = { overlay: "menu", sectionMenu: { ids: ["b"], machine: null } };
  byId(sidebar.sectionMenu({}), "sm-to-0").events.on_click();
  const hidden = w.shared["spaces.sections"].sections.find((s) => s.hidden && s.machine === null);
  assert.deepEqual([...hidden.members], ["b"]);
  assert.equal(hidden.folded, true);
  w.props = { overlay: "menu", sectionMenu: { section: hidden.id } };
  const reopened = await load("spaces-sections", w);
  byId(reopened.sectionMenu({}), "sm-restore").events.on_click();
  assert.equal(w.shared["spaces.sections"].sections.find((s) => s.id === hidden.id).members.length, 0);
  assert.equal(w.commands.length, 0);
});

test("Hidden membership overrides worktree nesting in either direction", async () => {
  const w = world();
  w.spaces = [space("a"), space("b")];
  const sidebar = prepareSidebar(await load("spaces-sections", w), w);
  const repo = JSON.stringify([null, "/repo"]);
  sidebar.git[JSON.stringify([null, "/a"])] = { repo, linked: false };
  sidebar.git[JSON.stringify([null, "/b"])] = { repo, linked: true };
  let rows = sidebar.ordered();
  assert.equal(rows.find((r) => r.w.id === "b").section, "hidden:");
  assert.equal(rows.find((r) => r.w.id === "b").tree, null);
  w.shared["spaces.sections"].sections = [{ id: "hidden:", name: "Hidden", hidden: true, members: ["a"], machine: null, folded: false }];
  rows = sidebar.ordered();
  assert.equal(rows.find((r) => r.w.id === "b").section, null);
  assert.equal(rows.find((r) => r.w.id === "b").tree, null);
  restore(w);
  assert.equal(sidebar.ordered().find((r) => r.w.id === "b").tree, "└─");
});

test("Hidden suppresses section attention without removing its sidebar rows", async () => {
  const w = world();
  const sidebar = prepareSidebar(await load("spaces-sections", w), w);
  const rows = sidebar.ordered();
  assert.ok(byId(sidebar.sectioned(rows, {}, false), "space-b"));
  const hidden = w.shared["spaces.sections"].sections.find((s) => s.id === "hidden:");
  const head = sidebar.sectionHead({ ...hidden, folded: true }, [{ w: { ...w.spaces[1], status: "blocked" }, i: 1 }], {}, false);
  assert.doesNotMatch(textOf(head), /●/);
});

test("pickers omit Hidden (Go to across every space, the hub in either scope), then restore it immediately", async () => {
  const w = world();
  const picker = await load("go-to", w);
  Object.assign(picker, { filter: "", showEarlier: true, machines: [] });
  assert.deepEqual(Array.from(picker.rows().filter((r) => r.kind === "ctx"), (r) => r.w.id), ["a", "c"]);
  const hub = await load("agent-hub", w);
  Object.assign(hub, { query: "", space: "b", all: false });
  assert.equal(hub.list().length, 0);
  hub.all = true;
  assert.deepEqual(Array.from(hub.list(), (a) => a.address), ["t1", "t3"]);
  const move = await load("pane-move", w);
  Object.assign(move, { from: { space: w.spaces[0], tab: w.spaces[0].tabs[0] }, query: "" });
  assert.deepEqual(Array.from(move.targets().filter((r) => r.kind === "tab"), (r) => r.space.id), ["c"]);
  restore(w);
  assert.equal(hub.list().length, 4);
  assert.equal(picker.rows().filter((r) => r.kind === "ctx").length, 4);
  assert.deepEqual(Array.from(move.targets().filter((r) => r.kind === "tab"), (r) => r.space.id), ["b", "c"]);
});

test("space keys skip Hidden, wrap, and can leave a manually opened Hidden space", async () => {
  const w = world();
  const nav = await load("curtain", w);
  nav.on = false;
  for (const [command, target] of [["space-next", "c"], ["space-prev", "c"], ["space-2", "c"]]) {
    nav.command(command, cx);
    assert.equal(w.commands.at(-1).args.id, target);
  }
  w.spaces[0].active = false;
  w.spaces[1].active = true;
  nav.command("space-next", cx);
  assert.equal(w.commands.at(-1).args.id, "c");
  nav.command("space-prev", cx);
  assert.equal(w.commands.at(-1).args.id, "a");
  w.shared["spaces.sections"].sections[1].members = ["a", "b", "c"];
  w.commands.length = 0;
  nav.command("space-next", cx);
  nav.command("space-1", cx);
  assert.equal(w.commands.length, 0);
});

test("agent keys exclude pinned Hidden agents even with stale sidebar order", async () => {
  const w = world();
  w.shared["agents.order"] = ["t2", "remote/t1", "t3", "t1"];
  const nav = await load("curtain", w);
  nav.on = false;
  nav.command("agent-next", cx);
  assert.equal(w.commands.at(-1).args.terminal, "t3");
  w.focus = { agent: "t2" };
  nav.command("agent-prev", cx);
  assert.equal(w.commands.at(-1).args.terminal, "t1");
  nav.on = true;
  w.commands.length = 0;
  nav.command("agent-next", cx);
  assert.equal(w.commands.length, 0);
  nav.on = false;
  restore(w);
  nav.command("agent-next", cx);
  assert.equal(w.commands.at(-1).name, "agent.next");
});

test("agent sidebar, nested agents, team counts and status totals omit Hidden", async () => {
  const w = world();
  // A kept child in Hidden must not reappear below a visible parent.
  w.terminals.find((t) => t.address === "t2").parent = "t1";
  w.terminals.push({ address: "child", parent: "t2", state: "live", labels: {} });
  const sidebar = await load("agents-titled", w);
  sidebar.init({}, cx);
  const rendered = sidebar.render(cx);
  assert.ok(byId(rendered, "ag-t1"));
  assert.equal(byId(rendered, "ag-t2"), undefined);
  assert.deepEqual([...w.order].sort(), ["t1", "t3"]);
  assert.ok(!w.shared["agents.order"].includes("child"));
  const picker = await load("go-to", w);
  Object.assign(picker, { filter: "", showEarlier: true, machines: [] });
  assert.equal(picker.rows().find((r) => r.kind === "ctx" && r.w.id === "a").team, 0);
  const status = await load("status-bar", w);
  assert.match(textOf(status.render()), /2 agents/);
  assert.doesNotMatch(textOf(status.render()), /needs you/);
  restore(w);
  assert.match(textOf(status.render()), /4 agents.*1 needs you/);
});

test("targeted Hidden toasts close, including remote and unkept descendants; unrelated notices remain", async () => {
  const w = world();
  w.terminals.push({ address: "child", parent: "t2", state: "live", labels: {} });
  const toast = await load("toasts", w);
  const hidden = [
    { name: "agent.focus", args: { terminal: "t2" } },
    { name: "terminal.peek", args: { terminal: "child" } },
    { name: "agent.focus", args: { terminal: "remote/t1" } },
    { name: "pane.focus", args: { pane: "t2-pane" } },
    { name: "tab.select", args: { id: "b-tab" } },
    { name: "space.select", args: { id: "b" } },
  ];
  for (const action of hidden) {
    w.props = { overlay: "notice", title: "Needs you", action };
    toast.render(cx);
  }
  assert.equal(w.closed.length, hidden.length);
  for (const action of [undefined, { name: "agent.focus", args: { terminal: "t1" } }, { name: "agent.focus", args: { terminal: "unknown" } }]) {
    w.props = { overlay: "notice", title: "General notice", action };
    assert.ok(byId(toast.render(cx), "toast"));
  }
  assert.equal(w.closed.length, hidden.length);
  restore(w);
  w.props = { overlay: "notice", action: hidden[0] };
  assert.ok(byId(toast.render(cx), "toast"));
});

test("prefix navigation and numbered agent shortcuts respect Hidden", async () => {
  const w = world();
  const prefix = await load("tmux-prefix", w);
  prefix.dismiss = () => {};
  prefix.key({ key: "a", key_char: "a", modifiers: {} }, cx);
  assert.equal(w.commands.at(-1).name, "curtain.agent-next");
  prefix.key({ key: "J", key_char: "J", modifiers: {} }, cx);
  assert.equal(w.commands.at(-1).name, "curtain.space-next");
  prefix.key({ key: "2", modifiers: { alt: true } }, cx);
  assert.equal(w.commands.at(-1).args.terminal, "t3");
});
