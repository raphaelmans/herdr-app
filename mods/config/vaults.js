// Vaults page: the Obsidian vaults added here, and which one is the connected
// vault. Terms: GLOSSARY.md.
//
// The list is this setup's own: a vault is here because it was added on this
// page, not because Obsidian has opened it. Both are kept in shared state:
//   shared "vaults": [{ name, path }]   in the order added
//   shared "vault":  { name, path }     absent: no connected vault
// A mod that wants the vault reads "vault" (tmux-prefix: ctrl-a o opens it in
// Obsidian, ctrl-a Y copies its path).
//
// Opening goes through Obsidian's own link, which starts Obsidian when it is
// not running and brings it to the vault when it is.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, pickFolder, setShared, shared } from "herdr";
import { heading, box, tildify } from "./ui.js";

const VAULT = "vault";
const VAULTS = "vaults";
const trim = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
const list = () => (Array.isArray(shared(VAULTS)) ? shared(VAULTS).filter((v) => typeof v?.path === "string") : []);

export default class Vaults {
  constructor(host) {
    this.host = host;
    this.at = 0;
    this.note = "";
    this.picking = false;
    this.hints = "j k g G move · a add a folder · d take off the list · space connect or not · o open in Obsidian · y copy path";
  }

  start(cx) {
    this.at = Math.max(0, list().findIndex((v) => v.path === shared(VAULT)?.path));
    cx.notify();
  }

  add(cx) {
    if (this.picking) return;
    this.picking = true;
    this.note = "";
    cx.notify();
    cx.spawn(async (cx) => {
      let picked = null;
      try { picked = await pickFolder({ prompt: "Add vault" }); }
      catch (e) { this.note = String(e?.message ?? e); }
      this.picking = false;
      this.host.handle.focus();
      if (picked) {
        const path = trim(picked), vaults = list();
        const i = vaults.findIndex((v) => v.path === path);
        if (i >= 0) { this.at = i; this.note = `${vaults[i].name} is already on the list.`; }
        else {
          const name = path.replace(/^.*\//, "") || path;
          setShared(VAULTS, [...vaults, { name, path }]);
          this.at = vaults.length;
          this.note = `Added ${name}.`;
          if (!shared(VAULT)?.path) setShared(VAULT, { name, path });
        }
      }
      cx.notify();
    });
  }

  // Off the list only: the folder and its notes stay where they are.
  drop(vault, cx) {
    if (!vault) return;
    const vaults = list().filter((v) => v.path !== vault.path);
    setShared(VAULTS, vaults);
    if (shared(VAULT)?.path === vault.path) setShared(VAULT, null);
    this.at = Math.min(this.at, Math.max(0, vaults.length - 1));
    this.note = `Took ${vault.name} off the list. Its folder is untouched.`;
    cx.notify();
  }

  connect(vault, cx) {
    if (!vault) return;
    this.note = "";
    setShared(VAULT, shared(VAULT)?.path === vault.path ? null : { name: vault.name, path: vault.path });
    cx.notify();
  }

  open(vault, cx) {
    if (!vault) return;
    this.note = `Opening ${vault.name} in Obsidian…`;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("open", [`obsidian://open?path=${encodeURIComponent(vault.path)}`]);
        this.note = r.code === 0 ? "" : (r.stderr.trim() || "Could not open Obsidian.");
      } catch (e) { this.note = String(e?.message ?? e); }
      cx.notify();
    });
  }

  copy(vault, cx) {
    if (!vault) return;
    cx.write_to_clipboard(vault.path);
    this.note = `Copied ${tildify(vault.path)}`;
    cx.notify();
  }

  key(e, cx) {
    const char = e.key_char ?? e.key, vaults = list(), n = vaults.length;
    if (char === "a") { this.add(cx); return true; }
    if (!n) return false;
    const vault = vaults[Math.min(this.at, n - 1)];
    if (e.key === "down" || char === "j") { this.at = (this.at + 1) % n; this.note = ""; cx.notify(); }
    else if (e.key === "up" || char === "k") { this.at = (this.at + n - 1) % n; this.note = ""; cx.notify(); }
    else if (char === "g" || char === "G") { this.at = char === "g" ? 0 : n - 1; this.note = ""; cx.notify(); }
    else if (e.key === "enter" || e.key === "space" || char === " ") this.connect(vault, cx);
    else if (char === "d") this.drop(vault, cx);
    else if (char === "o") this.open(vault, cx);
    else if (char === "y") this.copy(vault, cx);
    else return false;
    return true;
  }

  render(t) {
    const vaults = list(), now = shared(VAULT);
    const at = Math.min(this.at, Math.max(0, vaults.length - 1));
    const gone = now?.path && !vaults.some((v) => v.path === now.path);
    return v_flex().size_full().min_h(0).gap(10)
      .child(h_flex().flex_none().items_end()
        .child(heading(t, "VAULTS", this.picking ? "choosing a folder…" : "the ones added here, in the order added").flex_1())
        .child(div().flex_none().px(4).text_size(11).text_color(t.dim).child(now?.name ? `connected: ${now.name}` : "none connected")))
      .child(v_flex().id("vault-rows").flex_1().min_h(0).gap(2).overflow_y_scroll()
        .children(vaults.map((v, i) => {
          const on = now?.path === v.path, here = i === at;
          return h_flex().id(`vault-${i}`).flex_none().h(42).px(10).gap(10).items_center().rounded(8).cursor_pointer()
            .when(here, (el) => el.bg(t.selected)).when(!here, (el) => el.hover((s) => s.bg(t.hover)))
            .on_click((_e, cx) => { this.at = i; this.host.handle.focus(); this.connect(v, cx); })
            .child(box(t, on))
            .child(v_flex().flex_1().min_w(0)
              .child(div().truncate().text_color(on ? t.foreground : t.muted).child(v.name))
              .child(div().truncate().text_size(11).text_color(t.dim).child(tildify(v.path))));
        }))
        .child(h_flex().id("vault-add").flex_none().h(34).px(10).gap(10).items_center().rounded(8).cursor_pointer().text_color(t.muted)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.add(cx))
          .child(div().flex_none().w(15).text_size(14).child("+"))
          .child(div().flex_1().min_w(0).truncate().child(vaults.length ? "Add a vault" : "No vault yet. Add the folder of one."))
          .child(div().flex_none().text_size(11).text_color(t.dim).child("a"))))
      .when(Boolean(gone), (el) => el.child(div().flex_none().px(4).text_size(12).text_color(t.blocked).child(`The connected vault, ${now.name}, is not on the list.`)))
      .when(Boolean(this.note), (el) => el.child(div().flex_none().px(4).text_size(12).text_color(t.muted).child(this.note)));
  }
}
