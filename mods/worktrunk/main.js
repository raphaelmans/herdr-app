// Worktrunk: worktrees in the Launcher and its settings and Writer sync in Config.
// Off by default. Config → Mods moves this folder to mods/ to turn it on.
// Config and the Launcher check that placement before using wt; no saved
// shared value can enable it on a new machine. Opening it goes to its Config page.

import { View, div } from "gpui-kit";
import { checking, closeOverlay, props, run, setShared } from "herdr";

export default class Worktrunk extends View {
  init() {
    if (checking()) return;
    setShared("config.page", "worktrunk");
    const overlay = props()?.overlay;
    if (overlay) closeOverlay(overlay);
    run("mod.open", { name: "config" });
  }

  render() { return div(); }
}
