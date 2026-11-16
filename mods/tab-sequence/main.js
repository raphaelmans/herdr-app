// Tab sequence: on its command, puts the number in front of each tab's name
// back in step with its place in the shown space, like tmux's `move-window -r`.
//
//   tab-sequence.renumber     (prefix, then r)
//
// Auto Title already keeps the names it writes numbered ("2 · fix login"), but
// a tab named by hand is locked to it and keeps whatever number it had, or
// none: close or move a tab and the bar reads 1, 2, 2, 4. This renames those
// locked tabs, and only those. A name Auto Title wrote is left to it, since a
// rename from here would look like one made by hand and lock that tab too.
//
// It draws nothing: it sits in a layout as a floating block of no size.

import { View, div } from "gpui-kit";
import { focused, home, nextCommand, notify, readTextFile, run, spaces } from "herdr";

// Where Auto Title's service for this app keeps the tabs it treats as named by
// hand (macOS).
const LOCKS = `${home()}/Library/Application Support/herdr-auto-title/manual-names.json.desktop`;
const SEP = " · "; // as Auto Title writes it
const NUMBERED = /^\d+ · /;

export default class TabSequence extends View {
  init(_props, cx) {
    cx.spawn(async () => {
      for (;;) {
        if ((await nextCommand()) === "renumber") await this.renumber();
      }
    });
  }

  // Positions count the tabs a number key reaches: the ones not settled.
  async renumber() {
    try {
      const text = await readTextFile(LOCKS);
      if (!text) throw new Error("Auto Title's list of hand-named tabs is missing");
      const locked = JSON.parse(text).locked_tabs ?? {};
      const space = spaces().find((s) => s.id === focused()?.space);
      let renamed = 0;
      (space?.tabs ?? []).filter((tab) => !tab.settled).forEach((tab, i) => {
        if (!tab.named || !(tab.id in locked)) return;
        const name = `${i + 1}${SEP}${tab.name.replace(NUMBERED, "")}`;
        if (name === tab.name) return;
        run("tab.rename", { id: tab.id, name });
        renamed += 1;
      });
      notify({
        title: renamed ? `Renumbered ${renamed} ${renamed === 1 ? "tab" : "tabs"}` : "Tabs already in sequence",
        level: "success",
        timeout: 1500,
      });
    } catch (e) {
      notify({ title: "Could not renumber tabs", body: String(e?.message ?? e), level: "warning" });
    }
  }

  render() {
    return div();
  }
}
