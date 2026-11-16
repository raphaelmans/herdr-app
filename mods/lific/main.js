// Lific: the issues and pages of your projects, read and edited here instead of in the web UI.
//
//   Top:   every project (open issues counted); the one matching the space you came from is picked.
//   Left:  the project's issues (open ones first; f widens to all, then closed),
//          or with tab its pages (docs), pinned first, then the workspace's own.
//   Right: the selected issue (status, priority, labels, description, comments)
//          or the selected page's text. It scrolls.
//
//   1-9 h l ← →  project (click works too; remembered per space) · tab issues / pages
//   j k ↑ ↓      select · / search titles (esc clears) · f filter: open / all / closed
//   J K          scroll the text a little · space / shift-space a screen · g G top / end
//   z            read wide: hide the list (again: bring it back)
//   e            edit the description or the page's text (cmd-enter saves, esc cancels)
//   c            comment on the issue (cmd-enter posts) · R rename · u next priority
//   s then b t a d x   set an issue's status: backlog, todo, active, done, cancelled
//                (two keys on purpose: a stray letter typed at the window changes nothing)
//   n            new issue (todo) or page (draft): type a title, enter creates it
//   enter / i    hand the issue or page to the pane you came from (your send box, prefilled)
//   y            copy the identifier · o open it in the web UI · r refresh · q esc close
//   :            a Lific request: say what should be done, in your own words, in the
//                box along the bottom (cmd-enter runs it, esc leaves the box).
//                "new issue: the export button does nothing on Safari"
//                "mark RAISE-12 done and comment that it shipped in 2.4"
//                It works in the project shown unless the words name another.
//                The Lific agent (Config → Lific, shared "lific.agent": a shell
//                command that reads the request on stdin, acts through Lific's MCP
//                tools and prints what it did) carries it out; the list then
//                shows the issue it touched. Terms: GLOSSARY.md.
//                cmd-shift-i / ctrl-a I (mods/lific-request, an opener) open this
//                window straight into that box: shared "lific.ask" { n, at }
//                asks for it, and a window that is up answers with "lific.ack".
//
// Opened with ctrl-a L (tmux-prefix). It's a window: drag it by any empty spot,
// it reopens where you left it.
// Reads and writes through the lific CLI against the local database, so the
// lific server doesn't have to run. The binary is ~/.local/bin/lific, a link to
// the fork's build in ~/Documents/Coding/2026/lific (never upstream's release).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, Scrollbar, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { checking, closeOverlay, exec, focused, home, nextCommand, notify, panes, props, run, setShared, shared, spaces, theme } from "herdr";

// A wait: one spinner, turned natively, and what is being waited for.
const waiting = (t, label) => h_flex().gap(8).items_center().child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)).child(label);

const REFRESH_MS = 10000;
const WEB = "http://127.0.0.1:3456";
const STATUSES = ["backlog", "todo", "active", "done", "cancelled"];
const STATUS_KEY = { b: "backlog", t: "todo", a: "active", d: "done", x: "cancelled" };
const PRIORITIES = ["none", "low", "medium", "high", "urgent"];
const ORDER = { active: 0, todo: 1, backlog: 2, done: 3, cancelled: 4 };
const PRIORITY = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
const FILTERS = ["open", "all", "closed"];
const LIST_W = 380;
const LINE = 21;  // a line of body text, px (for scrolling by the keyboard)
const isOpen = (s) => s === "backlog" || s === "todo" || s === "active" || s === "draft";
const ASK = "lific.ask", ACK = "lific.ack", AGENT = "lific.agent";
const HEAD = { active: "Active", todo: "Todo", backlog: "Backlog", done: "Done", cancelled: "Cancelled" };
const tail = (s, n = 3) => String(s ?? "").trim().split("\n").map((l) => l.trim()).filter(Boolean).slice(-n).join("\n");
const flat = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// What the Lific agent reads: the rules of one request, then the request.
function word(text, project, projects, folder) {
  const known = projects.length ? ` The projects: ${projects.map((p) => `${p.identifier} (${p.name})`).join(", ")}.` : "";
  return [
    "You carry out one request against the Lific issue tracker through its MCP tools, then stop. Nobody can answer a question, so do not ask one.",
    "Do what the request says and nothing more. Never delete anything unless the request says to in plain words.",
    project
      ? `The person is looking at project ${project}: work in it unless the request names another.${known}`
      : `No project is shown. Use the one the request names.${known} If it names none, use the one that matches the folder the person is working in${folder ? ` ("${folder}")` : ""}. If that is still unclear, change nothing and say which project to name.`,
    "A new issue gets a short title and, when the request gives more, a description that keeps the person's own words.",
    "Reply with one or two plain lines, no markdown: what you did, with each identifier (like APP-12). If you changed nothing, say why.",
    "",
    "Request:",
    text,
  ].join("\n");
}
const slug = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// Markdown as blocks (split on blank lines, code fences kept whole), so the
// text can be scrolled to a block from the keyboard.
function blocks(text) {
  const out = [];
  let cur = [], fence = false;
  const flush = () => { if (cur.join("").trim()) out.push(cur.join("\n")); cur = []; };
  for (const line of (text ?? "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; cur.push(line); if (!fence) flush(); continue; }
    if (!fence && !line.trim()) { flush(); continue; }
    cur.push(line);
  }
  flush();
  return out;
}

// Escape is bound to an action of this mod's own: while a text field has the
// keyboard, Herdr closes the dialog on Escape before any key handler here sees it.
let escapeBound = false;

export default class Lific extends View {
  init(_props, cx) {
    if (!escapeBound) { cx.bind_keys([{ keystroke: "escape", action: "lific-escape", context: "Lific" }]); escapeBound = true; }
    this.bin = `${home()}/.local/bin/lific`;
    // Where you came from: its space picks the project, its pane gets "enter".
    const f = { ...(focused() ?? {}) };
    const pane = f.pane ? panes().find((p) => p.pane === f.pane) : null;
    const space = spaces().find((s) => s.id === f.space) ?? spaces().find((s) => s.active) ?? null;
    this.spaceId = space?.id ?? "none";
    this.hints = [space?.name, space?.folder?.split("/").pop(), (pane?.cwd ?? f.cwd)?.split("/").pop()].map(slug).filter(Boolean);
    this.home = pane?.terminal ? { pane: f.pane, target: pane.terminal, label: pane.title || pane.terminal } : null;

    this.projects = [];
    this.project = null;   // identifier
    this.issues = [];
    this.pages = [];
    this.counts = {};      // project identifier -> open issues
    this.selected = null;  // identifier
    this.detail = {};      // identifier -> { issue, comments }
    this.error = null;
    this.loaded = false;
    this.query = "";
    this.wide = false;     // z: the list is hidden
    this.top = 0;          // first text part in view (an estimate), for keyboard scrolling
    this.size = { width: 760, height: 560 };
    this.mode = "issues";  // or "pages"
    this.filter = "open";
    try {
      this.mode = localStorage.getItem("mode") === "pages" ? "pages" : "issues";
      this.filter = localStorage.getItem("filter") || "open";
    } catch {}

    // A Lific request: the box along the bottom, what is being carried out, and the last answer.
    this.cwd = space?.machine ? null : pane?.cwd ?? f.cwd ?? null; // lific runs here
    this.runs = [];        // { id, text, project }
    this.said = null;      // { ok, text }: how the last request ended
    this.count = 0;
    this.asking = false;   // the request box has the keyboard
    this.req = TextareaState.new({ placeholder: "Tell Lific what to do: new issue…, mark … done, comment on …", value: "", rows: 3 });
    try { this.req.set_value(localStorage.getItem("request") ?? ""); } catch {}
    this.req.on("change", (_e, cx) => { try { localStorage.setItem("request", this.req.value() ?? ""); } catch {} cx.notify(); });
    this.req.on("focus", (_e, cx) => { this.asking = true; this.leaving = false; cx.notify(); });
    this.req.on("blur", (_e, cx) => { this.asking = false; cx.notify(); });
    this.req.on("submit", (e, cx) => {
      if (e?.secondary) this.sendRequest(cx);
      else if (e?.shift) this.req.replace("\n");
    });
    // Opened by the request key: straight into that box.
    const ask = shared(ASK);
    this.asked = ask?.n ?? 0;
    const wanted = Boolean(ask) && Date.now() - (ask.at ?? 0) < 5000;

    this.handle = cx.focus_handle();
    if (wanted) this.req.focus(); else this.handle.focus();
    cx.timer.after(150, () => { if (wanted && !this.prompt && !this.editing) this.req.focus(); else if (!this.busy()) this.handle.focus(); });
    this.listScroll = ScrollHandle.new();
    this.bodyScroll = ScrollHandle.new();

    // One-line prompt: a new title, or a rename.
    this.prompt = null; // "new" | "rename"
    this.input = InputState.new({ placeholder: "Title" });
    this.input.on("submit", (_e, cx) => this.submitPrompt(cx));
    this.input.on("blur", (_e, cx) => { this.prompt = null; cx.notify(); });
    // `/` search.
    this.search = InputState.new({ placeholder: "Search titles" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); this.selected = null; this.resetScroll(); this.read(cx); cx.notify(); });
    this.search.on("submit", (_e, cx) => { this.handle.focus(); cx.notify(); });
    this.search.on("focus", (_e, cx) => { this.searching = true; cx.notify(); });
    this.search.on("blur", (_e, cx) => { this.searching = false; cx.notify(); });
    // Multi-line: the description, a page's text, or a comment. Cmd+Enter saves.
    this.editing = null; // "text" | "comment"
    this.area = TextareaState.new({ placeholder: "", value: "", rows: 12 });
    this.areaFocused = false;
    this.area.on("focus", (_e, cx) => { this.areaFocused = true; cx.notify(); });
    this.area.on("blur", (_e, cx) => { this.areaFocused = false; cx.notify(); });
    this.area.on("submit", (e, cx) => {
      if (e?.secondary) this.saveArea(cx);
      else if (e?.shift) this.area.replace("\n");
    });

    if (checking()) return; // a check draws the window; it runs no lific
    if (wanted) setShared(ACK, ask.n);
    this.start(cx);
    cx.timer.every(REFRESH_MS, (cx) => { if (this.project && !this.busy()) this.load(cx); });
    cx.spawn(async (cx) => {
      for (;;) { const c = await nextCommand(); if (c === "focus" && !this.busy()) { this.handle.focus(); cx.notify(); } }
    });
  }

  // Typing somewhere: keys belong to that field, and nothing reloads under it.
  busy() { return Boolean(this.prompt || this.editing || this.searching || this.asking); }

  // One lific call; JSON out, or a thrown message.
  async cli(args) {
    const r = await exec(this.bin, [...args, "--json"], { timeout: 10000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || `lific exited ${r.code}`).trim().split("\n").pop());
    const out = (r.stdout ?? "").trim();
    return out ? JSON.parse(out) : null;
  }

  fail(e, cx) {
    const m = String(e?.message ?? e);
    this.error = /no such file|not found|cannot start|os error 2/i.test(m)
      ? `Can't run ${this.bin}. Build the fork (cargo build --release --locked) and link target/release/lific there.`
      : m;
    this.loaded = true;
    cx.notify();
  }

  oops(title, e) { notify({ title, body: String(e?.message ?? e), level: "error", timeout: 4000 }); }

  start(cx) {
    cx.spawn(async (cx) => {
      try {
        const list = await this.cli(["project", "list"]);
        this.projects = Array.isArray(list) ? list : [];
        let saved = null;
        try { saved = localStorage.getItem(`project:${this.spaceId}`); } catch {}
        const has = (id) => this.projects.some((p) => p.identifier === id);
        // The space's name or folder against each project's name and identifier.
        const guess = this.projects.find((p) => {
          const names = [slug(p.name), slug(p.identifier)].filter((n) => n.length > 2);
          return this.hints.some((h) => names.some((n) => h === n || h.includes(n) || n.includes(h)));
        });
        this.project = (has(saved) && saved) || guess?.identifier || null;
        if (this.project) { this.load(cx); cx.notify(); }
        // Open issues per project, for the strip; and with no match, the first
        // project with open work (else the first one).
        await Promise.all(this.projects.map(async (p) => {
          const issues = await this.cli(["issue", "list", "--project", p.identifier, "--limit", "200"]).catch(() => null);
          if (Array.isArray(issues)) this.counts[p.identifier] = issues.filter((i) => isOpen(i.status)).length;
        }));
        if (!this.project) {
          this.project = this.projects.find((p) => this.counts[p.identifier] > 0)?.identifier ?? this.projects[0]?.identifier ?? null;
          if (this.project) this.load(cx);
        }
        this.loaded = this.loaded || !this.project;
        cx.notify();
      } catch (e) { this.fail(e, cx); }
    });
  }

  load(cx, force) {
    if (force) this.loading = false;
    if (this.loading || !this.project) return;
    this.loading = true;
    const project = this.project;
    cx.spawn(async (cx) => {
      try {
        const [list, pages, workspace] = await Promise.all([
          this.cli(["issue", "list", "--project", project, "--limit", "200"]),
          this.cli(["page", "list", "--project", project]).catch(() => []),
          this.cli(["page", "list"]).catch(() => []),
        ]);
        if (project !== this.project) return;
        this.issues = Array.isArray(list) ? list : [];
        this.counts[project] = this.issues.filter((i) => isOpen(i.status)).length;
        // A page arrives whole (its text included); the workspace's follow the project's.
        this.pages = [...(Array.isArray(pages) ? pages : []), ...(Array.isArray(workspace) ? workspace : []).map((p) => ({ ...p, workspace: true }))];
        // The issue a request touched: shown, whatever the filter was.
        const want = this.reveal;
        if (want && this.issues.some((i) => i.identifier === want)) {
          this.reveal = null; this.mode = "issues"; this.query = ""; this.selected = want;
          if (!this.list().some((i) => i.identifier === want)) this.filter = "all";
          const n = this.entries(this.list()).findIndex((e) => e.item?.identifier === want);
          if (n >= 0) this.listScroll.scroll_to_item(n);
          this.resetScroll();
        }
        this.error = null;
        this.loaded = true;
        cx.notify();
        this.read(cx);
      } catch (e) { this.fail(e, cx); } finally { this.loading = false; }
    });
  }

  // The selected issue in full, with its comments.
  read(cx) {
    const cur = this.current();
    if (!cur || this.mode === "pages") return;
    const id = cur.identifier;
    cx.spawn(async (cx) => {
      try {
        const [issue, comments] = await Promise.all([
          this.cli(["issue", "get", id]),
          this.cli(["comment", "list", id, "--order", "asc"]).catch(() => []),
        ]);
        this.detail[id] = { issue, comments: Array.isArray(comments) ? comments : [] };
        cx.notify();
      } catch {}
    });
  }

  list() {
    const q = this.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (i) => { const hay = `${i.identifier} ${i.title} ${(i.labels ?? []).join(" ")}`.toLowerCase(); return q.every((w) => hay.includes(w)); };
    const kept = this.filter === "all" ? () => true : this.filter === "closed" ? (i) => !isOpen(i.status) : (i) => isOpen(i.status);
    // A search looks everywhere, whatever the filter says.
    const keep = q.length ? hit : kept;
    if (this.mode === "pages") {
      return this.pages.filter(keep).sort((a, b) =>
        Number(Boolean(a.workspace)) - Number(Boolean(b.workspace)) || Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || String(b.updated_at).localeCompare(String(a.updated_at)));
    }
    return this.issues.filter(keep).sort((a, b) =>
      (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || (PRIORITY[a.priority] ?? 9) - (PRIORITY[b.priority] ?? 9) || b.sequence - a.sequence);
  }

  // The list as drawn: the issues under a heading per status. A search or the
  // pages are one plain run.
  entries(list) {
    if (this.mode === "pages" || this.query.trim()) return list.map((item) => ({ item }));
    const out = [];
    list.forEach((item, i) => {
      if (item.status !== list[i - 1]?.status) out.push({ head: item.status, count: list.filter((x) => x.status === item.status).length });
      out.push({ item });
    });
    return out;
  }

  current() {
    const l = this.list();
    return l.find((i) => i.identifier === this.selected) ?? l[0] ?? null;
  }

  // The selected thing as shown on the right: the full issue once read, the page as listed.
  shown() {
    const cur = this.current();
    if (!cur) return null;
    return this.mode === "pages" ? cur : this.detail[cur.identifier]?.issue ?? cur;
  }

  resetScroll() { this.top = 0; this.bodyScroll.scroll_to_item(0); }

  select(id, cx) {
    if (id === this.selected) return;
    this.selected = id;
    const n = this.entries(this.list()).findIndex((e) => e.item?.identifier === id);
    // The first issue of a group brings its heading along.
    if (n >= 0) this.listScroll.scroll_to_item(n === 1 ? 0 : n);
    this.resetScroll();
    this.read(cx);
    cx.notify();
  }

  move(delta, cx) {
    const l = this.list();
    if (!l.length) return;
    const n = Math.max(0, l.findIndex((i) => i.identifier === this.current()?.identifier));
    this.select(l[(n + delta + l.length) % l.length].identifier, cx);
  }

  // Scroll the text by about `px`. The handle can only reveal a part, so this
  // works from each part's estimated height: down reveals the part that far
  // below the fold, up reveals the one that far above the top.
  scrollBy(px, cx) {
    const h = this.heights ?? [];
    if (!h.length) return;
    const view = Math.max(120, this.size.height);
    let target;
    if (px > 0) {
      let i = this.top, used = 0;
      while (i < h.length - 1 && used + h[i] <= view) used += h[i++];   // i: the part at the fold
      let more = px;
      while (i < h.length - 1 && more > 0) more -= h[i++];
      target = i;
      let back = view - h[i];
      while (i > 0 && back - h[i - 1] >= 0) back -= h[--i];
      this.top = i;
    } else {
      let i = this.top, more = -px;
      while (i > 0 && more > 0) more -= h[--i];
      target = this.top = i;
    }
    this.bodyScroll.scroll_to_item(target);
    cx.notify();
  }

  scrollEnd(end, cx) {
    const n = (this.heights ?? []).length;
    if (!n) return;
    this.top = end ? n - 1 : 0;
    this.bodyScroll.scroll_to_item(this.top);
    cx.notify();
  }

  switchProject(delta, cx) {
    if (this.projects.length < 2) return;
    const n = Math.max(0, this.projects.findIndex((p) => p.identifier === this.project));
    this.pickProject(this.projects[(n + delta + this.projects.length) % this.projects.length].identifier, cx);
  }

  pickProject(id, cx) {
    if (!id || id === this.project) return;
    this.project = id;
    try { localStorage.setItem(`project:${this.spaceId}`, this.project); } catch {}
    this.issues = []; this.pages = []; this.selected = null; this.loaded = false;
    this.resetScroll();
    this.load(cx, true);
    cx.notify();
  }

  toggleMode(cx) {
    this.mode = this.mode === "pages" ? "issues" : "pages";
    try { localStorage.setItem("mode", this.mode); } catch {}
    this.selected = null;
    this.resetScroll();
    this.read(cx);
    cx.notify();
  }

  cycleFilter(cx) {
    this.filter = FILTERS[(FILTERS.indexOf(this.filter) + 1) % FILTERS.length];
    try { localStorage.setItem("filter", this.filter); } catch {}
    this.selected = null;
    this.resetScroll();
    this.read(cx);
    cx.notify();
  }

  clearSearch(cx) {
    this.query = ""; this.search.set_value(""); this.selected = null;
    this.handle.focus(); this.read(cx); cx.notify();
  }

  // Change the selected issue: shown at once, put back if lific refuses.
  update(field, value, flag, cx) {
    if (this.mode === "pages") return;
    const cur = this.current();
    if (!cur || cur[field] === value) return;
    const id = cur.identifier, was = cur[field];
    cur[field] = value;
    if (this.detail[id]?.issue) this.detail[id].issue[field] = value;
    this.selected = id;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await this.cli(["issue", "update", id, flag, value]);
        notify({ title: `${id}: ${field} ${value}`, level: "success", timeout: 1500 });
        this.load(cx, true);
      } catch (e) {
        cur[field] = was;
        if (this.detail[id]?.issue) this.detail[id].issue[field] = was;
        this.oops(`Couldn't update ${id}`, e);
        cx.notify();
      }
    });
  }

  setStatus(status, cx) { this.update("status", status, "--status", cx); }

  nextPriority(cx) {
    const cur = this.current();
    if (!cur || this.mode === "pages") return;
    this.update("priority", PRIORITIES[(PRIORITIES.indexOf(cur.priority) + 1) % PRIORITIES.length], "--priority", cx);
  }

  ask(kind, cx) {
    const cur = this.current();
    if (!this.project || (kind === "rename" && !cur)) return;
    this.prompt = kind;
    this.promptFor = cur?.identifier ?? null;
    this.input.set_value(kind === "rename" ? cur.title : "");
    this.input.focus();
    cx.notify();
  }

  endPrompt(cx) { this.prompt = null; this.handle.focus(); cx.notify(); }

  submitPrompt(cx) {
    const kind = this.prompt, id = this.promptFor, pages = this.mode === "pages";
    const title = (this.input.value() ?? "").trim();
    this.endPrompt(cx);
    if (!title || !kind) return;
    cx.spawn(async (cx) => {
      try {
        if (kind === "rename") {
          await this.cli([pages ? "page" : "issue", "update", id, "--title", title]);
          delete this.detail[id];
        } else {
          const made = pages
            ? await this.cli(["page", "create", "--project", this.project, "--title", title])
            : await this.cli(["issue", "create", "--project", this.project, "--title", title, "--status", "todo"]);
          if (made?.identifier) this.selected = made.identifier;
          if (this.filter === "closed") this.filter = "open";
        }
        this.load(cx, true);
      } catch (e) { this.oops(kind === "rename" ? `Couldn't rename ${id}` : `Couldn't create the ${pages ? "page" : "issue"}`, e); }
    });
  }

  // Open the text area on the description / page text, or empty for a comment.
  edit(kind, cx) {
    const full = this.shown();
    if (!full || (kind === "comment" && this.mode === "pages")) return;
    this.editing = kind;
    this.editFor = full.identifier;
    this.area.set_value(kind === "comment" ? "" : (this.mode === "pages" ? full.content : full.description) ?? "");
    this.area.focus();
    cx.notify();
  }

  endEdit(cx) { this.editing = null; this.handle.focus(); cx.notify(); }

  saveArea(cx) {
    const kind = this.editing, id = this.editFor, pages = this.mode === "pages";
    const text = this.area.value() ?? "";
    if (!kind) return;
    if (kind === "comment" && !text.trim()) return this.endEdit(cx);
    this.endEdit(cx);
    cx.spawn(async (cx) => {
      try {
        if (kind === "comment") await this.cli(["comment", "add", id, "--content", text]);
        else if (pages) await this.cli(["page", "update", id, "--content", text]);
        else await this.cli(["issue", "update", id, "--description", text]);
        delete this.detail[id];
        notify({ title: kind === "comment" ? `Commented on ${id}` : `Saved ${id}`, level: "success", timeout: 1500 });
        this.load(cx, true);
        if (kind === "comment") this.scrollEnd(true, cx);
      } catch (e) {
        // Keep what was typed: reopen the editor on it.
        this.editing = kind; this.editFor = id; this.area.set_value(text); this.area.focus();
        this.oops(`Couldn't save ${id}`, e);
        cx.notify();
      }
    });
  }

  // Put the issue or page in the send box, aimed at the pane the window was opened from.
  hand() {
    const cur = this.current();
    if (!cur) return;
    if (!this.home) return notify({ title: "No pane to send to", body: "Open Lific from a terminal pane.", level: "warning", timeout: 2500 });
    const id = cur.identifier;
    let text;
    if (this.mode === "pages") {
      text = `Lific page ${id}: ${cur.title}\n\n${(cur.content ?? "").trim() ? `${cur.content.trim()}\n\n` : ""}Read it again with \`lific page get ${id}\`; change it with \`lific page update ${id} --content ...\`.\n`;
    } else {
      const body = (this.shown()?.description ?? "").trim();
      text = `Work on Lific issue ${id}: ${cur.title}\n\n${body ? `${body}\n\n` : ""}Read it with \`lific issue get ${id}\`, and when it's finished run \`lific issue update ${id} --status done\`.\n`;
    }
    setShared("send-box.request", { ...this.home, text, at: Date.now() });
    run("mod.open", { name: "send-box" });
  }

  // Carry out what the request box says. The box empties at once so the next
  // can be typed; a request that fails goes back into it.
  sendRequest(cx) {
    const text = (this.req.value() ?? "").trim();
    if (!text) return;
    const command = shared(AGENT)?.command;
    if (!command) { this.said = { ok: false, text: "No Lific agent is chosen yet: pick one on Config → Lific." }; cx.notify(); return; }
    const job = { id: ++this.count, text, project: this.project };
    this.runs.push(job);
    this.said = null; this.leaving = false;
    this.req.set_value("");
    cx.notify();
    cx.spawn(async (cx) => {
      let said = "", failed = null;
      try {
        const r = await exec("sh", ["-c", `printf %s "$1" | ${command}`, "sh", word(text, job.project, this.projects, this.hints.at(-1))], { cwd: this.cwd ?? home(), timeout: 300_000 });
        said = tail(r.stdout);
        if (r.code !== 0 || !said) failed = tail(r.stderr || r.stdout, 2) || `exit ${r.code}, no answer`;
      } catch (e) { failed = String(e?.message ?? e); }
      this.runs = this.runs.filter((x) => x !== job);
      if (failed) {
        this.said = { ok: false, text: failed };
        if (!(this.req.value() ?? "").trim()) this.req.set_value(text);
        this.oops("The Lific request was not carried out", failed);
      } else {
        this.said = { ok: true, text: said };
        notify({ title: "Lific", body: said.length > 240 ? `${said.slice(0, 240)}…` : said, level: "success", timeout: 6000 });
        // Show what it touched: the first identifier it names that is a project's.
        const id = (said.match(/\b[A-Z][A-Z0-9]*-\d+\b/g) ?? []).find((x) => this.projects.some((p) => p.identifier === x.slice(0, x.lastIndexOf("-"))));
        if (id) {
          this.reveal = id;
          const project = id.slice(0, id.lastIndexOf("-"));
          if (project !== this.project) this.pickProject(project, cx);
        }
        this.detail = {};
        this.load(cx, true);
      }
      cx.notify();
    });
  }

  copy(cx) {
    const cur = this.current();
    if (!cur) return;
    cx.write_to_clipboard(cur.identifier);
    notify({ title: `Copied ${cur.identifier}`, level: "success", timeout: 1200 });
  }

  // The web UI is only there while `lific start` runs; say so rather than open a dead page.
  web(cx) {
    const cur = this.current();
    cx.spawn(async () => {
      const up = await exec("/usr/bin/nc", ["-z", "127.0.0.1", "3456"], { timeout: 3000 }).then((r) => r.code === 0).catch(() => false);
      if (!up) return notify({ title: "The lific server isn't running", body: "Start it in a terminal with: lific start", level: "warning", timeout: 4000 });
      const url = !cur || cur.workspace ? WEB : this.mode === "pages" ? `${WEB}/${this.project}/pages/${cur.id}` : `${WEB}/${this.project}/issues/${cur.identifier}`;
      await exec("/usr/bin/open", [url]);
    });
  }

  // Closing while a request is being carried out would lose its answer (the
  // agent still finishes): the first press says so, the next one closes.
  close(cx) {
    if (this.runs.length && !this.leaving) { this.leaving = true; cx?.notify(); return; }
    closeOverlay(props().overlay);
  }

  keys(e, cx) {
    const k = e.key, m = e.modifiers ?? {};
    if (this.editing) {
      // Escape steps back out of the text area and keeps the draft; a second one ends the edit.
      if (this.areaFocused) {
        if (k === "escape") { this.areaFocused = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
        return;
      }
      if (k === "escape") this.endEdit(cx);
      else if (e.keystroke === "cmd-enter") this.saveArea(cx);
      else if (k === "enter" || k === "tab" || e.key_char === "i") { this.area.focus(); cx.notify(); }
      cx.stop_propagation();
      return;
    }
    if (this.prompt) {
      if (k === "escape") { this.endPrompt(cx); cx.stop_propagation(); }
      return;
    }
    if (this.asking) {
      // Escape steps back out of the request box and keeps what was typed.
      if (k === "escape") { this.asking = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      return;
    }
    if (e.keystroke === "cmd-enter") { this.sendRequest(cx); cx.stop_propagation(); return; }
    if (this.searching) {
      // Arrows still pick while you type; esc steps back out of the field, a second one clears the search.
      if (k === "escape") { this.searching = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      else if (k === "down") { this.move(1, cx); cx.stop_propagation(); }
      else if (k === "up") { this.move(-1, cx); cx.stop_propagation(); }
      return;
    }
    if (m.platform || m.control || m.alt) return;
    const done = () => cx.stop_propagation();
    const page = Math.max(LINE * 4, this.size.height - LINE * 3);
    if (k === "/" || e.key_char === "/") { this.search.focus(); cx.notify(); return done(); }
    if (e.key_char === ":" && !shared("curtain")?.on) { this.req.focus(); cx.notify(); return done(); }
    if (k === "escape" && this.query) { this.clearSearch(cx); return done(); }
    if (k === "tab") { this.toggleMode(cx); return done(); }
    if (k === "space") { this.scrollBy(m.shift ? -page : page, cx); return done(); }
    if (k === "pagedown" || k === "pageup") { this.scrollBy(k === "pagedown" ? page : -page, cx); return done(); }
    if (/^[1-9]$/.test(k) && !m.shift) { this.pickProject(this.projects[Number(k) - 1]?.identifier, cx); return done(); }
    if (m.shift) {
      const upper = {
        j: () => this.scrollBy(LINE * 5, cx), k: () => this.scrollBy(-LINE * 5, cx),
        g: () => this.scrollEnd(true, cx), p: () => this.switchProject(-1, cx), r: () => this.ask("rename", cx),
      };
      if (upper[k]) { upper[k](); done(); }
      return;
    }
    // Status takes two keys: s, then the status's letter. Anything else cancels.
    if (this.picking) {
      this.picking = false;
      if (STATUS_KEY[k]) this.setStatus(STATUS_KEY[k], cx);
      cx.notify();
      return done();
    }
    if (k === "s" && this.mode === "issues" && this.current()) {
      this.picking = true;
      cx.timer.after(4000, (cx) => { if (this.picking) { this.picking = false; cx.notify(); } });
      cx.notify();
      return done();
    }
    const map = {
      j: () => this.move(1, cx), down: () => this.move(1, cx),
      k: () => this.move(-1, cx), up: () => this.move(-1, cx),
      p: () => this.switchProject(1, cx), l: () => this.switchProject(1, cx), right: () => this.switchProject(1, cx),
      h: () => this.switchProject(-1, cx), left: () => this.switchProject(-1, cx),
      f: () => this.cycleFilter(cx), g: () => this.scrollEnd(false, cx),
      z: () => { this.wide = !this.wide; cx.notify(); },
      e: () => this.edit("text", cx), c: () => this.edit("comment", cx), u: () => this.nextPriority(cx),
      enter: () => this.hand(), i: () => this.hand(),
      n: () => this.ask("new", cx), y: () => this.copy(cx), o: () => this.web(cx),
      r: () => this.load(cx, true),
      q: () => this.close(cx), escape: () => this.close(cx),
    };
    if (k !== "escape" && k !== "q") this.leaving = false;
    if (map[k]) { map[k](); done(); }
  }

  render(cx) {
    const t = theme();
    const pages = this.mode === "pages";
    const list = this.list();
    const cur = this.current();
    if (cur && cur.identifier !== this.selected) { this.selected = cur.identifier; this.read(cx); }
    const veiled = Boolean(shared("curtain")?.on); // the curtain is drawn: no agent, no request box
    // The request key, pressed while this window is up: answer it and take the keyboard to the box.
    const ask = shared(ASK);
    if (ask?.n && ask.n !== this.asked) {
      this.asked = ask.n;
      if (!veiled && Date.now() - (ask.at ?? 0) < 5000) cx.spawn(async (cx) => {
        setShared(ACK, ask.n);
        const take = (cx) => { if (!this.prompt && !this.editing) this.req.focus(); cx.notify(); };
        take(cx);
        cx.timer.after(250, take); // again once the opener has gone, which hands the keyboard back
      });
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const color = (s) => ({ active: t.working, todo: t.accent, backlog: t.dim, done: t.done, cancelled: t.muted, draft: t.dim, complete: t.done, archived: t.muted })[s] ?? t.dim;
    const dot = (s) => div().size(8).flex_none().rounded(4).bg(color(s));

    const chip = (id, text, hint, fn) => h_flex().id(id).h(22).px(8).gap(5).items_center().rounded(5).flex_none()
      .border_1().border_color(t.input).bg(t.raised).cursor_pointer().hover((s) => s.opacity(0.88))
      .on_mouse_down("left", stop).on_click((_e, cx) => fn(cx))
      .text_size(11).text_color(t.foreground)
      .child(text).child(div().text_size(10).opacity(0.6).child(hint));

    const button = (id, text, hint, primary, fn) => h_flex().id(id).h(26).px(10).gap(6).items_center().rounded(6).flex_none()
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12).font_medium()
      .cursor_pointer().hover((s) => s.opacity(0.88))
      .on_mouse_down("left", stop).on_click((_e, cx) => fn(cx))
      .child(text).child(div().text_size(10.5).opacity(0.7).child(hint));

    const field = (state, mark, active) => h_flex().mx(6).mt(6).h(28).px(8).gap(6).flex_none().items_center().rounded(6)
      .border_1().border_color(active ? t.accent : t.input).bg(t.background)
      .on_mouse_down("left", stop)
      .child(div().text_size(12).text_color(t.dim).child(mark))
      .child(div().flex_1().min_w(0).child(Input.new(state).w_full().text_size(12.5).text_color(t.foreground)));

    // Every project, always in view: click one or press its number.
    const strip = h_flex().id("lf-projects").h(40).px(8).gap(4).flex_none().items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .overflow_x_scroll()
      .children(this.projects.map((p, n) => {
        const on = p.identifier === this.project;
        const open = this.counts[p.identifier];
        return h_flex().id(`lf-p-${p.identifier}`).h(28).px(10).gap(7).items_center().rounded(6).flex_none()
          .border_1().border_color(on ? t.accent : t.popover.slice(0, 7) + "00")
          .cursor_pointer().when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((st) => st.bg(t.hover)))
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => { if (!this.busy()) this.handle.focus(); this.pickProject(p.identifier, cx); })
          .when(n < 9, (e) => e.child(div().text_size(10.5).text_color(t.dim).child(String(n + 1))))
          .child(div().text_size(12.5).font_medium().text_color(on ? t.foreground : t.muted).child(`${p.emoji ? `${p.emoji} ` : ""}${p.name}`))
          .when(open > 0, (e) => e.child(div().h(16).px(5).rounded(8).bg(on ? t.accent : t.raised)
            .text_size(10).text_color(on ? t.accent_foreground : t.muted).child(String(open))));
      }))
      .when(!this.projects.length, (e) => e.child(div().px(6).text_size(12.5).font_semibold().child("Lific")));

    const drawn = this.entries(list), grouped = drawn.some((e) => e.head);
    const row = (i) => {
      const on = i.identifier === cur?.identifier;
      const closed = !isOpen(i.status);
      return h_flex().id(`lf-${i.identifier}`).w_full().px(10).py(7).gap(9).items_center().rounded(6).flex_none()
        .cursor_pointer().when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((s) => s.bg(t.hover)))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { if (!this.busy()) this.handle.focus(); this.select(i.identifier, cx); })
        .child(dot(i.status))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().text_size(12.5).font_medium().text_color(closed ? t.muted : t.foreground).child(i.title))
          .child(div().truncate().text_size(11).text_color(t.muted)
            .child([i.identifier, grouped ? null : i.status, pages ? (i.workspace ? "workspace" : null) : (["low", "medium"].includes(i.priority) ? i.priority : null), i.pinned ? "pinned" : null, ...(i.labels ?? [])].filter(Boolean).join(" · "))))
        .when(!pages && (i.priority === "urgent" || i.priority === "high"), (e) => e.child(div().flex_none().h(16).px(5).flex().items_center().rounded(4)
          .bg(t.raised).text_size(10).font_medium().text_color(closed ? t.muted : i.priority === "urgent" ? t.blocked : t.ansi3).child(i.priority)));
    };
    const head = (h) => h_flex().w_full().flex_none().h(24).px(10).pt(6).gap(6).items_center().text_size(10.5)
      .child(div().font_semibold().text_color(color(h.head)).child((HEAD[h.head] ?? h.head).toUpperCase()))
      .child(div().text_color(t.dim).child(String(h.count)));

    const empty = this.error ? this.error
      : !this.loaded ? waiting(t, "Reading lific")
      : !this.projects.length ? "No lific projects yet. Create one with: lific project create"
      : this.query ? `Nothing matches "${this.query}".`
      : pages ? (this.pages.length ? "No pages here. Press f to change the filter." : "No pages yet. Press n to write one, tab for issues.")
      : this.filter === "open" ? "No open issues. Press n to add one, : to ask for one in words, f to see the rest."
      : "Nothing here. Press f to change the filter.";

    const left = v_flex().w(LIST_W).flex_none().h_full().border_r(1).border_color(t.border)
      .child(h_flex().px(12).h(38).flex_none().gap(8).items_center().justify_between().border_b(1).border_color(t.border)
        .child(div().truncate().text_size(13).font_semibold().text_color(t.foreground).child(pages ? "Pages" : "Issues"))
        .child(h_flex().gap(6).flex_none()
          .child(chip("lf-mode", pages ? "Issues" : "Pages", "tab", (cx) => this.toggleMode(cx)))
          .child(chip("lf-filter", this.query ? "search" : this.filter, `${list.length} · ${this.query ? "/" : "f"}`, (cx) => (this.query ? this.clearSearch(cx) : this.cycleFilter(cx))))))
      .when(Boolean(this.searching || this.query), (e) => e.child(field(this.search, "/", this.searching)))
      .when(this.prompt === "new", (e) => e.child(field(this.input, "+", true)))
      .child(div().relative().flex_1().min_h(0)
        .child(v_flex().id("lf-list").absolute().inset_0().p(6).gap(2).overflow_y_scroll().track_scroll(this.listScroll)
          .children(list.length ? drawn.map((e) => (e.head ? head(e) : row(e.item))) : [div().p(12).text_size(12).text_color(this.error ? t.blocked : t.muted).child(empty)])));

    const full = this.shown();
    const comments = cur && !pages ? (this.detail[cur.identifier]?.comments ?? []) : [];
    const text = full ? (pages ? full.content : full.description) ?? "" : "";
    const facts = !full ? [] : pages ? [
      full.status, full.workspace ? "workspace page" : null, full.pinned ? "pinned" : null, ...(full.labels ?? []),
      full.updated_at ? `updated ${String(full.updated_at).slice(0, 10)}` : null,
    ].filter(Boolean) : [
      full.priority !== "none" ? `${full.priority} priority` : null,
      ...(full.labels ?? []),
      full.blocked_by?.length ? `blocked by ${full.blocked_by.join(", ")}` : null,
      full.blocks?.length ? `blocks ${full.blocks.join(", ")}` : null,
      full.needs_human ? "needs a person" : null,
      full.updated_at ? `updated ${String(full.updated_at).slice(0, 10)}` : null,
    ].filter(Boolean);

    const statusBar = h_flex().gap(4).flex_none().flex_wrap().children(STATUSES.map((s) => {
      const on = full?.status === s;
      return h_flex().id(`lf-st-${s}`).h(22).px(8).gap(5).items_center().rounded(5)
        .border_1().border_color(on ? color(s) : this.picking ? t.accent : t.input).bg(on ? t.selected : t.raised)
        .cursor_pointer().hover((st) => st.opacity(0.88))
        .on_mouse_down("left", stop).on_click((_e, cx) => this.setStatus(s, cx))
        .text_size(11).text_color(on ? t.foreground : t.muted)
        .child(dot(s)).child(s)
        .child(div().text_size(10).opacity(this.picking ? 1 : 0.6).child(Object.keys(STATUS_KEY).find((key) => STATUS_KEY[key] === s)));
    })).child(div().text_size(10.5).text_color(this.picking ? t.accent : t.dim).child(this.picking ? "press a letter · esc cancels" : "s, then a letter"));

    // The text as parts, each a direct child of the scroller with an estimated
    // height (px), so the keyboard can scroll to one.
    const width = Math.max(240, this.size.width - 28);
    const lines = (s) => s.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil((l.length * 7.2) / width)), 0);
    const parts = [];
    const part = (el, px) => { parts.push({ el: el.flex_none(), px: px + 10 }); };
    if (full) {
      if (!pages) part(statusBar, 22);
      if (facts.length) part(div().text_size(11).text_color(t.muted).child(facts.join(" · ")), 16);
      const md = blocks(text);
      if (!md.length) part(div().text_size(12.5).text_color(t.dim).child(pages ? "This page is empty. Press e to write it." : "No description. Press e to write one."), LINE);
      md.forEach((b, n) => part(div().text_size(13).text_color(t.foreground)
        .child(TextView.markdown(`lf-md-${full.identifier}-${n}`, b).selectable(true)), lines(b) * LINE));
      comments.forEach((c) => {
        part(div().pt(8).border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
          .child(`${c.author_display_name || c.author} · ${String(c.created_at).slice(0, 16)}`), 26);
        blocks(c.content).forEach((b, n) => part(div().text_size(12.5).text_color(t.foreground)
          .child(TextView.markdown(`lf-cm-${c.id}-${n}`, b).selectable(true)), lines(b) * LINE));
      });
    }
    this.heights = parts.map((p) => p.px);
    if (this.top > parts.length - 1) this.top = Math.max(0, parts.length - 1);

    const editor = v_flex().size_full().p(10).gap(8).bg(t.background)
      .on_mouse_down("left", stop)
      .child(div().flex_none().text_size(11).text_color(t.muted)
        .child(this.editing === "comment" ? `Comment on ${this.editFor}` : `Editing ${this.editFor}${pages ? "" : ": description"} (markdown)`))
      .child(Textarea.new(this.area).flex_1().min_h(0).p(10).rounded(8).border_1().border_color(this.areaFocused ? t.accent : t.input).bg(t.popover)
        .text_size(13).text_color(t.foreground));

    const reader = div().size_full().relative().bg(t.background)
      .child(v_flex().id("lf-body").absolute().inset_0().px(14).py(10).gap(10).overflow_y_scroll().track_scroll(this.bodyScroll)
        .on_size_change((size, cx) => { this.size = size; cx.notify(); })
        .children(parts.map((p) => p.el)))
      .child(Scrollbar.vertical("lf-body").absolute().inset_0());

    const actions = this.editing
      ? [button("lf-save", this.editing === "comment" ? "Post" : "Save", "⌘↵", true, (cx) => this.saveArea(cx)),
         button("lf-cancel", "Cancel", this.areaFocused ? "esc esc" : "esc", false, (cx) => this.endEdit(cx))]
      : [button("lf-hand", "Send to pane", "↵", true, () => this.hand()),
         chip("lf-edit", "Edit", "e", (cx) => this.edit("text", cx)),
         ...(pages ? [] : [chip("lf-comment", "Comment", "c", (cx) => this.edit("comment", cx)),
                           chip("lf-prio", "Priority", "u", (cx) => this.nextPriority(cx))]),
         chip("lf-rename", "Rename", "R", (cx) => this.ask("rename", cx)),
         chip("lf-new", "New", "n", (cx) => this.ask("new", cx)),
         chip("lf-web", "Web", "o", (cx) => this.web(cx))];

    const right = v_flex().flex_1().min_w(0).h_full()
      .child(h_flex().px(12).h(38).flex_none().gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().text_size(11).text_color(t.dim).child(cur ? cur.identifier : ""))
        .child(this.prompt === "rename"
          ? div().flex_1().min_w(0).on_mouse_down("left", stop).child(Input.new(this.input).w_full().text_size(13).text_color(t.foreground))
          : div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(cur ? cur.title : "—"))
        .child(chip("lf-wide", this.wide ? "Show list" : "Read wide", "z", (cx) => { this.wide = !this.wide; cx.notify(); })))
      .child(div().flex_1().min_h(0).child(this.editing ? editor : reader))
      .child(h_flex().px(10).h(40).flex_none().gap(6).items_center().border_t(1).border_color(t.border)
        .children(actions)
        .child(div().flex_1())
        .when(!this.editing, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child("s status · J K space scroll · y copy")))
        .child(chip("lf-close", "Close", this.editing ? "" : "esc", (cx) => this.close(cx))));

    // The request box: one line until it is stepped into or holds more.
    const draft = this.req.value() ?? "", agent = shared(AGENT);
    const tall = this.asking || draft.includes("\n") || draft.length > 90;
    const where = this.project ? `works in ${this.project} unless you name another project` : "name the project in your words";
    const line = (mark, tint, text) => h_flex().flex_none().h(20).gap(8).items_center().text_size(11.5)
      .child(mark).child(div().flex_1().min_w(0).truncate().text_color(tint).child(text));
    const request = v_flex().flex_none().px(10).py(8).gap(6).border_t(1).border_color(t.border).bg(t.chrome)
      .on_mouse_down("left", stop)
      .children(this.runs.map((r) => line(waiting(t, div().flex_none().text_color(t.muted).child(r.project ? `Carrying out in ${r.project}` : "Carrying out")), t.dim, flat(r.text))))
      .when(this.leaving && this.runs.length > 0, (e) => e.child(line(div().flex_none().font_semibold().text_color(t.ansi3).child("!"), t.ansi3, "Still being carried out: closing now loses its answer. Press esc again to close anyway.")))
      .when(Boolean(this.said), (e) => e.child(line(div().flex_none().font_semibold().text_color(this.said.ok ? t.ansi2 : t.blocked).child(this.said.ok ? "✓" : "✕"), this.said.ok ? t.muted : t.blocked, flat(this.said?.text))))
      .child(h_flex().gap(8).items_end()
        .child(div().flex_none().h(34).flex().items_center().text_size(14).font_semibold().text_color(this.asking ? t.accent : t.dim).child(":"))
        .child(div().id("lf-req").flex_1().min_w(0).h(tall ? 92 : 34).flex().cursor_text()
          .child(Textarea.new(this.req).flex_1().min_h(0).px(10).py(7).rounded(8).border_1().border_color(this.asking ? t.accent : t.input).bg(t.background).text_size(13).text_color(t.foreground)))
        .child(button("lf-run", "Run", "⌘↵", draft.trim().length > 0, (cx) => this.sendRequest(cx))))
      .child(h_flex().gap(10).items_center().text_size(10.5).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(this.asking ? `⇧↵ new line · ⌘↵ run · esc leave the box · ${where}` : `: a Lific request, in your own words · ${where}`))
        .child(div().id("lf-agent").flex_none().cursor_pointer().hover((st) => st.text_color(t.foreground))
          .on_click(() => { setShared("config.page", "lific"); run("mod.open", { name: "config" }); })
          .child(agent?.label ? `Lific agent: ${agent.label}` : "No Lific agent chosen · Config → Lific")));

    return v_flex().id("lf-root").size_full().bg(t.popover).text_color(t.foreground)
      .track_focus(this.handle).key_context("Lific").on_action("lific-escape", (_e, cx) => this.keys({ key: "escape", keystroke: "escape", modifiers: {} }, cx)).on_key_down((e, cx) => this.keys(e, cx))
      .child(strip)
      .child(h_flex().flex_1().min_h(0).w_full().when(!this.wide, (e) => e.child(left)).child(right))
      .when(!veiled, (e) => e.child(request));
  }
}
