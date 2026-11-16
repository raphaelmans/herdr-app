// The pane header of this layout: the app's own (pane-base.js, a copy of the
// shipped `mods/pane/main.js`; a mod can't import another mod's files), which
// also records where each header sits in the window.
//
// Herdr has no pane-geometry API; mouse events carry the element's window
// bounds, and on_mouse_down_out fires on every header for any click anywhere,
// so every pane reports after each click (and on hover). Shared "pane-geo":
// { [pane]: { x, y, width, height, tab } }, written only when it changed.
// send-box reads it to keep its window off the pane it sends to.

import { div } from "gpui-kit";
import { panes, props, setShared, shared } from "herdr";
import Pane from "./pane-base.js";

const GEO = "pane-geo";
function recordGeo(pane, b) {
  if (!pane || !b || !(b.width > 0)) return;
  const tab = panes().find((x) => x.pane === pane)?.tab ?? null;
  const next = { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height), tab };
  const all = shared(GEO) ?? {};
  const old = all[pane];
  if (old && old.x === next.x && old.y === next.y && old.width === next.width && old.height === next.height && old.tab === next.tab) return;
  const live = new Set(panes().map((x) => x.pane));
  const kept = Object.fromEntries(Object.entries(all).filter(([k]) => live.has(k)));
  setShared(GEO, { ...kept, [pane]: next });
}

export default class Header extends Pane {
  render(cx) {
    return div()
      .id(`pane-geo-${props()?.pane}`)
      .size_full()
      .on_mouse_down_out((e) => recordGeo(props()?.pane, e.bounds))
      .on_mouse_move((e) => recordGeo(props()?.pane, e.bounds))
      .child(super.render(cx));
  }
}
