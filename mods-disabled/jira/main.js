// Jira: a project's board, its issues as cards in the board's columns, read here instead of in the browser.
//
//   Top:    every project (your open issues counted); the one matching the space you came from is picked.
//   Middle: the board. One column per board column, cards sorted by priority.
//           It opens on the active sprint and on your own issues: the account
//           the source is signed in as. The backlog is one list, in rank order.
//   Right:  the selected issue (status, people, labels, description, comments). It scrolls.
//
//   h l ← →      column · j k ↑ ↓ card · g G first / last card of the column
//   1-9 p P      project (click works too; remembered per space)
//   a            whose issues: mine / everyone (remembered)
//   s            which issues: a combobox of the sprints (active, coming, closed),
//                the backlog and all issues; remembered per project. In it: j k g G
//                move, enter picks, / filters by name, esc steps back, then closes it
//   / search key, title, label, person, across everyone (esc steps out, esc again clears)
//   J K          scroll the issue a little · space / shift-space a screen
//   z            board wide: hide the issue (again: bring it back)
//   enter / i    hand the issue to the pane you came from (your send box, prefilled)
//   b            branch, named <KEY>-<title words>: a menu to create it (git switch -c
//                in the repo of the pane you came from) or copy its name
//   y            copy the key · o open it in the browser · r read again · q esc close
//
// Opened with ctrl-a B (tmux-prefix). It's a window: drag it by any empty spot,
// it reopens where you left it.
//
// It only reads. Issues come from ./acli.js (READ access only). The last board
// is shown at once; acli runs again only when that read is old, or on r.
// The description and comments of the selected issue are read when it is shown.
// The mod is off by default (Config → Mods turns it on).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, VirtualListScrollHandle, v_virtual_list, Scrollbar, InputState, Input, TextView, Popup } from "gpui-base";
import { checking, closeOverlay, exec, focused, nextCommand, notify, panes, props, run, setShared, spaces, theme } from "herdr";
import * as acli from "./acli.js";

const SOURCES = { acli };
const SOURCE = "acli";
const DETAIL_W = 400;
const BACKLOG_ROW = 36; // a backlog issue and the space under it, px
const LINE = 21;  // a line of body text, px (for scrolling by the keyboard)
const PRIORITY = { highest: 0, high: 1, medium: 2, low: 3, lowest: 4 };
const PRIORITY_MARK = { highest: "↑↑", high: "↑", medium: "=", low: "↓", lowest: "↓↓" };
const slug = (s) => (s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
const initials = (name) => (name ?? "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();

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

// A wait: one spinner, turned natively, and what is being waited for.
const waiting = (t, label) => h_flex().flex_none().gap(8).items_center().text_size(12.5).text_color(t.muted)
  .child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)).child(label);

// Escape is bound to an action of this mod's own: while a text field has the
// keyboard, Herdr closes the window on Escape before any key handler here sees it.
let escapeBound = false;

export default class Jira extends View {
  init(_props, cx) {
    if (!escapeBound) { cx.bind_keys([{ keystroke: "escape", action: "jira-escape", context: "Jira" }]); escapeBound = true; }
    this.source = SOURCES[SOURCE];
    // Where you came from: its space picks the project, its pane gets "enter".
    const f = { ...(focused() ?? {}) };
    const pane = f.pane ? panes().find((p) => p.pane === f.pane) : null;
    const space = spaces().find((s) => s.id === f.space) ?? spaces().find((s) => s.active) ?? null;
    this.spaceId = space?.id ?? "none";
    this.hints = [space?.name, space?.folder?.split("/").pop(), (pane?.cwd ?? f.cwd)?.split("/").pop()].map(slug).filter(Boolean);
    this.home = pane?.terminal ? { pane: f.pane, target: pane.terminal, label: pane.title || pane.terminal } : null;
    this.cwd = pane?.cwd ?? f.cwd ?? null;   // where "create branch" runs git
    this.on = space?.machine ?? null;
    this.branchOpen = false;                 // the b menu
    this.branchAt = 0;

    this.me = null;        // { id, name }: the account the source is signed in as
    this.projects = [];
    this.project = null;   // key
    this.boards = {};      // project key -> { columns, sprints }
    this.issues = {};      // "project|scope" -> the issues read for it
    this.scopes = {};      // project key -> "sprint:<id>" | "backlog" | "all"
    this.counts = {};      // project key -> your open issues
    this.reading = null;   // the project being read for the first time in this scope
    this.selected = null;  // issue key
    this.error = null;
    this.loaded = false;
    this.query = "";
    this.top = 0;          // first part of the issue in view (an estimate), for keyboard scrolling
    this.size = { width: DETAIL_W - 28, height: 520 };
    this.who = "mine";     // or "all"
    this.detail = true;    // z: the issue is shown beside the board
    try {
      this.who = localStorage.getItem("who") === "all" ? "all" : "mine";
      this.detail = localStorage.getItem("detail") !== "0";
    } catch {}

    this.handle = cx.focus_handle();
    this.handle.focus();
    cx.timer.after(150, () => { if (!this.searching) this.handle.focus(); });
    // Column id -> its scroll handle. The backlog is one long list, so only
    // the rows in view are built: it scrolls by a virtual list's handle.
    this.colScroll = { backlog: VirtualListScrollHandle.new() };
    this.hay = new WeakMap(); // issue -> the text a search looks in
    this.bodyScroll = ScrollHandle.new();

    this.search = InputState.new({ placeholder: "Search key, title, label, person" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); this.selected = null; this.resetScroll(); cx.notify(); });
    this.search.on("submit", (_e, cx) => { this.handle.focus(); cx.notify(); });
    this.search.on("focus", (_e, cx) => { this.searching = true; cx.notify(); });
    this.search.on("blur", (_e, cx) => { this.searching = false; cx.notify(); });

    // The scope combobox: open, the highlighted option, and its filter field.
    this.scopeOpen = false;
    this.scopeAt = 0;
    this.scopeScroll = ScrollHandle.new();
    this.scopeFilter = InputState.new({ placeholder: "Filter sprints" });
    this.scopeFilter.on("change", (_e, cx) => { this.scopeAt = 0; this.scopeScroll.scroll_to_item(0); cx.notify(); });
    this.scopeFilter.on("submit", (_e, cx) => this.pickHighlighted(cx));
    this.scopeFilter.on("focus", (_e, cx) => { this.scopeTyping = true; cx.notify(); });
    this.scopeFilter.on("blur", (_e, cx) => { this.scopeTyping = false; cx.notify(); });

    if (!checking()) this.start(cx);
    cx.spawn(async (cx) => {
      for (;;) { const c = await nextCommand(); if (c === "focus" && !this.searching) { this.handle.focus(); cx.notify(); } }
    });
  }

  fail(e, cx) {
    this.error = String(e?.message ?? e);
    this.loaded = true;
    this.reading = null;
    cx.notify();
  }

  chooseProject() {
    if (this.project && this.projects.some((p) => p.key === this.project)) return;
    let saved = null;
    try { saved = localStorage.getItem(`project:${this.spaceId}`); } catch {}
    const has = (key) => this.projects.some((p) => p.key === key);
    // The space's name or folder against each project's name and key.
    const guess = this.projects.find((p) => {
      const names = [slug(p.name), slug(p.key)].filter((n) => n.length > 2);
      return this.hints.some((h) => names.some((n) => h === n || h.includes(n) || n.includes(h)));
    });
    // With no match: the first project where you have open work, else the first one.
    this.project = (has(saved) && saved) || guess?.key
      || this.projects.find((p) => this.counts[p.key] > 0)?.key || this.projects[0]?.key || null;
  }

  // Paint the last board before any acli call. Returns whether a list is on screen.
  showRemembered() {
    const remembered = this.source.remembered();
    if (remembered.me) this.me = remembered.me;
    if (remembered.projects.length) this.projects = remembered.projects;
    if (remembered.counts) this.counts = remembered.counts;
    if (!this.projects.length) return false;
    this.chooseProject();
    if (!this.project) return false;
    const sprints = remembered.boards[this.project]?.sprints ?? [];
    this.boards[this.project] = { columns: [], sprints };
    const scope = this.scope(this.project);
    const list = this.source.rememberedList(`${this.project}|${scope}`);
    if (!list) return false;
    const columns = this.source.columns(list);
    this.boards[this.project] = { columns, sprints };
    for (const col of [...columns, { id: "backlog" }]) this.colScroll[col.id] ??= ScrollHandle.new();
    this.issues[`${this.project}|${scope}`] = list;
    return true;
  }

  // The account, the projects, and the board. Open-issue counts follow, so they
  // don't hold the cards back.
  start(cx) {
    cx.spawn(async (cx) => {
      try {
        await this.source.restore();
        if (this.showRemembered()) { this.error = null; this.loaded = true; cx.notify(); }
        await this.pull(false, cx);
      } catch (e) { this.fail(e, cx); }
    });
  }

  async pull(force, cx) {
    const counts = this.count(force);
    const [me, projects] = await Promise.all([this.source.me(), this.source.projects()]);
    this.me = me;
    this.projects = Array.isArray(projects) ? projects : [];
    // The first choice of project may fall to "where you have open work":
    // that one waits for the counts. Every later read does not.
    if (!this.project && !Object.keys(this.counts).length) await counts;
    this.chooseProject();
    if (this.project) await this.read(this.project, force);
    this.error = null;
    this.loaded = true;
    this.reading = null;
    cx.notify();
    await counts;
    cx.notify();
  }

  async count(force) {
    const counts = await this.source.openMine({ force }).catch(() => null);
    if (counts) this.counts = counts;
  }

  // A project's sprints, then the issues of the scope it is on. Columns are the
  // statuses of those issues. Sprints are stored before the scope is chosen:
  // with none stored yet, the first scope would be the backlog.
  async read(project, force = false) {
    const b = await this.source.board(project, { force });
    this.boards[project] = { columns: this.boards[project]?.columns ?? [], sprints: b?.sprints ?? [] };
    const scope = this.scope(project);
    const want = this.issueQuery(scope);
    const list = await this.source.issues(project, want, { force });
    const columns = this.source.columns(list);
    this.boards[project] = { columns, sprints: b?.sprints ?? [] };
    // Made here, not while drawing: a scroll handle cannot be created during render.
    for (const col of [...columns, { id: "backlog" }]) this.colScroll[col.id] ??= ScrollHandle.new();
    this.issues[`${project}|${scope}`] = Array.isArray(list) ? list : [];
  }

  reload(cx, force = false) {
    if (!this.project) return this.start(cx);
    const project = this.project;
    const have = this.issues[`${project}|${this.scope(project)}`];
    if (!have) this.reading = project;
    cx.spawn(async (cx) => {
      try { await this.pull(force, cx); }
      catch (e) {
        if (have) notify({ title: "Jira didn't refresh", body: String(e?.message ?? e), level: "warning", timeout: 3000 });
        else this.fail(e, cx);
      }
      if (this.reading === project) this.reading = null;
      cx.notify();
    });
  }

  issueQuery(scope) {
    if (scope === "backlog") return { backlog: true };
    if (scope === "all") return {};
    return { sprint: scope.slice(7) };
  }

  // The scope a project is on: the one picked, the one remembered, else the first (the active sprint).
  scope(project) {
    const list = this.scopeOptions(project).map((o) => o.id);
    let saved = this.scopes[project];
    if (!saved) { try { saved = localStorage.getItem(`scope:${project}`); } catch {} }
    return list.includes(saved) ? saved : list[0];
  }

  scopeName(project) {
    const scope = this.scope(project);
    if (scope === "backlog") return { name: "Backlog", note: "" };
    if (scope === "all") return { name: "All issues", note: "" };
    const sprint = this.boards[project]?.sprints.find((s) => `sprint:${s.id}` === scope);
    return { name: sprint?.name ?? "Sprint", note: sprint?.state ?? "" };
  }

  // Every scope the combobox offers, in groups: the active sprint, the coming
  // ones, the backlog and all issues, then every closed sprint, newest first.
  scopeOptions(project) {
    const sprints = this.boards[project]?.sprints ?? [];
    const of = (state, group) => sprints.filter((s) => s.state === state).map((s) => ({ id: `sprint:${s.id}`, name: s.name, group }));
    return [
      ...of("active", "Active"),
      ...of("future", "Coming"),
      { id: "backlog", name: "Backlog", group: "Not in a sprint", note: "first 200" },
      { id: "all", name: "All issues", group: "Not in a sprint", note: "latest 150" },
      ...of("closed", "Closed").reverse(),
    ];
  }

  // The options as filtered by the field.
  scopeShown() {
    const q = (this.scopeFilter.value() ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
    return this.scopeOptions(this.project).filter((o) => q.every((w) => `${o.name} ${o.group}`.toLowerCase().includes(w)));
  }

  openScope(cx) {
    if (!this.boards[this.project]) return;
    this.scopeOpen = true;
    this.scopeFilter.set_value("");
    this.scopeAt = Math.max(0, this.scopeShown().findIndex((o) => o.id === this.scope(this.project)));
    this.scopeScroll.scroll_to_item(this.scopeAt);
    this.handle.focus();
    cx.notify();
  }

  closeScope(cx) {
    this.scopeOpen = false;
    this.scopeTyping = false;
    this.handle.focus();
    cx.notify();
  }

  moveScope(delta, cx) {
    const n = this.scopeShown().length;
    if (!n) return;
    this.scopeAt = Math.max(0, Math.min(n - 1, this.scopeAt + delta));
    this.scopeScroll.scroll_to_item(this.scopeAt);
    cx.notify();
  }

  pickHighlighted(cx) {
    const o = this.scopeShown()[this.scopeAt];
    if (o) this.pickScope(o.id, cx);
  }

  pickScope(id, cx) {
    this.closeScope(cx);
    if (id === this.scope(this.project)) return;
    this.scopes[this.project] = id;
    try { localStorage.setItem(`scope:${this.project}`, id); } catch {}
    this.selected = null;
    this.resetScroll();
    this.reload(cx);
    cx.notify();
  }

  // Keys while the combobox is open. Escape steps back: out of the filter field
  // (what was typed stays), then the combobox closes.
  scopeKeys(e, cx) {
    const k = e.key, char = e.key_char ?? k, m = e.modifiers ?? {};
    cx.stop_propagation();
    if (this.scopeTyping) {
      if (k === "escape") { this.scopeTyping = false; this.handle.focus(); cx.notify(); }
      else if (k === "down" || (m.control && k === "n")) this.moveScope(1, cx);
      else if (k === "up" || (m.control && k === "p")) this.moveScope(-1, cx);
      return;
    }
    if (m.platform || m.alt) return;
    if (k === "escape" || char === "q" || char === "s") this.closeScope(cx);
    else if (k === "down" || char === "j") this.moveScope(1, cx);
    else if (k === "up" || char === "k") this.moveScope(-1, cx);
    else if (char === "g") this.moveScope(-Infinity, cx);
    else if (char === "G") this.moveScope(Infinity, cx);
    else if (k === "enter" || char === "l" || k === "space") this.pickHighlighted(cx);
    else if (char === "/") { this.scopeFilter.focus(); cx.notify(); }
  }

  mine(issue) { return Boolean(this.me && issue.assignee?.id === this.me.id); }

  // The board as drawn: each column with its cards (the backlog: one list, as
  // the source ranks it). A search looks at everyone's, in the scope shown.
  columns() {
    const b = this.boards[this.project];
    const scope = b && this.scope(this.project);
    const all = b && this.issues[`${this.project}|${scope}`];
    if (!all) return [];
    // Asked several times per key press and per draw: worked out once for the
    // same list, search and filter. A detail arriving changes none of them.
    const m = this.drawn;
    if (m && m.all === all && m.columns === b.columns && m.query === this.query && m.who === this.who && m.me === this.me?.id) return m.out;
    const q = this.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const hay = (i) => {
      let text = this.hay.get(i);
      if (text === undefined) this.hay.set(i, text = `${i.key} ${i.title} ${i.status} ${i.assignee?.name ?? "unassigned"} ${(i.labels ?? []).join(" ")}`.toLowerCase());
      return text;
    };
    const keep = q.length ? (i) => { const text = hay(i); return q.every((w) => text.includes(w)); }
      : this.who === "mine" ? (i) => this.mine(i) : () => true;
    let out;
    if (scope === "backlog") out = [{ col: { id: "backlog", name: "Backlog" }, cards: all.filter(keep), list: true }];
    else {
      // One pass over the issues, then each column by priority. Equal
      // priorities stay in the order Jira gave, so cards do not move as
      // their details arrive.
      const by = new Map(b.columns.map((col) => [col.id, []]));
      for (const i of all) if (keep(i)) by.get(i.column)?.push(i);
      out = b.columns.map((col) => ({ col, cards: by.get(col.id).sort((x, y) => (PRIORITY[x.priority] ?? 9) - (PRIORITY[y.priority] ?? 9)) }));
    }
    this.drawn = { all, columns: b.columns, query: this.query, who: this.who, me: this.me?.id, out };
    return out;
  }

  // Where the selected card is: { c, r, issue }, or the first card there is.
  at(cols = this.columns()) {
    for (let c = 0; c < cols.length; c++) {
      const r = cols[c].cards.findIndex((i) => i.key === this.selected);
      if (r >= 0) return { c, r, issue: cols[c].cards[r] };
    }
    const c = cols.findIndex((x) => x.cards.length);
    return c < 0 ? null : { c, r: 0, issue: cols[c].cards[0] };
  }

  current() { return this.at()?.issue ?? null; }

  resetScroll() { this.top = 0; this.bodyScroll.scroll_to_item(0); }

  select(key, cx) {
    if (key === this.selected) return;
    this.selected = key;
    const cols = this.columns(), pos = this.at(cols);
    if (pos) this.colScroll[cols[pos.c].col.id]?.scroll_to_item(pos.r);
    this.resetScroll();
    this.loadDetail(key, cx);
    cx.notify();
  }

  // The issue in the list on screen. Another scope's list can hold a copy
  // with the same key: that one is not what is drawn.
  issueByKey(key) {
    const list = this.issues[`${this.project}|${this.scope(this.project)}`] ?? [];
    return list.find((i) => i.key === key) ?? null;
  }

  // The description, comments, points and sprint of the issue on screen, read
  // once the selection has rested on it: holding j down a column reads the
  // card it stops on, not every card it passes.
  loadDetail(key, cx) {
    const issue = this.issueByKey(key);
    if (!issue || issue.detail || this.readingDetail === key || this.detailDue === key || checking()) return;
    this.detailDue = key;
    cx.timer.after(200, (cx) => {
      if (this.detailDue !== key) return;
      this.detailDue = null;
      if (this.selected !== key || this.issueByKey(key)?.detail) return;
      this.readingDetail = key;
      cx.spawn(async (cx) => {
        try {
          const extra = await this.source.issue(key);
          const live = this.issueByKey(key);
          if (live && extra) Object.assign(live, extra);
        } catch (e) {
          // Kept apart from the description: Send hands that to an agent.
          const live = this.issueByKey(key);
          if (live && !live.detail) { live.detail = true; live.unread = String(e?.message ?? e); }
        }
        if (this.readingDetail === key) this.readingDetail = null;
        cx.notify();
      });
    });
  }

  // Up and down the column, around its ends.
  move(delta, cx) {
    const cols = this.columns(), pos = this.at(cols);
    if (!pos) return;
    const cards = cols[pos.c].cards;
    this.select(cards[(pos.r + delta + cards.length) % cards.length].key, cx);
  }

  // The first or last card of the column.
  edge(last, cx) {
    const cols = this.columns(), pos = this.at(cols);
    if (pos) this.select(cols[pos.c].cards.at(last ? -1 : 0).key, cx);
  }

  // To the next column that has cards, at the same height.
  across(delta, cx) {
    const cols = this.columns(), pos = this.at(cols);
    if (!pos) return;
    for (let c = pos.c + delta; c >= 0 && c < cols.length; c += delta) {
      const cards = cols[c].cards;
      if (cards.length) return this.select(cards[Math.min(pos.r, cards.length - 1)].key, cx);
    }
  }

  // Scroll the issue by about `px`. The handle can only reveal a part, so this
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

  switchProject(delta, cx) {
    if (this.projects.length < 2) return;
    const n = Math.max(0, this.projects.findIndex((p) => p.key === this.project));
    this.pickProject(this.projects[(n + delta + this.projects.length) % this.projects.length].key, cx);
  }

  pickProject(key, cx) {
    if (!key || key === this.project) return;
    this.project = key;
    try { localStorage.setItem(`project:${this.spaceId}`, key); } catch {}
    this.selected = null;
    this.resetScroll();
    this.reload(cx);
    cx.notify();
  }

  toggleWho(cx) {
    this.who = this.who === "mine" ? "all" : "mine";
    try { localStorage.setItem("who", this.who); } catch {}
    this.resetScroll();
    cx.notify();
  }

  toggleDetail(cx) {
    this.detail = !this.detail;
    try { localStorage.setItem("detail", this.detail ? "1" : "0"); } catch {}
    cx.notify();
  }

  clearSearch(cx) {
    this.query = ""; this.search.set_value(""); this.selected = null;
    this.handle.focus(); cx.notify();
  }

  // Put the issue in the send box, aimed at the pane the window was opened from.
  hand() {
    const cur = this.current();
    if (!cur) return;
    if (!cur.detail) return notify({ title: "Still reading that issue", body: "The description is on its way.", level: "info", timeout: 2000 });
    if (!this.home) return notify({ title: "No pane to send to", body: "Open Jira from a terminal pane.", level: "warning", timeout: 2500 });
    const body = (cur.description ?? "").trim();
    const text = `Work on Jira issue ${cur.key}: ${cur.title}\n\n${body ? `${body}\n\n` : ""}${cur.url ? `${cur.url}\n` : ""}`;
    setShared("send-box.request", { ...this.home, text, at: Date.now() });
    run("mod.open", { name: "send-box" });
  }

  // The branch for an issue: its key as Jira writes it (that is what links the
  // branch to the issue), then the first words of its title, lowercase kebab-case.
  branchName(issue) {
    const words = (issue.title ?? "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter(Boolean);
    let name = issue.key;
    for (const w of words) { if (`${name}-${w}`.length > 48) break; name += `-${w}`; }
    return name;
  }

  // The b menu: create the issue's branch, or copy its name.
  branchActions() {
    return [
      { id: "create", name: "Create branch", hint: "n", run: (cx) => this.createBranch(cx) },
      { id: "copy", name: "Copy branch name", hint: "c", run: (cx) => this.copyBranch(cx) },
    ];
  }

  openBranch(cx) {
    if (!this.current()) return;
    this.branchOpen = true;
    this.branchAt = 0;
    this.handle.focus();
    cx.notify();
  }

  closeBranch(cx) { this.branchOpen = false; this.handle.focus(); cx.notify(); }

  branchKeys(e, cx) {
    const k = e.key, char = e.key_char ?? k, m = e.modifiers ?? {};
    cx.stop_propagation();
    if (m.platform || m.control || m.alt) return;
    const acts = this.branchActions();
    if (k === "escape" || char === "q" || char === "b") this.closeBranch(cx);
    else if (k === "down" || char === "j") { this.branchAt = Math.min(acts.length - 1, this.branchAt + 1); cx.notify(); }
    else if (k === "up" || char === "k") { this.branchAt = Math.max(0, this.branchAt - 1); cx.notify(); }
    else if (char === "g") { this.branchAt = 0; cx.notify(); }
    else if (char === "G") { this.branchAt = acts.length - 1; cx.notify(); }
    else if (k === "enter" || k === "space" || char === "l") acts[this.branchAt].run(cx);
    else { const a = acts.find((x) => x.hint === char); if (a) a.run(cx); }
  }

  copyBranch(cx) {
    const cur = this.current();
    this.closeBranch(cx);
    if (!cur) return;
    const name = this.branchName(cur);
    cx.write_to_clipboard(name);
    notify({ title: "Copied the branch name", body: name, level: "success", timeout: 1500 });
  }

  // git switch -c in the repo of the pane the board was opened from, from where
  // that checkout is now. A branch that already exists is switched to instead.
  createBranch(cx) {
    const cur = this.current();
    this.closeBranch(cx);
    if (!cur) return;
    const name = this.branchName(cur);
    if (!this.cwd) return notify({ title: "No repo to make it in", body: "Open Jira from a terminal pane inside the repo.", level: "warning", timeout: 3000 });
    cx.spawn(async () => {
      const git = (args) => exec("git", args, { cwd: this.cwd, on: this.on, timeout: 15000 });
      try {
        const top = await git(["rev-parse", "--show-toplevel"]);
        if (top.code !== 0) return notify({ title: "Not in a git repo", body: `${this.cwd} is not inside one. Open Jira from a pane in the repo.`, level: "warning", timeout: 3500 });
        const repo = top.stdout.trim().split("/").pop();
        const exists = (await git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`])).code === 0;
        const r = await git(exists ? ["switch", name] : ["switch", "-c", name]);
        if (r.code !== 0) return notify({ title: `Couldn't ${exists ? "switch to" : "create"} ${name}`, body: (r.stderr || r.stdout).trim().split("\n").slice(-2).join("\n"), level: "error", timeout: 5000 });
        notify({ title: exists ? `Switched to ${name}` : `Created ${name}`, body: `${exists ? "It already existed" : "Checked out"} in ${repo}.`, level: "success", timeout: 2500 });
      } catch (e) {
        notify({ title: `Couldn't create ${name}`, body: String(e?.message ?? e), level: "error", timeout: 5000 });
      }
    });
  }

  copy(cx) {
    const cur = this.current();
    if (!cur) return;
    cx.write_to_clipboard(cur.key);
    notify({ title: `Copied ${cur.key}`, level: "success", timeout: 1200 });
  }

  web() {
    const cur = this.current();
    if (!cur) return;
    if (!cur.url) return notify({ title: `${cur.key} has no page to open`, body: `The ${this.source.name} source gives no links.`, level: "info", timeout: 2500 });
    exec("/usr/bin/open", [cur.url]);
  }

  close() { closeOverlay(props().overlay); }

  keys(e, cx) {
    if (this.scopeOpen) return this.scopeKeys(e, cx);
    if (this.branchOpen) return this.branchKeys(e, cx);
    const k = e.key, m = e.modifiers ?? {};
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
    if (k === "escape" && this.query) { this.clearSearch(cx); return done(); }
    if (k === "space") { this.scrollBy(m.shift ? -page : page, cx); return done(); }
    if (k === "pagedown" || k === "pageup") { this.scrollBy(k === "pagedown" ? page : -page, cx); return done(); }
    if (/^[1-9]$/.test(k) && !m.shift) { this.pickProject(this.projects[Number(k) - 1]?.key, cx); return done(); }
    if (m.shift) {
      const upper = {
        j: () => this.scrollBy(LINE * 5, cx), k: () => this.scrollBy(-LINE * 5, cx),
        g: () => this.edge(true, cx), p: () => this.switchProject(-1, cx),
      };
      if (upper[k]) { upper[k](); done(); }
      return;
    }
    const map = {
      j: () => this.move(1, cx), down: () => this.move(1, cx),
      k: () => this.move(-1, cx), up: () => this.move(-1, cx),
      l: () => this.across(1, cx), right: () => this.across(1, cx),
      h: () => this.across(-1, cx), left: () => this.across(-1, cx),
      g: () => this.edge(false, cx), p: () => this.switchProject(1, cx),
      a: () => this.toggleWho(cx), s: () => this.openScope(cx), z: () => this.toggleDetail(cx),
      enter: () => this.hand(), i: () => this.hand(), b: () => this.openBranch(cx),
      y: () => this.copy(cx), o: () => this.web(), r: () => this.reload(cx, true),
      q: () => this.close(), escape: () => this.close(),
    };
    if (map[k]) { map[k](); done(); }
  }

  render(cx) {
    const t = theme();
    const cols = this.columns();
    const scope = this.scopeName(this.project);
    const listed = Boolean(cols[0]?.list);
    const statuses = this.boards[this.project]?.columns ?? [];
    const pos = this.at(cols);
    const cur = pos?.issue ?? null;
    if (cur && cur.key !== this.selected) this.selected = cur.key;
    if (cur && !cur.detail) this.loadDetail(cur.key, cx);
    const shown = cols.reduce((n, c) => n + c.cards.length, 0);
    const read = this.issues[`${this.project}|${this.scope(this.project)}`];
    const capped = Boolean(read) && !listed && read.length >= this.source.SPRINT_CAP;
    const stop = (_e, cx) => cx.stop_propagation();
    const clear = t.popover.slice(0, 7) + "00";
    // A column's color by its place: the first is to do, the last is done.
    const tone = (n, of) => (n === 0 ? t.accent : n === of - 1 ? t.done : n === 1 ? t.working : t.blocked);
    const typeColor = (type) => ({ story: t.done, bug: t.blocked, task: t.accent, epic: t.ansi5 })[type] ?? t.dim;
    const prioColor = (p) => (p === "highest" || p === "high" ? t.blocked : p === "medium" ? t.muted : t.dim);

    const chip = (id, text, hint, fn) => h_flex().id(id).h(22).px(8).gap(5).items_center().rounded(5).flex_none()
      .border_1().border_color(t.input).bg(t.raised).cursor_pointer().hover((s) => s.opacity(0.88))
      .on_mouse_down("left", stop).on_click((_e, cx) => fn(cx))
      .text_size(11).text_color(t.foreground)
      .child(div().max_w(160).truncate().child(text)).child(div().flex_none().text_size(10).opacity(0.6).child(hint));

    const button = (id, text, hint, primary, fn) => h_flex().id(id).h(26).px(10).gap(6).items_center().rounded(6).flex_none()
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12).font_medium()
      .cursor_pointer().hover((s) => s.opacity(0.88))
      .on_mouse_down("left", stop).on_click((_e, cx) => fn(cx))
      .child(text).child(div().text_size(10.5).opacity(0.7).child(hint));

    const avatar = (person, size = 18) => h_flex().size(size).flex_none().rounded(size / 2).items_center().justify_center()
      .bg(!person ? clear : person.id === this.me?.id ? t.accent : t.raised)
      .when(!person, (e) => e.border_1().border_color(t.input))
      .text_size(size * 0.48).font_semibold()
      .text_color(!person ? t.dim : person.id === this.me?.id ? t.accent_foreground : t.muted)
      .child(person ? initials(person.name) : "–");

    // Every project, always in view: click one or press its number.
    const strip = h_flex().id("jr-projects").h(40).px(8).gap(4).flex_none().items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .overflow_x_scroll()
      .children(this.projects.map((p, n) => {
        const on = p.key === this.project;
        const open = this.counts[p.key] ?? 0;
        return h_flex().id(`jr-p-${p.key}`).h(28).px(10).gap(7).items_center().rounded(6).flex_none()
          .border_1().border_color(on ? t.accent : clear)
          .cursor_pointer().when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((st) => st.bg(t.hover)))
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => { if (!this.searching) this.handle.focus(); this.pickProject(p.key, cx); })
          .when(n < 9, (e) => e.child(div().text_size(10.5).text_color(t.dim).child(String(n + 1))))
          .child(div().text_size(12.5).font_medium().text_color(on ? t.foreground : t.muted).child(p.name))
          .child(div().text_size(10.5).text_color(t.dim).child(p.key))
          .when(open > 0, (e) => e.child(div().h(16).px(5).rounded(8).bg(on ? t.accent : t.raised)
            .text_size(10).text_color(on ? t.accent_foreground : t.muted).child(String(open))));
      }))
      .when(!this.projects.length, (e) => e.child(div().px(6).text_size(12.5).font_semibold().child("Jira")))
      .child(div().flex_1());

    // The scope combobox: a trigger that names the scope, and under it the options.
    const current = this.scope(this.project);
    const trigger = h_flex().id("jr-scope").h(24).pl(8).pr(6).gap(6).items_center().rounded(5).flex_none()
      .border_1().border_color(this.scopeOpen ? t.accent : t.input).bg(t.raised)
      .cursor_pointer().hover((s) => s.opacity(0.88))
      .on_mouse_down("left", stop)
      .on_click((_e, cx) => (this.scopeOpen ? this.closeScope(cx) : this.openScope(cx)))
      .text_size(11.5).text_color(t.foreground)
      .when(scope.note === "active", (e) => e.child(div().size(6).rounded(3).bg(t.working)))
      .child(scope.name)
      .when(Boolean(scope.note) && scope.note !== "active", (e) => e.child(div().text_size(10.5).text_color(t.dim).child(scope.note)))
      .child(div().text_size(10).text_color(t.dim).child(this.scopeOpen ? "▴" : "▾ s"));
    const options = this.scopeOpen ? this.scopeShown() : [];
    if (this.scopeAt > options.length - 1) this.scopeAt = Math.max(0, options.length - 1);
    const option = (o, n) => {
      const hi = n === this.scopeAt, on = o.id === current;
      return h_flex().id(`jr-so-${o.id}`).w_full().h(30).px(8).gap(8).items_center().rounded(5).flex_none()
        .cursor_pointer().when(hi, (e) => e.bg(t.selected)).when(!hi, (e) => e.hover((s) => s.bg(t.hover)))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => this.pickScope(o.id, cx))
        .child(div().w(12).flex_none().text_size(11).text_color(t.accent).child(on ? "✓" : ""))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(on ? t.foreground : t.muted).child(o.name))
        .when(Boolean(o.note), (e) => e.child(div().flex_none().text_size(10.5).text_color(t.dim).child(o.note)));
    };
    const rows = [];
    options.forEach((o, n) => {
      if (o.group !== options[n - 1]?.group) rows.push(div().h(22).px(8).pt(6).flex_none().text_size(10).font_semibold().text_color(t.dim).child(o.group.toUpperCase()));
      rows.push(option(o, n));
    });
    const panel = v_flex().w(280).mt(4).p(6).gap(2).rounded(8).border_1().border_color(t.input).bg(t.popover).shadow_lg()
      .on_mouse_down("left", stop)
      .child(h_flex().h(28).px(8).gap(6).flex_none().items_center().rounded(6)
        .border_1().border_color(this.scopeTyping ? t.accent : t.input).bg(t.background)
        .child(div().text_size(12).text_color(t.dim).child("/"))
        .child(div().flex_1().min_w(0).child(Input.new(this.scopeFilter).w_full().text_size(12.5).text_color(t.foreground))))
      .child(v_flex().id("jr-scope-list").max_h(320).gap(1).overflow_y_scroll().track_scroll(this.scopeScroll)
        .children(rows.length ? rows : [div().p(8).text_size(12).text_color(t.dim).child("No sprint matches.")]))
      .child(div().pt(4).px(4).text_size(10.5).text_color(t.dim).child(this.scopeTyping ? "↑ ↓ move · ↵ pick · esc back" : "j k move · ↵ pick · / filter · esc close"));
    const scopeBox = Popup.new("jr-scope-pop", trigger).anchor("top_right")
      .when(this.scopeOpen, (e) => e.content(panel));

    const bar = h_flex().h(38).px(12).gap(8).flex_none().items_center().overflow_hidden().border_b(1).border_color(t.border)
      .child(div().flex_none().text_size(13).font_semibold().text_color(t.foreground).child(listed ? "Backlog" : "Board"))
      .child(div().flex_none().text_size(11).text_color(t.dim).child(`${shown} ${shown === 1 ? "issue" : "issues"}${capped ? ` · first ${this.source.SPRINT_CAP} of the sprint` : ""}`))
      .child(this.searching || this.query
        ? h_flex().flex_1().min_w(0).h(26).px(8).gap(6).items_center().rounded(6)
            .border_1().border_color(this.searching ? t.accent : t.input).bg(t.background)
            .on_mouse_down("left", stop)
            .child(div().text_size(12).text_color(t.dim).child("/"))
            .child(div().flex_1().min_w(0).child(Input.new(this.search).w_full().text_size(12.5).text_color(t.foreground)))
        : div().flex_1())
      .child(this.query
        ? chip("jr-who", "Searching everyone", "esc", (cx) => this.clearSearch(cx))
        : chip("jr-who", this.who === "mine" ? "Mine" : "Everyone", "a", (cx) => this.toggleWho(cx)))
      .child(scopeBox)
      .child(chip("jr-detail", this.detail ? "Board wide" : "Show issue", "z", (cx) => this.toggleDetail(cx)));

    const card = (i) => {
      const on = i.key === cur?.key;
      return v_flex().id(`jr-${i.key}`).w_full().min_w(0).p(9).gap(7).rounded(7).flex_none().overflow_hidden()
        .border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : t.background)
        .cursor_pointer().when(!on, (e) => e.hover((s) => s.bg(t.hover)))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { if (!this.searching) this.handle.focus(); this.select(i.key, cx); })
        .child(div().w_full().min_w(0).text_size(12.5).text_color(t.foreground).child(i.title))
        .when(Boolean(i.labels?.length), (e) => e.child(h_flex().w_full().min_w(0).gap(4).flex_wrap()
          .children(i.labels.map((l) => div().h(16).px(5).max_w_full().truncate().rounded(4).bg(t.raised).text_size(10).text_color(t.muted).child(l)))))
        .child(h_flex().w_full().min_w(0).gap(6).items_center()
          .child(div().size(8).flex_none().rounded(2).bg(typeColor(i.type)))
          .child(div().flex_1().min_w(0).truncate().text_size(10.5).text_color(t.muted).child(i.key))
          .child(div().flex_none().text_size(11).font_semibold().text_color(prioColor(i.priority)).child(PRIORITY_MARK[i.priority] ?? ""))
          .when(i.points != null, (e) => e.child(div().flex_none().h(16).px(5).rounded(8).bg(t.raised).text_size(10).text_color(t.muted).child(String(i.points))))
          .child(avatar(i.assignee)));
    };

    // A backlog issue: one line, in rank order.
    const row = (i) => {
      const on = i.key === cur?.key;
      return h_flex().id(`jr-${i.key}`).w_full().h(34).px(10).gap(9).items_center().rounded(6).flex_none()
        .border_1().border_color(on ? t.accent : clear)
        .cursor_pointer().when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((s) => s.bg(t.hover)))
        .child(div().size(8).flex_none().rounded(2).bg(typeColor(i.type)))
        .child(div().w(62).flex_none().truncate().text_size(10.5).text_color(t.muted).child(i.key))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(i.title))
        .children((i.labels ?? []).slice(0, 2).map((l) => div().flex_none().max_w(110).truncate().h(16).px(5).rounded(4).bg(t.raised).text_size(10).text_color(t.muted).child(l)))
        .child(div().w(18).flex_none().text_size(11).font_semibold().text_color(prioColor(i.priority)).child(PRIORITY_MARK[i.priority] ?? ""))
        .child(div().w(22).flex_none().text_size(10.5).text_color(t.muted).child(i.points != null ? String(i.points) : ""))
        .child(avatar(i.assignee));
    };

    const column = ({ col, cards, list }, n) => {
      const here = pos?.c === n;
      return v_flex().flex_1().min_w(0).h_full().rounded(8).bg(t.surface).overflow_hidden()
        .border_1().border_color(here ? t.input : t.border)
        .child(h_flex().h(34).px(10).gap(7).flex_none().items_center()
          .child(div().size(7).flex_none().rounded(4).bg(list ? t.dim : tone(n, cols.length)))
          .child(div().flex_1().min_w(0).truncate().text_size(11).font_semibold().text_color(here ? t.foreground : t.muted).child(col.name.toUpperCase()))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(String(cards.length))))
        .child(list
          // Only the rows in view are built. A row inside a virtual list
          // cannot hold a handler of its own: the list reports which was clicked.
          ? div().relative().flex_1().min_h(0).on_mouse_down("left", stop)
              .child(div().absolute().inset_0().px(6).child(v_virtual_list("jr-col-backlog", cards.length, BACKLOG_ROW, (n) => cards[n].key,
                (range) => cards.slice(range.start, range.end).map((i) => div().w_full().h(BACKLOG_ROW).child(row(i))))
                .on_item_click((key, cx) => { if (!this.searching) this.handle.focus(); this.select(key, cx); })
                .track_scroll(this.colScroll.backlog).size_full()))
              .child(Scrollbar.vertical("jr-col-backlog").viewport_from_layout().absolute().inset_0())
          : div().relative().flex_1().min_h(0)
              .child(v_flex().id(`jr-col-${col.id}`).absolute().inset_0().px(6).pb(6).overflow_x_hidden().gap(6).overflow_y_scroll().track_scroll(this.colScroll[col.id])
                .children(cards.map(card))));
    };

    const empty = this.error ? this.error
      : !this.loaded || this.reading ? waiting(t, this.projects.length ? "Reading issues" : "Reading projects")
      : !this.projects.length ? "No Jira projects."
      : this.query ? `Nothing matches "${this.query}".`
      : this.who === "mine" ? `Nothing in ${scope.name} is assigned to you. Press a to see everyone's, s to pick another sprint or the backlog.`
      : `${scope.name} has no issues. Press s to pick another sprint or the backlog.`;

    const board = v_flex().flex_1().min_w(0).h_full()
      .child(bar)
      .child(shown
        ? h_flex().flex_1().min_h(0).min_w(0).w_full().p(8).gap(8).overflow_hidden().children(cols.map(column))
        : div().p(20).text_size(12.5).text_color(this.error ? t.blocked : t.muted).child(empty));

    // The issue as parts, each a direct child of the scroller with an estimated
    // height (px), so the keyboard can scroll to one.
    const width = Math.max(240, this.size.width - 28);
    const lines = (s) => s.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil((l.length * 7.2) / width)), 0);
    const parts = [];
    const part = (el, px) => { parts.push({ el: el.flex_none().w_full().min_w(0).overflow_hidden(), px: px + 10 }); };
    if (cur) {
      part(div().text_size(15).font_semibold().text_color(t.foreground).child(cur.title), lines(cur.title) * 21);
      const fact = (label, value) => h_flex().w_full().min_w(0).gap(8).items_center().h(22)
        .child(div().w(72).flex_none().text_size(11).text_color(t.dim).child(label))
        .child(div().flex_1().min_w(0).overflow_hidden().child(value));
      const text = (s) => div().min_w(0).truncate().text_size(12).text_color(t.foreground).child(s);
      const person = (p) => h_flex().min_w(0).gap(6).items_center().child(avatar(p, 16)).child(text(p ? `${p.name}${p.id === this.me?.id ? " (you)" : ""}` : "Unassigned"));
      const facts = [
        fact("Status", h_flex().gap(6).items_center().child(div().size(7).rounded(4).bg(tone(Math.max(0, statuses.findIndex((c) => c.id === cur.column)), statuses.length))).child(text(cur.status))),
        fact("Assignee", person(cur.assignee)),
        cur.reporter ? fact("Reporter", person(cur.reporter)) : null,
        fact("Type", h_flex().gap(6).items_center().child(div().size(8).rounded(2).bg(typeColor(cur.type))).child(text(cur.type))),
        fact("Priority", h_flex().gap(6).items_center().child(div().text_size(11).font_semibold().text_color(prioColor(cur.priority)).child(PRIORITY_MARK[cur.priority] ?? "")).child(text(cur.priority))),
        cur.points != null ? fact("Points", text(String(cur.points))) : null,
        fact("Sprint", text(cur.sprint ?? (cur.sprintKnown ? "Backlog" : "…"))),
        cur.labels?.length ? fact("Labels", text(cur.labels.join(", "))) : null,
        cur.updated ? fact("Updated", text(String(cur.updated).slice(0, 10))) : null,
      ].filter(Boolean);
      part(v_flex().pb(4).children(facts), facts.length * 22 + 4);
      const md = cur.detail ? blocks(cur.description) : [];
      if (!cur.detail) part(waiting(t, "Reading the issue"), LINE);
      else if (cur.unread) part(div().text_size(12.5).text_color(t.blocked).child(`Could not read this issue. ${cur.unread}`), LINE * 2);
      else if (!md.length) part(div().text_size(12.5).text_color(t.dim).child("No description."), LINE);
      md.forEach((b, n) => part(div().text_size(13).text_color(t.foreground)
        .child(TextView.markdown(`jr-md-${cur.key}-${n}`, b).selectable(true)), lines(b) * LINE));
      (cur.comments ?? []).forEach((c, n) => {
        part(div().pt(8).border_t(1).border_color(t.border).text_size(10.5).text_color(t.dim)
          .child(`${c.author} · ${String(c.at).slice(0, 16).replace("T", " ")}`), 26);
        blocks(c.text).forEach((b, k) => part(div().text_size(12.5).text_color(t.foreground)
          .child(TextView.markdown(`jr-cm-${cur.key}-${n}-${k}`, b).selectable(true)), lines(b) * LINE));
      });
    }
    this.heights = parts.map((p) => p.px);
    if (this.top > parts.length - 1) this.top = Math.max(0, parts.length - 1);

    // The b menu, opening upward from the Branch button.
    const branchButton = button("jr-branch", "Branch", "b", false, (cx) => (this.branchOpen ? this.closeBranch(cx) : this.openBranch(cx)));
    const branchMenu = !this.branchOpen || !cur ? null : v_flex().w(300).mb(4).p(6).gap(2).rounded(8).border_1().border_color(t.input).bg(t.popover).shadow_lg()
      .on_mouse_down("left", stop)
      .child(v_flex().px(8).pt(2).pb(6).gap(2)
        .child(div().text_size(10).font_semibold().text_color(t.dim).child("BRANCH"))
        .child(div().truncate().text_size(12).text_color(t.foreground).child(this.branchName(cur)))
        .child(div().truncate().text_size(10.5).text_color(t.dim).child(this.cwd ? `in ${this.cwd.replace(/^\/Users\/[^/]+/, "~")}` : "no pane to make it in")))
      .children(this.branchActions().map((a, n) => {
        const hi = n === this.branchAt;
        return h_flex().id(`jr-ba-${a.id}`).h(30).px(8).gap(8).items_center().rounded(5).flex_none()
          .cursor_pointer().when(hi, (e) => e.bg(t.selected)).when(!hi, (e) => e.hover((s) => s.bg(t.hover)))
          .on_mouse_down("left", stop).on_click((_e, cx) => a.run(cx))
          .child(div().flex_1().text_size(12.5).text_color(t.foreground).child(a.name))
          .child(div().text_size(10.5).text_color(t.dim).child(a.hint));
      }))
      .child(div().pt(4).px(4).text_size(10.5).text_color(t.dim).child("j k move · ↵ pick · esc close"));
    const branchBox = Popup.new("jr-branch-pop", branchButton).anchor("bottom_left")
      .when(Boolean(branchMenu), (e) => e.content(branchMenu));

    const detail = v_flex().w(DETAIL_W).flex_none().h_full().overflow_hidden().border_l(1).border_color(t.border)
      .child(h_flex().px(12).h(38).flex_none().gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(cur ? cur.key : "—")))
      .child(div().flex_1().min_h(0).relative().bg(t.background)
        .child(v_flex().id("jr-body").absolute().inset_0().px(14).py(12).overflow_x_hidden().gap(10).overflow_y_scroll().track_scroll(this.bodyScroll)
          .on_size_change((size, cx) => { this.size = size; cx.notify(); })
          .children(parts.map((p) => p.el)))
        .child(Scrollbar.vertical("jr-body").absolute().inset_0()))
      .child(h_flex().px(10).h(44).flex_none().gap(6).items_center().overflow_hidden().border_t(1).border_color(t.border)
        .child(button("jr-hand", "Send", "↵", true, () => this.hand()))
        .child(branchBox)
        .child(button("jr-copy", "Copy key", "y", false, (cx) => this.copy(cx)))
        .child(button("jr-web", "Open", "o", false, () => this.web()))
        .child(div().flex_1())
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child("esc close")));

    return v_flex().id("jr-root").size_full().overflow_hidden()
      .on_mouse_down("left", (_e, cx) => { if (this.scopeOpen) this.closeScope(cx); if (this.branchOpen) this.closeBranch(cx); }).bg(t.popover).text_color(t.foreground)
      .track_focus(this.handle).key_context("Jira").on_action("jira-escape", (_e, cx) => this.keys({ key: "escape", keystroke: "escape", modifiers: {} }, cx)).on_key_down((e, cx) => this.keys(e, cx))
      .child(strip)
      .child(h_flex().flex_1().min_h(0).w_full().overflow_hidden().child(board).when(this.detail, (e) => e.child(detail)));
  }
}
