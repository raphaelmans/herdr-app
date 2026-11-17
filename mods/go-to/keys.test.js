// Run: node --experimental-vm-modules --test mods/go-to/keys.test.js
// Go to's keys against a stub model: no input reaches the person's window.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const cx = { notify() {}, stop_propagation() {}, spawn() {}, bind_keys() {}, timer: { after() {} }, focus_handle: () => ({ focus() {} }) };

async function open() {
  const w = { commands: [], closed: 0, value: "" };
  const tab = (id) => ({ id, name: id, active: id === "one" });
  const herdr = {
    spaces: () => [{ id: "a", name: "a", active: true, tabs: [tab("one"), tab("two"), tab("three")] }],
    agents: () => [], terminals: () => [], shared: () => undefined, setShared() {},
    props: () => ({ overlay: 1 }), closeOverlay: () => { w.closed++; }, run: (name, args) => w.commands.push({ name, args }),
  };
  const base = { View: class {}, InputState: { new: () => {
    const on = {};
    w.input = { on: (name, fn) => { on[name] = fn; }, value: () => w.value, focus: () => on.focus?.(null, cx), blur: () => on.blur?.(null, cx),
      type: (text) => { w.value = text; on.change(null, cx); } };
    return w.input;
  } } };
  const source = await readFile(new URL("./main.js", import.meta.url), "utf8");
  const context = vm.createContext({ console });
  const mod = new vm.SourceTextModule(source, { context });
  await mod.link((specifier) => {
    const names = [...source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)].filter((m) => m[2] === specifier).flatMap((m) => m[1].split(",").map((n) => n.trim()));
    return new vm.SyntheticModule(names, function () { for (const n of names) this.setExport(n, herdr[n] ?? base[n] ?? (() => {})); }, { context });
  });
  await mod.evaluate();
  const picker = new mod.namespace.default();
  picker.init({}, cx);
  picker.at = 0;
  const press = (key, modifiers = {}) => picker.keys({ key, key_char: key.length === 1 && !modifiers.control ? key : undefined, modifiers }, cx);
  return { picker, w, press };
}

test("opens in NORMAL: vim motions move and clamp, l goes", async () => {
  const { picker, w, press } = await open();
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
  press("/");
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
  const { picker, w, press } = await open();
  press("i");
  picker.control("j", cx); picker.control("n", cx); picker.control("k", cx);
  assert.equal(picker.at, 1);
  press("d", { control: true });
  assert.equal(JSON.stringify(w.commands), JSON.stringify([{ name: "tab.close", args: { id: "two" } }]));
});
