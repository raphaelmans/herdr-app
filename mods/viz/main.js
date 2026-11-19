// Artifacts in Herdr (T3 Code's "visual replies", as documents). Terms: CONTEXT.md.
//
// An agent publishes an artifact with `herdr-viz <doc.md>` (./herdr-viz, linked to ~/.local/bin/herdr-viz): the CLI writes
// it to the library (.artifacts/<id>/), points the agent's artifact pane at it
// (.current/<terminal>.json), writes .current/.request.json = {terminal, at} and runs
// `mod.open {name: "viz"}`.
//
// Three roles, one folder:
// - launcher: what mod.open opens (an invisible 1x1 popup, see mod.json). With a fresh request it
//   makes sure that agent has an artifact pane; without one (cmd-shift-a) it toggles the library.
// - artifact pane (props {terminal}): the one artifact that agent published to most recently,
//   redrawn when it's overwritten. The person annotates its blocks there and sends the
//   annotations to that agent (annotate.js).
// - library (props {library, home}): every artifact. Project (default: the project of the pane it
//   was opened from) or All; Archived. Show in pane, open, copy path, archive, delete.
// - expanded picture (props {expand}): one picture of an artifact in a window, to zoom (expand.js).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, InputState, Input } from "gpui-base";
import { agents, closeOverlay, exec, home, nextCommand, notify, panes, props, run, setShared, shared, theme, watchFolder } from "herdr";
import * as fs from "fs/promises";
import { build, pad, part, reanchor, sourceOf, ago, tail, tildify } from "./render.js";
import { initExpand, openExpand, renderExpand } from "./expand.js";

// A wait: one spinner, turned natively, and what is being waited for.
const waiting = (t, label) => h_flex().gap(8).items_center().child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)).child(label);
import {
  blockRow, hints, initNotes, keys as noteKeys, moved, overlay, pending, release, send, setMode, tint, unhover, wantsKey,
} from "./annotate.js";
import {
  LIBRARY, OPEN, current, currentOf, deleteArtifact, dirOf, docOf, ensureDirs, ensurePane, lib, listArtifacts, readMeta,
  readNotes, setArchived, writeNotes, setCurrent, toggleLibrary,
} from "./store.js";

const stop = (_e, cx) => cx.stop_propagation();
const builtKey = (a) => `${a.id}@${a.updated}`;

// Escape is bound to an action of this mod's own: while a text field has the
// keyboard, Herdr closes the dialog on Escape before any key handler here sees it.
let escapeBound = false;

export default class Viz extends View {
  init(_props, cx) {
    if (!escapeBound) {
      cx.bind_keys([
        { keystroke: "escape", action: "viz-escape", context: "VizLibrary" },
        { keystroke: "escape", action: "viz-escape", context: "VizExpand" },
      ]);
      escapeBound = true;
    }
    const p = props() ?? {};
    if (p.expand) return initExpand(this, p, cx);
    if (p.library) return this.initLibrary(p, cx);
    if (p.terminal) return this.initPane(p, cx);
    return this.initLauncher(p, cx);
  }

  async close() {
    this.closed = true;
    if (this.role === "library" && shared(LIBRARY) === this.overlay) setShared(LIBRARY, null);
  }

  // ---- shared bits ------------------------------------------------------------------------

  button(id, text, t, onClick, { primary = false, danger = false } = {}) {
    return div().id(id).h(24).px(8).flex().items_center().rounded(5).text_size(11.5)
      .border_1().border_color(primary ? t.solid : danger ? t.blocked : t.border)
      .bg(primary ? t.solid : danger ? t.blocked : t.raised)
      .text_color(primary ? t.solid_foreground : danger ? t.background : t.foreground)
      .hover((s) => s.opacity(0.85))
      .on_mouse_down("left", stop)
      .on_click(onClick)
      .child(text);
  }

  ghost(id, text, t, onClick) {
    return div().id(id).flex_none().h(20).px(6).rounded(4).flex().items_center().text_size(11.5).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop)
      .on_click(onClick)
      .child(text);
  }

  chip(id, text, on, t, onClick) {
    return div().id(id).h(24).px(10).flex().items_center().rounded(5).text_size(12)
      .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
      .hover((s) => s.text_color(t.foreground))
      .on_mouse_down("left", stop)
      .on_click(onClick)
      .child(text);
  }

  // The artifact's document, drawn. `parts` come from build().
  documentView(id, parts, width, t, title) {
    const avail = Math.max(80, width - 44);
    const expand = (p) => openExpand(p, title);
    return v_flex().id(id).flex_1().min_h(0).overflow_y_scrollbar().px(22).py(16).text_size(13.5).text_color(t.foreground)
      .children((parts ?? []).map((p, i) => div().pb(pad(p)).child(part(p, `${id}-${i}`, avail, t, expand))));
  }

  // ---- launcher ---------------------------------------------------------------------------

  initLauncher(p, cx) {
    this.role = "launcher";
    cx.spawn(async (cx) => {
      const path = `${current()}/.request.json`;
      let req = null;
      try { req = JSON.parse(await fs.readFile(path, "utf8")); } catch {}
      if (req) await fs.unlink(path).catch(() => {});
      const term = req && Date.now() - (req.at ?? 0) < 15000 ? req.terminal : null;
      if (!term) {
        toggleLibrary();
        return closeOverlay(p.overlay);
      }
      ensurePane(term, cx, () => closeOverlay(p.overlay));
    });
  }

  // ---- artifact pane ----------------------------------------------------------------------

  initPane(p, cx) {
    this.role = "pane";
    this.terminal = p.terminal;
    this.artifact = null;
    this.parts = null;
    this.key = null;
    this.width = 600;
    this.scroll = ScrollHandle.new();
    initNotes(this, cx);
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        else if (c === "annotate" && this.artifact && wantsKey(this)) setMode(this, !this.mode);
        cx.notify();
      }
    });
    cx.spawn(async (cx) => {
      await ensureDirs();
      await this.reloadPane(cx);
      // Follow the pointer (another artifact) and the library (this one overwritten).
      cx.spawn(async (cx) => { while (!this.closed) { await watchFolder(current()).catch(() => null); await this.reloadPane(cx); } });
      while (!this.closed) { await watchFolder(lib()).catch(() => null); await this.reloadPane(cx); }
    });
  }

  async reloadPane(cx) {
    const id = await currentOf(this.terminal);
    const a = id ? await readMeta(id) : null;
    const key = a ? builtKey(a) : null;
    if (key === this.key) return;
    const switched = a?.id !== this.artifact?.id;
    const parts = a ? await build(a) : null;
    let notes = a ? await readNotes(a.id) : [];
    // Republished: the annotations file went with the old content. Keep the unsent ones whose
    // blocks are still there, and the open comment box if its blocks are.
    const unsent = switched ? [] : this.notes.filter((n) => !n.sent);
    if (a && !notes.length && unsent.length) {
      notes = reanchor(unsent, parts);
      if (notes.length) await writeNotes(a.id, notes);
    }
    const box = !switched && this.composing && !this.composing.id
      ? reanchor([{ ...this.composing, text: sourceOf(this.parts ?? [], this.composing.from, this.composing.to) }], parts ?? [])[0]
      : null;
    this.artifact = a;
    this.parts = parts;
    this.notes = notes;
    this.key = key;
    this.cursor = box ? box.to : null;
    this.anchor = null;
    this.confirm = null;
    if (box) this.composing = { from: box.from, to: box.to, id: null };
    else if (this.composing) { this.composing = null; this.area.set_value(""); }
    if (switched) this.scroll.scroll_to_item(0);
    cx.notify();
  }

  // This copy's pane: props().pane when Herdr gives it, else the one the launcher recorded.
  closePane() {
    const isViz = (id) => id && panes().some((x) => x.pane === id && x.mod === "viz");
    const id = [props()?.pane, (shared(OPEN) ?? {})[this.terminal]].find(isViz);
    if (!id) return notify({ title: "Artifacts", body: "Couldn't find this pane; close it with ⌘⇧W.", level: "error", timeout: 3000 });
    const open = { ...(shared(OPEN) ?? {}) };
    delete open[this.terminal];
    setShared(OPEN, open);
    run("pane.close", { pane: id });
  }

  renderPane() {
    const t = theme();
    const a = this.artifact;
    const status = agents().find((x) => x.address === this.terminal)?.status ?? null;
    const unsent = a ? pending(this).length : 0;
    const header = h_flex().px(12).h(34).gap(8).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(div().flex_none().w(7).h(7).rounded(4).bg(status ? t[status] ?? t.dim : t.dim))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(a ? a.title : "Artifact"))
      .when(Boolean(a), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`${tail(a.project)} · ${ago(a.updated)}`)))
      .when(unsent > 0, (el) => el.child(this.button("pane-send", this.sending ? waiting(t, "Sending") : `Send ${unsent} to agent`, t,
        (_e, cx) => { this.handle.focus(); send(this, cx); cx.notify(); })))
      .when(Boolean(a), (el) => el.child(this.mode
        ? this.button("pane-annotate", "Annotating · esc", t, (_e, cx) => { setMode(this, false); cx.notify(); }, { primary: true })
        : this.ghost("pane-annotate", "Annotate", t, (_e, cx) => { setMode(this, true); cx.notify(); })))
      .when(Boolean(a), (el) => el.child(this.ghost("pane-open", "Open", t, () => exec("open", [docOf(a)]).catch(() => {}))))
      .child(this.ghost("pane-library", "Library", t, () => { if (!shared(LIBRARY)) toggleLibrary(); }))
      .child(div().id("pane-close").flex_none().w(20).h(20).rounded(4).flex().items_center().justify_center()
        .text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => this.closePane()).child("✕"));
    const avail = Math.max(80, this.width - 30);
    // The document area: the scrolling document, and over it what annotating draws.
    const body = a
      ? div().id("pane-stage").relative().flex_1().min_h(0).overflow_hidden()
          .border_1().border_color(this.mode ? tint(t.accent, "66") : "#00000000")
          .when(this.mode, (el) => el
            .on_mouse_move((e, cx) => { if (moved(this, e)) cx.notify(); })
            .on_hover((h, cx) => { if (!h && unhover(this)) cx.notify(); })
            .on_scroll_wheel((_e, cx) => { if (unhover(this)) cx.notify(); }))
          .child(v_flex().id("pane-doc").size_full().overflow_y_scrollbar().track_scroll(this.scroll)
            .pl(4).pr(22).py(16).text_size(13.5).text_color(t.foreground)
            .children((this.parts ?? []).map((p, i) => blockRow(this, p, i, `pane-doc-${i}`, avail, t))))
          .children(overlay(this, t))
      : v_flex().flex_1().items_center().justify_center().gap(4).text_color(t.dim).text_size(12)
          .child("No artifact yet")
          .child(div().text_size(11).child("Agents publish with herdr-viz <doc.md> · earlier ones are in the Library (⌘⇧A)"));
    return v_flex().id("pane-root").size_full().bg(t.background).track_focus(this.handle)
      .on_key_down((e, cx) => noteKeys(this, e, cx))
      .on_mouse_up("left", (_e, cx) => { if (release(this)) cx.notify(); })
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) > 1) { this.width = size.width; cx.notify(); } })
      .child(header)
      .child(body)
      .when(Boolean(a), (el) => el.child(div().flex_none().px(12).py(4).border_t(1).border_color(t.border).bg(t.chrome)
        .truncate().text_size(10.5).text_color(t.dim).child(hints(this))));
  }

  // ---- library ----------------------------------------------------------------------------

  initLibrary(p, cx) {
    this.role = "library";
    this.overlay = p.overlay;
    // A hot reload re-runs init in the open window: only a fresh open takes the keyboard.
    const fresh = shared(LIBRARY) !== p.overlay;
    setShared(LIBRARY, p.overlay);
    this.homeT = p.home ?? {};
    this.project = this.homeT.cwd ?? null;
    this.scope = "project";  // "project" | "all"
    this.archived = false;
    this.all = [];
    this.selected = null;
    this.built = {};         // builtKey -> parts
    this.confirm = null;     // id awaiting a second delete press
    this.previewWidth = 640;
    this.query = "";
    this.typing = false;
    this.handle = cx.focus_handle();
    if (fresh) {
      this.handle.focus();
      cx.timer.after(150, () => this.handle.focus());
    }
    this.listScroll = ScrollHandle.new();
    this.input = InputState.new({ placeholder: "Search the library" });
    this.input.on("change", (_e, cx) => { this.query = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => { this.handle.focus(); cx.notify(); });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    cx.spawn(async (cx) => {
      if (this.project) {
        const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: this.project, timeout: 3000 }).catch(() => null);
        if (r?.code === 0 && r.stdout.trim()) this.project = r.stdout.trim();
      }
      await ensureDirs();
      while (!this.closed) {
        this.all = await listArtifacts();
        cx.notify();
        await watchFolder(lib()).catch(() => null);
      }
    });
    cx.spawn(async (cx) => {
      for (;;) { const c = await nextCommand(); if (c === "focus") { this.handle.focus(); cx.notify(); } }
    });
  }

  list() {
    const q = this.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return this.all.filter((a) =>
      Boolean(a.archived) === this.archived &&
      (this.scope === "all" || a.project === this.project) &&
      (!q.length || q.every((w) => [a.title, a.project].join(" ").toLowerCase().includes(w))));
  }

  current() {
    const l = this.list();
    return l.find((a) => a.id === this.selected) ?? l[0] ?? null;
  }

  move(delta) {
    const l = this.list();
    if (!l.length) return;
    const i = Math.max(0, l.findIndex((a) => a.id === this.current()?.id));
    const n = l[(i + delta + l.length) % l.length];
    this.selected = n.id;
    this.confirm = null;
    this.listScroll.scroll_to_item(l.indexOf(n));
  }

  showInPane(a, cx) {
    const term = this.homeT.terminal;
    if (!term) return notify({ title: "Library", body: "Open the library from a terminal to show an artifact beside it.", level: "warning", timeout: 3000 });
    cx.spawn(async (cx) => {
      await setCurrent(term, a.id);
      // Close once the pane is there: closing first would cancel the wait for a new pane.
      ensurePane(term, cx, () => closeOverlay(this.overlay));
    });
  }

  // Open the document in its app, and get out of the way.
  openDoc(a) {
    exec("open", [docOf(a)]).catch(() => {});
    closeOverlay(this.overlay);
  }

  archive(a, cx) {
    cx.spawn(async (cx) => {
      await setArchived(a, !a.archived);
      notify({ title: a.archived ? "Restored" : "Archived", body: a.title, level: "success", timeout: 1200 });
      this.all = await listArtifacts();
      cx.notify();
    });
  }

  remove(a, cx) {
    if (this.confirm !== a.id) { this.confirm = a.id; cx.notify(); return; }
    this.confirm = null;
    cx.spawn(async (cx) => {
      await deleteArtifact(a);
      this.all = await listArtifacts();
      cx.notify();
    });
  }

  keys(e, cx) {
    const k = e.key, m = e.modifiers ?? {};
    if (this.typing) {
      if (k === "escape") { this.handle.focus(); cx.stop_propagation(); }
      else if (k === "down") { this.move(1); cx.stop_propagation(); }
      else if (k === "up") { this.move(-1); cx.stop_propagation(); }
      cx.notify();
      return;
    }
    if (m.platform || m.control || m.alt) return;
    const a = this.current();
    const map = {
      j: () => this.move(1), down: () => this.move(1), k: () => this.move(-1), up: () => this.move(-1),
      enter: () => a && this.showInPane(a, cx), o: () => a && this.openDoc(a),
      a: () => a && this.archive(a, cx), d: () => a && this.remove(a, cx),
      tab: () => { this.scope = this.scope === "project" ? "all" : "project"; },
      x: () => { this.archived = !this.archived; },
      "/": () => this.input.focus(),
      q: () => closeOverlay(this.overlay), escape: () => closeOverlay(this.overlay),
    };
    const f = map[k] ?? map[e.key_char];
    if (f) { f(); cx.stop_propagation(); cx.notify(); }
  }

  renderLibrary(cx) {
    const t = theme();
    const list = this.list();
    const cur = this.current();
    if (cur && !this.built[builtKey(cur)] && !this.building) {
      this.building = true;
      cx.spawn(async (cx) => { this.built[builtKey(cur)] = await build(cur); this.building = false; cx.notify(); });
    }
    const live = this.all.filter((a) => !a.archived);
    const counts = { project: live.filter((a) => a.project === this.project).length, all: live.length };

    const top = h_flex().px(14).h(44).gap(10).items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .child(div().text_size(13).font_semibold().text_color(t.foreground).child("Library"))
      .child(h_flex().gap(2).p(2).rounded(7).bg(t.background)
        .child(this.chip("scope-project", `Project · ${tail(this.project) || "—"}  ${counts.project}`, this.scope === "project", t, (_e, cx) => { this.scope = "project"; cx.notify(); }))
        .child(this.chip("scope-all", `All  ${counts.all}`, this.scope === "all", t, (_e, cx) => { this.scope = "all"; cx.notify(); })))
      .child(this.chip("archived", this.archived ? "Archived ✓" : "Archived", this.archived, t, (_e, cx) => { this.archived = !this.archived; cx.notify(); }))
      .child(div().flex_1())
      .child(h_flex().w(220).h(26).px(8).items_center().rounded(6).border_1().border_color(this.typing ? t.accent : t.input).bg(t.background)
        .on_mouse_down("left", stop)
        .child(div().flex_1().min_w(0).child(Input.new(this.input).w_full().text_size(12).text_color(t.foreground))))
      .child(this.button("close", "✕", t, () => closeOverlay(this.overlay)));

    const row = (a) => {
      const on = a.id === cur?.id;
      const n = Object.keys(a.embeds ?? {}).length;
      return h_flex().id(`row-${a.id}`).px(10).py(7).gap(8).items_center().rounded(6)
        .bg(on ? t.selected : t.background).hover((s) => s.bg(on ? t.selected : t.hover))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { this.selected = a.id; this.confirm = null; cx.notify(); })
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(12.5).text_color(t.foreground).child(a.title))
          .child(div().truncate().text_size(11).text_color(t.dim)
            .child(`${this.scope === "all" ? tail(a.project) + " · " : ""}${n ? `${n} embed${n === 1 ? "" : "s"}` : "prose"}`)))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(a.updated)));
    };

    const empty = (text) => v_flex().flex_1().h_full().items_center().justify_center().gap(4).text_color(t.dim).text_size(12).child(text);
    const left = v_flex().w(320).h_full().flex_none().border_r(1).border_color(t.border)
      .child(list.length
        ? v_flex().id("lib-list").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.listScroll).p(6).gap(2).children(list.map(row))
        : empty(this.archived ? "Nothing archived" : this.scope === "project" ? "No artifacts in this project yet" : "The library is empty"))
      .child(div().px(12).py(6).border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
        .child("↵ show in pane · o open · a archive · d d delete · tab project/all · x archived · / search"));

    let right;
    if (!cur) right = empty("Select an artifact");
    else {
      const del = this.confirm === cur.id;
      right = v_flex().flex_1().h_full().min_w(0)
        .child(h_flex().px(14).py(8).gap(6).items_center().border_b(1).border_color(t.border)
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground).child(cur.title))
            .child(div().truncate().text_size(11).text_color(t.dim).child(`${tildify(cur.project, home())} · published ${new Date(cur.updated).toLocaleString()}`)))
          .child(this.button("show", "Show in pane", t, (_e, cx) => this.showInPane(cur, cx), { primary: true }))
          .child(this.button("open", "Open", t, () => this.openDoc(cur)))
          .child(this.button("copy", "Copy path", t, (_e, cx) => { cx.write_to_clipboard(dirOf(cur.id)); notify({ title: "Copied path", body: dirOf(cur.id), level: "success", timeout: 1200 }); }))
          .child(this.button("arch", cur.archived ? "Unarchive" : "Archive", t, (_e, cx) => this.archive(cur, cx)))
          .child(this.button("del", del ? "Delete for good?" : "Delete", t, (_e, cx) => this.remove(cur, cx), { danger: del })))
        .child(v_flex().flex_1().min_h(0)
          .on_size_change((size, cx) => { if (Math.abs(size.width - this.previewWidth) > 1) { this.previewWidth = size.width; cx.notify(); } })
          .child(this.documentView(`lib-doc-${cur.id}`, this.built[builtKey(cur)], this.previewWidth, t, cur.title)));
    }

    return v_flex().id("lib-root").size_full().bg(t.background).track_focus(this.handle).key_context("VizLibrary").on_action("viz-escape", (_e, cx) => this.keys({ key: "escape", keystroke: "escape", modifiers: {} }, cx))
      .on_key_down((e, cx) => this.keys(e, cx))
      .child(top)
      .child(h_flex().flex_1().min_h(0).items_start().child(left).child(right));
  }

  render(cx) {
    if (this.role === "pane") return this.renderPane();
    if (this.role === "library") return this.renderLibrary(cx);
    if (this.role === "expand") return renderExpand(this);
    return div();
  }
}
