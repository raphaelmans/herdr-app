// The fork shortcut opens the same Launcher as a new tab or split. The
// Launcher returns the chosen agent here; only then do we fork or hand over.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { checking, closeOverlay, focused, notify, openOverlay, panes, props, shared, theme } from "herdr";
import { inspect, supportsFork, start } from "./session.js";

export default class AgentFork extends View {
  init(_props, cx) {
    this.status = "Finding the source agent…";
    if (checking()) return;
    const ask = props(), overlay = ask.overlay;
    const pane = panes().find((p) => p.pane === (ask.source?.pane ?? focused()?.pane));
    const source = ask.source ?? { pane: pane?.pane, terminal: pane?.terminal };
    cx.spawn(async (cx) => {
      try {
        if (shared("curtain")?.on) return;
        const current = await inspect(source);
        if (!ask.target) {
          closeOverlay(overlay);
          openOverlay({ mod: "launcher", kind: "dialog", width: 500, height: 680, frame: "none",
            props: { place: "right", fork: { pane: current.pane.pane, terminal: current.pane.terminal,
              key: current.agent.key, name: current.agent.name, canFork: supportsFork(current.agent.key) } } });
          return;
        }
        const same = current.agent.key === ask.target.key;
        this.status = same ? "Forking " + current.agent.name + "…" : "Opening " + ask.target.name + " and requesting a handover…";
        cx.notify();
        const result = await start(current, ask.target);
        if (result.handover) notify({ title: "Handover requested from " + current.agent.name,
          body: ask.target.name + " is open beside it. The source will send the context with hc send.", timeout: 5000 });
        else if (result.guessed) notify({ title: "Forked the latest " + current.agent.name + " session here",
          body: current.folder ?? "", level: "warning", timeout: 4000 });
      } catch (e) {
        notify({ title: "Fork / handover failed", body: String(e?.message ?? e), level: "error", timeout: 7000 });
      } finally {
        closeOverlay(overlay);
      }
    });
  }

  render() {
    const t = theme();
    return v_flex().w_full().p(16).gap(10).rounded(10).border(1).border_color(t.border).bg(t.popover).shadow_lg()
      .text_size(13).text_color(t.foreground)
      .child(div().font_semibold().child("Fork agent session"))
      .child(h_flex().gap(10).items_center()
        .child(div().text_color(t.muted).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90))
        .child(div().flex_1().child(this.status ?? "Finding the source agent…")));
  }
}
