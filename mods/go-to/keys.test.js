// Run: node --experimental-vm-modules --test mods/go-to/keys.test.js
// Go to's keys against a stub model: no input reaches the person's window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function open() {
  const w = { commands: [], closed: 0, value: "" };
  const timers = [], bindings = [], actions = new Map();
  const cx = {
    notify() {}, stop_propagation() {}, spawn() {}, bind_keys(keys) { bindings.push(...keys); },
    timer: { after: (_ms, run) => timers.push(run) },
    focus_handle: () => ({ focus() { w.focus = "list"; } }),
  };
  const tab = (id) => ({ id, name: id, active: id === "one" });
  const herdr = {
    spaces: () => [{ id: "a", name: "a", active: true, tabs: [tab("one"), tab("two"), tab("three")] }],
    agents: () => [], terminals: () => [], shared: () => undefined, setShared() {}, theme: () => ({}), settings: () => ({ zoom: 1 }),
    props: () => ({ overlay: 1 }), closeOverlay: () => { w.closed++; }, run: (name, args) => w.commands.push({ name, args }),
  };
  const element = () => {
    const node = new Proxy({}, { get: (_, prop) => (...args) => {
      if (prop === "on_action") actions.set(args[0], args[1]);
      return node;
    } });
    return node;
  };
  const base = { View: class {}, div: element, svg: element, v_flex: element, h_flex: element, Input: { new: element }, InputState: { new: () => {
    const on = {};
    w.input = { on: (name, fn) => { on[name] = fn; }, value: () => w.value,
      focus() { w.focus = "input"; on.focus?.(null, cx); }, blur() { w.focus = "host"; on.blur?.(null, cx); },
      submit: (secondary = false) => on.submit({ secondary }, cx),
      type: (text) => { w.value = text; on.change(null, cx); } };
    return w.input;
  } } };
  const source = await readFile(new URL("./main.js", import.meta.url), "utf8");
  const context = vm.createContext({ console, window: { viewport_size: () => ({ height: 800 }) } });
  const mod = new vm.SourceTextModule(source, { context });
  await mod.link((specifier) => {
    const names = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)].filter((m) => m[2] === specifier).flatMap((m) => m[1].split(",").map((n) => n.trim()));
    return new vm.SyntheticModule(names, function () { for (const n of names) this.setExport(n, herdr[n] ?? base[n] ?? (() => {})); }, { context });
  });
  await mod.evaluate();
  const picker = new mod.namespace.default();
  picker.init({}, cx);
  picker.render();
  const press = (key, modifiers = {}) => picker.keys({ key, key_char: key.length === 1 && !modifiers.control ? key : undefined, modifiers }, cx);
  const searchKey = (key) => {
    const binding = bindings.find(b => b.context === "GoTo > Input" && b.keystroke === key);
    assert.ok(binding, `Missing search binding for ${key}`);
    actions.get(binding.action)({}, cx);
  };
  return { picker, w, press, searchKey, timers };
}

test("opening focus retries restore the search and respect an early Escape", async () => {
  const { w, press, timers } = await open();
  w.input.blur();
  timers[0]();
  assert.equal(w.focus, "input");
  press("escape");
  timers[1]();
  assert.equal(w.focus, "list");
});

test("submitting an unmatched search leaves the picker open until a tab matches", async () => {
  const { w } = await open();
  w.input.type("missing");
  w.input.submit();
  assert.equal(w.closed, 0);
  assert.equal(w.commands.length, 0);
  w.input.type("two");
  w.input.submit();
  assert.equal(w.closed, 1);
  assert.equal(w.commands[0].name, "tab.select");
  assert.equal(w.commands[0].args.id, "two");
});

test("creating from Go to requires confirmation of an explicitly selected action", async () => {
  const { w, press } = await open();
  w.input.type("missing");
  w.input.submit(true);
  press("down");
  w.input.submit();
  assert.equal(w.commands.length, 0);
  w.input.submit(true);
  assert.equal(w.commands.length, 1);
  assert.equal(w.commands[0].name, "tab.new");
});

test("opens in INSERT and Escape enables normal-mode navigation", async () => {
  const { picker, w, press } = await open();
  assert.equal(picker.typing, true);
  press("escape");
  assert.equal(picker.typing, false);
  press("j"); press("j");
  assert.equal(picker.at, 2);
  press("G");
  assert.equal(picker.at, 4); // the "new space" row, last
  press("j");
  assert.equal(picker.at, 4);
  press("g"); press("k");
  assert.equal(picker.at, 0);
  press("j"); press("l");
  assert.equal(JSON.stringify(w.commands), JSON.stringify([{ name: "tab.select", args: { id: "two" } }]));
  assert.equal(w.closed, 1);
});

test("Escape steps back: help, then search with the text kept, then close", async () => {
  const { picker, w, press } = await open();
  assert.equal(picker.typing, true);
  w.input.type("tw");
  press("j"); // typed into the field, not a motion
  assert.equal(picker.at, 0);
  press("down");
  assert.equal(picker.at, 1);
  press("escape");
  assert.equal(picker.typing, false);
  assert.equal(picker.filter, "tw");
  assert.equal(w.closed, 0);
  press("?");
  assert.equal(picker.help, true);
  press("escape");
  assert.equal(picker.help, false);
  assert.equal(w.closed, 0);
  press("escape");
  assert.equal(w.closed, 1);
});

test("Ctrl+J/K move while searching; Ctrl+D closes the selected tab", async () => {
  const { picker, w, searchKey } = await open();
  searchKey("down"); searchKey("up");
  searchKey("ctrl-j"); searchKey("ctrl-n"); searchKey("ctrl-k");
  assert.equal(picker.at, 1);
  searchKey("ctrl-d");
  assert.equal(JSON.stringify(w.commands), JSON.stringify([{ name: "tab.close", args: { id: "two" } }]));
});
