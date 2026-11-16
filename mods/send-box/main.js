// Send box: a floating, non-blocking window with a text area. Send (Cmd+Enter only;
// Enter and Shift+Enter add a new line)
// pastes the text into the terminal that had focus when it opened and presses
// Enter (`hc send`), then puts the keyboard back on that pane. Esc cancels.
// Drag it by any spot that isn't the text area or a button.
//
// Two roles:
// - launcher: what `mod.open:send-box` opens (cmd-i, ctrl-a i). mod.json makes
//   it an invisible full-window popup for one frame, to read the window size.
//   It sizes the real window from that (about 40% wide), anchors it in the
//   first corner that doesn't cover the target pane (pane boxes come from
//   shared "pane-geo", which pane-header records), opens it with props {window: true, pane, terminal, label, text} and
//   closes itself. Opening again while the window is up closes the window.
// - window: the send box itself.
//
// Another mod (agent-hub) can aim the next open: it sets shared
// "send-box.request" to {pane, target, label, text, wrap, at}, then runs
// mod.open:send-box. The request picks the target and the starting text.
// `wrap` ({head, tail, from}) is put around the typed text when it sends: the
// box shows only what the person types, and "From: <from>" under the target.
// `hub` is the overlay that asked (the agent hub's window) and `back` the pane
// the person was on: sending closes the hub too and goes back to that pane;
// cancelling goes back to the hub.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea } from "gpui-base";
import { closeOverlay, exec, focused, notify, openOverlay, panes, props, run, setShared, shared, theme } from "herdr";

const OPEN = "send-box.window"; // shared: the open window's overlay id
const REQUEST = "send-box.request";
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const GEO = "pane-geo"; // shared by pane-header: each pane's header box
const STATUS_BAR = 34; // room kept for the status bar at the bottom
const MARGIN = 16;
const AREA_PAD = 10;    // the text area's padding
const AREA_LINE = 21.5; // one line of its 13px text, rounded up

const overlap = (a, b) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

// The target pane's box, from the header boxes of its tab: it runs from its
// header down to the next header below it, else to the bottom of the window.
function paneRect(pane, H) {
  const geo = shared(GEO) ?? {};
  const me = geo[pane];
  if (!me) return null;
  const below = Object.entries(geo)
    .filter(([k, g]) => k !== pane && g.tab === me.tab && g.y > me.y &&
      Math.min(g.x + g.width, me.x + me.width) - Math.max(g.x, me.x) > 20)
    .map(([, g]) => g.y);
  const bottom = below.length ? Math.min(...below) : H - STATUS_BAR;
  return { x: me.x, y: me.y, width: me.width, height: Math.max(me.height, bottom - me.y), tab: me.tab };
}

// Where the window goes: the first corner of the tab's area (bottom right,
// bottom left, top right, top left) that doesn't cover the target pane, else
// the corner covering least of it. Without geometry: bottom right.
function place(width, height, W, H, pane) {
  const target = paneRect(pane, H);
  const geo = Object.values(shared(GEO) ?? {}).filter((g) => !target || g.tab === target.tab);
  const left = geo.length ? Math.min(...geo.map((g) => g.x)) : 0;
  const top = geo.length ? Math.min(...geo.map((g) => g.y)) : 0;
  const right = W, bottom = H - STATUS_BAR;
  const xs = { r: Math.max(MARGIN, right - width - MARGIN - 8), l: left + MARGIN };
  const ys = { b: Math.max(MARGIN, bottom - height - MARGIN), t: top + MARGIN + 30 };
  const corners = [[xs.r, ys.b], [xs.l, ys.b], [xs.r, ys.t], [xs.l, ys.t]].map(([x, y]) => ({ x, y, width, height }));
  if (!target) return corners[0];
  let best = corners[0], least = Infinity;
  for (const c of corners) {
    const o = overlap(c, target);
    if (o === 0) return c;
    if (o < least) { least = o; best = c; }
  }
  return best;
}

// Escape is bound to an action of this mod's own: while a text field has the
// keyboard, Herdr closes the dialog on Escape before any key handler here sees it.
let escapeBound = false;

export default class SendBox extends View {
  init(_props, cx) {
    if (!escapeBound) { cx.bind_keys([{ keystroke: "escape", action: "send-box-escape", context: "SendBox" }]); escapeBound = true; }
    const p = props() ?? {};
    this.isWindow = Boolean(p.window);
    if (!this.isWindow) return this.initLauncher();
    setShared(OPEN, p.overlay);
    this.terminal = p.terminal ?? null;
    this.pane = p.pane ?? null;
    const pane = panes().find((x) => x.pane === this.pane);
    this.label = p.label || pane?.title || this.terminal || "no terminal";
    this.text = p.text ?? "";
    this.wrap = p.wrap ?? null;
    this.hub = p.hub ?? null;
    this.back = p.back ?? null;
    this.rows = 4; // until the frame is measured; fits the smallest window
    this.area = TextareaState.new({ placeholder: "Type a message…  (Enter for a new line, Cmd+Enter to send)", value: this.text, rows: this.rows });
    // Start after any supplied text, including pulled output, ready to append.
    this.area.set_selected_range({ start: this.text.length, end: this.text.length });
    this.area.on("change", (_e, cx) => { this.text = this.area.value(); cx.notify(); });
    // Only Cmd+Enter sends. The text area reports Enter as "submit" (with the
    // modifiers held): plain Enter already adds its new line; Shift+Enter
    // doesn't, so it gets one here.
    this.area.on("submit", (e) => {
      if (e?.secondary) this.send();
      else if (e?.shift) this.newline();
    });
    // Whether the text area has the keyboard: Escape steps back out of it first.
    this.typing = false;
    this.left = false;
    this.area.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.area.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.area.focus();
    cx.timer.after(300, () => { if (!this.left) this.area.focus(); });
    this.handle = cx.focus_handle();
  }

  initLauncher() {
    const open = shared(OPEN);
    const req = shared(REQUEST);
    if (req) setShared(REQUEST, null);
    const asked = req && Date.now() - (req.at ?? 0) < 5000 ? req : null;
    if (open && typeof open === "string") {
      closeOverlay(open);
      setShared(OPEN, null);
      if (!asked) {
        // Second press: just close the window.
        closeOverlay(props().overlay);
        this.done = true;
        return;
      }
      // A request replaces whatever the window was holding.
    }
    if (asked) {
      this.source = { pane: asked.pane ?? null, terminal: asked.target ?? null, label: asked.label ?? null, text: asked.text ?? "", wrap: asked.wrap ?? null, hub: asked.hub ?? null, back: asked.back ?? null };
      return;
    }
    const f = focused();
    this.source = { pane: f?.pane ?? null, terminal: f?.terminal ?? null };
  }

  // Launcher: the window size is known; open the send box and go.
  launch(size) {
    if (this.done) return;
    this.done = true;
    const W = size.width, H = size.height;
    const width = Math.round(clamp(W * 0.4, 460, 760));
    const height = Math.round(clamp(H * 0.34, 260, 420));
    const spot = place(width, height, W, H, this.source.pane);
    const at = { x: Math.round(spot.x), y: Math.round(spot.y) };
    closeOverlay(props().overlay);
    openOverlay({ kind: "window", mod: "send-box", width, height, at, props: { window: true, ...this.source } });
  }

  // Close the box and put the keyboard somewhere sensible. Opened by itself:
  // the pane it sends to. Opened from the agent hub: after sending, the hub
  // closes and the pane the person came from gets the keyboard (not the agent
  // they wrote to, which may be in another tab); after cancelling, the hub does.
  dismiss(sent = false) {
    if (shared(OPEN) === props()?.overlay) setShared(OPEN, null);
    closeOverlay(props()?.overlay);
    if (!this.hub) {
      if (this.pane) run("pane.focus", { pane: this.pane });
      return;
    }
    const back = this.back ?? this.pane;
    if (sent) closeOverlay(this.hub);
    if (back) run("pane.focus", { pane: back });
    // If the hub is still up it takes the keyboard; if it was closed meanwhile, the pane keeps it.
    if (!sent) run("agent-hub.focus");
  }

  // One new line at the cursor (once, if both the text area and the key
  // handler see the same Shift+Enter).
  newline() {
    const now = Date.now();
    if (now - (this.lastNewline ?? 0) < 60) return;
    this.lastNewline = now;
    this.area.replace("\n");
  }

  send() {
    if (this.sent) return;
    const typed = this.area.value();
    if (!typed.trim() || !this.terminal) return;
    const text = this.wrap ? `${this.wrap.head ?? ""}${typed.trim()}${this.wrap.tail ?? ""}` : typed;
    const terminal = this.terminal;
    this.sent = true;
    this.dismiss(true);
    if (this.hub) notify({ title: `Sent to ${this.label}`, level: "success", timeout: 1500 });
    // hc waits while a person has an unfinished draft in that terminal.
    exec("hc", ["send", terminal, text], { timeout: 120000 }).then((r) => {
      if (r.code !== 0) notify({ title: "Send failed", body: (r.stderr || r.stdout || "").trim(), level: "error" });
    });
  }

  render() {
    if (this.done && !this.isWindow) return div();
    if (!this.isWindow) {
      // The popup's own box may collapse; the viewport is the real window size.
      let vp = null;
      try { vp = window.viewport_size(); } catch {}
      return div().id("sb-launch").size_full().on_size_change((size) => this.launch(vp?.height > 0 ? vp : size));
    }
    const t = theme();
    const button = (id, text, primary, action, enabled = true) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .opacity(enabled ? 1 : 0.45).when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action))
      .child(text);
    const canSend = Boolean(this.terminal) && this.text.trim().length > 0;
    return v_flex().id("send-box").track_focus(this.handle).key_context("SendBox")
      .on_action("send-box-escape", (_e, cx) => {
        // First Escape steps back out of the text area, keeping the text; the next closes the box.
        if (this.typing) { this.typing = false; this.left = true; this.handle.focus(); cx.notify(); }
        else this.dismiss();
        cx.stop_propagation();
      })
      .on_key_down((e, cx) => {
        if (e.keystroke === "cmd-enter") { this.send(); cx.stop_propagation(); }
        else if (this.typing) { if (e.keystroke === "shift-enter") { this.newline(); cx.stop_propagation(); } }
        else if (e.key === "enter" || e.key === "tab" || e.key_char === "i") { this.area.focus(); cx.stop_propagation(); cx.notify(); }
      })
      .size_full().p(18).gap(10).rounded(10).border_1().border_color(t.border).bg(t.popover).cursor_move().text_color(t.foreground)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().child("Send box"))
        .child(div().text_size(11).text_color(t.dim).child(this.typing ? "drag to move · esc leave field" : "i type · esc close")))
      .child(div().text_size(11.5).text_color(t.dim).child(this.terminal ? `To: ${this.label}${this.wrap?.from ? `  ·  From: ${this.wrap.from} (replies go back there)` : ""}` : "No terminal had focus. Close this, click a terminal, and try again."))
      .child(div().id("sb-area").flex_1().min_h(0).flex().cursor_text()
        // The text area scrolls past the rows it was told it shows, not past
        // its frame: keep that count at what fits, or the last lines are cut off.
        .on_size_change((size) => {
          const rows = Math.max(2, Math.floor((size.height - AREA_PAD * 2 - 2) / AREA_LINE));
          if (rows !== this.rows) { this.rows = rows; this.area.set_rows(rows); }
        })
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Textarea.new(this.area).flex_1().min_h(0).p(AREA_PAD).rounded(9).border_1().border_color(this.typing ? t.accent : t.input).bg(t.background).text_size(13).text_color(t.foreground)))
      .child(h_flex().gap(8).justify_end()
        .child(button("sb-cancel", "Cancel", false, () => this.dismiss()))
        .child(button("sb-send", "Send  ⌘↵", true, () => this.send(), canSend)));
  }
}
