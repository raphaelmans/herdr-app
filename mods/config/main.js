// Config: the one dialog for every choice this setup's mods read. Terms: GLOSSARY.md.
//
// Each subject is a page, one file each, listed in PAGES below:
//   Agents  ./agents.js  the agent shortlist      shared "agents.shortlist"
//   Writer  ./writer.js  who writes short texts   shared "writer"
//   Models  ./models.js  the model catalog        models.json, shared "models.synced"
//   Worktrunk  ./worktrunk.js  worktrunk's own settings   ~/.config/worktrunk/config.toml
//   Lific   ./lific.js   the Lific agent, and Lific's MCP   shared "lific.agent"
//   Mods    ./mods.js    every mod, on or off     mods/ and mods-disabled/
//   Curtain ./curtain.js no agents on the window  shared "curtain" (mods/curtain)
//   Vaults  ./vaults.js  the connected vault      shared "vault"
//   Health  ./health.js  what the mods need, and what is missing   shared "health"
// While the curtain is drawn the pages about agents (AGENT_PAGES) are passed over.
// The mods that use a choice read its shared key; none of them opens a dialog
// of its own. To add a subject: write a page and add it to PAGES.
//
// A page is a class: constructor(host), start(cx) (once, when first shown),
// key(e, cx) (true when the key was its own), render(t), `hints`, and `typing`
// (true while a text field of its has the keyboard). host provides handle, self,
// show(key, cx) to change page and changed(name, cx) after a mod's switch changes.
//
//   h l, tab / shift-tab, 1-9  change page      esc  close
// Every page takes vim motions: j k move, g G first and last.
//
// Another mod opens it on a page: setShared("config.page", "writer"), then
// mod.open config. Without that it opens where it was left.
//
// With props { role: "toggle" } it is the tab-bar button that opens this. That
// copy also keeps the Writer's choice working on this machine (./writer.js),
// the Lific agent's likewise (./lific.js),
// worktrunk's commit writer equal to it when it follows it (./worktrunk.js),
// the model catalog no more than a day old (./models.js), and looks once for
// missing requirements (./health.js), which mark the button.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, knownAgents, props, run, setShared, shared, theme } from "herdr";
import Agents from "./agents.js";
import Writer, { settle } from "./writer.js";
import Models, { refresh } from "./models.js";
import Worktrunk, { follow } from "./worktrunk.js";
import Lific, { settle as settleLific } from "./lific.js";
import Mods from "./mods.js";
import Curtain from "./curtain.js";
import Vaults from "./vaults.js";
import Health, { HEALTH, survey } from "./health.js";

const SELF = "config";
const PAGE = "config.page";
const PAGES = [
  { key: "agents", name: "Agents", about: "the ones offered when you pick an agent", page: Agents },
  { key: "writer", name: "Writer", about: "writes worktree branch names and agent titles", page: Writer },
  { key: "models", name: "Models", about: "the model catalog, synced from models.dev", page: Models },
  { key: "worktrunk", name: "Worktrunk", about: "its commit writer, where worktrees go, what a merge does", page: Worktrunk },
  { key: "lific", name: "Lific", about: "the agent that carries out Lific requests, and Lific's MCP", page: Lific },
  { key: "mods", name: "Mods", about: "what each is wired to, and a switch for ours", page: Mods },
  { key: "curtain", name: "Curtain", about: "takes every sign of agents off the window", page: Curtain },
  { key: "vaults", name: "Vaults", about: "the Obsidian vaults added here, and the connected one", page: Vaults },
  { key: "health", name: "Health", about: "what the mods need on this computer, and what is missing", page: Health },
];
const AGENT_PAGES = ["agents", "writer", "models", "worktrunk", "lific"];
const hidden = (p) => Boolean(shared("curtain")?.on) && AGENT_PAGES.includes(p.key);

// Escape is bound to an action of this mod's own: while a text field has the
// keyboard, Herdr closes the dialog on Escape before any key handler here sees it.
let escapeBound = false;

export default class Config extends View {
  init(_props, cx) {
    if (!escapeBound) { cx.bind_keys([{ keystroke: "escape", action: "config-escape", context: "ConfigDialog" }]); escapeBound = true; }
    this.role = props()?.role ?? "panel";
    if (this.role === "toggle") {
      cx.spawn(async (cx) => { try { const agents = await knownAgents(); settle(agents); settleLific(agents); } catch {} follow(cx); });
      cx.spawn(async () => { await refresh(); });
      cx.spawn(async () => { await survey(); });
      cx.timer.every(6 * 3600_000, (cx) => { cx.spawn(async () => { await refresh(); }); });
      return;
    }
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.made = {};
    this.at = Math.max(0, PAGES.findIndex((p) => p.key === shared(PAGE)));
    this.show(this.at, cx);
  }

  show(i, cx) {
    const step = i < this.at ? -1 : 1;
    this.at = (i + PAGES.length) % PAGES.length;
    while (hidden(PAGES[this.at])) this.at = (this.at + step + PAGES.length) % PAGES.length;
    const { key, page } = PAGES[this.at];
    if (!this.made[key]) {
      this.made[key] = new page({ handle: this.handle, self: SELF,
        show: (key, cx) => this.show(PAGES.findIndex((p) => p.key === key), cx),
        changed: (name, cx) => {
          if (name === "worktrunk") {
            if (this.made.worktrunk) this.made.worktrunk.reload(cx);
            else follow(cx);
          }
          cx.spawn(async () => { await survey(); });
        },
      });
      this.made[key].start(cx);
    } else if (key === "worktrunk") this.made[key].reload(cx);
    if (shared(PAGE) !== key) setShared(PAGE, key);
    this.handle.focus();
    cx.notify();
  }

  page() { return this.made[PAGES[this.at].key]; }

  key(e, cx) {
    const page = this.page();
    if (page.typing) { page.key(e, cx); return; }
    const m = e.modifiers;
    if (m.control || m.alt || m.platform) return;
    const char = e.key_char ?? e.key;
    if (e.key === "tab") { cx.stop_propagation(); return this.show(this.at + (m.shift ? -1 : 1), cx); }
    if (/^[1-9]$/.test(char) && PAGES[Number(char) - 1]) { cx.stop_propagation(); return this.show(Number(char) - 1, cx); }
    if (page.key(e, cx)) return cx.stop_propagation();
    if (char === "l" || char === "h") { cx.stop_propagation(); return this.show(this.at + (char === "l" ? 1 : -1), cx); }
    if (e.key === "escape") { cx.stop_propagation(); const overlay = props()?.overlay; if (overlay) closeOverlay(overlay); }
  }

  // The tab-bar button: same bar, size and hover as its neighbours.
  button(t) {
    return h_flex().size_full().items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
      .child(h_flex().id("open-config").h(26).px(8).flex_none().items_center().rounded(6).text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => run("mod.open", { name: SELF }))
        .child(svg("mods/config/sliders.svg").size(15).flex_none())
        .when(Boolean(shared(HEALTH)?.missing?.length), (el) => el.child(div().flex_none().ml(4).size(6).rounded_full().bg(t.blocked))));
  }

  render() {
    const t = theme();
    if (this.role === "toggle") return this.button(t);
    const now = PAGES[this.at], page = this.page();
    const nav = v_flex().flex_none().w(150).p(10).gap(2).bg(t.chrome).border_r(1).border_color(t.border)
      .child(h_flex().flex_none().h(30).px(8).gap(8).items_center()
        .child(svg("mods/config/sliders.svg").size(14).flex_none().text_color(t.accent))
        .child(div().text_size(14).font_semibold().child("Config")))
      .children(PAGES.map((p, i) => {
        if (hidden(p)) return div();
        const on = i === this.at;
        return h_flex().id(`page-${p.key}`).flex_none().h(30).px(8).gap(8).items_center().rounded(7).cursor_pointer()
          .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => this.show(i, cx))
          .child(div().flex_1().min_w(0).truncate().text_color(on ? t.foreground : t.muted).child(p.name))
          .when(p.key === HEALTH && Boolean(shared(HEALTH)?.missing?.length), (el) => el.child(div().flex_none().size(6).rounded_full().bg(t.blocked)))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(String(i + 1)));
      }))
      .child(div().flex_1())
      .child(div().px(8).text_size(11).text_color(t.dim).child("h l change page"));
    return h_flex().id("config").track_focus(this.handle).key_context("ConfigDialog").on_action("config-escape", (_e, cx) => this.key({ key: "escape", keystroke: "escape", modifiers: {} }, cx)).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).items_stretch().bg(t.popover).text_size(13).text_color(t.foreground)
      .child(nav)
      .child(v_flex().flex_1().min_w(0).min_h(0).p(14).gap(10)
        .child(h_flex().flex_none().px(4).items_center().gap(10)
          .child(div().flex_none().text_size(15).font_semibold().child(now.name))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(now.about))
          .child(div().flex_none().text_size(11).text_color(t.dim).child("Esc")))
        .child(v_flex().flex_1().min_h(0).gap(10).child(page.render(t)))
        .child(div().flex_none().px(4).truncate().text_size(11).text_color(t.dim).child(page.hints)));
  }
}
