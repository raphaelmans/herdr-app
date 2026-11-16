// Lific request key: an opener for the Lific window (mods/lific), straight into
// its request box. Unseen; it asks and goes away. Terms: GLOSSARY.md (Opener,
// Lific request).
//
// `mod.open:lific` alone toggles the window, so pressing the request key while
// it is up would close it. This sets shared "lific.ask" { n, at } instead: a
// window that is up answers with shared "lific.ack" = n and takes the keyboard
// to its box; with no answer, the window is opened and reads the same ask.
//
// Bound to cmd-shift-i (keys.json) and ctrl-a I (mods/tmux-prefix).

import { View, div } from "gpui-kit";
import { checking, closeOverlay, notify, props, run, setShared, shared } from "herdr";

export default class LificRequest extends View {
  init(_props, cx) {
    if (checking()) return; // a check draws nothing and opens nothing
    const go = () => closeOverlay(props()?.overlay);
    if (shared("curtain")?.on) { notify({ title: "The curtain is drawn", body: "Lift it to make a Lific request.", level: "warning", timeout: 2500 }); return go(); }
    const n = Date.now();
    setShared("lific.ask", { n, at: n });
    cx.timer.after(150, () => { const up = shared("lific.ack") === n; go(); if (!up) run("mod.open", { name: "lific" }); });
  }

  render() { return div(); }
}
