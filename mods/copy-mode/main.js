import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, focused, hc, notify, props, run, settings, theme } from "herdr";

// tmux-style copy mode (vi keys) over a snapshot of a terminal's screen and history.
// Herdr can't draw a cursor or set a selection on a live terminal, so this reads the
// text with `hc read` and draws its own view. Like tmux, the view is frozen; `r` re-reads.
// Open it from tmux-prefix (Ctrl+A [) as a window with props { terminal }.

const HISTORY = 10000; // lines of scrollback above the screen
const PAD = 10;        // px left of the text
const FOOTER = 26;     // px

const untab = (s) => s.replace(/\r$/, "").replace(/[^\t]*\t/g, (m) => m.slice(0, -1) + " ".repeat(8 - ((m.length - 1) % 8)));
const isSpace = (ch) => ch === undefined || ch === "\n" || /\s/.test(ch);
const cls = (ch, big) => (isSpace(ch) ? 0 : big ? 1 : /[\p{L}\p{N}_]/u.test(ch) ? 1 : 2);

export default class CopyMode extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.terminal = props()?.terminal ?? focused()?.terminal;
    this.lines = [];      // per line, an array of characters
    this.text = [];       // per line, the string
    this.row = 0; this.col = 0; this.want = 0;
    this.top = 0; this.left = 0;
    this.size = { width: 800, height: 600 };
    this.mode = null;     // null | "char" | "line" | "block"
    this.anchor = null;
    this.count = "";
    this.pending = null;  // "g" | "z" | "f" | "F" | "t" | "T"
    this.lastFind = null;
    this.search = null;   // { dir, query }
    this.prompt = null;   // { dir, text } while typing a search
    this.message = "";
    this.loading = true;
    this.error = null;
    this.load(cx, false);
  }

  // ---- data -------------------------------------------------------------

  load(cx, keepPlace) {
    if (!this.terminal) { this.loading = false; this.error = "No terminal has focus."; return; }
    const fromBottom = this.lines.length - 1 - this.row;
    const pending = hc(["read", this.terminal, "--lines", String(HISTORY), "--json"]);
    cx.spawn(async (cx) => {
      try {
        const r = await pending;
        if (r.code !== 0) throw new Error(r.stderr.trim() || `hc read exited ${r.code}`);
        const raw = JSON.parse(r.stdout).text ?? "";
        const text = raw.split("\n").map(untab);
        while (text.length > 1 && !text[text.length - 1].trim()) text.pop();
        this.text = text;
        this.lines = text.map((s) => Array.from(s));
        this.error = null;
        if (keepPlace) {
          this.row = Math.max(0, this.lines.length - 1 - fromBottom);
          this.clampCol();
          this.message = "Refreshed";
        } else {
          this.row = this.lines.length - 1;
          this.col = Math.max(0, this.len(this.row) - 1);
          this.want = this.col;
          this.top = Number.MAX_SAFE_INTEGER; // reveal() puts the last line at the bottom
        }
        this.reveal();
      } catch (e) {
        this.error = `Can't read ${this.terminal}: ${e.message ?? e}`;
      }
      this.loading = false;
      cx.notify();
    });
  }

  len(r) { return this.lines[r]?.length ?? 0; }
  get n() { return this.lines.length; }
  get zoom() { return Number(settings().zoom) || 1; }
  get fontSize() { return Number(settings().font_size) || 14; }
  get rowH() { return Math.ceil(this.fontSize * 1.45); }
  get charW() { return this.fontSize * 0.6; }
  get rows() { return Math.max(1, Math.floor((this.size.height / this.zoom - FOOTER) / this.rowH)); }
  get cols() { return Math.max(1, Math.floor((this.size.width / this.zoom - 2 * PAD) / this.charW)); }

  clampCol() {
    this.col = Math.max(0, Math.min(this.col, this.len(this.row) - 1));
  }

  setRow(r) {
    this.row = Math.max(0, Math.min(this.n - 1, r));
    this.col = this.want === Infinity ? this.len(this.row) - 1 : this.want;
    this.clampCol();
  }

  setPos(r, c) {
    this.row = Math.max(0, Math.min(this.n - 1, r));
    this.col = c;
    this.clampCol();
    this.want = this.col;
  }

  // Scroll the view only as far as needed to show the cursor.
  reveal() {
    const rows = this.rows;
    if (this.row < this.top) this.top = this.row;
    if (this.row >= this.top + rows) this.top = this.row - rows + 1;
    this.top = Math.max(0, Math.min(this.top, this.n - rows));
    const cols = this.cols;
    if (this.col < this.left) this.left = this.col;
    if (this.col >= this.left + cols) this.left = this.col - cols + 1;
    if (this.col < cols) this.left = 0;
  }

  // Scroll the view, dragging the cursor along when it would leave it (ctrl-e/ctrl-y, wheel).
  scrollView(delta) {
    const rows = this.rows;
    this.top = Math.max(0, Math.min(this.top + delta, this.n - rows));
    if (this.row < this.top) this.setRow(this.top);
    if (this.row >= this.top + rows) this.setRow(this.top + rows - 1);
  }

  // ---- motions ----------------------------------------------------------

  at(p) { return p.c < this.len(p.r) ? this.lines[p.r][p.c] : "\n"; }
  next(p) { return p.c < this.len(p.r) ? { r: p.r, c: p.c + 1 } : p.r < this.n - 1 ? { r: p.r + 1, c: 0 } : null; }
  prev(p) { return p.c > 0 ? { r: p.r, c: p.c - 1 } : p.r > 0 ? { r: p.r - 1, c: this.len(p.r - 1) } : null; }
  emptyLine(p) { return p.c === 0 && this.len(p.r) === 0; }

  wordForward(p, big) {
    const k = cls(this.at(p), big);
    let q = p;
    if (k) while (q && cls(this.at(q), big) === k) q = this.next(q);
    while (q && cls(this.at(q), big) === 0 && !(q.r !== p.r && this.emptyLine(q))) q = this.next(q);
    return q ?? { r: this.n - 1, c: this.len(this.n - 1) };
  }

  wordEnd(p, big) {
    let q = this.next(p);
    while (q && cls(this.at(q), big) === 0) q = this.next(q);
    if (!q) return p;
    const k = cls(this.at(q), big);
    for (let s = this.next(q); s && cls(this.at(s), big) === k; s = this.next(s)) q = s;
    return q;
  }

  wordBack(p, big) {
    let q = this.prev(p);
    while (q && cls(this.at(q), big) === 0 && !this.emptyLine(q)) q = this.prev(q);
    if (!q) return { r: 0, c: 0 };
    const k = cls(this.at(q), big);
    if (!k) return q;
    for (let s = this.prev(q); s && cls(this.at(s), big) === k; s = this.prev(s)) q = s;
    return q;
  }

  paragraph(dir) {
    let r = this.row + dir;
    while (r > 0 && r < this.n - 1 && this.text[r].trim()) r += dir;
    return Math.max(0, Math.min(this.n - 1, r));
  }

  find(op, ch, n) {
    const line = this.lines[this.row];
    let c = this.col;
    for (let i = 0; i < n; i++) {
      const from = op === "f" || op === "t" ? c + 1 + (op === "t" && i === 0 ? 1 : 0) : c - 1 - (op === "T" && i === 0 ? 1 : 0);
      let hit = -1;
      if (op === "f" || op === "t") { for (let j = from; j < line.length; j++) if (line[j] === ch) { hit = j; break; } }
      else { for (let j = from; j >= 0; j--) if (line[j] === ch) { hit = j; break; } }
      if (hit < 0) return;
      c = hit;
    }
    if (op === "t") c -= 1;
    if (op === "T") c += 1;
    this.setPos(this.row, c);
  }

  // ---- search -----------------------------------------------------------

  runSearch(dir, n) {
    if (!this.search?.query) return;
    const q = this.search.query;
    const fold = q === q.toLowerCase();
    const needle = fold ? q.toLowerCase() : q;
    const hay = (r) => (fold ? this.text[r].toLowerCase() : this.text[r]);
    const toCol = (r, idx) => Array.from(this.text[r].slice(0, idx)).length;
    const toIdx = (r, col) => this.lines[r].slice(0, col).join("").length;
    let r = this.row, c = this.col;
    for (let k = 0; k < n; k++) {
      let found = false;
      for (let i = 0; i <= this.n; i++) {
        const rr = (r + dir * i + this.n * 2) % this.n;
        const h = hay(rr);
        let idx;
        if (dir > 0) idx = h.indexOf(needle, i === 0 ? toIdx(rr, c) + 1 : 0);
        else idx = i === 0 ? (c > 0 ? h.lastIndexOf(needle, toIdx(rr, c) - 1) : -1) : h.lastIndexOf(needle);
        if (idx >= 0) {
          if (i > 0 && ((dir > 0 && rr <= r) || (dir < 0 && rr >= r))) this.message = dir > 0 ? "Search wrapped to top" : "Search wrapped to bottom";
          r = rr; c = toCol(rr, idx); found = true;
          break;
        }
      }
      if (!found) { this.message = `Not found: ${q}`; return; }
    }
    this.setPos(r, c);
  }

  // ---- selection --------------------------------------------------------

  bounds() {
    const a = this.anchor, b = { r: this.row, c: this.col };
    const [s, e] = a.r < b.r || (a.r === b.r && a.c <= b.c) ? [a, b] : [b, a];
    return { s, e, c0: Math.min(a.c, b.c), c1: Math.max(a.c, b.c) };
  }

  selected(r, c) {
    if (!this.mode) return false;
    const { s, e, c0, c1 } = this.bounds();
    if (r < s.r || r > e.r) return false;
    if (this.mode === "line") return true;
    if (this.mode === "block") return c >= c0 && c <= c1;
    return (r > s.r || c >= s.c) && (r < e.r || c <= e.c);
  }

  selectionText() {
    const { s, e, c0, c1 } = this.bounds();
    const out = [];
    for (let r = s.r; r <= e.r; r++) {
      const l = this.lines[r];
      if (this.mode === "line") out.push(this.text[r]);
      else if (this.mode === "block") out.push(l.slice(c0, c1 + 1).join("").trimEnd());
      else out.push(l.slice(r === s.r ? s.c : 0, r === e.r ? e.c + 1 : l.length).join(""));
    }
    return { text: out.join("\n") + (this.mode === "line" ? "\n" : ""), count: e.r - s.r + 1 };
  }

  setMode(mode) {
    if (this.mode === mode) { this.mode = null; return; }
    if (!this.mode) this.anchor = { r: this.row, c: this.col };
    this.mode = mode;
  }

  yank(cx, text, count) {
    cx.write_to_clipboard(text);
    this.mode = null;
    notify({ title: "Copied", body: `${count} line${count === 1 ? "" : "s"} from ${this.terminal}`, level: "success", timeout: 1500 });
    this.exit();
  }

  exit() {
    closeOverlay(props().overlay);
    if (this.terminal) run("pane.focus", { terminal: this.terminal });
  }

  // ---- keys -------------------------------------------------------------

  key(e, cx) {
    const m = e.modifiers;
    if (m.platform) {
      if (e.key === "c" && this.mode) { cx.stop_propagation(); const s = this.selectionText(); this.yank(cx, s.text, s.count); }
      return; // other Cmd shortcuts stay the app's
    }
    cx.stop_propagation();
    this.message = "";
    const ctrl = m.control && !m.alt;
    const plain = !m.control && !m.alt;
    const k = plain ? (e.key_char ?? (m.shift && e.key.length === 1 ? e.key.toUpperCase() : e.key)) : e.key;

    if (this.error || this.loading) {
      if (k === "escape" || k === "q" || (ctrl && k === "c")) this.exit();
      return;
    }

    if (this.prompt) return this.promptKey(e, k, ctrl, cx);

    if (this.pending) {
      const p = this.pending; this.pending = null;
      const n = this.takeCount();
      if (p === "g" && k === "g") this.setPos(n.given ? n.value - 1 : 0, 0);
      else if ("fFtT".includes(p) && k.length === 1) { this.lastFind = { op: p, ch: k }; this.find(p, k, n.value); }
      else if (p === "z") {
        if (k === "z" || k === ".") this.top = this.row - Math.floor(this.rows / 2);
        else if (k === "t" || k === "enter") this.top = this.row;
        else if (k === "b" || k === "-") this.top = this.row - this.rows + 1;
        this.top = Math.max(0, Math.min(this.top, this.n - this.rows));
        return cx.notify();
      }
      this.reveal();
      return cx.notify();
    }

    if (plain && (/^[1-9]$/.test(k) || (k === "0" && this.count))) { this.count += k; return cx.notify(); }
    const { value: n, given } = this.takeCount();
    const half = Math.max(1, Math.floor(this.rows / 2));

    if (ctrl) {
      switch (e.key) {
        case "c": return this.exit();
        case "[": if (this.mode) this.mode = null; else return this.exit(); break;
        case "d": this.top += half * n; this.setRow(this.row + half * n); break;
        case "u": this.top -= half * n; this.setRow(this.row - half * n); break;
        case "f": this.top += this.rows * n; this.setRow(this.row + this.rows * n); break;
        case "b": this.top -= this.rows * n; this.setRow(this.row - this.rows * n); break;
        case "e": this.scrollView(n); return cx.notify();
        case "y": this.scrollView(-n); return cx.notify();
        case "v": this.setMode("block"); break;
        default: return;
      }
      this.top = Math.max(0, Math.min(this.top, this.n - this.rows));
      this.reveal();
      return cx.notify();
    }
    if (!plain) return;

    const here = { r: this.row, c: this.col };
    switch (k) {
      case "escape": if (this.mode) this.mode = null; else return this.exit(); break;
      case "q": return this.exit();
      case "h": case "left": case "backspace": this.setPos(this.row, this.col - n); break;
      case "l": case "right": this.setPos(this.row, this.col + n); break;
      case "j": case "down": this.setRow(this.row + n); break;
      case "k": case "up": this.setRow(this.row - n); break;
      case "0": case "home": this.setPos(this.row, 0); break;
      case "^": this.setPos(this.row, Math.max(0, this.lines[this.row].findIndex((ch) => !isSpace(ch)))); break;
      case "$": case "end": this.setRow(this.row + n - 1); this.col = this.len(this.row) - 1; this.clampCol(); this.want = Infinity; break;
      case "w": case "W": { let p = here; for (let i = 0; i < n; i++) p = this.wordForward(p, k === "W"); this.setPos(p.r, p.c); break; }
      case "e": case "E": { let p = here; for (let i = 0; i < n; i++) p = this.wordEnd(p, k === "E"); this.setPos(p.r, p.c); break; }
      case "b": case "B": { let p = here; for (let i = 0; i < n; i++) p = this.wordBack(p, k === "B"); this.setPos(p.r, p.c); break; }
      case "}": for (let i = 0; i < n; i++) this.setPos(this.paragraph(1), 0); break;
      case "{": for (let i = 0; i < n; i++) this.setPos(this.paragraph(-1), 0); break;
      case "G": this.setPos(given ? n - 1 : this.n - 1, 0); break;
      case "H": this.setRow(this.top + (given ? n - 1 : 0)); break;
      case "M": this.setRow(this.top + Math.floor((Math.min(this.rows, this.n - this.top) - 1) / 2)); break;
      case "L": this.setRow(this.top + Math.min(this.rows, this.n - this.top) - 1 - (given ? n - 1 : 0)); break;
      case "pagedown": this.top += this.rows * n; this.setRow(this.row + this.rows * n); this.top = Math.max(0, Math.min(this.top, this.n - this.rows)); break;
      case "pageup": this.top -= this.rows * n; this.setRow(this.row - this.rows * n); this.top = Math.max(0, Math.min(this.top, this.n - this.rows)); break;
      case "g": case "z": case "f": case "F": case "t": case "T":
        this.pending = k; if (given) this.count = String(n); return cx.notify();
      case ";": if (this.lastFind) this.find(this.lastFind.op, this.lastFind.ch, n); break;
      case ",": if (this.lastFind) this.find({ f: "F", F: "f", t: "T", T: "t" }[this.lastFind.op], this.lastFind.ch, n); break;
      case "/": this.prompt = { dir: 1, text: "" }; return cx.notify();
      case "?": this.prompt = { dir: -1, text: "" }; return cx.notify();
      case "n": if (this.search) this.runSearch(this.search.dir, n); break;
      case "N": if (this.search) this.runSearch(-this.search.dir, n); break;
      case "*": case "#": {
        const word = this.wordUnderCursor();
        if (word) { this.search = { dir: k === "*" ? 1 : -1, query: word }; this.runSearch(this.search.dir, n); }
        break;
      }
      case "v": this.setMode("char"); break;
      case "V": this.setMode("line"); break;
      case " ": case "space": if (!this.mode) this.setMode("char"); else this.anchor = { r: this.row, c: this.col }; break;
      case "o": if (this.mode) { const a = this.anchor; this.anchor = here; this.setPos(a.r, a.c); } break;
      case "y": case "enter":
        if (this.mode) { const s = this.selectionText(); return this.yank(cx, s.text, s.count); }
        if (k === "enter") return this.exit();
        break;
      case "Y": {
        const last = Math.min(this.n - 1, this.row + n - 1);
        return this.yank(cx, this.text.slice(this.row, last + 1).join("\n") + "\n", last - this.row + 1);
      }
      case "r": this.load(cx, true); break;
      default: return;
    }
    this.reveal();
    cx.notify();
  }

  takeCount() {
    const given = this.count !== "";
    const value = given ? Math.max(1, parseInt(this.count, 10)) : 1;
    this.count = "";
    return { value, given };
  }

  wordUnderCursor() {
    const l = this.lines[this.row];
    if (cls(l[this.col]) !== 1) return "";
    let s = this.col, e = this.col;
    while (s > 0 && cls(l[s - 1]) === 1) s--;
    while (e < l.length - 1 && cls(l[e + 1]) === 1) e++;
    return l.slice(s, e + 1).join("");
  }

  promptKey(e, k, ctrl, cx) {
    const p = this.prompt;
    if (k === "escape" || (ctrl && (e.key === "c" || e.key === "["))) this.prompt = null;
    else if (k === "enter") {
      this.prompt = null;
      if (p.text) this.search = { dir: p.dir, query: p.text };
      if (this.search) { this.search.dir = p.dir; this.runSearch(p.dir, 1); this.reveal(); }
    } else if (k === "backspace") { if (!p.text) this.prompt = null; else p.text = Array.from(p.text).slice(0, -1).join(""); }
    else if (ctrl && e.key === "u") p.text = "";
    else if (!ctrl && !e.modifiers.alt && e.key_char && e.key_char.length >= 1 && e.key_char >= " ") p.text += e.key_char;
    cx.notify();
  }

  // ---- mouse ------------------------------------------------------------

  click(e, cx) {
    cx.stop_propagation(); // a window is dragged by presses its mod doesn't stop
    this.handle.focus();
    const pos = e.local_position;
    if (!pos || !this.n) return;
    const r = this.top + Math.floor(pos.y / this.zoom / this.rowH);
    if (r >= this.top + this.rows) return;
    this.setPos(r, this.left + Math.floor(Math.max(0, pos.x / this.zoom - PAD) / this.charW));
    this.reveal();
    cx.notify();
  }

  wheel(e, cx) {
    const lines = e.delta_lines ? -e.delta_lines.y : -e.delta.y / this.zoom / this.rowH;
    this.wheelRest = (this.wheelRest ?? 0) + lines;
    const whole = Math.trunc(this.wheelRest);
    if (!whole) return;
    this.wheelRest -= whole;
    this.scrollView(whole);
    cx.notify();
  }

  // ---- view -------------------------------------------------------------

  line(r, t) {
    const chars = this.lines[r];
    const cursorRow = r === this.row;
    let width = chars.length;
    if (cursorRow) width = Math.max(width, this.col + 1);
    if (this.mode && this.mode !== "block" && this.selected(r, 0) && width === 0) width = 1;
    const end = Math.min(width, this.left + this.cols + 1);
    const runs = [];
    for (let c = this.left; c < end; c++) {
      const style = cursorRow && c === this.col ? 2 : this.selected(r, c) ? 1 : 0;
      const ch = chars[c] ?? " ";
      const last = runs[runs.length - 1];
      if (last && last.style === style) last.text += ch;
      else runs.push({ style, text: ch });
    }
    return h_flex().id(`l${r}`).h(this.rowH).flex_none().pl(PAD).overflow_hidden().children(runs.map((run, i) =>
      div().id(`l${r}-${i}`).flex_none().whitespace_nowrap()
        .when(run.style === 1, (d) => d.bg(t.selection))
        .when(run.style === 2, (d) => d.bg(t.accent).text_color(t.accent_foreground))
        .child(run.text)));
  }

  render() {
    const t = theme();
    const mono = settings().font_family ?? "JetBrains Mono";
    const visible = [];
    for (let r = this.top; r < Math.min(this.n, this.top + this.rows); r++) visible.push(this.line(r, t));
    const label = this.mode === "line" ? "V-LINE" : this.mode === "block" ? "V-BLOCK" : this.mode ? "VISUAL" : "COPY";
    const left = this.prompt
      ? h_flex().child(div().text_color(t.accent).child(this.prompt.dir > 0 ? "/" : "?")).child(this.prompt.text).child(div().w(1).h(this.fontSize).bg(t.foreground).loop("opacity", { from: 0, to: 1, period: 1000 }))
      : h_flex().gap(10).items_center()
          .child(div().px(6).rounded(4).bg(this.mode ? t.accent : t.raised).text_color(this.mode ? t.accent_foreground : t.foreground).font_semibold().child(label))
          .child(div().text_color(t.muted).child(this.message || [this.count, this.pending ?? ""].join("") || this.terminal || ""));
    const hint = this.mode ? "y yank · o other end · Esc cancel" : "v select · / search · Y yank line · r refresh · q quit";

    return v_flex().id("root").size_full().bg(t.background).text_color(t.foreground)
      .font_family(mono).text_size(this.fontSize)
      .track_focus(this.handle).on_key_down((e, cx) => this.key(e, cx))
      .on_size_change((size, cx) => { this.size = size; this.reveal(); cx.notify(); })
      .child(v_flex().id("copy-body").flex_1().min_h(0).overflow_hidden().relative()
        .on_mouse_down("left", (e, cx) => this.click(e, cx))
        .on_scroll_wheel((e, cx) => this.wheel(e, cx))
        .when(this.loading, (d) => d.child(div().p(PAD).text_color(t.muted).child(`Reading ${this.terminal}…`)))
        .when(Boolean(this.error), (d) => d.child(div().p(PAD).text_color(t.ansi1).child(this.error)).child(div().px(PAD).text_color(t.dim).child("Esc to close")))
        .children(visible)
        .when(!this.loading && !this.error, (d) => d.child(div().absolute().top(2).right(PAD).px(6).rounded(4).bg(t.raised).text_color(t.accent).text_size(12)
          .child(`[${this.row + 1}/${this.n}]`))))
      .child(h_flex().h(FOOTER).flex_none().px(PAD).gap(12).items_center().justify_between().border_t(1).border_color(t.border).bg(t.chrome).text_size(12)
        .child(left)
        .child(div().text_color(t.dim).truncate().child(hint)));
  }
}
