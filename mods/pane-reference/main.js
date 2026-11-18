// Copy reference: puts a reference to a pane on the clipboard, so it can be
// pasted into any agent's session and that agent can read or message the pane
// with `hc`. Terms: GLOSSARY.md (Address, Reference). Spec: docs/specs/pane-reference.md.
//
//   pane-reference.copy           the focused pane's reference   (cmd-shift-c, ctrl-a R)
//   pane-reference.copy-address   its bare address, e.g. t63     (ctrl-a @)
//   pane-reference.ask            the pane named in shared "pane-reference.ask"
//                                 { terminal, bare, n }, set just before (Agent hub c / C)
//
// No dialog and no focus change: the keyboard stays where it was, a toast confirms.
// The reference includes the source core's permanent ID. Machine aliases
// belong to the computer doing the looking up.
// It draws nothing: it sits in my layout as a floating block of no size.

import { View, div } from "gpui-kit";
import { agents, focused, hc, nextCommand, notify, panes, shared, spaces, terminals } from "herdr";
import { reference, toastBody } from "./reference.js";

// A request from the Agent hub counts only right after it was made.
const ASK_MS = 2000;

// What the builder needs about one terminal, from whichever list knows it.
function describe(address) {
  const a = agents().find((x) => x.address === address);
  if (a) {
    return { address, title: a.title, agent: a.app ?? a.program?.key ?? "agent", program: a.program?.name, space: a.space_name, tab: a.tab_index };
  }
  const term = terminals().find((x) => x.address === address);
  const pane = panes().find((p) => p.terminal === address);
  const space = spaces().find((s) => (s.tabs ?? []).some((t) => t.id === pane?.tab));
  const tab = space?.tabs.find((t) => t.id === pane?.tab);
  return { address, title: pane?.title ?? term?.title ?? "", agent: null, program: pane?.program?.name ?? term?.program?.name ?? "shell", space: space?.name, tab: tab?.index ?? null };
}

export default class PaneReference extends View {
  init(_props, cx) {
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        await this.command(command, cx);
      }
    });
  }

  async command(command, cx) {
    let address = focused()?.terminal ?? null;
    let bare = command === "copy-address";
    if (command === "ask") {
      const ask = shared("pane-reference.ask");
      if (!ask || Date.now() - (ask.n ?? 0) > ASK_MS) return;
      address = ask.terminal;
      bare = Boolean(ask.bare);
    } else if (command !== "copy" && command !== "copy-address") return;
    if (!address) return notify({ title: "This pane has no terminal", level: "warning", timeout: 1500 });
    const pane = describe(address);
    if (!bare) {
      try {
        const remote = address.includes("/");
        const result = await hc(remote ? ["machine", "ls", "--json"] : ["server", "status", "--json"]);
        if (result.code !== 0) throw new Error();
        const info = JSON.parse(result.stdout);
        const core = remote ? info.machines.find((m) => m.name === address.split("/")[0]) : info.core;
        if (!core?.id) throw new Error();
        pane.core = core.id;
        pane.machine = core.host || core.name;
      } catch {
        return notify({ title: "Couldn't identify the terminal's machine", body: "Try copying its reference again.", level: "warning" });
      }
    }
    cx.write_to_clipboard(bare ? address : reference(pane));
    notify({ title: bare ? "Copied address" : "Copied reference", body: toastBody(pane, Boolean(shared("curtain")?.on)), level: "success", timeout: 1500 });
  }

  render() {
    return div();
  }
}
