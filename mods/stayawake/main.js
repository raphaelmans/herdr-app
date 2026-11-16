// Stay awake: a tab-bar button that keeps this Mac from sleeping, for agents
// left running. It carries its own script (./stayawake.sh) and only runs it.
//
//   off   normal sleep                              muted cup
//   on    awake while the lid is open               accent cup
//   lid   awake with the lid closed too             accent cup with a dot
//
// Click: on / off, in the mode used last. Right-click: lid mode on / off.
// Lid mode changes a system setting, so macOS asks for the password each time
// it is switched; plain on and off never ask. What it sets outlives the window,
// like the terminals do. Keys reach it as commands (none bound by default):
//   stayawake.toggle | on | lid | off

import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { appHome, checking, exec, nextCommand, notify, theme } from "herdr";

const POLL = 20000; // the script can be run from a shell too
const TIP = {
  off: "Stay awake: off. Click to keep this Mac awake, right-click to include lid closed",
  on: "Stay awake: on, closing the lid still sleeps. Click to turn off, right-click to include lid closed",
  lid: "Stay awake: on, lid closed included. Click to turn off, right-click to let the lid sleep it",
};

export default class StayAwake extends View {
  init(_props, cx) {
    this.state = null;
    this.busy = false;
    try { this.mode = localStorage.getItem("mode") === "lid" ? "lid" : "on"; } catch { this.mode = "on"; }
    if (checking()) return; // a check draws the button; it runs no script
    cx.timer.every(POLL, (cx) => { if (!this.busy) this.refresh(cx); });
    this.refresh(cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "toggle") this.toggle(cx);
        else if (command === "on" || command === "lid" || command === "off") this.set(command, cx);
      }
    });
  }

  script(args, timeout) {
    return exec("bash", [`${appHome()}/mods/stayawake/stayawake.sh`, ...args], { timeout });
  }

  async read() {
    const r = await this.script(["state"]);
    const state = r.stdout.trim();
    if (!["off", "on", "lid"].includes(state)) return;
    if (state !== "off" && state !== this.mode) {
      this.mode = state;
      try { localStorage.setItem("mode", state); } catch {}
    }
    this.state = state;
  }

  refresh(cx) {
    cx.spawn(async (cx) => {
      const was = this.state;
      try { await this.read(); } catch {}
      if (this.state !== was) cx.notify();
    });
  }

  toggle(cx) { this.set(this.state === "off" ? this.mode : "off", cx); }

  set(want, cx) {
    if (this.busy || this.state === null || this.state === want) return;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        // Long enough to type a password into the system dialog.
        const args = want === "off" ? ["off"] : want === "lid" ? ["on", "--keep-awake"] : ["on"];
        const r = await this.script(args, 180000);
        // -128: the password dialog was cancelled, nothing changed.
        if (r.code !== 0 && !r.stderr.includes("-128")) {
          notify({ title: "Stay awake", body: r.stderr.trim().split("\n").pop() || `exit ${r.code}`, level: "error" });
        }
        await this.read();
      } catch (e) {
        notify({ title: "Stay awake", body: String(e?.message ?? e), level: "error" });
      }
      this.busy = false;
      cx.notify();
    });
  }

  // Same bar, size and hover as the tab-bar buttons beside it.
  render() {
    const t = theme();
    const state = this.state ?? "off", on = state !== "off";
    const cup = svg("mods/stayawake/coffee.svg").size(15).flex_none();
    return h_flex().size_full().items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("stayawake").relative().h(26).px(8).flex_none().items_center().rounded(6)
        .text_color(on ? t.accent : t.muted).tooltip(TIP[state])
        .hover((s) => (on ? s.bg(t.hover) : s.bg(t.hover).text_color(t.foreground)))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click((_e, cx) => this.toggle(cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.set(state === "lid" ? "on" : "lid", cx); })
        .child(this.busy ? cup.loop("opacity", { from: 0.35, to: 1, period: 900 }) : cup)
        .when(state === "lid", (el) => el.child(div().absolute().top(3).right(4).size(5).rounded(3).bg(t.accent))));
  }
}
