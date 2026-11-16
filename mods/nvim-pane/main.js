// nvim-pane: one plain `nvim` per tab, beside the focused pane.
//
//   cmd-e        nvim-pane.toggle   show it, or hide it (nvim keeps running)
//   cmd-shift-e  nvim-pane.show     show it and give it the keyboard
//
// - The first time in a tab: one `hc run` starts nvim in the focused pane's
//   folder, labelled with the tab, then `terminal.keep` gives it a pane.
// - Hiding is `terminal.park`: the pane goes, nvim and its buffers stay.
//   Showing again is `terminal.keep`: no process starts.
// - `:q` ends it; the next key starts a new one.
// - A tab that closes takes its parked nvim with it.
// - Each nvim listens on SOCKET(tab), so anything can talk to a tab's nvim:
//   `nvim --server /tmp/nvim-pane-<tab>.sock --remote <file>`.
//
// It lives in an empty floating block of the layout (always loaded, draws
// nothing), so a key reaches it with no overlay to open:
//   layout  "floating": [{ "id": "nvim-pane", "content": { "mod": "nvim-pane" }, ... }]

import { View, div } from "gpui-kit";
import { focused, hc, nextCommand, notify, panes, run, spaces, terminals } from "herdr";

const LABEL = "nvim-pane.tab";
// Which side of the focused pane nvim opens on: "right" or "down".
const PLACE = "right";

const SOCKET = (tab) => `/tmp/nvim-pane-${tab.replace(/[^A-Za-z0-9]/g, "_")}.sock`;

// The tab's nvim terminal (shown or parked), or null.
function nvimOf(tab) {
  return terminals().find((t) => t.state === "live" && t.labels?.[LABEL] === tab)?.address ?? null;
}

const isShown = (terminal) => panes().some((p) => p.terminal === terminal);

export default class NvimPane extends View {
  init(_props, cx) {
    this.busy = false;
    this.tabs = null; // local tab ids at the last render
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (this.busy) continue;
        const f = focused();
        if (!f?.tab) {
          notify({ title: "nvim", body: "Open a tab first.", level: "warning" });
          continue;
        }
        this.busy = true;
        try {
          if (command === "toggle") await this.open(f, cx, true);
          else if (command === "show") await this.open(f, cx, false);
        } catch (e) {
          notify({ title: "nvim", body: String(e?.message ?? e), level: "error" });
        } finally {
          this.busy = false;
        }
      }
    });
  }

  // The tab's nvim in a pane with the keyboard, started if there is none.
  // `toggle`: one that shows is hidden instead. True once nvim shows.
  async open(f, cx, toggle) {
    let terminal = nvimOf(f.tab);
    if (terminal && isShown(terminal)) {
      run(toggle ? "terminal.park" : "pane.focus", { terminal });
      return !toggle;
    }
    if (!terminal) {
      const space = spaces().find((s) => s.id === f.space);
      const args = ["run", "--bg", "--json", "--no-parent", "--label", `${LABEL}=${f.tab}`];
      const cwd = f.cwd ?? space?.folder;
      if (cwd) args.push("--cwd", cwd);
      if (space?.machine) args.push("--on", space.machine);
      // A socket file left by an nvim that died would stop the new one.
      // herdr-core starts this with the app's short PATH, not a login shell's,
      // so a mise-owned nvim is not found. Prepend its shims, as health.sh does.
      const r = await hc([...args, "--", "sh", "-c",
        'rm -f "$1"; d="${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims"; [ -d "$d" ] && PATH="$d:$PATH"; export PATH; exec nvim --listen "$1"',
        "sh", SOCKET(f.tab)]);
      try { terminal = JSON.parse(r.stdout).address ?? null; } catch {}
      if (r.code !== 0 || !terminal) {
        notify({ title: "nvim did not start", body: (r.stderr || r.stdout).trim().slice(-300), level: "error" });
        return false;
      }
      // The app's terminal list shows it a moment after `hc` answers, and
      // `terminal.keep` only takes a terminal it lists.
      for (const end = Date.now() + 2000; !terminals().some((t) => t.address === terminal) && Date.now() < end; ) await cx.sleep(10);
    }
    // The pane goes beside the focused one: only in the tab it is for. In
    // another by now, nvim stays parked for that tab's next key.
    if (focused()?.tab !== f.tab) return false;
    run("terminal.keep", { terminal, place: PLACE });
    return true;
  }

  // A local tab that was here at the last render and is gone now: its nvim
  // ends too (a parked one has no pane to close with the tab). Only tabs
  // seen going, never ones merely missing, so a list still loading ends
  // nothing.
  sweep() {
    const now = new Set(spaces().filter((s) => !s.machine).flatMap((s) => s.tabs.map((t) => t.id)));
    if (this.tabs && now.size) {
      for (const tab of this.tabs) {
        if (now.has(tab)) continue;
        const terminal = nvimOf(tab);
        if (terminal) run("terminal.kill", { terminal });
      }
    }
    if (now.size) this.tabs = now;
  }

  render() {
    this.sweep();
    return div();
  }
}
