// Agents page: the agent shortlist, which of the installed agents this machine
// offers wherever an agent is picked (the launcher, the Writer page).
//
// The list and its order are Herdr's (knownAgents(), as the + menu). The
// shortlist only narrows it, and is kept in shared state, so it is this
// machine's own:
//   shared "agents.shortlist": [agent key, ...]   absent or empty: every installed agent
// A mod that lists agents keeps those whose key is in it, and shows them all
// when none of them is installed on the machine it is listing.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { focused, knownAgents, setShared, shared, spaces } from "herdr";
import { heading, box, SHORTLIST, waiting } from "./ui.js";

const chosen = () => { const keys = shared(SHORTLIST); return Array.isArray(keys) && keys.length ? keys : null; };

export default class Agents {
  constructor(host) {
    this.host = host;
    this.agents = null; // installed, in Herdr's order
    this.at = 0;
    this.note = "";
    this.hints = "j k g G move · space offer or not · a offer all · saved as you change it";
  }

  start(cx) {
    // The machine of the space it was opened from, as the launcher lists.
    const space = spaces().find((s) => s.id === focused()?.space) ?? spaces().find((s) => s.active);
    const on = space?.machine ?? null;
    this.where = on ? `on ${on}` : "on this computer";
    cx.spawn(async (cx) => {
      try { this.agents = (await knownAgents({ on })).filter((a) => a.installed); }
      catch { this.agents = []; this.note = "Could not check installed agents."; }
      cx.notify();
    });
  }

  // Offered: every one with no shortlist, else the ones in it.
  offered(key) { const keys = chosen(); return !keys || keys.includes(key); }

  toggle(agent, cx) {
    if (!agent) return;
    const here = this.agents.map((a) => a.key);
    // Keys of agents installed elsewhere stay as they are.
    const elsewhere = (chosen() ?? []).filter((k) => !here.includes(k));
    const now = here.filter((k) => (k === agent.key ? !this.offered(k) : this.offered(k)));
    if (!now.length) { this.note = "One agent has to stay."; return cx.notify(); }
    this.note = "";
    setShared(SHORTLIST, now.length === here.length && !elsewhere.length ? null : [...now, ...elsewhere]);
    cx.notify();
  }

  all(cx) { this.note = ""; setShared(SHORTLIST, null); cx.notify(); }

  key(e, cx) {
    const char = e.key_char ?? e.key, n = this.agents?.length ?? 0;
    if (!n) return false;
    if (e.key === "down" || char === "j") { this.at = (this.at + 1) % n; cx.notify(); }
    else if (e.key === "up" || char === "k") { this.at = (this.at + n - 1) % n; cx.notify(); }
    else if (char === "g" || char === "G") { this.at = char === "g" ? 0 : n - 1; cx.notify(); }
    else if (e.key === "enter" || e.key === "space" || char === " ") this.toggle(this.agents[this.at], cx);
    else if (char === "a") this.all(cx);
    else return false;
    return true;
  }

  render(t) {
    const agents = this.agents ?? [], keys = chosen();
    const count = agents.filter((a) => this.offered(a.key)).length;
    return v_flex().size_full().min_h(0).gap(10)
      .child(h_flex().flex_none().items_end()
        .child(heading(t, "INSTALLED", this.agents ? this.where : waiting(t, "Checking what is installed")).flex_1())
        .child(div().flex_none().px(4).text_size(11).text_color(t.dim).child(!this.agents ? "" : keys ? `${count} of ${agents.length} offered` : "all offered")))
      .child(v_flex().id("agent-rows").flex_1().min_h(0).gap(2).overflow_y_scroll().children(agents.map((a, i) => {
        const on = this.offered(a.key), at = i === this.at;
        return h_flex().id(`agent-${a.key}`).flex_none().h(34).px(10).gap(10).items_center().rounded(8).cursor_pointer()
          .when(at, (el) => el.bg(t.selected)).when(!at, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => { this.at = i; this.host.handle.focus(); this.toggle(a, cx); })
          .child(box(t, on))
          .child(!a.icon ? div().flex_none().w(16) : a.tint ? svg(a.icon).size(16).flex_none().text_color(on ? t.foreground : t.dim) : image(a.icon).w(16).h(16).flex_none())
          .child(div().flex_1().min_w(0).truncate().text_color(on ? t.foreground : t.dim).child(a.name))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(on ? "" : "not offered"));
      })).when(Boolean(this.agents) && !agents.length && !this.note, (el) => el.child(div().px(10).py(6).text_color(t.dim).child("Herdr found no installed agent."))))
      .when(Boolean(this.note), (el) => el.child(div().flex_none().px(4).text_size(12).text_color(t.blocked).child(this.note)))
      .child(h_flex().flex_none().px(4).justify_end()
        .child(div().id("agents-all").flex_none().h(28).px(12).flex().items_center().rounded(8).border_1().border_color(t.border).text_size(12)
          .text_color(keys ? t.foreground : t.dim).when(Boolean(keys), (b) => b.cursor_pointer().hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => this.all(cx)).child("Offer all")));
  }
}
