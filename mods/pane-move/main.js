// Pane move: sends the focused terminal pane to another tab, or breaks it out
// into a tab of its own (tmux's join-pane / break-pane). ctrl-a t and ctrl-a !
// in tmux-prefix.
//
// There is no app command for this. A terminal shows in the tab its
// `herdr.space` / `herdr.tab` labels name, so the move is: park the terminal
// (its pane goes, it keeps running), wait for that to land, then label it for
// the target tab, where Herdr adopts it as a new split. A tab id Herdr doesn't
// know becomes a new tab.
//
// Keys: j k (or arrows) choose, g G first and last, / filters, Enter moves.
//
// Props: { to?: "new", terminal? }. `to: "new"` skips the list and breaks the
// pane out at once; `terminal` moves that one instead of the focused pane.
// Terminal panes only (a mod pane has no terminal to relabel), and only to
// tabs on the pane's own machine. Moving a tab's only pane closes that tab.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { closeOverlay, exec, focused, hc, notify, panes, props, run, shared, spaces, theme } from "herdr";

const ROW = 30;
// Labels use the ids of the terminal's own machine: no "<machine>/" prefix.
const bare = (id) => id.slice(id.lastIndexOf("/") + 1);
const newTabId = () => `tb${Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("")}`;
const pause = () => exec("sleep", ["0.1"], { timeout: 2000 }).catch(() => null);

async function labelsOf(terminal) {
  const r = await hc(["get", terminal, "--json"]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "hc get failed").trim());
  return JSON.parse(r.stdout).labels ?? {};
}

async function label(terminal, space, tab) {
  const r = await hc(["label", terminal, `herdr.space=${bare(space)}`, `herdr.tab=${bare(tab)}`]);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout || "hc label failed").trim());
}

export default class PaneMove extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.scroll = ScrollHandle.new();
    this.query = "";
    this.search = false; // "/" types into the filter; otherwise letters are vim motions
    this.at = 0;
    this.busy = null;
    const want = props()?.terminal ?? focused()?.terminal;
    const pane = panes().find((p) => p.terminal && p.terminal === want);
    const space = pane && spaces().find((s) => s.tabs.some((t) => t.id === pane.tab));
    if (!pane || !space) {
      notify({ title: "No terminal pane to move", body: "Mod panes can't be moved to another tab.", level: "warning", timeout: 2500 });
      this.quiet = true;
      return this.dismiss();
    }
    this.terminal = pane.terminal;
    this.from = { space, tab: space.tabs.find((t) => t.id === pane.tab) };
    if (props()?.to === "new") {
      this.quiet = true;
      if (this.from.tab.panes < 2) {
        notify({ title: "This pane already has a tab to itself", level: "warning", timeout: 2000 });
        return this.dismiss();
      }
      this.move({ kind: "new" }, cx);
    }
  }

  dismiss() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  // "New tab" first (when it would change anything), then this space's other
  // tabs, then the other spaces' on the same machine.
  targets() {
    const { space, tab } = this.from;
    const hidden = new Set((shared("spaces.sections")?.sections ?? []).filter((s) => s.hidden).flatMap((s) => s.members));
    const rows = tab.panes > 1 ? [{ kind: "new", text: "New tab", hint: space.name }] : [];
    const ordered = [space, ...spaces().filter((s) => s.id !== space.id && s.machine === space.machine)];
    for (const s of ordered.filter((s) => !hidden.has(s.id))) {
      for (const t of s.tabs) {
        if (t.id === tab.id) continue;
        rows.push({ kind: "tab", space: s, tab: t, text: t.name, hint: s.id === space.id ? "this space" : s.name });
      }
    }
    const q = this.query.trim().toLowerCase();
    return q ? rows.filter((r) => `${r.text} ${r.hint}`.toLowerCase().includes(q)) : rows;
  }

  move(target, cx) {
    if (this.busy) return;
    const terminal = this.terminal;
    const { space, tab } = this.from;
    const to = target.kind === "new" ? { space: space.id, tab: newTabId() } : { space: target.space.id, tab: target.tab.id };
    this.busy = target.kind === "new" ? "a new tab" : target.text;
    cx.notify();
    // The overlay stays open until the move is over: closing cancels this task.
    cx.spawn(async () => {
      let parked = false;
      try {
        run("terminal.park", { terminal });
        // Parking is applied after the core replies: wait until the pane and
        // its labels are gone, or the new labels would be cleared with it.
        for (let i = 0; ; i++) {
          const gone = !panes().some((p) => p.terminal === terminal);
          if (gone && !(await labelsOf(terminal))["herdr.tab"]) break;
          if (i > 60) throw new Error("The pane didn't let go of its tab.");
          await pause();
        }
        parked = true;
        await label(terminal, to.space, to.tab);
        for (let i = 0; i < 50 && !panes().some((p) => p.terminal === terminal); i++) await pause();
        if (!panes().some((p) => p.terminal === terminal)) throw new Error("Herdr didn't show it in the new tab.");
        run("pane.focus", { terminal });
      } catch (e) {
        // Don't leave it without a pane: back to where it was (its old tab, or a new one if that closed).
        if (parked) await label(terminal, space.id, tab.id).catch(() => null);
        notify({ title: "Couldn't move the pane", body: String(e?.message ?? e), level: "error", timeout: 5000 });
      } finally {
        this.dismiss();
      }
    });
  }

  key(e, cx) {
    cx.stop_propagation();
    if (this.busy) return;
    const rows = this.targets();
    const m = e.modifiers;
    const k = e.key;
    if (k === "escape") {
      if (!this.search) return this.dismiss();
      this.search = false;
      this.query = "";
      this.at = 0;
      return cx.notify();
    }
    if (k === "enter") return rows[this.at] && this.move(rows[this.at], cx);
    const char = e.key_char ?? k;
    const to = (i) => { this.at = (i + rows.length) % rows.length; this.scroll.scroll_to_item(this.at); };
    const step = k === "down" || (m.control && (k === "n" || k === "j")) ? 1 : k === "up" || (m.control && (k === "p" || k === "k")) ? -1 : 0;
    if (step) {
      if (rows.length) to(this.at + step);
    } else if (m.control || m.platform || m.alt) {
      return;
    } else if (this.search) {
      // Searching: keys are typed; backspace on nothing leaves.
      if (k === "backspace") {
        if (this.query) this.query = this.query.slice(0, -1);
        else this.search = false;
      } else if (e.key_char && e.key_char.length === 1 && e.key_char >= " ") this.query += e.key_char;
      else return;
      this.at = 0;
    } else if (char === "/") {
      this.search = true;
    } else if (rows.length && (char === "j" || char === "k")) {
      to(this.at + (char === "j" ? 1 : -1));
    } else if (rows.length && (char === "g" || char === "G")) {
      to(char === "g" ? 0 : rows.length - 1);
    } else return;
    cx.notify();
  }

  render() {
    if (this.quiet) return div();
    const t = theme();
    const rows = this.targets();
    if (this.at >= rows.length) this.at = Math.max(0, rows.length - 1);
    const body = this.busy
      ? div().py(24).text_color(t.muted).child(`Moving to ${this.busy}…`)
      : rows.length === 0
        ? div().py(24).text_color(t.muted).child(this.query ? "No tab matches." : "There is no other tab to move it to.")
        : v_flex().id("pm-list").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll).children(rows.map((r, i) =>
          h_flex().id(`pm-${i}`).h(ROW).flex_none().px(10).gap(10).items_center().rounded(7).cursor_pointer()
            .bg(i === this.at ? t.selected : "#00000000").hover((s) => s.bg(i === this.at ? t.selected : t.hover))
            .on_click((_e, cx) => this.move(r, cx))
            .child(div().w(14).text_color(t.accent).child(r.kind === "new" ? "+" : ""))
            .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(r.text))
            .child(div().flex_none().max_w(200).truncate().text_color(t.dim).text_size(11.5).child(r.hint))));
    return v_flex().id("pane-move").track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .size_full().min_h(0).p(16).gap(10).bg(t.popover).text_size(13)
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Move pane to…"))
        .child(div().text_size(11).text_color(t.dim).child(this.search ? "↑↓ choose · ↵ move · esc back" : "j k choose · g G ends · / search · ↵ move · esc")))
      .when(this.search, (el) => el.child(h_flex().h(34).flex_none().px(10).gap(8).items_center().rounded(8).border_1().border_color(t.accent).bg(t.background)
        .child(div().text_color(t.accent).child("/"))
        .child(div().text_color(this.query ? t.foreground : t.dim).child(this.query || "filter tabs"))))
      .child(body);
  }
}
