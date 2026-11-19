// node --experimental-vm-modules --test mods/send-box/keys.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function open() {
  const context = vm.createContext({});
  const bindings = [], handlers = new Map(), sent = [];
  const cx = { notify() {}, stop_propagation() {}, bind_keys(keys) { bindings.push(...keys); },
    timer: { after() {} }, focus_handle: () => ({ focus() {} }) };
  const element = () => {
    let scope;
    const node = new Proxy({}, { get: (_, key) => (...args) => {
      if (key === "key_context") scope = args[0];
      if (key === "on_action") handlers.set(`${scope}/${args[0]}`, args[1]);
      return node;
    } });
    return node;
  };
  const textarea = { new: ({ value }) => {
    const events = {};
    let selection;
    return {
      on: (name, fn) => { events[name] = fn; }, focus: () => events.focus({}, cx), value: () => value,
      set_selected_range: range => { selection = range; },
      replace(text) {
        value = value.slice(0, selection.start) + text + value.slice(selection.end);
        selection = { start: selection.start + text.length, end: selection.start + text.length };
        events.change({}, cx);
      },
    };
  } };
  const modules = {
    "gpui-kit": { View: class {}, div: element },
    "gpui-base": { v_flex: element, h_flex: element, Textarea: { new: element }, TextareaState: textarea },
    "herdr": {
      props: () => ({ window: true, terminal: "t1", text: "left🌲right", overlay: 1 }),
      panes: () => [], theme: () => ({}), shared() {}, setShared() {}, closeOverlay() {}, openOverlay() {}, focused() {}, run() {}, notify() {},
      exec: async (cmd, args) => { sent.push([cmd, ...args]); return { code: 0 }; },
    },
  };
  const source = await readFile(new URL("./main.js", import.meta.url), "utf8");
  const mod = new vm.SourceTextModule(source, { context });
  await mod.link(name => new vm.SyntheticModule(Object.keys(modules[name]), function () {
    for (const [key, value] of Object.entries(modules[name])) this.setExport(key, value);
  }, { context }));
  await mod.evaluate();
  const box = new mod.namespace.default();
  box.init({}, cx);
  box.render();
  const press = key => {
    const binding = bindings.find(b => b.keystroke === key && b.context === "SendBoxText > Input");
    assert.ok(binding, `Missing text-area binding for ${key}`);
    handlers.get(`SendBoxText/${binding.action}`)({}, cx);
  };
  return { box, press, sent };
}

test("Shift+Enter replaces the selection with one newline and either submit key sends the exact draft once", async () => {
  for (const key of ["enter", "secondary-enter"]) {
    const { box, press, sent } = await open();
    box.area.set_selected_range({ start: 4, end: 6 });
    press("shift-enter");
    assert.equal(box.area.value(), "left\nright");
    assert.equal(sent.length, 0);
    press(key);
    press(key);
    assert.deepEqual(sent, [["hc", "send", "t1", "left\nright"]]);
  }
});
