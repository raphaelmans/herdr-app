// Cmd+O: find paths below the terminal's captured cwd; choose a viewer afterward.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Input, InputState, VirtualListScrollHandle, v_virtual_list, Scrollbar, Editor, EditorState } from "gpui-base";
import { checking, focused, spaces, terminals, panes, exec, readTextFile, openOverlay, closeOverlay, props, theme, run, notify } from "herdr";
import { indexFiles, search } from "./search.js";

// A wait: one spinner, turned natively, and what is being waited for.
const SEARCH_PAUSE = 1000;
const waiting = (t, label) => h_flex().gap(8).items_center().child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)).child(label);

const markdown = path => /\.(md|markdown|mdown)$/i.test(path);
const absolute = (root, path) => `${root.replace(/[\\/]$/, "")}/${path}`;
// As in the Git and Send Box mods, Escape must be an action: a dialog's
// built-in Escape otherwise closes it before an input can leave insert mode.
let keysBound = false;

export default class FilePicker extends View {
  init(_props, cx) {
    if (!keysBound) {
      cx.bind_keys([
        { keystroke: "escape", action: "file-picker-escape", context: "FilePicker" },
        ...["n", "j", "p", "k", "d", "u"].map(key => ({ keystroke: `ctrl-${key}`, action: `file-picker-ctrl-${key}`, context: "FilePicker" })),
      ]);
      keysBound = true;
    }
    this.source = focused();
    const space = spaces().find(s => s.id === this.source?.space);
    this.root = this.source?.cwd || space?.folder;
    this.on = space?.machine ?? null;
    this.files = []; this.matches = []; this.at = 0; this.loading = true;
    this.hidden = true; this.ignored = false; this.generation = 0; this.scanGeneration = 0;
    this.closed = false; this.searching = false; this.warning = null;
    this.typing = false; this.help = false; this.pageRows = 10;
    this.previewLine = 0; this.lineOffsets = [0];
    this.error = null; this.selected = null; this.code = null; this.previewError = null;
    this.input = InputState.new({ placeholder: "Search filenames and paths…" });
    this.scroll = VirtualListScrollHandle.new();
    this.handle = cx.focus_handle();
    this.input.on("change", (_e, cx) => this.filter(cx));
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    if (checking()) { this.loading = false; return; }
    this.handle.focus();
    cx.timer.after(100, () => { if (!this.typing && !this.selected) this.handle.focus(); });
    this.rescan(cx);
  }

  async discover(hidden, ignored) {
    // fd is Snacks' first choice too. Fall back only when a finder is absent.
    for (const command of ["fd", "fdfind", "rg"]) {
      const args = command === "rg"
        ? ["--files", "--null", "--no-messages", "--color", "never", "-g", "!.git"]
        : ["--type", "f", "--type", "l", "--print0", "--color", "never", "-E", ".git"];
      if (hidden) args.push("--hidden");
      if (ignored) args.push("--no-ignore");
      if (command === "rg") args.push(".");
      try {
        const r = await exec(command, args, { cwd: this.root, on: this.on, timeout: 15000 });
        if (r.code === 127) continue;
        return r;
      } catch (e) {
        if (/not found|no such file|cannot find.*(?:fd|rg)/i.test(String(e))) continue;
        throw e;
      }
    }
    throw new Error("Install fd or ripgrep on this machine to search files.");
  }

  rescan(cx) {
    this.scanGeneration++; this.generation++;
    this.files = []; this.matches = []; this.at = 0;
    this.loading = true; this.searching = false; this.error = null; this.warning = null;
    cx.notify();
    // Serialize directory walks. Rapid toggles replace the pending request,
    // instead of spawning one filesystem walk per click.
    if (this.scanning) return;
    this.scanning = true;
    cx.spawn(async cx => {
      while (!this.closed) {
        const token = this.scanGeneration;
        const current = () => !this.closed && token === this.scanGeneration;
        try {
          if (!this.root) throw new Error("Focus a terminal with a working directory, then press Cmd+O.");
          const r = await this.discover(this.hidden, this.ignored);
          if (!current()) continue;
          if (r.code !== 0 && !(r.code === 1 && !r.stderr) && !r.stdout) throw new Error(r.stderr || "Unable to list files.");
          const indexed = await indexFiles(r.stdout, () => cx.sleep(1), current);
          if (!indexed || !current()) continue;
          this.files = indexed.items;
          this.warning = indexed.truncated || r.stdout.length >= 8 * 1024 * 1024 - 4096
            ? "File list reached Herdr's output limit. Open a narrower working directory."
            : r.code > 1 ? "Some folders could not be read; showing available files." : null;
          this.loading = false;
          this.filter(cx, true);
        } catch (e) { if (current()) { this.error = String(e.message ?? e); this.loading = false; } }
        if (current()) break;
      }
      this.scanning = false;
      if (!this.closed) cx.notify();
    });
  }

  // Debounced: the search runs once typing pauses for SEARCH_PAUSE ms. The
  // previous results stay on screen meanwhile, so the list doesn't blank and
  // flicker on every keystroke. `now` skips the pause (first fill, Enter).
  filter(cx, now = false) {
    const token = ++this.generation, query = this.input.value(), items = this.files;
    this.searching = Boolean(query.trim());
    cx.notify();
    const current = () => !this.closed && token === this.generation;
    cx.spawn(async cx => {
      if (query.trim() && !now) await cx.sleep(SEARCH_PAUSE);
      if (!current()) return;
      const result = await search(items, query, () => cx.sleep(1), current);
      if (!result || !current()) return;
      this.matches = result; this.at = 0; this.searching = false;
      this.scroll.scroll_to_item(0); cx.notify();
      if (this.openWhenSearched) { this.openWhenSearched = false; this.openFile(cx); }
    });
  }

  // Enter while a search is still pending opens the top result for what was
  // typed, not the stale row left from the previous query.
  submit(cx) {
    if (!this.searching) return this.openFile(cx);
    this.openWhenSearched = true;
    this.filter(cx, true);
  }

  selectedPath() { return this.selected ?? this.matches[this.at]?.path; }

  normal(cx) { this.typing = false; this.handle.focus(); cx.notify(); }

  back(cx) {
    this.selected = null;
    this.code?.release(); this.code = null;
    this.normal(cx);
    this.scroll.scroll_to_item(this.at, "center");
  }

  escape(cx) {
    if (this.help) { this.help = false; this.normal(cx); }
    else if (this.typing) this.normal(cx);
    else if (this.selected) this.back(cx);
    else closeOverlay(props().overlay);
    cx.stop_propagation();
  }

  move(to, cx) {
    if (this.selected) {
      this.previewLine = Math.max(0, Math.min(to, this.lineOffsets.length - 1));
      const at = this.lineOffsets[this.previewLine];
      this.code?.set_selected_range({ start: at, end: at });
    } else {
      this.at = Math.max(0, Math.min(to, this.matches.length - 1));
      this.scroll.scroll_to_item(this.at, "center");
    }
    cx.notify();
  }

  control(key, cx) {
    if (this.help) return;
    const from = this.selected ? this.previewLine : this.at;
    const half = Math.max(1, Math.floor(this.pageRows / 2));
    this.move(from + ({ n: 1, j: 1, p: -1, k: -1, d: half, u: -half })[key], cx);
    cx.stop_propagation();
  }

  copyPath(cx, full = false) {
    const path = this.selectedPath();
    if (path && (!full || this.root)) {
      cx.write_to_clipboard(full ? absolute(this.root, path) : path);
      notify({ title: full ? "Absolute path copied" : "Relative path copied", timeout: 1500 });
    }
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
    // Printable keys belong to the input while inserting; j/k never eat queries.
    if (this.typing) {
      const step = { down: 1, up: -1, pagedown: this.pageRows, pageup: -this.pageRows }[key];
      if (step !== undefined) { this.move(this.at + step, cx); cx.stop_propagation(); }
      return;
    }
    if (m.control) return; // Scoped native actions handle these, including in inputs.
    const from = this.selected ? this.previewLine : this.at;
    const last = (this.selected ? this.lineOffsets.length : this.matches.length) - 1;
    if (ch === "j" || key === "down") this.move(from + 1, cx);
    else if (ch === "k" || key === "up") this.move(from - 1, cx);
    else if (ch === "g" || key === "home") this.move(0, cx);
    else if (ch === "G" || key === "end") this.move(last, cx);
    else if (key === "pagedown") this.move(from + this.pageRows, cx);
    else if (key === "pageup") this.move(from - this.pageRows, cx);
    else if (ch === "h" || key === "left" || key === "backspace") { if (this.selected) this.back(cx); }
    else if (ch === "l" || key === "right" || key === "enter") this.openFile(cx);
    else if (ch === "p") { if (!this.selected) this.preview(cx); }
    else if (ch === "/" || ch === "i") { if (this.selected) this.back(cx); this.typing = true; this.input.focus(); cx.notify(); }
    else if (ch === "q") closeOverlay(props().overlay);
    else if (ch === "e") this.openNvim(cx);
    else if (ch === "y") this.copyPath(cx);
    else if (ch === "Y") this.copyPath(cx, true);
    else if (ch === "?") { this.help = true; cx.notify(); }
    else if (ch === "H" && !this.selected) { this.hidden = !this.hidden; this.rescan(cx); }
    else if (ch === "I" && !this.selected) { this.ignored = !this.ignored; this.rescan(cx); }
    else if (ch === "R" && !this.selected) this.rescan(cx);
    else return;
    cx.stop_propagation();
  }

  preview(cx) {
    const path = this.matches[this.at]?.path;
    if (!path) return;
    this.normal(cx);
    if (markdown(path)) return this.openMarkdown(path);
    this.selected = path; this.previewError = null;
    this.code?.release(); this.code = null;
    cx.spawn(async cx => {
      try {
        const text = await readTextFile(absolute(this.root, path), { on: this.on });
        if (this.selected !== path) return;
        if (text === null) throw new Error("This file is no longer available.");
        if (text.includes("\0")) throw new Error("Binary file — no text preview.");
        const ext = path.split(".").pop();
        const value = text.slice(0, 400000) + (text.length > 400000 ? "\n… Preview truncated" : "");
        this.previewLine = 0; this.lineOffsets = [0];
        for (let i = 0; i < value.length; i++) if (value[i] === "\n") this.lineOffsets.push(i + 1);
        this.code = EditorState.new({ readonly: true, language: ({ ts: "js", tsx: "js", jsx: "js" })[ext] ?? ext,
          value, font_size: 13 });
      } catch (e) { if (this.selected === path) this.previewError = String(e.message ?? e); }
      cx.notify();
    });
    cx.notify();
  }

  openMarkdown(path) {
    openOverlay({ mod: "md-popup", kind: "dialog", width: 960, height: 1, frame: "none",
      props: { file: absolute(this.root, path), on: this.on } });
  }

  openFile(cx) {
    const path = this.selectedPath();
    if (!path || this.opening) return;
    if (!markdown(path)) return this.openNvim(cx);
    const source = panes().find(p => p.pane === this.source?.pane);
    if (!source || focused()?.tab !== source.tab) {
      notify({ title: "Could not open preview", body: "Return to the original tab and reopen the picker.", level: "error" });
      return;
    }
    this.opening = true;
    const before = new Set(panes().map(p => p.pane));
    run("pane.split", { pane: source.pane, direction: "right", mod: "md-popup",
      props: { file: absolute(this.root, path), on: this.on, mode: "pane" } });
    cx.spawn(async cx => {
      const end = Date.now() + 3000;
      let made;
      while (!this.closed) {
        made = panes().find(p => p.tab === source.tab && p.mod === "md-popup" && !before.has(p.pane));
        if (made || Date.now() >= end) break;
        await cx.sleep(20);
      }
      this.opening = false;
      if (this.closed) return;
      if (made) {
        closeOverlay(props().overlay);
        if (focused()?.tab === source.tab) run("pane.focus", { pane: made.pane });
      } else {
        notify({ title: "Could not open preview", body: "The Markdown pane could not be created. Try again.", level: "error" });
        cx.notify();
      }
    });
    cx.notify();
  }

  openNvim(cx) {
    const path = this.selectedPath();
    if (!path || this.opening) return;
    this.opening = true;
    cx.spawn(async cx => {
      try {
        // Keep the captured tab as the destination, even if focus changed.
        if (focused()?.tab !== this.source?.tab) throw new Error("Return to the original tab and reopen the picker.");
        const existing = terminals().find(t => t.state === "live" && t.labels?.["nvim-pane.tab"] === this.source.tab);
        if (existing) {
          const socket = `/tmp/nvim-pane-${this.source.tab.replace(/[^A-Za-z0-9]/g, "_")}.sock`;
          const r = await exec("nvim", ["--server", socket, "--remote", absolute(this.root, path)], { on: this.on });
          if (r.code !== 0) throw new Error(r.stderr || "Neovim could not open this file.");
          const shown = panes().some(p => p.terminal === existing.address);
          run(shown ? "pane.focus" : "terminal.keep", shown ? { terminal: existing.address } : { terminal: existing.address, place: "right" });
        } else {
          run("terminal.open", { argv: ["nvim", "--", absolute(this.root, path)], folder: this.root, place: "right" });
        }
        closeOverlay(props().overlay);
      } catch (e) { notify({ title: "Could not open Neovim", body: String(e.message ?? e), level: "error" }); }
      this.opening = false; cx.notify();
    });
  }

  async close() {
    this.closed = true; this.generation++; this.scanGeneration++;
    this.input?.release(); this.scroll?.release(); this.code?.release();
  }

  render() {
    const t = theme(), path = this.selectedPath();
    const button = (id, label, action, enabled = true) => div().id(id).px(12).py(8).rounded(7)
      .bg(t.raised).opacity(enabled ? 1 : 0.4).child(label)
      .when(enabled, el => el.cursor_pointer().hover(s => s.bg(t.hover)).on_click(action));
    const matches = this.matches;
    return v_flex().id("file-picker").track_focus(this.handle).key_context("FilePicker").size_full().min_h(0).p(18).gap(10)
      .bg(t.popover).text_color(t.foreground).text_size(13)
      .on_action("file-picker-escape", (_e, cx) => this.escape(cx))
      .on_action("file-picker-ctrl-n", (_e, cx) => this.control("n", cx))
      .on_action("file-picker-ctrl-j", (_e, cx) => this.control("j", cx))
      .on_action("file-picker-ctrl-p", (_e, cx) => this.control("p", cx))
      .on_action("file-picker-ctrl-k", (_e, cx) => this.control("k", cx))
      .on_action("file-picker-ctrl-d", (_e, cx) => this.control("d", cx))
      .on_action("file-picker-ctrl-u", (_e, cx) => this.control("u", cx))
      .on_key_down((e, cx) => this.keys(e, cx))
      .child(h_flex().items_center().justify_between()
        .child(div().font_semibold().text_size(17).child(this.selected ? "File preview" : "Find a file"))
        .child(button("fp-close", "Close", () => closeOverlay(props().overlay))))
      .child(div().text_color(t.dim).text_size(11).truncate().child(this.root ?? "No working directory"))
      .when(this.help, el => el.child(v_flex().flex_1().gap(12).p(14)
        .child(div().font_semibold().child("Keyboard controls"))
        .children([
          "Esc: leave search → back from preview → close",
          "j / k: down / up     g or gg / G: first / last",
          "Ctrl+D / Ctrl+U: half page     Page Down / Page Up: full page",
          "l / Enter: open (Markdown preview pane; other files in Neovim)",
          "p: quick preview     h: back to files     / or i: search",
          "e: open in Neovim     y: copy relative path     Y: copy absolute path",
          "H: hidden files     I: ignored files     R: refresh",
          "Ctrl+N / Ctrl+P or Ctrl+J / Ctrl+K: move while searching",
          "q: close     ?: help     Esc / q: leave help",
        ].map(text => div().child(text)))))
      .when(!this.selected && !this.help, el => el
        .child(h_flex().gap(8)
          .child(button("fp-hidden", `Hidden: ${this.hidden ? "on" : "off"}`, (_e, cx) => { this.hidden = !this.hidden; this.rescan(cx); }))
          .child(button("fp-ignored", `Ignored: ${this.ignored ? "on" : "off"}`, (_e, cx) => { this.ignored = !this.ignored; this.rescan(cx); }))
          .child(button("fp-refresh", "Refresh", (_e, cx) => this.rescan(cx))))
        .child(Input.new(this.input).h(38).px(10).rounded(8).border_1().border_color(t.accent).bg(t.background))
        .child(v_flex().relative().flex_1().min_h(0)
          .on_size_change(size => { this.pageRows = Math.max(1, Math.floor(size.height / 33)); })
          .when(Boolean(matches.length), box => box
            .child(v_virtual_list("fp-results", matches.length, 33, i => matches[i].path,
              range => matches.slice(range.start, range.end).map((item, offset) => h_flex().id(item.path).h(33).px(10).gap(10).items_center().rounded(6)
                .bg(range.start + offset === this.at ? t.hover : t.popover).cursor_pointer()
                .child(div().w(28).text_size(10).text_color(markdown(item.path) ? t.accent : t.dim).child(markdown(item.path) ? "MD" : "file"))
                .child(div().flex_1().min_w(0).truncate().child(item.path))))
              .track_scroll(this.scroll).size_full()
              .on_item_click((key, cx) => { const i = this.matches.findIndex(item => item.path === key); if (i < 0) return; this.at = i; this.normal(cx); }))
            .child(Scrollbar.vertical("fp-results").absolute().inset_0()))
          .when(!matches.length, box => box.child(div().p(12).text_color(t.dim).child(this.error || (this.loading ? waiting(t, "Finding files") : this.searching ? waiting(t, "Searching") : "No matching files")))))
        .when(Boolean(this.warning), el => el.child(div().text_size(11).text_color(t.blocked).child(this.warning)))
        .child(div().text_size(11).text_color(t.dim).child(this.searching && matches.length ? waiting(t, "Searching") : this.typing
          ? `${matches.length} files · INSERT · Esc navigate · Ctrl+J/K select · Enter open`
          : `${matches.length} files · NORMAL · j/k move · / search · Enter/l open · p preview · ? help`)))
      .when(Boolean(this.selected) && !this.help, el => el
        .child(h_flex().items_center().gap(10)
          .child(button("fp-back", "← Files · h", (_e, cx) => this.back(cx)))
          .child(div().flex_1().truncate().child(this.selected)))
        .child(this.code ? Editor.new(this.code).flex_1().min_h(0) : div().flex_1().p(12).child(this.previewError || (this.selected ? waiting(t, "Reading preview") : ""))))
      .child(h_flex().gap(8).justify_end()
        .when(!this.selected, el => el.child(button("fp-preview", markdown(path ?? "") ? "Markdown preview · p" : "Preview · p", (_e, cx) => this.preview(cx), Boolean(path))))
        .child(button("fp-copy", "Copy relative path · y", (_e, cx) => this.copyPath(cx), Boolean(path)))
        .child(button("fp-copy-absolute", "Copy absolute path · Y", (_e, cx) => this.copyPath(cx, true), Boolean(path && this.root)))
        .when(markdown(path ?? ""), el => el.child(button("fp-nvim", "Edit in Neovim · e", (_e, cx) => this.openNvim(cx), Boolean(path) && !this.opening)))
        .child(button("fp-open", this.opening ? waiting(t, "Opening") : markdown(path ?? "") ? "Open preview pane · ↵" : "Open in Neovim · ↵", (_e, cx) => this.openFile(cx), Boolean(path) && !this.opening)));
  }
}
