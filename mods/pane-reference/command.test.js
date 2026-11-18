// node --experimental-vm-modules --test mods/pane-reference/command.test.js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";
import * as builder from "./reference.js";

test("copy resolves identical terminal IDs on different cores, preserving the clipboard on lookup failure", async () => {
  let address = "t9", clipboard = "", notice;
  const calls = [];
  const host = {
    focused: () => ({ terminal: address }), agents: () => [], panes: () => [], spaces: () => [], terminals: () => [],
    shared() {}, nextCommand() {}, notify: (event) => { notice = event; },
    hc: async (args) => {
      calls.push(Array.from(args));
      const data = args[0] === "machine" ? { machines: [{ name: "laptop", host: "remote-host", id: "remote-id" }] }
        : { core: { id: "local-id", name: "local-host" } };
      return { code: 0, stdout: JSON.stringify(data) };
    },
  };
  const modules = { herdr: host, "gpui-kit": { View: class {}, div() {} }, "./reference.js": builder };
  const context = vm.createContext({});
  const mod = new vm.SourceTextModule(await readFile(new URL("./main.js", import.meta.url), "utf8"), { context });
  await mod.link((name) => {
    const stub = modules[name];
    return new vm.SyntheticModule(Object.keys(stub), function () {
      for (const [key, value] of Object.entries(stub)) this.setExport(key, value);
    }, { context });
  });
  await mod.evaluate();
  const view = new mod.namespace.default();
  const cx = { write_to_clipboard: (text) => { clipboard = text; } };
  await view.command("copy", cx);
  assert.match(clipboard, /machine="local-host" core="local-id"/);
  address = "laptop/t9";
  await view.command("copy", cx);
  assert.match(clipboard, /machine="remote-host" core="remote-id"/);
  assert.match(clipboard, /using its name on your machine/);
  assert.doesNotMatch(clipboard, /hc read laptop\/t9/);
  address = "missing/t9";
  const before = clipboard;
  await view.command("copy", cx);
  assert.equal(clipboard, before);
  assert.equal(notice.level, "warning");
  await view.command("copy-address", cx);
  assert.equal(clipboard, "missing/t9");
  assert.deepEqual(calls, [["server", "status", "--json"], ["machine", "ls", "--json"], ["machine", "ls", "--json"]]);
});
