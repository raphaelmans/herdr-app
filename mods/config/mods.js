// Mods page: every mod in three groups, what each is wired to, and a switch to
// turn one off and on again. Terms: GLOSSARY.md.
//   Ours      written or cloned here
//   Vendored  someone else's, copied in as it is: the names in ./vendored.json
//   Shipped   Herdr's own. Listed only: Herdr restores them on every start.
//
// Off means its folder is moved from mods/<name> to mods-disabled/<name>:
// Herdr no longer loads it, nothing is deleted, and on moves it back.
// Its keys stay in keys.json (they answer "no mod folder" while it is off).

import { div } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { appHome, exec, keys, notify, readTextFile, setShared, shared } from "herdr";
import * as fs from "fs/promises";
import { chip, toggle, waiting } from "./ui.js";
import { enabled as worktrunkEnabled } from "./worktrunk.js";

const OFF_DIR = "mods-disabled";
const ROW = 54;
const GROUPS = [
  ["ours", "OURS", (n, off) => `${n} · ${n - off} on, ${off} off`],
  ["vendored", "VENDORED", (n, off) => `${n} · someone else's, copied in as it is${off ? ` · ${off} off` : ""}`],
  ["shipped", "SHIPPED", (n) => `${n} · by Herdr, restored on every start, no switch`],
];

// The first sentence of a file's leading // comment.
function summary(source) {
  const lines = [];
  for (const line of (source ?? "").split("\n")) {
    const m = line.match(/^\/\/ ?(.*)$/);
    if (!m || (!m[1].trim() && lines.length)) break;
    if (m[1].trim()) lines.push(m[1].trim());
  }
  const text = lines.join(" ");
  const end = text.search(/\.(\s|$)/);
  return end < 0 ? text : text.slice(0, end + 1);
}

// Every mod a layout names: blocks, pane and stack headers, floats, menus, toasts.
export function layoutMods(node, found = new Set()) {
  if (Array.isArray(node)) node.forEach((n) => layoutMods(n, found));
  else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === "string" && (key === "mod" || key === "terminal_menu" || key === "toast" || (key === "header" && value !== "tabs"))) found.add(value);
      else layoutMods(value, found);
    }
  }
  return found;
}

export async function dirs(path) {
  if (!(await fs.exists(path))) return [];
  return (await fs.readdir(path, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name);
}

export default class Mods {
  constructor(host) {
    this.host = host;
    this.scroll = ScrollHandle.new();
    this.mods = null;
    this.at = 0;
    this.armed = null; // the mod waiting for a second press
    this.busy = null;
    this.error = "";
    this.hints = `j k g G move · space switch on or off · o show folder · r reread · off = moved to ${OFF_DIR}/`;
  }

  start(cx) { this.reload(cx); }

  reload(cx) {
    cx.spawn(async (cx) => {
      try {
        await this.scan();
        this.error = "";
      } catch (e) {
        this.error = String(e?.message ?? e);
        this.mods ??= [];
      }
      this.at = Math.min(this.at, Math.max(0, this.mods.length - 1));
      cx.notify();
    });
  }

  async scan() {
    const root = appHome();
    const installed = JSON.parse((await readTextFile(`${root}/installed.json`)) ?? "{}");
    let vendored = {};
    try { vendored = JSON.parse((await readTextFile(`${root}/mods/${this.host.self}/vendored.json`)) ?? "{}"); } catch {}
    const on = await dirs(`${root}/mods`), off = await dirs(`${root}/${OFF_DIR}`);
    // Worktrunk's controls live in Config and the Launcher. Folder placement
    // still owns its switch; tell already-open copies when it changes.
    await worktrunkEnabled();

    // Which layouts name which mods.
    const inLayout = {};
    for (const file of await fs.readdir(`${root}/layouts`)) {
      if (!file.endsWith(".json")) continue;
      try {
        for (const mod of layoutMods(JSON.parse(await fs.readFile(`${root}/layouts/${file}`, "utf8")))) (inLayout[mod] ??= []).push(file.slice(0, -5));
      } catch {}
    }

    // Which mods open which: `mod: "x"`, `name: "x"` (mod.open) and "mod.open:x" in their code.
    const openedBy = {};
    const grep = await exec("sh", ["-c", `find mods -maxdepth 2 -name '*.js' -size -300k -print0 | xargs -0 grep -EoH '(mod|name): ?"[a-z0-9-]+"|mod\\.open:[a-z0-9-]+'`], { cwd: root });
    for (const line of grep.stdout.split("\n")) {
      const m = line.match(/^mods\/([^/]+)\/[^:]+:.*?([a-z0-9-]+)"?$/);
      if (m && m[1] !== m[2] && !(openedBy[m[2]] ??= []).includes(m[1])) openedBy[m[2]].push(m[1]);
    }

    const bound = keys();
    const mods = [];
    for (const [names, enabled] of [[on, true], [off.filter((n) => !(n in installed)), false]]) {
      for (const name of names) {
        const dir = `${root}/${enabled ? "mods" : OFF_DIR}/${name}`;
        let meta = {};
        try { meta = JSON.parse((await readTextFile(`${dir}/mod.json`)) ?? "{}"); } catch {}
        mods.push({
          name, enabled, dir,
          group: name in installed ? "shipped" : name in vendored ? "vendored" : "ours",
          title: meta.title || name,
          clone: meta.cloned_from?.name ?? null,
          about: summary(await readTextFile(`${dir}/main.js`)),
          keys: [...new Set(bound.filter((k) => k.action === `mod.open:${name}` || k.action.startsWith(`${name}.`) || k.section === `mod:${name}`).map((k) => k.keys))],
          layouts: inLayout[name] ?? [],
          openedBy: (openedBy[name] ?? []).filter((m) => on.includes(m)),
        });
      }
    }
    const order = (m) => GROUPS.findIndex(([key]) => key === m.group);
    this.mods = mods.sort((a, b) => order(a) - order(b) || (a.title.toLowerCase() < b.title.toLowerCase() ? -1 : 1));
  }

  current() { return this.mods?.[this.at]; }

  // The list as drawn: a heading before each group's first mod.
  entries() {
    const mods = this.mods ?? [], out = [];
    mods.forEach((mod, i) => {
      if (mod.group !== mods[i - 1]?.group) out.push({ group: mod.group });
      out.push({ mod, i });
    });
    return out;
  }

  // What stops working, said before the mod goes; null when nothing on screen depends on it.
  warning(mod) {
    const shown = shared("layout");
    if (mod.layouts.includes(shown)) return `The layout on screen (${shown}) shows it. Press again to turn it off anyway.`;
    return null;
  }

  toggle(mod, cx) {
    if (!mod || this.busy) return;
    if (mod.group === "shipped") return notify({ title: `${mod.title} is Herdr's own`, body: "Herdr restores its shipped mods on every start, so it has no switch. Clone it to change it.", level: "info", timeout: 3500 });
    if (mod.name === this.host.self) return notify({ title: "That is this dialog", body: "Turning it off would leave no switch to turn it back on.", level: "warning", timeout: 2500 });
    if (mod.enabled && this.armed !== mod.name && this.warning(mod)) {
      this.armed = mod.name;
      return cx.notify();
    }
    this.armed = null;
    this.busy = mod.name;
    cx.notify();
    cx.spawn(async (cx) => {
      const root = appHome();
      const from = mod.dir, to = `${root}/${mod.enabled ? OFF_DIR : "mods"}/${mod.name}`;
      let failed = "";
      try {
        if (await fs.exists(to)) failed = `${to} already exists`;
        else {
          const r = await exec("sh", ["-c", 'mkdir -p "$(dirname "$2")" && mv "$1" "$2"', "sh", from, to]);
          if (r.code !== 0) failed = r.stderr.trim() || `mv exited ${r.code}`;
        }
      } catch (e) {
        failed = String(e?.message ?? e);
      }
      this.busy = null;
      if (failed) notify({ title: `Could not turn ${mod.title} ${mod.enabled ? "off" : "on"}`, body: failed, level: "error" });
      try { await this.scan(); } catch (e) { this.error = String(e?.message ?? e); }
      if (!failed) this.host.changed?.(mod.name, cx);
      const i = this.mods.findIndex((m) => m.name === mod.name);
      if (i >= 0) this.at = i;
      cx.notify();
    });
  }

  move(delta, cx) {
    const n = this.mods?.length ?? 0;
    if (!n) return;
    this.at = (this.at + delta + n) % n;
    this.armed = null;
    this.scroll.scroll_to_item(this.entries().findIndex((e) => e.i === this.at));
    cx.notify();
  }

  key(e, cx) {
    const char = e.key_char ?? e.key;
    if (e.key === "escape") {
      if (!this.armed) return false;
      this.armed = null; cx.notify();
    } else if (e.key === "down" || char === "j") this.move(1, cx);
    else if (e.key === "up" || char === "k") this.move(-1, cx);
    else if (char === "g") this.move(-this.at, cx);
    else if (char === "G") this.move((this.mods?.length ?? 1) - 1 - this.at, cx);
    else if (e.key === "enter" || e.key === "space" || char === " ") this.toggle(this.current(), cx);
    else if (char === "o" && this.current()) exec("open", [this.current().dir]);
    else if (char === "r") this.reload(cx);
    else return false;
    return true;
  }

  switch(t, mod) {
    const on = mod.enabled, locked = mod.name === this.host.self;
    return toggle(t, on).when(locked || this.busy === mod.name, (el) => el.opacity(0.45));
  }

  row(t, mod, i) {
    const selected = i === this.at, armed = this.armed === mod.name, shipped = mod.group === "shipped";
    const uses = [];
    if (mod.layouts.length) uses.push(`in layout ${mod.layouts.join(", ")}`);
    if (mod.openedBy.length) uses.push(`opened by ${mod.openedBy.join(", ")}`);
    if (mod.clone) uses.push(`clone of ${mod.clone}`);
    const second = armed ? this.warning(mod) : [uses.join(" · "), mod.about].filter(Boolean).join("  —  ") || (mod.keys.length ? "" : "Not wired to a key, a layout or another mod.");
    return h_flex().id(`mod-${mod.name}`).flex_none().h(ROW).px(10).gap(12).items_center().rounded(8).cursor_pointer()
      .when(selected, (el) => el.bg(t.selected)).when(!selected, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { this.at = i; if (this.armed !== mod.name) this.armed = null; this.host.handle.focus(); this.toggle(mod, cx); })
      .child(v_flex().flex_1().min_w(0).gap(3)
        .child(h_flex().gap(6).items_center()
          .child(div().flex_shrink(1).min_w(0).truncate().font_semibold().text_color(mod.enabled ? t.foreground : t.dim).child(mod.title))
          .when(mod.title !== mod.name, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(mod.name)))
          .children(mod.keys.slice(0, 4).map((k) => chip(t, k, mod.enabled ? t.accent : t.dim)))
          .when(mod.name === this.host.self, (el) => el.child(chip(t, "this dialog", t.dim))))
        .child(div().truncate().text_size(12).text_color(armed ? t.blocked : mod.enabled ? t.muted : t.dim).child(second)))
      .child(div().flex_none().w(22).text_size(11).text_color(t.dim).child(shipped ? "" : mod.enabled ? "on" : "off"))
      .child(shipped ? div().flex_none().w(32).text_size(11).text_color(t.dim).child("Herdr") : this.switch(t, mod));
  }

  render(t) {
    const mods = this.mods ?? [];
    const heading = (group) => {
      const [, label, note] = GROUPS.find(([key]) => key === group), of = mods.filter((m) => m.group === group);
      return h_flex().flex_none().h(28).px(10).gap(8).items_end().pb(4).text_size(11)
        .child(div().font_semibold().text_color(t.muted).child(label)).child(div().text_color(t.dim).child(note(of.length, of.filter((m) => !m.enabled).length)));
    };
    return v_flex().size_full().min_h(0).gap(6)
      .when(!this.mods, (el) => el.child(div().px(4).text_color(t.dim).child(waiting(t, "Reading mods"))))
      .when(Boolean(this.error), (el) => el.child(div().px(4).text_color(t.blocked).child(this.error)))
      .child(v_flex().id("mod-list").flex_1().min_h(0).gap(2).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(this.entries().map((e) => (e.mod ? this.row(t, e.mod, e.i) : heading(e.group)))));
  }
}
