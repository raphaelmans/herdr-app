// node --experimental-vm-modules --test mods/nvim-pane/zoom.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

async function editor() {
  const context = vm.createContext({});
  const f = { tab: "tab", space: "space" };
  const pane = { pane: "editor", terminal: "t2", tab: f.tab, zoomed: false };
  const state = { tab: f.tab, panes: [], calls: [] };
  const herdr = {
    focused: () => ({ tab: state.tab }), panes: () => state.panes,
    terminals: () => [{ address: pane.terminal, state: "live", labels: { "nvim-pane.tab": f.tab } }],
    run: (name, args) => state.calls.push([name, args.pane ?? args.terminal]),
    hc() { assert.fail("a parked editor must be reused"); },
    notify() { assert.fail("unexpected notification"); }, nextCommand() {}, spaces: () => [],
  };
  const source = await readFile(new URL("./main.js", import.meta.url), "utf8");
  const mod = new vm.SourceTextModule(source, { context });
  await mod.link(name => {
    const values = name === "herdr" ? herdr : { View: class {}, div() {} };
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value);
    }, { context });
  });
  await mod.evaluate();
  const app = new mod.namespace.default();
  const open = (sleep = () => assert.fail("unexpected wait")) => app.open(f, { sleep }, "zoom");
  return { open, pane, state };
}

test("zoom gives a lone editor the keyboard and preserves an existing zoom", async () => {
  const { open, pane, state } = await editor();
  state.panes = [pane];
  await open();
  assert.deepEqual(state.calls, [["pane.focus", "editor"]]);
  state.calls.length = 0;
  state.panes.push({ pane: "shell", tab: pane.tab });
  await open();
  assert.deepEqual(state.calls, [["pane.focus", "editor"], ["pane.zoom", "editor"]]);
  state.calls.length = 0;
  pane.zoomed = true;
  await open();
  assert.deepEqual(state.calls, [["pane.focus", "editor"]]);
});

test("zoom waits for a parked editor and respects a switch to another tab", async () => {
  for (const switchTab of [false, true]) {
    const { open, pane, state } = await editor();
    state.panes = [{ pane: "shell", tab: pane.tab }];
    await open(() => {
      state.panes.push(pane);
      if (switchTab) state.tab = "other";
    });
    const expected = [["terminal.keep", "t2"]];
    if (!switchTab) expected.push(["pane.focus", "editor"], ["pane.zoom", "editor"]);
    assert.deepEqual(state.calls, expected);
  }
});
