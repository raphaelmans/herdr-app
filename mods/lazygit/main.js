// lazygit in a popup, for the focused pane's folder. No key is bound to it:
// the Git dialog's L starts lazygit itself (mods/git/features.js).
//
// mod.open:lazygit opens this mod for a moment: it starts lazygit as a
// herdr-core terminal, shows it in a centered dialog and closes itself.
// Esc goes to lazygit; quit lazygit (q) to close the popup.
import { View, div } from "gpui-kit";
import { focused, spaces, home, hc, openOverlay, closeOverlay, props, notify, checking } from "herdr";

const LAZYGIT = "lazygit";

export default class LazygitLauncher extends View {
  init(_props, cx) {
    if (checking()) return;
    cx.spawn(async (cx) => {
      const self = props().overlay;
      try {
        const f = focused();
        const space = spaces().find((s) => s.id === f?.space) ?? spaces().find((s) => s.active);
        const cwd = f?.cwd || space?.folder || home();
        const args = ["run", "--json", "--bg", "--rm", "--no-parent", "--name", `lazygit-${Date.now() % 100000}`, "--cwd", cwd];
        if (space?.machine) args.push("--on", space.machine);
        args.push("--", LAZYGIT);

        const r = await hc(args);
        if (r.code !== 0) throw new Error(r.stderr || r.stdout || "herdr-core could not start lazygit");
        const address = JSON.parse(r.stdout).address;
        openOverlay({
          kind: "dialog",
          modal: true,
          width: 0.9,
          height: 0.9,
          layout: { type: "block", content: { terminal: address } },
        });
      } catch (e) {
        notify({ title: "Couldn't start lazygit", body: String(e?.message ?? e), level: "error" });
      }
      if (self) closeOverlay(self);
    });
  }

  render() {
    return div();
  }
}
