// Go to a tab in any space, in a content-sized popup capped by the window with vertical
// insets. Spaces with something that needs you come first, then the one you are in;
// other quiet spaces (no agent running) fold into "earlier". Last rows: new work (a tab here, a space on this
// computer or on each connected machine).
//
// Keys follow Find a file (Cmd+O): it opens in NORMAL, where j/k g/G move,
// l or Enter goes, / or i searches, ? shows the keys and q closes. While
// searching (INSERT) letters are typed and arrows or Ctrl+J/K/N/P move.
// Escape steps back: help, then search (keeping what was typed), then close.
// Ctrl+D closes the selected tab in either mode.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { agents, spaces, terminals, run, hc, theme, settings, props, closeOverlay, shared, setShared } from "herdr";

const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// Space colors, kept by space id in shared "space.colors": a theme
// color name ("ansi6") or a picked #rrggbb. A space seen without one gets
// the theme color fewest spaces use, once; every mod does the same in the
// same order, so they agree, and adding or renaming spaces moves nothing.
const PROJECT_COLORS = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
function spaceColors() {
  const ids = new Set(spaces().map((p) => p.id));
  const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
  let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
  for (const p of spaces()) {
    if (kept[p.id] || p.name === "~") continue;
    const uses = (c) => Object.values(kept).filter((v) => v === c).length;
    kept[p.id] = PROJECT_COLORS.reduce((best, c) => (uses(c) < uses(best) ? c : best));
    changed = true;
  }
  if (changed) setShared("space.colors", kept);
  return kept;
}
function spaceColor(t, p) {
  if (p.name === "~") return t.dim;
  const c = spaceColors()[p.id] ?? PROJECT_COLORS[0];
  return c.startsWith("#") ? c : (MARK[c] ?? t[c]);
}

// Escape must be an action: Herdr's own Escape otherwise closes the popup
// before the search field can be left.
let keysBound = false;
const HELP = [
  "Esc: leave search → close",
  "j / k: down / up     g / G: first / last",
  "Page Down / Page Up: a page at a time",
  "l / Enter: go     / or i: search",
  "Ctrl+J / Ctrl+K or Ctrl+N / Ctrl+P: move while searching",
  "Ctrl+D: close the selected tab",
  "q: close     ?: help     Esc / q: leave help",
];

export default class Picker extends View {
  init(_props, cx) {
    if (!keysBound) {
      cx.bind_keys([
        { keystroke: "escape", action: "go-to-escape", context: "GoTo" },
        ...["n", "j", "p", "k"].map((key) => ({ keystroke: `ctrl-${key}`, action: `go-to-ctrl-${key}`, context: "GoTo" })),
      ]);
      keysBound = true;
    }
    this.typing = false;
    this.help = false;
    this.pageRows = 10;
    this.filter = "";
    this.input = InputState.new({ placeholder: "Go to a tab, space or agent…" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = this.filter ? Math.max(0, this.rows().filter(r => r.kind !== "head").findIndex(r => r.kind === "ctx")) : 0;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.go(this.rows().filter(r => r.kind !== "head")[this.at], cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.at = null;
    this.scroll = 0;
    this.showEarlier = false;
    this.machines = [];
    this.handle = cx.focus_handle();
    // The popup takes the keyboard a moment after it opens; claim it again.
    this.handle.focus();
    for (const ms of [100, 600]) cx.timer.after(ms, () => { if (!this.typing) this.handle.focus(); });
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => m.state === "connected" && !m.temporary).map((m) => m.name);
      } catch {}
      cx.notify();
    });
  }

  close() {
    closeOverlay(props().overlay);
  }

  pickable() {
    return this.rows().filter((r) => r.kind !== "head");
  }

  // Keep the keyboard where it was: the search field while typing, the list otherwise.
  refocus() {
    if (this.typing) this.input.focus();
    else this.handle.focus();
  }

  normal(cx) {
    this.typing = false;
    this.handle.focus();
    cx.notify();
  }

  escape(cx) {
    if (this.help) { this.help = false; this.normal(cx); }
    else if (this.typing) this.normal(cx);
    else this.close();
    cx.stop_propagation();
  }

  move(to, cx) {
    this.at = Math.max(0, Math.min(to, this.pickable().length - 1));
    cx.notify();
  }

  control(key, cx) {
    if (this.help) return;
    this.move((this.at ?? 0) + { n: 1, j: 1, p: -1, k: -1 }[key], cx);
    cx.stop_propagation();
  }

  keys(e, cx) {
    const m = e.modifiers ?? {}, key = e.key;
    const ch = e.key_char ?? (m.shift ? key.toUpperCase() : key);
    if (m.platform || m.alt) return;
    if (key === "escape") return this.escape(cx);
    if (this.help) {
      if (ch === "q" || ch === "?") { this.help = false; this.normal(cx); }
      cx.stop_propagation(); return;
    }
    const at = this.at ?? 0;
    if (m.control) {
      if (key !== "d") return; // Scoped actions handle the rest, including in the search field.
      const sel = this.pickable()[at];
      if (sel?.kind === "ctx") { this.close(); run("tab.close", { id: sel.ctx.id }); }
      cx.stop_propagation(); return;
    }
    // Printable keys belong to the search field while typing; j/k never eat a search.
    if (this.typing) {
      const step = { down: 1, up: -1, pagedown: this.pageRows, pageup: -this.pageRows }[key];
      if (step !== undefined) { this.move(at + step, cx); cx.stop_propagation(); }
      return;
    }
    if (ch === "j" || key === "down") this.move(at + 1, cx);
    else if (ch === "k" || key === "up") this.move(at - 1, cx);
    else if (ch === "g" || key === "home") this.move(0, cx);
    else if (ch === "G" || key === "end") this.move(Infinity, cx);
    else if (key === "pagedown") this.move(at + this.pageRows, cx);
    else if (key === "pageup") this.move(at - this.pageRows, cx);
    else if (ch === "l" || key === "right" || key === "enter") this.go(this.pickable()[at], cx);
    else if (ch === "/" || ch === "i") { this.typing = true; this.input.focus(); cx.notify(); }
    else if (ch === "q") this.close();
    else if (ch === "?") { this.help = true; cx.notify(); }
    else return;
    cx.stop_propagation();
  }

  rows() {
    const hidden = new Set((shared("spaces.sections")?.sections ?? []).filter((s) => s.hidden).flatMap((s) => s.members));
    const f = this.filter.toLowerCase();
    const all = agents();
    const excluded = new Set(all.filter((a) => hidden.has(a.space)).map((a) => a.address));
    const live = terminals().filter((x) => {
      const space = x.labels?.["herdr.space"];
      const prefix = x.address.slice(0, x.address.lastIndexOf("/") + 1);
      return x.state === "live" && !excluded.has(x.address) && !(space && hidden.has(prefix + space));
    });
    const teamOf = (addrs) => {
      let n = 0;
      const walk = (a) => live.filter((x) => x.parent === a).forEach((k) => (n++, walk(k.address)));
      addrs.forEach(walk);
      return n;
    };
    const groups = spaces().filter((w) => !hidden.has(w.id)).map((w) => {
      const ctxs = w.tabs
        .map((ctx) => {
          const mine = all.filter((a) => a.tab === ctx.id);
          return { w, ctx, mine, team: teamOf(mine.map((a) => a.address)) };
        })
        .filter((c) => !f || [w.name, c.ctx.name, ...c.mine.map((a) => a.program?.name ?? "")].join(" ").toLowerCase().includes(f));
      return { w, ctxs };
    });
    // The space you are in never folds away: Go to opens on it.
    const shown = (p) => p.w.status || p.w.active;
    const busy = groups.filter((p) => shown(p) && p.ctxs.length);
    const quiet = groups.filter((p) => !shown(p) && p.ctxs.length);
    busy.sort((a, b) => (b.w.status === "blocked") - (a.w.status === "blocked"));
    const out = [];
    const add = (p) => {
      out.push({ kind: "head", w: p.w });
      for (const c of p.ctxs) out.push({ kind: "ctx", ...c });
    };
    busy.forEach(add);
    if (quiet.length) {
      out.push({ kind: "earlier", count: quiet.length });
      if (this.showEarlier || f) quiet.forEach(add);
    }
    out.push({ kind: "new" });
    out.push({ kind: "space", machine: null });
    for (const m of this.machines) out.push({ kind: "space", machine: m });
    return out;
  }

  go(r, cx) {
    if (!r) return;
    if (r.kind === "earlier") {
      this.at = this.rows().filter(r => r.kind !== "head").findIndex(r => r.kind === "earlier");
      this.showEarlier = !this.showEarlier;
      this.refocus();
      cx.notify();
      return;
    }
    this.close();
    if (r.kind === "ctx") run("tab.select", { id: r.ctx.id });
    else if (r.kind === "new") run("tab.new");
    else if (r.kind === "space") run("space.new", { machine: r.machine ?? "" });
  }

  glyph(t, st) {
    if (st === "working") return svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900);
    return div().w(12).flex_none().text_color(t[st] ?? t.dim).child(st === "idle" ? "○" : st ? "●" : "·");
  }

  render() {
    const t = theme();
    const rows = this.rows();
    const pickable = rows.filter((r) => r.kind !== "head");
    // Opens on where you are.
    if (this.at === null) this.at = Math.max(0, pickable.findIndex((r) => r.kind === "ctx" && r.w.active && r.ctx.active));
    this.at = Math.min(this.at, pickable.length - 1);
    const sel = pickable[this.at];
    const tabs = pickable.filter((r) => r.kind === "ctx").length;
    // One continuous strip: each row (and the group title before it) at a fixed
    // y. Scrolling moves the strip only as far as it takes to keep the selected
    // row in view, so the arrows can't run the selection off the list.
    const H = { head: 29, earlier: 35, new: 36, ctx: 32, space: 32 };
    const tops = [];
    let y = 0;
    rows.forEach((r) => { tops.push(y); y += H[r.kind] ?? 32; });
    const total = this.help ? HELP.length * 24 : y;
    // 18px outer insets plus the popup border; 142px for padding, header, search, footer and gaps.
    const availableHeight = Math.max(0, window.viewport_size().height / settings().zoom - 38);
    const panelHeight = Math.min(total + 142, availableHeight);
    const height = Math.max(1, panelHeight - 142);
    this.pageRows = Math.max(1, Math.floor(height / 32));
    const fixed = !this.help && total > height;
    const maxScroll = Math.max(0, total - height);
    this.scroll = Math.max(0, Math.min(this.scroll, maxScroll));
    const si = rows.indexOf(sel);
    if (si >= 0) {
      if (tops[si] < this.scroll) this.scroll = tops[si];
      if (tops[si] + (H[sel.kind] ?? 32) > this.scroll + height) this.scroll = tops[si] + (H[sel.kind] ?? 32) - height;
    }
    const place = (el, i) =>
      fixed
        ? el.absolute().left(0).right(0).top(tops[i] - this.scroll).bottom(height - (tops[i] + (H[rows[i].kind] ?? 32) - this.scroll))
        : el;
    const visible = (i) => !fixed || (tops[i] + (H[rows[i].kind] ?? 32) > this.scroll && tops[i] < this.scroll + height);

    const row = (r) => {
      if (r.kind === "head") {
        return h_flex()
          .px(10)
          .pt(10)
          .pb(3)
          .gap(8)
          .items_center()
          .text_size(11)
          .font_semibold()
          .text_color(t.dim)
          .child(h_flex().size(18).rounded(5).bg(spaceColor(t, r.w)).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...r.w.name][0]?.toUpperCase() ?? "?"))
          .child(r.w.name);
      }
      if (r.kind === "earlier") {
        return h_flex()
          .id("pk-earlier")
          .mt(6)
          .px(10)
          .py(6)
          .border_t(1)
          .border_color(t.border)
          .text_size(12)
          .text_color(t.dim)
          .cursor_pointer()
          .when(r === sel, (el) => el.bg(t.hover).text_color(t.foreground))
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.go(r, cx))
          .child(`earlier: ${r.count} quiet space${r.count > 1 ? "s" : ""} ${this.showEarlier ? "▴" : "▾"}`);
      }
      const on = r === sel;
      if (r.kind === "new" || r.kind === "space") {
        const label = r.kind === "new" ? "new tab" : r.machine ? `new space on ${r.machine}` : "new space";
        return h_flex()
          .id(r.kind === "new" ? "pk-new" : `pk-space-${r.machine ?? "here"}`)
          .mx(4)
          .when(r.kind === "new", (el) => el.mt(4))
          .px(10)
          .h(32)
          .items_center()
          .rounded(7)
          .gap(8)
          .text_color(t.muted)
          .cursor_pointer()
          .when(on, (el) => el.bg(t.hover))
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.go(r))
          .child(div().w(12).child("+"))
          .child(label);
      }
      const who = r.mine.map((a) => a.program?.name ?? "agent").join(" · ");
      const here = r.w.active && r.ctx.active;
      return h_flex()
        .id(`pk-${r.ctx.id}`)
        .mx(4)
        .px(10)
.h(32)
        .rounded(7)
        .gap(10)
        .items_center()
        .cursor_pointer()
        .when(on, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click(() => this.go(r))
        .child(this.glyph(t, r.ctx.status))
        .child(div().flex_1().truncate().text_color(t.foreground).when(here, (d) => d.font_semibold()).child(r.ctx.name))
        .when(r.ctx.status === "blocked", (el) => el.child(div().text_size(11).text_color(t.blocked).child("needs you")))
        .when(r.ctx.status === "done", (el) => el.child(div().text_size(11).text_color(t.done).child("finished")))
        .child(div().text_size(11).text_color(t.dim).child(who + (r.team ? `  +${r.team}` : "")));
    };

    return v_flex()
      .id("picker")
      .track_focus(this.handle)
      .key_context("GoTo")
      .on_action("go-to-escape", (_e, cx) => this.escape(cx))
      .on_action("go-to-ctrl-n", (_e, cx) => this.control("n", cx))
      .on_action("go-to-ctrl-j", (_e, cx) => this.control("j", cx))
      .on_action("go-to-ctrl-p", (_e, cx) => this.control("p", cx))
      .on_action("go-to-ctrl-k", (_e, cx) => this.control("k", cx))
      .w_full()
      .h(panelHeight)
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => this.keys(e, cx))
      .child(h_flex().h(24).flex_none().items_center().gap(10)
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Go to…"))
        .child(div().id("picker-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")))
      .child(
        h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(this.typing ? t.accent : t.border).bg(t.background)
          .child(svg("mods/workspace-chrome/search.svg").size(15).text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)),
      )
      .child(
        v_flex()
          .id("pk-list")
          .flex_1()
          .min_h(0)
          .when(fixed, (el) =>
            el.overflow_hidden().on_scroll_wheel((e, cx) => {
              this.scroll = Math.max(0, Math.min(this.scroll - e.delta.y, maxScroll));
              // The selection follows the wheel, so the next frame doesn't scroll back to it.
              while (this.at < pickable.length - 1 && tops[rows.indexOf(pickable[this.at])] < this.scroll) this.at++;
              while (this.at > 0 && tops[rows.indexOf(pickable[this.at])] + (H[pickable[this.at].kind] ?? 32) > this.scroll + height) this.at--;
              cx.notify();
            }))
          .children(this.help
            ? HELP.map((text) => div().h(24).px(10).text_color(t.foreground).truncate().child(text))
            : rows.map((r, i) => (visible(i) ? place(row(r), i) : null)).filter(Boolean)),
      )
      .child(div().h(16).flex_none().px(10).text_size(11).text_color(t.dim).truncate().child(this.help
        ? "Keyboard controls · Esc or q back"
        : this.typing
          ? `${tabs} tab${tabs === 1 ? "" : "s"} · INSERT · Esc navigate · Ctrl+J/K select · Enter go`
          : `${tabs} tab${tabs === 1 ? "" : "s"} · NORMAL · j/k move · / search · Enter/l go · ? help`));
  }
}
