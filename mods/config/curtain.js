// Curtain page: the switch that takes every sign of agents off the window, and
// what goes while it is drawn. The work is the curtain mod's (mods/curtain);
// this page only sends it `curtain.toggle` and reads its state:
//   shared "curtain": { on, parked, settled, ... }

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { keys, run, shared } from "herdr";
import { heading } from "./ui.js";

const GOES = [
  ["Tabs with only agents", "put away, still running; spaces with nothing else are left out"],
  ["Agents beside a shell", "taken out of the tab, still running; put back to the right of their neighbour"],
  ["Agents list, counts and status marks", "sidebar, tab bar and status bar"],
  ["Skillshare", "its tab-bar button and panel"],
  ["Agent choices", "the + menu, the launcher, the Agents, Writer and Models pages"],
  ["Agent keys", "agent hub, fork, next and previous agent, Go to"],
  ["Notifications and sounds", "finished and needs-you toasts, the attention sounds"],
];

export default class Curtain {
  constructor(host) {
    this.host = host;
    this.hints = "space or enter draw or lift";
  }

  start() {}

  key(e) {
    const char = e.key_char ?? e.key;
    if (e.key !== "enter" && e.key !== "space" && char !== " ") return false;
    run("curtain.toggle");
    return true;
  }

  render(t) {
    const st = shared("curtain") ?? {}, on = Boolean(st.on);
    const bound = keys().find((k) => k.action === "curtain.toggle")?.keys;
    const away = (st.parked?.length ?? 0) + (st.settled?.length ?? 0);
    return v_flex().size_full().min_h(0).gap(10)
      .child(h_flex().id("curtain-switch").flex_none().h(44).px(12).gap(12).items_center().rounded(8).bg(t.selected).cursor_pointer()
        .on_click(() => { this.host.handle.focus(); run("curtain.toggle"); })
        .child(h_flex().flex_none().w(30).h(18).px(2).items_center().rounded(9).bg(on ? t.accent : t.input)
          .when(on, (el) => el.justify_end())
          .child(div().size(14).rounded(7).bg(on ? t.accent_foreground : t.muted)))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().child(on ? "Drawn: no agents on the window" : "Lifted: everything shows"))
          .child(div().truncate().text_size(11).text_color(t.dim).child(on ? `${away} put away or taken out so far, all still running` : "Draw it before sharing the screen")))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(bound ?? "no key")))
      .child(heading(t, "WHILE DRAWN", "nothing is ended; lifting it brings all of it back"))
      .child(v_flex().id("curtain-goes").flex_1().min_h(0).gap(2).overflow_y_scroll().children(GOES.map(([what, how], i) =>
        h_flex().id(`goes-${i}`).flex_none().h(30).px(10).gap(10).items_center()
          .child(div().flex_none().w(230).truncate().child(what))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(how)))));
  }
}
