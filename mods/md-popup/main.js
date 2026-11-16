// Markdown preview pane from Cmd+O, or popup opened from nvim with <leader>mp
// (~/.config/nvim/lua/plugins/md-preview-herdr.lua).
//
// nvim writes the file's path to mods/md-popup/.file (hidden, so writing it
// doesn't reload the mod), then runs `herdr-app do mod.open '{"name":"md-popup"}'`.
// The popup renders that file and reloads when it changes on disk.
// ```mermaid blocks are drawn as diagrams by Pele (mermaid.js); their SVGs go
// to the hidden .cache folder, since image() only reads inside the app home.
// Esc or q closes it. In a pane, e replaces the preview with Neovim.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { appHome, checking, closeOverlay, exec, focused, nextCommand, notify, panes, props, readTextFile, run, theme, watchFolder } from "herdr";
import * as fs from "fs/promises";
import { renderMermaid, splitMermaid } from "./mermaid.js";

const CACHE = "mods/md-popup/.cache";

const dirname = (p) => p.replace(/\/[^/]*$/, "") || "/";
const basename = (p) => p.replace(/^.*\//, "");

// FNV-1a: the cache name of an SVG.
function hashOf(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0") + s.length.toString(16);
}

// Mods read files only inside the app home; anything else goes through cat.
async function readText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    const r = await exec("cat", [file]);
    if (r.code !== 0) throw new Error(r.stderr);
    return r.stdout;
  }
}

// Segments ready to draw: {kind: "md", text} | {kind: "diagram", src, w, h} | {kind: "error", text}.
async function build(text, cache) {
  const t = theme();
  const dir = `${appHome()}/${cache}`;
  await fs.mkdir(dir, { recursive: true });
  const used = new Set();
  const out = [];
  for (const seg of splitMermaid(text)) {
    if (seg.kind === "md") {
      if (seg.text.trim()) out.push(seg);
      continue;
    }
    const r = renderMermaid(seg.text, t);
    if (r.error) {
      out.push({ kind: "error", text: r.error, source: seg.text });
      continue;
    }
    const name = `${hashOf(r.svg)}.svg`;
    used.add(name);
    if (!(await fs.exists(`${dir}/${name}`))) await fs.writeFile(`${dir}/${name}`, r.svg);
    out.push({ kind: "diagram", src: `${cache}/${name}`, w: r.width, h: r.height });
  }
  // Each preview owns its cache, so refreshing one cannot erase another's diagrams.
  for (const old of await fs.readdir(dir).catch(() => [])) {
    const n = typeof old === "string" ? old : old.name;
    if (n.endsWith(".svg") && !used.has(n)) await fs.unlink(`${dir}/${n}`).catch(() => {});
  }
  return out;
}

export default class MdPopup extends View {
  init(_props, cx) {
    this.file = null;
    this.segments = null;
    this.error = null;
    this.inPane = props()?.mode === "pane";
    this.width = 960;
    this.closed = false;
    this.opening = false;
    this.h = cx.focus_handle();
    if (checking()) return;
    this.cache = `${CACHE}/${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    this.on = props()?.on ?? null;
    cx.spawn(async cx => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.h.focus();
        else if (this.h.is_focused()) {
          if (command === "edit") this.edit(cx);
          else if (command === "close") this.dismiss();
        }
      }
    });
    cx.spawn(async (cx) => {
      this.h.focus();
      try {
        this.file = props()?.file || (await fs.readFile(`${appHome()}/mods/md-popup/.file`, "utf8")).trim();
      } catch {
        this.error = "No file to preview. Press <leader>mp in a markdown buffer in nvim.";
        cx.notify();
        return;
      }
      const ours = (changed) => !changed.length || changed.some((p) => p === this.file || p === dirname(this.file));
      while (!this.closed) {
        try {
          const text = this.on ? await readTextFile(this.file, { on: this.on }) : await readText(this.file);
          if (text === null) throw new Error("This file is no longer available.");
          // Unchanged text in the same theme draws the same: a remote file is
          // read again every few seconds, and rebuilding redraws every diagram.
          const key = `${theme().background}\0${text}`;
          if (key !== this.built) {
            this.segments = await build(text, this.cache);
            this.built = key;
            this.error = null;
            cx.notify();
          }
        } catch (e) {
          this.built = null;
          this.error = `Can't show this file: ${e?.message ?? e}`;
          cx.notify();
        }
        if (this.on) await cx.sleep(3000);
        else while (!this.closed) {
          this.watchTask = watchFolder(dirname(this.file));
          if (ours(await this.watchTask)) break;
        }
      }
    });
  }

  async close() {
    this.closed = true;
    this.watchTask?.cancel();
    if (!this.cache) return;
    const dir = `${appHome()}/${this.cache}`;
    for (const old of await fs.readdir(dir).catch(() => [])) {
      const name = typeof old === "string" ? old : old.name;
      await fs.unlink(`${dir}/${name}`).catch(() => {});
    }
    await fs.rmdir(dir).catch(() => {});
  }

  currentPane() {
    const id = props()?.pane ?? focused()?.pane;
    return this.inPane ? panes().find(p => p.pane === id && p.mod === "md-popup") : null;
  }

  dismiss() {
    const overlay = props()?.overlay;
    if (overlay) return closeOverlay(overlay);
    const pane = this.currentPane();
    if (pane) run("pane.close", { pane: pane.pane });
  }

  edit(cx) {
    const source = this.currentPane();
    if (!source || !this.file || this.opening) return;
    this.opening = true;
    cx.notify();
    cx.spawn(async cx => {
      try {
        const before = new Set(panes().map(p => p.pane));
        // Split first, then remove only this preview after the editor exists.
        // Collapsing that split leaves the editor in the preview's old position.
        run("pane.split", { pane: source.pane, direction: "right", argv: ["nvim", "--", this.file] });
        const end = Date.now() + 3000;
        let made;
        while (!this.closed) {
          made = panes().find(p => p.tab === source.tab && p.terminal && !before.has(p.pane));
          if (made || Date.now() >= end) break;
          await cx.sleep(20);
        }
        if (this.closed) return;
        if (!made) throw new Error("The editor pane could not be created. Your preview is still open.");
        run("pane.close", { pane: source.pane });
        if (focused()?.tab === source.tab) {
          run("pane.focus", { pane: made.pane });
          if (source.zoomed) run("pane.zoom", { pane: made.pane });
        }
      } catch (e) {
        this.opening = false;
        notify({ title: "Could not open Neovim", body: String(e.message ?? e), level: "error" });
        cx.notify();
      }
    });
  }

  segment(seg, i, t) {
    if (seg.kind === "md") return TextView.markdown(`md-popup-${i}`, seg.text).selectable(true);
    if (seg.kind === "diagram") {
      const scale = Math.min(1, Math.max(1, this.width - 44) / seg.w);
      return h_flex().w_full().justify_center().py(10).child(image(seg.src).w(seg.w * scale).h(seg.h * scale));
    }
    return v_flex()
      .my(8)
      .p(12)
      .gap(6)
      .rounded(6)
      .border(1)
      .border_color(t.blocked ?? t.border)
      .child(div().text_color(t.blocked ?? t.foreground).text_size(12).child("Mermaid error"))
      .child(div().text_color(t.muted).text_size(12).child(seg.text));
  }

  render() {
    const t = theme();
    const overlay = Boolean(props()?.overlay);
    const body = this.error
      ? div().m_auto().text_color(t.dim).child(this.error)
      : !this.segments
        ? div()
        : v_flex()
            .id("md-popup-scroll")
            .flex_1()
            .min_h(0)
            .overflow_y_scrollbar()
            .px(22)
            .py(14)
            .gap(4)
            .children(this.segments.map((s, i) => this.segment(s, i, t)));
    return v_flex()
      .id("md-popup")
      .track_focus(this.h)
      .on_key_down((e, cx) => {
        const m = e.modifiers ?? {};
        if (m.platform || m.control || m.alt || m.shift) return;
        if (e.key === "q" || e.key === "escape") this.dismiss();
        else if (e.key === "e" && this.inPane) this.edit(cx);
        else return;
        cx.stop_propagation();
      })
      .on_size_change((size, cx) => {
        if (this.width !== size.width) { this.width = size.width; cx.notify(); }
      })
      .size_full()
      // The frameless dialog owns the window height; inset the visible frame.
      // Match Go to's 18px margins, including when the app is zoomed or resized.
      .when(overlay, (el) => el.py(18))
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .overflow_hidden()
          .bg(t.background)
          .when(overlay, (el) => el.rounded(8).border(1).border_color(t.border).shadow_lg())
          .text_size(14)
          .text_color(t.foreground)
          .child(
            h_flex()
              .flex_none()
              .px(16)
              .py(8)
              .border_b(1)
              .border_color(t.border)
              .text_size(12)
              .text_color(t.muted)
              .justify_between()
              .child(div().flex_1().min_w(0).truncate().child(this.file ? basename(this.file) : "Markdown preview"))
              .when(this.inPane, el => el.child(div().id("md-edit").flex_none().px(10).py(4).rounded(5).bg(t.raised)
                .child(this.opening ? "Opening Neovim…" : "Edit in Neovim · e")
                .when(Boolean(this.file) && !this.opening, button => button.cursor_pointer().hover(s => s.bg(t.hover)).on_click((_e, cx) => this.edit(cx)))))
              .child(div().flex_none().pl(12).child("Esc / q to close")),
          )
          .child(body),
      );
  }
}
