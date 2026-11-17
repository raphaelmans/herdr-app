// The tab bar: a clone of Herdr's `tabs` that follows the curtain (mods/curtain).
// While it is drawn (shared "curtain".on), tabs that are put away or hold only
// agents are left out, no tab shows an agent's icon or status, and + starts a
// plain terminal instead of opening the menu that lists agents.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, focused, run, openOverlay, theme, window, shared, layout, settings } from "herdr";

// The curtain's rule, the same in mods/curtain and spaces-sections.
// An agent: a terminal that reports a status, or runs a program Herdr can start
// as an agent (its own list, as the + menu last saw it) and has not reported yet.
const agentKeys = () => new Set(Object.values(shared("new-menu.agents") ?? {}).flat().map((a) => a.key));
const isAgent = (p, keys) => Boolean(p.terminal && (p.program?.agent || p.status || keys.has(p.program?.key)));
const hiddenTab = (tab, ps, keys) => {
  if (tab.settled) return true;
  const mine = ps.filter((p) => p.tab === tab.id);
  return mine.length > 0 && mine.every((p) => isAgent(p, keys));
};

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init() {
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}");
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const veiled = Boolean(shared("curtain")?.on), ps = panes(), keys = agentKeys();
    // Snoozed agents, as the Agents sidebar (mods/agents-titled) publishes them.
    const asleep = new Set(veiled ? [] : shared("agents.snoozing") ?? []);
    const here = focused()?.pane;
    const shown = (space?.tabs ?? []).filter(tab => !veiled || !hiddenTab(tab, ps, keys));
    const active = shown.findIndex(tab => tab.active);
    const selected = shown[active]?.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const mine = ps.filter(p => p.tab === c.id);
      // The agent a right-click acts on: on the shown tab the focused one, else the tab's first.
      const them = veiled ? [] : mine.filter(p => isAgent(p, keys));
      const agent = (c.active && them.find(p => p.pane === here)) || them[0] || null;
      const program = veiled ? mine.find(p => !isAgent(p, keys))?.program : mine.find(p => p.program?.agent)?.program ?? mine[0]?.program;
      const name = /^tb\d+$/.test(c.name) ? program?.name ?? "Terminal" : c.name;
      // A snoozed tab shrinks to its program's icon and its number; the name is in its tooltip.
      // On the shown tab the focused agent decides; elsewhere every agent in it must be snoozed.
      const sleeping = asleep.size > 0 && them.length > 0 && (c.active && agent?.pane === here ? asleep.has(agent.terminal) : them.every(p => asleep.has(p.terminal)));
      return h_flex().id(`tab-${c.id}`).h(29).px(sleeping ? 8 : 10).gap(sleeping ? 5 : 7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(c.active ? t.border : t.chrome).bg(c.active ? t.raised : t.chrome).text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          const tab = { id: c.id, space: space.id };
          // A tab with an agent gets the agent's menu (mods/agents-titled) with the tab's items
          // under it: 6 rows, a rule and padding. Any other tab gets Herdr's own tab menu.
          if (agent) openOverlay({ mod: "agents-titled", kind: "popup", width: 200, height: 205, props: { rowMenu: { address: agent.terminal, asleep: asleep.has(agent.terminal), tab } } });
          else openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: tab } });
        })
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .when(sleeping, el => el.tooltip(`${name} · Snoozed`).child(div().flex_none().text_color(t.dim).child(String(c.index))))
        .when(!sleeping, el => el.child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name)))
        .when(!sleeping && c.status === "working" && !veiled, el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(!sleeping && !veiled && (c.status === "blocked" || c.status === "done"), el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        .when(c.active && !sleeping, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    const panelButton = (id, label, icon) => {
      const on = panel && !panel.hidden && body?.active === id;
      return h_flex().id(`panel-${id}`).h(26).px(8).gap(5).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click(() => {
          if (on) run("layout.hide", { id: "panel" });
          else { run("layout.select", { stack: "panel-body", child: id }); run("layout.show", { id: "panel" }); }
        }).child(svg(icon).size(14)).child(label);
    };
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => { if (Math.abs(e.delta.y) >= 1) run(e.delta.y > 0 ? "tab.prev" : "tab.next"); })
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } })
        .children(shown.map(item)))
      .child(button("tab-new", "+", () => veiled ? run("tab.new", { space: space?.id }) : openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/files/file.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/changes/changes.svg")))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/tab-bar/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/tab-bar/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/tab-bar/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}
