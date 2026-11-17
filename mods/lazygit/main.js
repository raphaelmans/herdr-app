// lazygit in a popup that takes the keyboard, for the focused pane's repository on
// its machine (Cmd-G, ctrl-a g). Git is this program, not an own mod (ADR 0011).
// A lazygit already running for that repository (labelled lazygit.repo) is shown
// again; otherwise one starts as a herdr-core terminal that goes away on q.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { focused, spaces, terminals, home, hc, exec, openOverlay, closeOverlay, props, notify, checking, theme } from "herdr";

const LABEL = "lazygit.repo";
// herdr-core's service is started by launchd with a bare PATH, and `hc run`
// programs inherit it, so a mise-owned lazygit is not found: put mise's shims first.
const RUN = 'd="${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims"; [ -d "$d" ] && PATH="$d:$PATH"; export PATH; exec lazygit';

export default class LazygitLauncher extends View {
  init(_props, cx) {
    if (checking()) return;
    cx.spawn(async () => {
      const self = props().overlay;
      try {
        const f = focused(), all = spaces();
        const space = all.find((s) => s.id === f?.space) ?? all.find((s) => s.active);
        const cwd = f?.cwd || space?.folder || home();
        const machine = space?.machine ?? null;
        // The repository, so panes in its subfolders share one lazygit; the folder outside one.
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on: machine ?? undefined, timeout: 5000 }).catch(() => null);
        const repo = top?.code === 0 ? top.stdout.trim() : cwd;
        const here = (t) => (machine ? t.address.startsWith(`${machine}/`) : !t.address.includes("/"));
        let address = terminals().find((t) => t.state === "live" && t.labels?.[LABEL] === repo && here(t))?.address;
        if (!address) {
          const args = ["run", "--json", "--bg", "--rm", "--no-parent", "--label", `${LABEL}=${repo}`, "--cwd", repo];
          if (machine) args.push("--on", machine);
          const r = await hc([...args, "--", "sh", "-c", RUN]);
          if (r.code !== 0) throw new Error(r.stderr || r.stdout || "herdr-core could not start lazygit");
          address = JSON.parse(r.stdout).address;
        }
        // This popup closes first: closing it after the dialog opened handed the keyboard
        // back to the pane under it. Opened last, the dialog keeps the keyboard.
        if (self) closeOverlay(self);
        openOverlay({ kind: "dialog", modal: true, width: 0.9, height: 0.9, layout: { type: "block", content: { terminal: address } } });
        return;
      } catch (e) {
        notify({ title: "Couldn't start lazygit", body: String(e?.message ?? e), level: "error" });
      }
      if (self) closeOverlay(self);
    });
  }

  // Shown only while lazygit is found or started.
  render() {
    const t = theme();
    return h_flex().size_full().px(12).gap(8).items_center().bg(t.popover).text_size(12.5).text_color(t.muted)
      .child(svg("mods/workspace-chrome/spinner.svg").size(13).flex_none().text_color(t.working).spin(900))
      .child(div().child("Starting lazygit"));
  }
}
