// Agent hub: every running agent in one floating window, two ways.
//
//   Left:  the agents in the space you opened it from (a: every space), live status.
//   Right: the selected agent's recent screen, refreshed while you watch.
//
//   enter / i   message the selected agent (the send box, aimed at it)
//   p           pull: the selected agent's recent output goes into the send box, aimed
//               at the pane you opened the hub from
//
// Both work like Claude Code's own cross-session messages, for any agent CLI: what
// arrives is wrapped in a tag naming the session it came from, and the receiver
// answers that session by its address. The addresses are herdr-core terminals and
// the reply goes through `hc send`, so nothing depends on which agent is on either end.
//
//   message:  <herdr-message from="t63" name="…" agent="…">what you typed</herdr-message>
//             plus one line saying how to reply to t63. The send box shows only your
//             text; the wrapper is added when it sends. From a pane that isn't an
//             agent there is nobody to reply to, so the text goes as typed.
//   pull:     <herdr-context from="t5y" name="…" agent="…">its output</herdr-context>
//             plus one line saying how to ask t5y for more, then what you type.
//   y           copy that output to the clipboard · t copy the pane title
//   c / C       copy a reference to the selected agent / its bare address, for pasting
//               into another session (mods/pane-reference builds it; the hub stays up)
//   g           go to the agent and close the hub
//   /           focus the sidebar search (esc steps out, then clears; enter keeps the filter)
//   j k ↑ ↓ 1-9 select · a this space / all spaces · r refresh · q esc close
//
// What closes what:
//   message  the hub stays up while you write, so you can read the agent's screen.
//            Sending closes the send box and the hub and puts the keyboard back on
//            the pane you came from. Cancelling the send box brings you back to the hub.
//   pull     the hub closes at once: the output is in the send box, aimed at your
//            pane. Sending or cancelling leaves you on your pane.
//   go       closes the hub and shows the agent.
//
// Opened with cmd-j or ctrl-a m (keys.json, tmux-prefix). It's a window: no dimming,
// drag it by any empty spot, it reopens where you left it.
// The send box reads its target from shared "send-box.request" (mod.open takes no props).

import { View, div, image, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, InputState, Input } from "gpui-base";
import { agents, closeOverlay, exec, focused, nextCommand, notify, panes, props, run, setShared, settings, shared, spaces, terminals, theme } from "herdr";

// A wait: one spinner, turned natively, and what is being waited for.
const waiting = (t, label) => h_flex().gap(8).items_center().child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)).child(label);

const LINES = 160;       // history pulled into the preview
const PULL_LINES = 120;  // what "pull" and "copy" hand over
const REFRESH_MS = 2000;
const STATUS_ORDER = { blocked: 0, done: 1, working: 2, idle: 3, unknown: 4 };
// Leading spinner / status glyphs agents put in their titles.
const TITLE_NOISE = /^[⠀-⣿✀-➿☀-⛿■-◿•·*\p{Extended_Pictographic}️\s]+/u;

const cleanTitle = (t) => (t ?? "").replace(TITLE_NOISE, "").trim();
const short = (s, n = 22) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const label = (a) => cleanTitle(a.title) || a.program?.name || a.address;

// The agent's logo from the app's program table: a one-color glyph or a picture;
// a letter when the program has none.
function logo(p, size, t) {
  if (p?.icon) return p.tint ? svg(p.icon).size(size).flex_none().text_color(p.color ?? t.muted) : image(p.icon).w(size).h(size).flex_none();
  return h_flex().size(size).flex_none().items_center().justify_center().rounded(4).bg(t.raised)
    .text_size(size * 0.62).font_semibold().text_color(t.muted).child((p?.name ?? "?").slice(0, 1).toUpperCase());
}

// A tab's number in its space (from 1), and its name when someone named it.
function tabOf(a) {
  const tab = spaces().find((s) => s.id === a.space)?.tabs.find((x) => x.id === a.tab);
  const n = tab?.index ?? null;
  // A name that repeats the number ("3", "3 · fix login") loses it: the badge shows it.
  const raw = tab ? (tab.named ? tab.name : "") : (a.tab_name ?? "");
  const name = n == null ? raw : raw.replace(new RegExp(`^${n}(\\s*[·:.-]\\s*|$)`), "");
  return { n, name };
}

// The tag attributes naming a session: its herdr-core address is what a reply goes to.
const attr = (s) => String(s ?? "").replace(/"/g, "'").replace(/[<>\n]/g, " ").trim();
const who = (a) => `from="${a.address}" name="${attr(label(a))}" agent="${attr(a.app ?? a.program?.name ?? "agent")}"`;
// How session `from` writes to session `to`.
const reply = (to, from, what) => `hc send ${to} '<herdr-message from="${from}">${what}</herdr-message>'`;

// The screen as text: no trailing blanks, no long empty runs.
function tidy(text) {
  return (text ?? "")
    .split("\n").map((l) => l.replace(/\s+$/, ""))
    .join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// Escape is bound to an action of this mod's own: while a text field has the
// keyboard, Herdr closes the dialog on Escape before any key handler here sees it.
let escapeBound = false;

export default class AgentHub extends View {
  init(_props, cx) {
    if (!escapeBound) { cx.bind_keys([{ keystroke: "escape", action: "agent-hub-escape", context: "AgentHub" }]); escapeBound = true; }
    // Where you came from: the pane "pull" sends context back into.
    const f = { ...(focused() ?? {}) };
    const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
    if (pane?.terminal) f.terminal = pane.terminal;
    // Scope: the space you opened the hub from; `a` widens to every space.
    this.space = f.space ?? spaces().find((s) => s.active)?.id ?? null;
    this.all = false;
    this.query = "";
    try { this.all = localStorage.getItem("scope") === "all"; } catch {}
    // A send-box draft terminal isn't somewhere to pull context into.
    const draft = terminals().find((t) => t.address === f?.terminal && /send-box\/\.drafts/.test(t.cwd ?? ""));
    if (draft) f.terminal = null;
    const own = agents().find((a) => a.address === f?.terminal);
    this.home = f?.terminal
      ? { pane: f.pane ?? own?.pane ?? null, target: f.terminal, label: (own && label(own)) || cleanTitle(pane?.title) || f.terminal }
      : null;
    this.selected = f?.agent ?? (agents().find((a) => a.focused)?.address) ?? null;
    if (this.selected === this.home?.target) this.selected = this.list().find((a) => a.address !== this.home.target)?.address ?? this.selected;
    this.text = {};      // address -> tidy screen text
    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(150, () => { if (!this.typing) this.handle.focus(); });
    this.scroll = ScrollHandle.new();
    this.listScroll = ScrollHandle.new();
    // `/` search: filters by name, program, space, tab or address.
    this.typing = false;
    this.input = InputState.new({ placeholder: "Search agents" });
    this.input.on("change", (_e, cx) => {
      this.query = this.input.value(); this.selected = null;
      this.listScroll.scroll_to_item(0); this.read(cx, true); cx.notify();
    });
    this.input.on("submit", (_e, cx) => { this.handle.focus(); cx.notify(); });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.read(cx, true);
    cx.timer.every(REFRESH_MS, (cx) => this.read(cx, false));
    cx.spawn(async (cx) => {
      for (;;) { const c = await nextCommand(); if (c === "focus") { this.handle.focus(); cx.notify(); } }
    });
  }

  // The Agents sidebar's order, 1:1 (shared "agents.order", which it publishes as it
  // draws); agents it doesn't show go after, blocked first, then done, working, idle.
  list() {
    const hidden = new Set((shared("spaces.sections")?.sections ?? []).filter((s) => s.hidden).flatMap((s) => s.members));
    const q = (this.query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (a) => { const hay = [label(a), a.program?.name, a.app, a.space_name, a.tab_name, a.address].join(" ").toLowerCase(); return q.every((w) => hay.includes(w)); };
    const order = new Map((shared("agents.order") ?? []).map((addr, i) => [addr, i]));
    const pos = (a) => order.get(a.address) ?? Infinity;
    return agents().filter((a) => !hidden.has(a.space) && (this.all || !this.space || a.space === this.space) && (!q.length || hit(a))).map((a, i) => ({ a, i }))
      .sort((x, y) => pos(x.a) - pos(y.a) || (STATUS_ORDER[x.a.status] ?? 9) - (STATUS_ORDER[y.a.status] ?? 9) || x.i - y.i)
      .map((x) => x.a);
  }

  current() {
    const l = this.list();
    return l.find((a) => a.address === this.selected) ?? l[0] ?? null;
  }

  read(cx, jump) {
    const a = this.current();
    if (!a || this.reading) return;
    this.reading = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("hc", ["read", a.address, "--lines", String(LINES)], { timeout: 8000 });
        const text = r.code === 0 ? tidy(r.stdout) : `(couldn't read ${a.address}: ${(r.stderr || "").trim()})`;
        const changed = this.text[a.address] !== text;
        this.text[a.address] = text;
        if (changed || jump) this.scroll.scroll_to_item(Math.max(0, text.split("\n").length - 1));
        if (changed || jump) cx.notify();
      } catch (e) {
        this.text[a.address] = `(couldn't read ${a.address}: ${e?.message ?? e})`;
        cx.notify();
      } finally { this.reading = false; }
    });
  }

  select(address, cx) {
    if (address === this.selected) return;
    this.selected = address;
    const i = this.list().findIndex((a) => a.address === address);
    if (i >= 0) this.listScroll.scroll_to_item(i);
    this.read(cx, true);
    cx.notify();
  }

  move(delta, cx) {
    const l = this.list();
    if (!l.length) return;
    const i = Math.max(0, l.findIndex((a) => a.address === this.current()?.address));
    this.select(l[(i + delta + l.length) % l.length].address, cx);
  }

  // Hand a target to the send box, then open it. `text` starts the box off;
  // `wrap` ({head, tail, from}) goes around what is typed when it sends.
  // `hub` is this window, which the send box closes when it sends and hands the
  // keyboard back to when cancelled; `back` is the pane to return to after sending.
  sendBox(target, text, wrap, stay) {
    setShared("send-box.request", { ...target, text: text ?? "", wrap: wrap ?? null,
      hub: stay ? props().overlay : null, back: stay ? this.home?.pane ?? null : null, at: Date.now() });
    run("mod.open", { name: "send-box" });
  }

  // Message the selected agent. It arrives tagged with the agent session you
  // came from, and says how to answer that session.
  message() {
    const a = this.current();
    if (!a) return;
    if (a.status === "blocked") {
      notify({ title: `${label(a)} is waiting on you`, body: "Press g to go answer it first.", level: "warning", timeout: 2500 });
      return;
    }
    const from = this.home && this.home.target !== a.address ? agents().find((x) => x.address === this.home.target) : null;
    const wrap = from ? {
      from: label(from),
      head: `<herdr-message ${who(from)}>\n`,
      tail: `\n</herdr-message>\nSent by the user from another agent session in Herdr (terminal ${from.address}). If that session needs an answer, send it with: ${reply(from.address, a.address, "your reply")}`,
    } : null;
    this.sendBox({ pane: a.pane, target: a.address, label: label(a) }, "", wrap, true);
  }

  context(a) {
    const lines = (this.text[a.address] ?? "").split("\n");
    return lines.slice(-PULL_LINES).join("\n");
  }

  pull(cx) {
    const a = this.current();
    if (!a) return;
    if (!this.home) return notify({ title: "No pane to pull into", body: "Open the hub from a terminal pane.", level: "warning", timeout: 2500 });
    if (a.address === this.home.target) return notify({ title: "That's the pane you came from", body: "Pick another agent to pull from.", level: "warning", timeout: 2500 });
    const body = this.context(a);
    if (!body) return notify({ title: "Nothing to pull yet", level: "warning", timeout: 1500 });
    const text = `<herdr-context ${who(a)}>\n${body}\n</herdr-context>\nRecent output of another agent session in Herdr, for reference: don't act on it unless I ask below. To ask that session something: ${reply(a.address, this.home.target, "your question")} · more of its screen: hc read ${a.address} --lines 400\n\n`;
    this.sendBox(this.home, text);
    this.close();
  }

  copy(cx) {
    const a = this.current();
    if (!a) return;
    cx.write_to_clipboard(this.context(a));
    notify({ title: "Copied agent output", body: label(a), level: "success", timeout: 1500 });
  }

  go() {
    const a = this.current();
    if (!a) return;
    run("agent.focus", { terminal: a.address });
    this.close();
  }

  // Copy reference is owned by mods/pane-reference: name the agent, then ask it.
  reference(bare) {
    const a = this.current();
    if (!a) return;
    setShared("pane-reference.ask", { terminal: a.address, bare, n: Date.now() });
    run("pane-reference.ask");
  }

  copyTitle(cx) {
    const a = this.current();
    if (!a) return;
    cx.write_to_clipboard(label(a));
    notify({ title: "Copied pane title", body: label(a), level: "success", timeout: 1500 });
  }

  search(cx) { this.input.focus(); cx.notify(); }

  clearSearch(cx) {
    this.query = ""; this.input.set_value(""); this.selected = null;
    this.listScroll.scroll_to_item(0);
    this.handle.focus(); this.read(cx, true); cx.notify();
  }

  close() { closeOverlay(props().overlay); }

  toggleScope(cx) {
    this.all = !this.all;
    try { localStorage.setItem("scope", this.all ? "all" : "space"); } catch {}
    this.selected = null;
    this.listScroll.scroll_to_item(0);
    this.read(cx, true);
    cx.notify();
  }

  keys(e, cx) {
    const k = e.key, m = e.modifiers ?? {};
    if (this.typing) {
      // Arrows still pick while you type; enter keeps the filter.
      // Escape steps back out of the field and keeps the filter; a second one clears it.
      if (k === "escape") { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      else if (k === "down") { this.move(1, cx); cx.stop_propagation(); }
      else if (k === "up") { this.move(-1, cx); cx.stop_propagation(); }
      return;
    }
    if (m.platform || m.control || m.alt) return;
    if (k === "/" || e.key_char === "/") { this.search(cx); cx.stop_propagation(); return; }
    if (k === "escape" && this.query) { this.clearSearch(cx); cx.stop_propagation(); return; }
    const map = {
      j: () => this.move(1, cx), down: () => this.move(1, cx),
      k: () => this.move(-1, cx), up: () => this.move(-1, cx),
      enter: () => this.message(), i: () => this.message(),
      p: () => this.pull(cx), y: () => this.copy(cx), t: () => this.copyTitle(cx), g: () => this.go(),
      c: () => this.reference(Boolean(m.shift)),
      r: () => this.read(cx, true), a: () => this.toggleScope(cx), q: () => this.close(), escape: () => this.close(),
    };
    if (map[k]) { map[k](); cx.stop_propagation(); return; }
    if (/^[1-9]$/.test(k)) {
      const a = this.list()[Number(k) - 1];
      if (a) this.select(a.address, cx);
      cx.stop_propagation();
    }
  }

  render(cx) {
    const t = theme();
    const list = this.list();
    const cur = this.current();
    if (cur && cur.address !== this.selected) { this.selected = cur.address; this.read(cx, true); }
    const mono = settings().font_family;
    const dot = (s) => div().size(8).flex_none().rounded(4).bg(t[s] ?? t.unknown);
    const stop = (_e, cx) => cx.stop_propagation();

    const button = (id, text, hint, primary, fn) => h_flex().id(id).h(26).px(10).gap(6).items_center().rounded(6)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12).font_medium()
      .cursor_pointer().hover((s) => s.opacity(0.88))
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => fn(cx))
      .child(text)
      .child(div().text_size(10.5).opacity(0.7).child(hint));

    // The tab number, made to stand out: it's what you look for in the tab bar.
    const tabBadge = (n, on) => h_flex().h(18).min_w(18).px(5).flex_none().items_center().justify_center().rounded(5)
      .bg(on ? t.accent : t.raised).text_color(on ? t.accent_foreground : t.accent)
      .when(!on, (e) => e.border_1().border_color(t.input))
      .text_size(12).font_bold().child(String(n));

    const row = (a, i) => {
      const on = a.address === cur?.address;
      const tab = tabOf(a);
      const where = [this.all ? a.space_name : "", tab.name, a.address === this.home?.target ? "you are here" : ""].filter(Boolean).join(" · ");
      return h_flex().id(`ah-${a.address}`).w_full().px(10).py(7).gap(9).items_center().rounded(6).flex_none()
        .cursor_pointer().when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((s) => s.bg(t.hover)))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { this.handle.focus(); this.select(a.address, cx); })
        .child(logo(a.program, 18, t))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(div().truncate().text_size(12.5).font_medium().text_color(t.foreground).child(label(a)))
          .child(h_flex().min_w(0).gap(6).items_center()
            .when(tab.n != null, (e) => e.child(tabBadge(tab.n, on)))
            .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.muted).child(where))))
        .child(v_flex().flex_none().items_end().gap(3)
          .child(h_flex().gap(5).items_center()
            .child(div().text_size(10.5).text_color(a.status === "blocked" ? t.blocked : t.dim).child(a.status))
            .child(dot(a.status)))
          .when(i < 9, (e) => e.child(div().text_size(10).text_color(t.dim).child(`press ${i + 1}`))));
    };

    const left = v_flex().w(280).flex_none().h_full().border_r(1).border_color(t.border)
      .child(h_flex().px(12).h(38).flex_none().items_center().justify_between().border_b(1).border_color(t.border)
        .child(v_flex().min_w(0)
          .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Agents"))
          .child(div().truncate().text_size(10.5).text_color(t.dim).child(this.all ? "all spaces" : (spaces().find((s) => s.id === this.space)?.name ?? "this space"))))
        .child(h_flex().id("ah-scope").h(22).px(8).gap(5).items_center().rounded(5).flex_none()
          .border_1().border_color(t.input).bg(t.raised).cursor_pointer().hover((s) => s.opacity(0.88))
          .on_mouse_down("left", stop).on_click((_e, cx) => this.toggleScope(cx))
          .text_size(11).text_color(t.foreground)
          .child(this.all ? "All spaces" : "This space")
          .child(div().text_size(10).opacity(0.6).child(`${list.length} · a`))))
      .child(h_flex().id("ah-search").mx(6).mt(6).h(28).px(8).gap(6).flex_none().items_center().rounded(6)
        .border_1().border_color(this.typing ? t.accent : t.input).bg(t.background)
        .on_mouse_down("left", stop)
        .child(div().text_size(12).text_color(t.dim).child("/"))
        .child(div().flex_1().min_w(0).child(Input.new(this.input).id("ah-search-input").w_full().text_size(12.5).text_color(t.foreground)))
        .when(Boolean(this.query), (e) => e.child(h_flex().id("ah-clear-search").size(20).flex_none().items_center().justify_center().rounded(4)
          .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Clear search")
          .on_mouse_down("left", stop).on_click((_e, cx) => this.clearSearch(cx))
          .text_size(14).text_color(t.muted).child("×"))))
      .child(div().relative().flex_1().min_h(0)
        .child(v_flex().id("ah-list").absolute().inset_0().p(6).gap(2).overflow_y_scroll().track_scroll(this.listScroll)
          .children(list.length ? list.map(row) : [div().p(12).text_size(12).text_color(t.muted).child(this.query ? `Nothing matches "${this.query}".${this.all ? "" : " Choose All spaces to search every space."}` : this.all ? "No agents running." : "No agents in this space. Press a for all spaces.")])))
      .child(div().px(12).py(7).flex_none().border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
        .child(this.typing ? "↑ ↓ select · ↵ keep filter · esc leave field" : `j k ↑ ↓ select · / search · c reference${this.query ? " · esc clear" : ""}`));

    const unread = Boolean(cur) && this.text[cur.address] === undefined;
    const lines = cur && !unread ? this.text[cur.address].split("\n") : [];
    const right = v_flex().flex_1().min_w(0).h_full()
      .child(h_flex().px(12).h(38).flex_none().gap(8).items_center().border_b(1).border_color(t.border)
        .child(cur ? logo(cur.program, 16, t) : div())
        .when(cur && tabOf(cur).n != null, (e) => e.child(tabBadge(tabOf(cur).n, true)))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground)
          .child(cur ? label(cur) : "—"))
        .child(cur ? dot(cur.status) : div())
        .child(div().flex_none().text_size(11).text_color(t.dim).child(cur ? cur.address : "")))
      .child(div().relative().flex_1().min_h(0).bg(t.background)
        .child(v_flex().id("ah-screen").absolute().inset_0().px(12).py(8).overflow_y_scrollbar().track_scroll(this.scroll)
          .font_family(mono).text_size(11.5).text_color(t.foreground)
          .when(unread, (e) => e.child(waiting(t, "Reading output"))).children(lines.map((l, i) => div().id(`ln-${i}`).flex_none().whitespace_nowrap().child(l || " ")))))
      .child(h_flex().px(10).h(44).flex_none().gap(8).items_center().border_t(1).border_color(t.border)
        .child(button("ah-send", "Message", "↵", true, () => this.message()))
        .child(button("ah-pull", this.home ? `Pull into ${short(this.home.label, 16)}` : "Pull", "p", false, (cx) => this.pull(cx)))
        .child(button("ah-copy", "Copy", "y", false, (cx) => this.copy(cx)))
        .child(button("ah-title", "Title", "t", false, (cx) => this.copyTitle(cx)))
        .child(button("ah-go", "Go to", "g", false, () => this.go()))
        .child(div().flex_1())
        .child(button("ah-close", "Close", "esc", false, () => this.close())));

    return h_flex().id("ah-root").size_full().bg(t.popover).text_color(t.foreground)
      .track_focus(this.handle).key_context("AgentHub").on_action("agent-hub-escape", (_e, cx) => this.keys({ key: "escape", keystroke: "escape", modifiers: {} }, cx)).on_key_down((e, cx) => this.keys(e, cx))
      .child(left).child(right);
  }
}
