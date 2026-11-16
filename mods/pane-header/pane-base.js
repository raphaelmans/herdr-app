// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "pane" } } } }
// Shows the program's icon (the app's program table), the tab's title (Auto
// Title's), else the agent's name or the terminal's title, the folder, the
// agent's model (model.js) and its status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, theme, home, layout, spaces, terminals, hc } from "herdr";
import { fromLabel, fromText } from "./model.js";

// Match the first visible tab frame, including the active child of a stack.
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter(child => !child.hidden);
    children = [visible.find(child => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// The tab's name when someone named it: Auto Title's ("3 · fix login"), without
// the position it puts in front, or one typed by hand.
function tabTitle(id) {
  for (const s of spaces()) {
    const tab = s.tabs.find((x) => x.id === id);
    if (tab) return tab.named ? tab.name.replace(/^\d+\s*·\s*/, "") : "";
  }
  return "";
}

// A title the agents sidebar wrote for this terminal alone, where several
// agents share a tab and the tab's name can't be theirs (label "agents.title").
function ownTitle(address) {
  return terminals().find((k) => k.address === address)?.labels?.["agents.title"] ?? "";
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init(_props, cx) {
    this.hovered = false;
    this.model = ""; // read from the terminal's text
    this.read = null; // the terminal last read, so a new one is read whole
    // Panes start together: spread their first (whole-history) reads out.
    cx.timer.after(Math.floor(Math.random() * 5000), (cx) => {
      this.readModel(cx);
      cx.timer.every(15000, (cx) => this.readModel(cx));
    });
  }

  // The whole history once (the banner is near the top), then only its end:
  // a /model switch or a status bar change shows up there.
  readModel(cx) {
    const p = this.me();
    if (!p?.terminal || !p.program?.agent || this.reading) return;
    // A labelled model is what render shows: nothing to read for.
    if (fromLabel(terminals().find((k) => k.address === p.terminal)?.labels)) return;
    const whole = this.read !== p.terminal;
    this.reading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["read", p.terminal, "--lines", whole ? "20000" : "200"]);
        const found = r.code === 0 ? fromText(r.stdout) : "";
        if (whole) { this.read = p.terminal; this.model = found; }
        else if (found) this.model = found;
        cx.notify();
      } catch {}
      this.reading = false;
    });
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane/${icon}.svg`).size(14));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = (p.terminal && (ownTitle(p.terminal) || tabTitle(p.tab))) || ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 14, t.dim);
    const st = p.status;
    const model = p.program?.agent ? fromLabel(terminals().find((k) => k.address === p.terminal)?.labels) || this.model : "";
    const pane = p.pane;
    const bottom = paneFrame(layout())?.header?.position === "bottom";
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .when(bottom, el => el.border_t(1))
      .when(!bottom, el => el.border_b(1))
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      .when(Boolean(pic), (el) => el.child(pic))
      .child(div().flex_none().truncate().max_w(260).font_medium().text_color(t.foreground).child(name))
      .child(div().flex_1().truncate().text_color(t.dim).child(folder(p.cwd)))
      .when(Boolean(model), el => el.child(div().flex_none().max_w(160).truncate().text_size(11).text_color(t.dim).child(model)))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
