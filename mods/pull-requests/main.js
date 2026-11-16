// Pull requests for a repository in a selected organization, on this computer.
//
// Its own spec needs gh. The Git dialog and lazygit do not. gh is this
// computer's copy (mise's shim when it is there, else the one on PATH), signed
// in as this computer's GitHub account. Another machine's checkout is never asked.
//
//   Top:     the account, then its organizations. 1-9, [ and ], or a click.
//   Left:    that organization's repositories, most recently pushed first.
//   Middle:  the selected repository's pull requests, most recently updated first.
//   Right:   the selected pull request.
//
//   j k ↑ ↓     move in the list that has the keys (repositories, or pull requests once stepped in)
//   l →         step into the pull requests
//   h ←         step back to the repositories
//   [ ]         previous and next organization
//   1-9         an organization
//   g G         first and last of that list
//   /           search that list (esc leaves the field and keeps what was typed)
//   f           open, all, then closed
//   enter       hand the pull request to the pane you came from, once stepped in
//   y o r       copy its link, open it, read everything on screen again
//   J K space   scroll the pull request
//   q           close
//   esc         step back, and close once nothing is left to leave
//
// Opened with ctrl-a P. The last organization and repository are remembered here.
//
// What was read last is shown at once, then checked: each list on screen is
// read again once it is older than its age below, all of them side by side.
// A list arrives with its descriptions, so moving through pull requests asks
// gh nothing. What is remembered belongs to the account gh is signed in as:
// another account starts empty.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, Scrollbar, InputState, Input, TextView } from "gpui-base";
import { checking, closeOverlay, exec, focused, home, notify, panes, props, run, setShared, theme } from "herdr";
import {
  GH, FILTERS, PULL_REQUEST_CAP, REPOSITORY_CAP,
  accountArgs, organizationsArgs, repositoriesArgs, pullRequestsArgs,
  parse, explain, mark, matches, blocks, readMemory, trimMemory, forAccount, emptyMemory,
} from "./github.js";

const LINE = 21;
const AGE = { account: 60_000, organizations: 10 * 60_000, repositories: 5 * 60_000, pullRequests: 60_000 };
const PLACES = { repositories: "repositories", pullRequests: "pullRequests" };

// Kept for as long as this version of the mod is loaded, so opening the
// window again does not parse what localStorage holds a second time.
let MEMORY = null;

const day = (iso) => (iso ? String(iso).slice(0, 10) : "");
const waiting = (t, label) => h_flex().flex_none().gap(8).items_center().text_size(12).text_color(t.muted)
  .child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)).child(label);

function tone(pullRequest, t) {
  const m = mark(pullRequest);
  if (m === "approved" || m === "merged") return t.done;
  if (m === "changes") return t.blocked;
  if (m === "review") return t.working;
  if (m === "draft" || m === "closed") return t.muted;
  return t.accent;
}

function quietBorder(t) {
  const color = t.popover;
  if (typeof color === "string" && color.length >= 7) return color.slice(0, 7) + "00";
  return t.border;
}

function wrapped(list, index, delta) {
  if (!list.length) return null;
  return list[((index < 0 ? 0 : index) + delta + list.length) % list.length];
}

// Escape is bound to an action of this mod's own: while a text field has the
// keyboard, Herdr closes a dialog on Escape before any key handler here sees it.
let escapeBound = false;

export default class PullRequests extends View {
  init(_props, cx) {
    if (!escapeBound) { cx.bind_keys([{ keystroke: "escape", action: "pull-requests-escape", context: "PullRequests" }]); escapeBound = true; }
    const f = focused() ?? {};
    const pane = f.pane ? panes().find((p) => p.pane === f.pane) : null;
    this.homePane = pane?.terminal ? { pane: f.pane, target: pane.terminal, label: pane.title || pane.terminal } : null;

    if (!MEMORY) { try { MEMORY = readMemory(localStorage.getItem("memory")); } catch { MEMORY = emptyMemory(); } }
    this.organization = null;
    this.repository = null;
    this.selected = null;            // a pull request's number
    this.organizations = [];
    this.repositories = [];
    this.pullRequests = [];
    this.place = PLACES.repositories; // the list that has the keys
    this.filter = "open";
    this.searches = { repositories: "", pullRequests: "" };
    this.waits = new Map();          // what is being read -> its label
    this.errors = {};                // what could not be read -> why
    this.top = 0;
    this.size = { width: 420, height: 560 };
    try {
      const saved = localStorage.getItem("filter");
      if (FILTERS.includes(saved)) this.filter = saved;
      this.organization = localStorage.getItem("organization");
    } catch {}

    this.handle = cx.focus_handle();
    this.handle.focus();
    this.repositoryScroll = ScrollHandle.new();
    this.pullRequestScroll = ScrollHandle.new();
    this.bodyScroll = ScrollHandle.new();
    this.search = InputState.new({ placeholder: "Search" });
    this.search.on("change", (_e, cx) => { this.searches[this.place] = this.search.value(); cx.notify(); });
    this.search.on("submit", (_e, cx) => { this.searching = false; this.handle.focus(); cx.notify(); });
    this.search.on("focus", (_e, cx) => { this.searching = true; cx.notify(); });
    this.search.on("blur", (_e, cx) => { this.searching = false; cx.notify(); });

    this.show();
    this.check(cx);
  }

  close() { this.closed = true; closeOverlay(props().overlay); }

  // ---------- what is remembered ----------

  pullRequestsKey() { return this.organization && this.repository ? `${this.organization}/${this.repository}|${this.filter}` : ""; }

  remember() {
    trimMemory(MEMORY);
    try { localStorage.setItem("memory", JSON.stringify(MEMORY)); } catch {}
  }

  // The lists as remembered, and the choices that still exist in them.
  show() {
    this.organizations = MEMORY.organizations?.items ?? [];
    if (MEMORY.organizations && !this.organizations.includes(this.organization)) this.organization = this.organizations[0] ?? null;
    const repositories = this.organization ? MEMORY.repositories[this.organization] : null;
    this.repositories = repositories?.items ?? [];
    this.moreRepositories = Boolean(repositories?.more);
    if (repositories) {
      let saved = null;
      try { saved = localStorage.getItem(`repository:${this.organization}`); } catch {}
      const names = this.repositories.map((r) => r.name);
      if (!names.includes(this.repository)) this.repository = names.includes(saved) ? saved : (names[0] ?? null);
    } else this.repository = null;
    const list = MEMORY.pullRequests[this.pullRequestsKey()];
    this.pullRequests = list?.items ?? [];
    this.totalPullRequests = list?.total ?? this.pullRequests.length;
    if (!this.pullRequests.some((p) => p.number === this.selected)) this.selected = this.pullRequests[0]?.number ?? null;
  }

  // ---------- reading ----------

  async gh(args) {
    return parse(await exec("sh", ["-c", GH, "gh", ...args], { cwd: home(), timeout: 20_000 }));
  }

  // Everything on screen, each with when it was last read and how to read it.
  needs() {
    const out = [{
      key: "account", label: "Reading the account", at: MEMORY.accountAt, age: AGE.account,
      read: async () => { const me = await this.gh(accountArgs()); if (me?.login) MEMORY = forAccount(MEMORY, me.login, Date.now()); },
    }, {
      key: "organizations", label: "Reading organizations", at: MEMORY.organizations?.at, age: AGE.organizations,
      read: async () => {
        const logins = await this.gh(organizationsArgs());
        const items = (Array.isArray(logins) ? logins : []).sort((a, b) => a.localeCompare(b));
        MEMORY.organizations = { at: Date.now(), items };
      },
    }];
    const organization = this.organization;
    if (organization && this.organizations.includes(organization)) out.push({
      key: `repositories:${organization}`, label: "Reading repositories", at: MEMORY.repositories[organization]?.at, age: AGE.repositories,
      read: async () => {
        const got = await this.gh(repositoriesArgs(organization));
        MEMORY.repositories[organization] = { at: Date.now(), more: Boolean(got?.more), items: Array.isArray(got?.items) ? got.items : [] };
      },
    });
    const key = this.pullRequestsKey(), repository = this.repository, filter = this.filter;
    if (key) out.push({
      key: `pullRequests:${key}`, label: "Reading pull requests", at: MEMORY.pullRequests[key]?.at, age: AGE.pullRequests,
      read: async () => {
        const got = await this.gh(pullRequestsArgs(organization, repository, filter));
        MEMORY.pullRequests[key] = { at: Date.now(), total: got?.total ?? 0, items: Array.isArray(got?.items) ? got.items : [] };
      },
    });
    return out;
  }

  // Start every read that is due and not already running. Each one that ends
  // shows what it brought and checks again, which starts the list under it.
  // A read that failed waits for r: checking again would only repeat it.
  check(cx, force = false) {
    if (checking() || this.closed) return;
    for (const need of this.needs()) {
      if (this.waits.has(need.key)) continue;
      if (!force && (this.errors[need.key] || (need.at && Date.now() - need.at < need.age))) continue;
      this.waits.set(need.key, need.label);
      cx.spawn(async (cx) => {
        try { await need.read(); delete this.errors[need.key]; }
        catch (e) { this.errors[need.key] = explain(e); }
        this.waits.delete(need.key);
        if (!this.closed) { this.show(); this.check(cx); }
        // Saved once the whole chain of reads has ended, not after each one.
        if (!this.waits.size) this.remember();
        if (!this.closed) cx.notify();
      });
    }
    cx.notify();
  }

  // A choice that moves quickly (j held down) is read once it settles.
  settle(cx) {
    const turn = this.turn = {};
    cx.timer.after(150, (cx) => { if (this.turn === turn) this.check(cx); });
  }

  refresh(cx) { this.errors = {}; this.check(cx, true); }

  wait(prefix) { for (const [key, label] of this.waits) if (key.startsWith(prefix)) return label; return null; }
  error(prefix) { for (const key of Object.keys(this.errors)) if (key.startsWith(prefix)) return this.errors[key]; return null; }

  // ---------- choosing ----------

  get query() { return this.searches[this.place]; }
  repositoriesShown() { const q = this.searches.repositories; return this.repositories.filter((r) => matches(q, `${r.name} ${r.description}`)); }
  pullRequestsShown() { const q = this.searches.pullRequests; return this.pullRequests.filter((p) => matches(q, `${p.number} ${p.title} ${p.author} ${p.head}`)); }

  // The pull request on screen: the selected one, or the first a search left.
  current() {
    const list = this.pullRequestsShown();
    return list.find((p) => p.number === this.selected) ?? list[0] ?? null;
  }

  pickOrganization(login, cx) {
    if (!login || login === this.organization) return;
    this.organization = login;
    try { localStorage.setItem("organization", login); } catch {}
    this.repository = null;
    this.selected = null;
    this.setPlace(PLACES.repositories);
    this.show();
    this.settle(cx);
    cx.notify();
  }

  shiftOrganization(delta, cx) {
    if (this.organizations.length < 2) return;
    this.pickOrganization(wrapped(this.organizations, this.organizations.indexOf(this.organization), delta), cx);
  }

  pickRepository(name, cx) {
    if (!name || name === this.repository) return;
    this.repository = name;
    try { if (this.organization) localStorage.setItem(`repository:${this.organization}`, name); } catch {}
    this.selected = null;
    this.show();
    this.resetBody();
    const n = this.repositoriesShown().findIndex((r) => r.name === name);
    if (n >= 0) this.repositoryScroll.scroll_to_item(n);
    this.settle(cx);
    cx.notify();
  }

  pickPullRequest(number, cx) {
    if (number == null || number === this.selected) return;
    this.selected = number;
    this.resetBody();
    const n = this.pullRequestsShown().findIndex((p) => p.number === number);
    if (n >= 0) this.pullRequestScroll.scroll_to_item(n);
    cx.notify();
  }

  resetBody() { this.top = 0; this.bodyScroll.scroll_to_item(0); }

  move(delta, cx) {
    if (this.place === PLACES.pullRequests) {
      const list = this.pullRequestsShown();
      const next = wrapped(list, list.findIndex((p) => p.number === this.current()?.number), delta);
      if (next) this.pickPullRequest(next.number, cx);
      return;
    }
    const list = this.repositoriesShown();
    const next = wrapped(list, list.findIndex((r) => r.name === this.repository), delta);
    if (next) this.pickRepository(next.name, cx);
  }

  edge(last, cx) {
    if (this.place === PLACES.pullRequests) {
      const item = this.pullRequestsShown().at(last ? -1 : 0);
      if (item) this.pickPullRequest(item.number, cx);
      return;
    }
    const item = this.repositoriesShown().at(last ? -1 : 0);
    if (item) this.pickRepository(item.name, cx);
  }

  // Each list keeps its own search: the field shows the one of the list with the keys.
  setPlace(place) {
    if (this.place === place) return;
    this.place = place;
    this.search.set_value(this.searches[place]);
  }

  stepIn(cx) { this.setPlace(PLACES.pullRequests); this.handle.focus(); cx.notify(); }
  stepOut(cx) { this.setPlace(PLACES.repositories); this.handle.focus(); cx.notify(); }

  cycleFilter(cx) {
    this.filter = FILTERS[(FILTERS.indexOf(this.filter) + 1) % FILTERS.length];
    try { localStorage.setItem("filter", this.filter); } catch {}
    this.selected = null;
    this.show();
    this.resetBody();
    this.check(cx);
  }

  clearSearch(cx) {
    this.searches[this.place] = "";
    this.search.set_value("");
    this.searching = false;
    this.handle.focus();
    cx.notify();
  }

  // ---------- acting on the pull request on screen ----------

  hand() {
    const cur = this.current();
    if (!cur) return;
    if (!this.homePane) return notify({ title: "No pane to send to", body: "Open Pull requests from a terminal pane.", level: "warning", timeout: 2500 });
    const body = (cur.body ?? "").trim();
    const text = `Look at pull request ${this.organization}/${this.repository}#${cur.number}: ${cur.title}\n\n${cur.url}\n${body ? `\n${body}\n` : ""}${cur.cut ? "\n(The description is longer on GitHub.)\n" : ""}`;
    setShared("send-box.request", { ...this.homePane, text, at: Date.now() });
    run("mod.open", { name: "send-box" });
  }

  copy(cx) {
    const cur = this.current();
    if (!cur?.url) return;
    cx.write_to_clipboard(cur.url);
    notify({ title: `Copied ${this.organization}/${this.repository}#${cur.number}`, level: "success", timeout: 1200 });
  }

  open() {
    const cur = this.current();
    if (!cur?.url) return;
    exec("/usr/bin/open", [cur.url]).catch(() => {});
  }

  scrollBy(px, cx) {
    const h = this.heights ?? [];
    if (!h.length) return;
    let i = this.top;
    if (px > 0) { let more = px; while (i < h.length - 1 && more > 0) more -= h[i++]; }
    else { let more = -px; while (i > 0 && more > 0) more -= h[--i]; }
    this.top = i;
    this.bodyScroll.scroll_to_item(i);
    cx.notify();
  }

  keys(e, cx) {
    const k = e.key, m = e.modifiers ?? {};
    if (this.searching) {
      // Arrows still move the list. Letters, including j and k, stay in the field.
      if (k === "escape") { this.searching = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      else if (k === "down") { this.move(1, cx); cx.stop_propagation(); }
      else if (k === "up") { this.move(-1, cx); cx.stop_propagation(); }
      return;
    }
    if (m.platform || m.control || m.alt) return;
    const done = () => cx.stop_propagation();
    const stepped = this.place === PLACES.pullRequests;
    const page = Math.max(LINE * 4, this.size.height - LINE * 3);
    if (k === "/" || e.key_char === "/") { this.search.focus(); cx.notify(); return done(); }
    if (k === "escape" && this.query) { this.clearSearch(cx); return done(); }
    if (k === "escape") { if (stepped) this.stepOut(cx); else this.close(); return done(); }
    if (k === "[" || e.key_char === "[") { this.shiftOrganization(-1, cx); return done(); }
    if (k === "]" || e.key_char === "]") { this.shiftOrganization(1, cx); return done(); }
    if (/^[1-9]$/.test(k) && !m.shift) { this.pickOrganization(this.organizations[Number(k) - 1], cx); return done(); }
    if (m.shift && (k === "j" || k === "k")) { this.scrollBy(k === "j" ? LINE * 5 : -LINE * 5, cx); return done(); }
    if (m.shift && k === "g") { this.edge(true, cx); return done(); }
    const map = {
      j: () => this.move(1, cx), down: () => this.move(1, cx),
      k: () => this.move(-1, cx), up: () => this.move(-1, cx),
      l: () => this.stepIn(cx), right: () => this.stepIn(cx),
      h: () => { if (stepped) this.stepOut(cx); }, left: () => { if (stepped) this.stepOut(cx); },
      g: () => this.edge(false, cx),
      f: () => this.cycleFilter(cx),
      enter: () => (stepped ? this.hand() : this.stepIn(cx)),
      y: () => this.copy(cx), o: () => this.open(), r: () => this.refresh(cx),
      space: () => this.scrollBy(m.shift ? -page : page, cx),
      pagedown: () => this.scrollBy(page, cx), pageup: () => this.scrollBy(-page, cx),
      q: () => this.close(),
    };
    if (map[k]) { map[k](); done(); }
  }

  render() {
    const t = theme();
    const stop = (_e, cx) => cx.stop_propagation();
    const repositories = this.repositoriesShown();
    const pullRequests = this.pullRequestsShown();
    const cur = this.current();
    const stepped = this.place === PLACES.pullRequests;

    const button = (id, text, hint, primary, fn) => h_flex().id(id).h(26).px(10).gap(6).items_center().rounded(6).flex_none()
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12).font_medium()
      .cursor_pointer().hover((s) => s.opacity(0.88))
      .on_mouse_down("left", stop).on_click((_e, cx) => fn(cx))
      .child(text).child(div().text_size(10.5).opacity(0.7).child(hint));

    const chip = (id, text, hint, fn) => h_flex().id(id).h(22).px(8).gap(5).items_center().rounded(5).flex_none()
      .border_1().border_color(t.input).bg(t.raised).cursor_pointer().hover((s) => s.opacity(0.88))
      .on_mouse_down("left", stop).on_click((_e, cx) => fn(cx))
      .text_size(11).text_color(t.foreground)
      .child(text).child(div().text_size(10).opacity(0.6).child(hint));

    const columnHead = (title, active, extra) => h_flex().px(12).h(38).flex_none().gap(8).items_center().justify_between()
      .border_b(1).border_color(active ? t.accent : t.border)
      .child(div().truncate().text_size(13).font_semibold().text_color(active ? t.foreground : t.muted).child(title))
      .child(extra);

    // What a list says under its rows: what it waits for, else why it is short.
    const foot = (wait, note) => (wait || note
      ? h_flex().px(12).h(24).flex_none().items_center().border_t(1).border_color(t.border)
          .child(wait ? waiting(t, wait) : div().text_size(10.5).text_color(t.dim).child(note))
      : null);

    const organizationsWait = this.wait("organizations") ?? (this.organizations.length ? null : this.wait("account"));
    const organizationsError = this.error("organizations") ?? this.error("account");
    const strip = h_flex().id("pull-requests-organizations").h(40).px(8).gap(6).flex_none().items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .overflow_x_scroll()
      .child(div().flex_none().text_size(11).text_color(t.dim).child(MEMORY.account || "This computer"))
      .children(this.organizations.map((login, n) => {
        const on = login === this.organization;
        return h_flex().id(`pull-requests-organization-${login}`).h(28).px(10).gap(7).items_center().rounded(6).flex_none()
          .border_1().border_color(on ? t.accent : quietBorder(t))
          .cursor_pointer().when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((s) => s.bg(t.hover)))
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => { this.handle.focus(); this.pickOrganization(login, cx); })
          .when(n < 9, (e) => e.child(div().text_size(10.5).text_color(t.dim).child(String(n + 1))))
          .child(div().text_size(12.5).font_medium().text_color(on ? t.foreground : t.muted).child(login));
      }))
      .when(Boolean(organizationsWait), (e) => e.child(waiting(t, organizationsWait)))
      .when(!organizationsWait && Boolean(organizationsError), (e) => e.child(div().text_size(12).text_color(t.blocked).child(organizationsError ?? "")))
      .when(!organizationsWait && !organizationsError && Boolean(MEMORY.organizations) && !this.organizations.length,
        (e) => e.child(div().text_size(12).text_color(t.muted).child("No organization on this account.")));

    const repositoryRow = (r) => {
      const on = r.name === this.repository;
      const quiet = [r.private ? "private" : null, day(r.pushed), r.description].filter(Boolean).join(" · ");
      return h_flex().id(`pull-requests-repository-${r.name}`).w_full().px(10).py(7).gap(8).items_center().rounded(6).flex_none()
        .cursor_pointer().when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((s) => s.bg(t.hover)))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { this.stepOut(cx); this.pickRepository(r.name, cx); })
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().text_size(12.5).font_medium().text_color(on ? t.foreground : t.muted).child(r.name))
          .child(div().truncate().text_size(11).text_color(t.dim).child(quiet)));
    };

    const pullRequestRow = (p) => {
      const on = p.number === cur?.number;
      return h_flex().id(`pull-requests-row-${p.number}`).w_full().px(10).py(7).gap(8).items_center().rounded(6).flex_none()
        .cursor_pointer().when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((s) => s.bg(t.hover)))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { this.stepIn(cx); this.pickPullRequest(p.number, cx); })
        .child(div().size(8).flex_none().rounded(4).bg(tone(p, t)))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().text_size(12.5).font_medium().text_color(t.foreground).child(p.title))
          .child(div().truncate().text_size(11).text_color(t.muted)
            .child([`#${p.number}`, p.author, p.head, mark(p), day(p.updated)].filter(Boolean).join(" · "))));
    };

    // Rows, or the one thing to say instead. While the list is still being
    // read for the first time its foot says so, and nothing is claimed here.
    const list = (id, rows, scroll, error, empty) => div().relative().flex_1().min_h(0)
      .child(v_flex().id(id).absolute().inset_0().p(6).gap(2).overflow_y_scroll().track_scroll(scroll)
        .children(rows.length ? rows : error || empty ? [div().p(12).text_size(12).text_color(error ? t.blocked : t.muted).child(error || empty)] : []));

    const repositoriesWait = this.wait("repositories:");
    const repositoriesError = this.error("repositories:");
    const repositoriesRead = Boolean(this.organization && MEMORY.repositories[this.organization]);
    const repositoriesEmpty = repositoriesWait && !repositoriesRead ? null
      : !this.organization ? null
      : this.searches.repositories ? "Nothing matches."
      : repositoriesRead ? "No repository here." : null;
    const left = v_flex().w(300).flex_none().h_full().border_r(1).border_color(t.border)
      .child(columnHead("Repositories", !stepped, div().text_size(11).text_color(t.dim).child(this.repositories.length ? String(repositories.length) : "")))
      .when(Boolean(this.searching || this.query) && !stepped, (e) => e.child(this.searchField(t, stop)))
      .child(list("pull-requests-repositories", repositories.map(repositoryRow), this.repositoryScroll, repositories.length ? null : repositoriesError, repositoriesEmpty))
      .when(Boolean(repositoriesWait || this.moreRepositories), (e) => e.child(foot(repositoriesWait, `The ${REPOSITORY_CAP} most recently pushed.`)));

    const pullRequestsWait = this.wait("pullRequests:");
    const pullRequestsError = this.error("pullRequests:");
    const pullRequestsRead = Boolean(MEMORY.pullRequests[this.pullRequestsKey()]);
    const pullRequestsEmpty = pullRequestsWait && !pullRequestsRead ? null
      : !this.repository ? (repositoriesRead ? "Select a repository." : null)
      : this.searches.pullRequests ? "Nothing matches."
      : !pullRequestsRead ? null
      : this.filter === "open" ? "No open pull request. f shows the rest." : "No pull request here.";
    const mid = v_flex().w(360).flex_none().h_full().border_r(1).border_color(t.border)
      .child(columnHead(this.repository || "Pull requests", stepped, chip("pull-requests-filter", this.filter, "f", (cx) => this.cycleFilter(cx))))
      .when(Boolean(this.searching || this.query) && stepped, (e) => e.child(this.searchField(t, stop)))
      .child(list("pull-requests-list", pullRequests.map(pullRequestRow), this.pullRequestScroll, pullRequests.length ? null : pullRequestsError, pullRequestsEmpty))
      .when(Boolean(pullRequestsWait || this.totalPullRequests > this.pullRequests.length), (e) => e.child(foot(pullRequestsWait,
        `The ${PULL_REQUEST_CAP} most recently updated of ${this.totalPullRequests}.`)));

    const facts = !cur ? [] : [
      cur.author, cur.head && cur.base ? `${cur.head} → ${cur.base}` : cur.head,
      mark(cur), `+${cur.add ?? 0} −${cur.del ?? 0}`, `${cur.files ?? 0} files`, day(cur.updated),
    ].filter(Boolean);

    const width = Math.max(220, this.size.width - 28);
    const lines = (s) => s.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil((l.length * 7.2) / width)), 0);
    const parts = [];
    const part = (el, px) => { parts.push({ el: el.flex_none(), px: px + 10 }); };
    if (cur) {
      part(div().text_size(11).text_color(t.muted).child(facts.join(" · ")), 16);
      // The same text gives the same blocks: split once per pull request shown.
      if (this.split?.of !== cur) this.split = { of: cur, blocks: blocks(cur.body) };
      const md = this.split.blocks;
      if (!md.length) part(div().text_size(12.5).text_color(t.dim).child("No description."), LINE);
      md.forEach((b, n) => part(div().text_size(13).text_color(t.foreground)
        .child(TextView.markdown(`pull-requests-md-${cur.number}-${n}`, b).selectable(true)), lines(b) * LINE));
      if (cur.cut) part(div().text_size(11).text_color(t.dim).child("The rest is on GitHub."), LINE);
    } else if (pullRequestsWait && !pullRequestsRead) {
      part(waiting(t, pullRequestsWait), LINE);
    } else if (pullRequestsRead || !this.repository) {
      part(div().text_size(12.5).text_color(t.muted).child(this.repository ? "No pull request selected." : "Select a repository."), LINE);
    }
    this.heights = parts.map((p) => p.px);
    if (this.top > parts.length - 1) this.top = Math.max(0, parts.length - 1);

    const reader = div().size_full().relative().bg(t.background)
      .child(v_flex().id("pull-requests-body").absolute().inset_0().px(14).py(10).gap(10).overflow_y_scroll().track_scroll(this.bodyScroll)
        .on_size_change((size, cx) => {
          if (this.size.width === size.width && this.size.height === size.height) return;
          this.size = size;
          cx.notify();
        })
        .children(parts.map((p) => p.el)))
      .child(Scrollbar.vertical("pull-requests-body").absolute().inset_0());

    const right = v_flex().flex_1().min_w(0).h_full()
      .child(h_flex().px(12).h(38).flex_none().gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().text_size(11).text_color(t.dim).child(cur ? `#${cur.number}` : ""))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(cur ? cur.title : "")))
      .child(div().flex_1().min_h(0).child(reader))
      .child(h_flex().px(10).h(44).flex_none().gap(8).items_center().border_t(1).border_color(t.border)
        .child(button("pull-requests-hand", "Send to pane", "↵", true, () => this.hand()))
        .child(button("pull-requests-open", "Open", "o", false, () => this.open()))
        .child(button("pull-requests-copy", "Copy", "y", false, (cx) => this.copy(cx)))
        .child(div().flex_1())
        .child(button("pull-requests-refresh", "Read again", "r", false, (cx) => this.refresh(cx)))
        .child(button("pull-requests-close", "Close", "q", false, () => this.close())));

    const hint = stepped
      ? "j k move · h back · g G first last · / search · f filter · ↵ send · y copy · o open · J K scroll · esc back"
      : "j k move · l pull requests · g G first last · [ ] 1-9 organization · / search · r read again · esc close";

    return v_flex().id("pull-requests-root").size_full().bg(t.popover).text_color(t.foreground)
      .track_focus(this.handle).key_context("PullRequests")
      .on_action("pull-requests-escape", (_e, cx) => this.keys({ key: "escape", keystroke: "escape", modifiers: {} }, cx))
      .on_key_down((e, cx) => this.keys(e, cx))
      .child(strip)
      .child(h_flex().flex_1().min_h(0).w_full().child(left).child(mid).child(right))
      .child(h_flex().h(28).px(12).flex_none().items_center().border_t(1).border_color(t.border)
        .child(div().truncate().text_size(10.5).text_color(t.dim).child(hint)));
  }

  searchField(t, stop) {
    return h_flex().mx(6).mt(6).h(28).px(8).gap(6).flex_none().items_center().rounded(6)
      .border_1().border_color(this.searching ? t.accent : t.input).bg(t.background)
      .on_mouse_down("left", stop)
      .child(div().text_size(12).text_color(t.dim).child("/"))
      .child(div().flex_1().min_w(0).child(Input.new(this.search).w_full().text_size(12.5).text_color(t.foreground)));
  }
}
