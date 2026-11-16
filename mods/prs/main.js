// Pull requests for a repository in a selected organization, on this computer.
//
// Its own spec needs gh. The Git dialog and lazygit do not. gh is this
// computer's copy (mise's shim when it is there), signed in as this computer's
// GitHub account. Another machine's checkout is never asked.
//
//   Top:     the account, then its organizations. 1-9, [ and ], or a click.
//   Left:    that organization's repositories, most recently pushed first.
//   Middle:  the selected repository's pull requests.
//   Right:   the selected pull request.
//
//   j k ↑ ↓     move in the list that has the keys (repositories, or pull requests once stepped in)
//   l →         step into the pull requests
//   h ←         step back to the repositories, or the previous organization
//   [ ]         previous and next organization
//   1-9         an organization
//   g G         first and last of that list
//   /           search (esc leaves the field and keeps what was typed)
//   f           open, all, then closed
//   enter       hand the pull request to the pane you came from, once stepped in
//   y o r       copy its link, open it, refresh
//   J K space   scroll the pull request
//   q           close
//   esc         step back, and close once nothing is left to leave
//
// Opened with ctrl-a P. The last organization and repository are remembered here.
//
// Each list is cached on this computer and drawn from that cache at once.
// gh runs one call at a time, and only for the organization, repository or
// pull request on screen when its cache is missing or you press r.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, Scrollbar, InputState, Input, TextView } from "gpui-base";
import { checking, closeOverlay, exec, focused, home, notify, panes, props, run, setShared, theme } from "herdr";

const ORG_CAP = 100;
const REPO_CAP = 30;
const PR_CAP = 20;
const BODY_CAP = 4000;
const LINE = 21;
const FILTERS = ["open", "all", "closed"];
const ORG_TTL = 10 * 60 * 1000;
const REPO_TTL = 10 * 60 * 1000;
const PULL_TTL = 2 * 60 * 1000;
const DETAIL_TTL = 10 * 60 * 1000;

function loadCache() {
  try {
    const c = JSON.parse(localStorage.getItem("cache") || "");
    if (c && Array.isArray(c.orgs) && c.repos && c.pulls && c.details) return c;
  } catch {}
  return { account: "", orgs: [], orgsAt: 0, repos: {}, pulls: {}, details: {} };
}

const REPO_JQ = '[.[] | select(.archived | not) | {name, private, description: (.description // "" | .[0:140]), pushed: .pushed_at, url: .html_url}]';
const PR_JQ = `[.[] | {number, title, author: .author.login, updated: .updatedAt, url, draft: .isDraft, review: (.reviewDecision // ""), state, branch: .headRefName, add: (.additions // 0), del: (.deletions // 0)}]`;
const DETAIL_JQ = `{number, title, body: (.body // "" | .[0:${BODY_CAP}]), cut: ((.body // "") | length > ${BODY_CAP}), author: .author.login, state, draft: .isDraft, review: (.reviewDecision // ""), url, head: .headRefName, base: .baseRefName, add: (.additions // 0), del: (.deletions // 0), files: (.changedFiles // 0), updated: .updatedAt}`;

const day = (iso) => (iso ? String(iso).slice(0, 10) : "");
const words = (q) => q.trim().toLowerCase().split(/\s+/).filter(Boolean);
const hit = (q, hay) => { const w = words(q); const t = hay.toLowerCase(); return w.every((x) => t.includes(x)); };

function mark(p) {
  if (!p) return "";
  if (p.draft) return "draft";
  if (p.state === "MERGED") return "merged";
  if (p.state === "CLOSED") return "closed";
  if (p.review === "APPROVED") return "approved";
  if (p.review === "CHANGES_REQUESTED") return "changes";
  if (p.review === "REVIEW_REQUIRED") return "review";
  return "open";
}

function tone(p, t) {
  const m = mark(p);
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
  const n = index < 0 ? 0 : index;
  return list[(n + delta + list.length) % list.length];
}

function repoEmpty(view) {
  if (view.orgError) return view.orgError;
  if (view.repoError) return view.repoError;
  if (!view.org) return "No organization on this account.";
  if (view.reposBusy && !view.repos.length) return "Reading…";
  if (view.query) return "Nothing matches.";
  return "No repository here.";
}

function pullEmpty(view) {
  if (view.pullError) return view.pullError;
  if (!view.repo) return "Select a repository.";
  if (view.pullsBusy && !view.pulls.length) return "Reading…";
  if (view.query) return "Nothing matches.";
  if (view.filter === "open") return "No open pull request. f shows the rest.";
  return "No pull request here.";
}

// Markdown as blocks (blank lines split, code fences kept whole) so the
// keyboard can scroll to one.
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

function explain(e) {
  const m = String(e?.message ?? e);
  if (/no such file|not found|cannot start|os error 2/i.test(m)) return "Can't run gh on this computer. Install it with: mise use --global gh@2";
  if (/gh auth login|HTTP 401|authentication required|to authenticate/i.test(m)) return "gh isn't signed in on this computer. Run: gh auth login";
  return m;
}

// Escape is bound to an action of this mod's own: while a text field has the
// keyboard, Herdr closes a dialog on Escape before any key handler here sees it.
let escapeBound = false;

export default class PullRequests extends View {
  init(_props, cx) {
    if (!escapeBound) { cx.bind_keys([{ keystroke: "escape", action: "prs-escape", context: "Prs" }]); escapeBound = true; }
    const f = focused() ?? {};
    const pane = f.pane ? panes().find((p) => p.pane === f.pane) : null;
    this.homePane = pane?.terminal ? { pane: f.pane, target: pane.terminal, label: pane.title || pane.terminal } : null;

    this.bin = `${home()}/.local/share/mise/shims/gh`;
    this.cache = loadCache();
    this.account = this.cache.account || "";
    this.orgs = this.cache.orgs;
    this.org = null;
    this.repos = [];
    this.repo = null;
    this.pulls = [];
    this.selected = null;
    this.place = "repos"; // or "pulls", once l steps in
    this.filter = "open";
    this.query = "";
    this.orgError = null;
    this.repoError = null;
    this.pullError = null;
    this.detailFailed = {};
    this.want = { orgs: false, repos: false, pulls: false, detail: false };
    this.orgsBusy = false;
    this.reposBusy = false;
    this.pullsBusy = false;
    this.detailBusy = false;
    this.running = false;
    this.pending = false;
    this.accountTried = Boolean(this.account);
    this.top = 0;
    this.size = { width: 420, height: 560 };
    try {
      const saved = localStorage.getItem("filter");
      if (FILTERS.includes(saved)) this.filter = saved;
      this.org = localStorage.getItem("org");
    } catch {}
    if (!this.orgs.some((o) => o.login === this.org)) this.org = this.orgs[0]?.login ?? this.org;
    this.applyRepos();
    this.orgsBusy = !this.orgs.length;
    this.reposBusy = Boolean(this.org) && !this.cache.repos[this.org];
    this.pullsBusy = Boolean(this.repo) && !this.cache.pulls[this.pullKey()];

    this.handle = cx.focus_handle();
    this.handle.focus();
    this.repoScroll = ScrollHandle.new();
    this.pullScroll = ScrollHandle.new();
    this.bodyScroll = ScrollHandle.new();
    this.search = InputState.new({ placeholder: "Search" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); cx.notify(); });
    this.search.on("submit", (_e, cx) => { this.searching = false; this.handle.focus(); cx.notify(); });
    this.search.on("focus", (_e, cx) => { this.searching = true; cx.notify(); });
    this.search.on("blur", (_e, cx) => { this.searching = false; cx.notify(); });

    if (checking()) return;
    this.ensure(cx);
  }

  stale(at, ttl) { return !at || Date.now() - at > ttl; }

  pullKey() { return this.org && this.repo ? `${this.org}/${this.repo}|${this.filter}` : ""; }

  save() {
    const details = this.cache.details;
    const keys = Object.keys(details);
    if (keys.length > 8) {
      keys.sort((a, b) => (details[a].at ?? 0) - (details[b].at ?? 0));
      for (const key of keys.slice(0, keys.length - 8)) delete details[key];
    }
    try { localStorage.setItem("cache", JSON.stringify(this.cache)); } catch {}
  }

  async cli(args) {
    const r = await exec(this.bin, args, { timeout: 15000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || `gh exited ${r.code}`).trim().split("\n").pop());
    const out = (r.stdout ?? "").trim();
    if (!out) return null;
    try { return JSON.parse(out); } catch { throw new Error(out.split("\n").pop()); }
  }

  // One gh call at a time. A newer choice waits until the current call ends,
  // then the loop fetches whatever is still missing.
  ensure(cx) {
    this.pending = true;
    if (this.running) return;
    this.running = true;
    cx.spawn(async (cx) => {
      try {
        while (this.pending) {
          this.pending = false;
          if (this.needOrgs()) await this.fetchOrgs(cx);
          else if (this.needRepos()) await this.fetchRepos(cx);
          else if (this.needPulls()) await this.fetchPulls(cx);
          else if (this.needDetail()) await this.fetchDetail(cx);
          else if (this.needAccount()) await this.fetchAccount(cx);
        }
      } finally {
        this.running = false;
        if (this.pending) this.ensure(cx);
      }
    });
  }

  needOrgs() {
    if (this.want.orgs) return true;
    if (this.orgError) return false;
    if (!this.orgs.length) return !this.cache.orgsAt;
    return this.stale(this.cache.orgsAt, ORG_TTL);
  }

  fresh(want, failed, entry, ttl) {
    if (want) return true;
    if (failed) return false;
    if (!entry) return true;
    return this.stale(entry.at, ttl);
  }

  needRepos() {
    if (!this.org) return false;
    return this.fresh(this.want.repos, this.repoError, this.cache.repos[this.org], REPO_TTL);
  }

  needPulls() {
    if (!this.org || !this.repo) return false;
    return this.fresh(this.want.pulls, this.pullError, this.cache.pulls[this.pullKey()], PULL_TTL);
  }

  needDetail() {
    if (this.selected == null || !this.org || !this.repo) return false;
    if (!this.pulls.some((p) => p.number === this.selected)) return false;
    const key = this.detailKey(this.selected);
    return this.fresh(this.want.detail, this.detailFailed[key], this.cache.details[key], DETAIL_TTL);
  }

  needAccount() { return !this.account && !this.accountTried; }

  applyRepos() {
    const hit = this.org ? this.cache.repos[this.org] : null;
    this.repos = hit?.items ?? [];
    if (!hit) {
      this.repo = null;
      this.pulls = [];
      this.selected = null;
      return;
    }
    let saved = null;
    try { saved = localStorage.getItem(`repo:${this.org}`); } catch {}
    const names = new Set(this.repos.map((r) => r.name));
    this.repo = names.has(saved) ? saved : (this.repos[0]?.name ?? null);
    if (this.repo) { try { localStorage.setItem(`repo:${this.org}`, this.repo); } catch {} }
    this.applyPulls();
  }

  applyPulls() {
    const hit = this.pullKey() && this.cache.pulls[this.pullKey()];
    this.pulls = hit?.items ?? [];
    const numbers = new Set(this.pulls.map((p) => p.number));
    this.selected = numbers.has(this.selected) ? this.selected : (this.pulls[0]?.number ?? null);
  }

  orgsShown() { return this.orgs.filter((o) => hit(this.query, o.login)); }
  reposShown() { return this.repos.filter((r) => hit(this.query, `${r.name} ${r.description}`)); }
  pullsShown() { return this.pulls.filter((p) => hit(this.query, `${p.number} ${p.title} ${p.author} ${p.branch}`)); }

  currentPull() {
    const list = this.pullsShown();
    return list.find((p) => p.number === this.selected) ?? list[0] ?? null;
  }

  detailKey(n = this.selected) { return `${this.org}/${this.repo}#${n}`; }

  shown() {
    const cur = this.currentPull();
    if (!cur) return null;
    return this.cache.details[this.detailKey(cur.number)]?.item ?? cur;
  }

  async fetchOrgs(cx) {
    this.want.orgs = false;
    this.orgsBusy = !this.orgs.length;
    if (this.orgsBusy) cx.notify();
    try {
      const orgs = await this.cli(["api", `user/orgs?per_page=${ORG_CAP}`, "--jq", "[.[] | {login: .login}]"]);
      const list = (Array.isArray(orgs) ? orgs : []).sort((a, b) => a.login.localeCompare(b.login));
      this.cache.orgs = list;
      this.cache.orgsAt = Date.now();
      this.orgs = list;
      this.orgError = null;
      if (!list.some((o) => o.login === this.org)) this.org = list[0]?.login ?? null;
      if (this.org) { try { localStorage.setItem("org", this.org); } catch {} }
      this.save();
      this.applyRepos();
      this.reposBusy = Boolean(this.org) && !this.cache.repos[this.org];
      this.pullsBusy = Boolean(this.repo) && !this.cache.pulls[this.pullKey()];
    } catch (e) {
      this.orgError = explain(e);
    } finally {
      this.orgsBusy = false;
      cx.notify();
    }
  }

  async fetchRepos(cx) {
    const org = this.org;
    this.want.repos = false;
    if (!org) return;
    this.reposBusy = !this.cache.repos[org];
    if (this.reposBusy) cx.notify();
    try {
      const repos = await this.cli(["api", `orgs/${org}/repos?sort=pushed&per_page=${REPO_CAP}&type=all`, "--jq", REPO_JQ]);
      const items = Array.isArray(repos) ? repos : [];
      this.cache.repos[org] = { at: Date.now(), items };
      this.save();
      if (org === this.org) { this.repoError = null; this.applyRepos(); }
    } catch (e) {
      if (org === this.org) this.repoError = explain(e);
    } finally {
      this.reposBusy = false;
      cx.notify();
    }
  }

  async fetchPulls(cx) {
    const org = this.org, repo = this.repo, filter = this.filter;
    const key = `${org}/${repo}|${filter}`;
    this.want.pulls = false;
    if (!org || !repo) return;
    this.pullsBusy = !this.cache.pulls[key];
    if (this.pullsBusy) cx.notify();
    try {
      const pulls = await this.cli(["pr", "list", "--repo", `${org}/${repo}`, "--state", filter, "--limit", String(PR_CAP), "--json", "number,title,author,updatedAt,url,isDraft,reviewDecision,headRefName,additions,deletions,state", "--jq", PR_JQ]);
      const items = Array.isArray(pulls) ? pulls : [];
      this.cache.pulls[key] = { at: Date.now(), items };
      this.save();
      if (key === this.pullKey()) { this.pullError = null; this.applyPulls(); }
    } catch (e) {
      if (key === this.pullKey()) this.pullError = explain(e);
    } finally {
      this.pullsBusy = false;
      cx.notify();
    }
  }

  async fetchDetail(cx) {
    const n = this.selected, org = this.org, repo = this.repo;
    const key = `${org}/${repo}#${n}`;
    this.want.detail = false;
    if (n == null || !org || !repo) return;
    this.detailBusy = !this.cache.details[key];
    if (this.detailBusy) cx.notify();
    try {
      const detail = await this.cli(["pr", "view", String(n), "--repo", `${org}/${repo}`, "--json", "number,title,body,author,state,isDraft,reviewDecision,url,headRefName,baseRefName,additions,deletions,changedFiles,updatedAt", "--jq", DETAIL_JQ]);
      if (detail) {
        this.cache.details[key] = { at: Date.now(), item: detail };
        delete this.detailFailed[key];
        this.save();
      } else this.detailFailed[key] = true;
    } catch {
      this.detailFailed[key] = true;
    } finally {
      this.detailBusy = false;
      cx.notify();
    }
  }

  async fetchAccount(cx) {
    this.accountTried = true;
    try {
      const me = await this.cli(["api", "user", "--jq", "{login: .login}"]);
      if (me?.login) {
        this.account = me.login;
        this.cache.account = me.login;
        this.save();
        cx.notify();
      }
    } catch {}
  }

  pickOrg(login, cx) {
    if (!login || login === this.org) return;
    this.org = login;
    try { localStorage.setItem("org", login); } catch {}
    this.repoError = null;
    this.pullError = null;
    this.place = "repos";
    this.applyRepos();
    this.reposBusy = !this.cache.repos[login];
    this.pullsBusy = Boolean(this.repo) && !this.cache.pulls[this.pullKey()];
    this.ensure(cx);
    cx.notify();
  }

  shiftOrg(delta, cx) {
    const list = this.orgsShown();
    if (list.length < 2) return;
    const next = wrapped(list, list.findIndex((o) => o.login === this.org), delta);
    if (next) this.pickOrg(next.login, cx);
  }

  pickRepo(name, cx) {
    if (!name || name === this.repo) return;
    this.repo = name;
    try { if (this.org) localStorage.setItem(`repo:${this.org}`, name); } catch {}
    this.selected = null;
    this.pullError = null;
    this.applyPulls();
    this.pullsBusy = !this.cache.pulls[this.pullKey()];
    const n = this.reposShown().findIndex((r) => r.name === name);
    if (n >= 0) this.repoScroll.scroll_to_item(n);
    this.ensure(cx);
    cx.notify();
  }

  shiftRepo(delta, cx) {
    const list = this.reposShown();
    const next = wrapped(list, list.findIndex((r) => r.name === this.repo), delta);
    if (next) this.pickRepo(next.name, cx);
  }

  pickPull(number, cx) {
    if (number == null || number === this.selected) return;
    this.selected = number;
    this.top = 0;
    this.bodyScroll.scroll_to_item(0);
    const n = this.pullsShown().findIndex((p) => p.number === number);
    if (n >= 0) this.pullScroll.scroll_to_item(n);
    this.detailBusy = !this.cache.details[this.detailKey()];
    this.ensure(cx);
    cx.notify();
  }

  shiftPull(delta, cx) {
    const list = this.pullsShown();
    const next = wrapped(list, list.findIndex((p) => p.number === this.currentPull()?.number), delta);
    if (next) this.pickPull(next.number, cx);
  }

  move(delta, cx) {
    if (this.place === "pulls") this.shiftPull(delta, cx);
    else this.shiftRepo(delta, cx);
  }

  back(cx) {
    if (this.place === "pulls") this.stepOut(cx);
    else this.shiftOrg(-1, cx);
  }

  edge(last, cx) {
    if (this.place === "pulls") {
      const list = this.pullsShown();
      const item = last ? list[list.length - 1] : list[0];
      if (item) this.pickPull(item.number, cx);
      return;
    }
    const list = this.reposShown();
    const item = last ? list[list.length - 1] : list[0];
    if (item) this.pickRepo(item.name, cx);
  }

  stepIn(cx) { this.place = "pulls"; this.handle.focus(); cx.notify(); }
  stepOut(cx) { this.place = "repos"; this.handle.focus(); cx.notify(); }

  cycleFilter(cx) {
    this.filter = FILTERS[(FILTERS.indexOf(this.filter) + 1) % FILTERS.length];
    try { localStorage.setItem("filter", this.filter); } catch {}
    this.selected = null;
    this.pullError = null;
    this.applyPulls();
    this.pullsBusy = !this.cache.pulls[this.pullKey()];
    this.ensure(cx);
    cx.notify();
  }

  clearSearch(cx) {
    this.query = "";
    this.search.set_value("");
    this.searching = false;
    this.handle.focus();
    cx.notify();
  }

  refresh(cx) {
    this.want = { orgs: true, repos: true, pulls: true, detail: true };
    this.orgError = null;
    this.repoError = null;
    this.pullError = null;
    this.detailFailed = {};
    this.ensure(cx);
    cx.notify();
  }

  hand() {
    const cur = this.currentPull();
    if (!cur) return;
    if (!this.homePane) return notify({ title: "No pane to send to", body: "Open Pull requests from a terminal pane.", level: "warning", timeout: 2500 });
    const full = this.shown();
    const body = (full?.body ?? "").trim();
    const text = `Look at pull request ${this.org}/${this.repo}#${cur.number}: ${cur.title}\n\n${cur.url}\n${body ? `\n${body}\n` : ""}`;
    setShared("send-box.request", { ...this.homePane, text, at: Date.now() });
    run("mod.open", { name: "send-box" });
  }

  copy(cx) {
    const cur = this.currentPull();
    if (!cur?.url) return;
    cx.write_to_clipboard(cur.url);
    notify({ title: `Copied ${this.org}/${this.repo}#${cur.number}`, level: "success", timeout: 1200 });
  }

  open() {
    const cur = this.currentPull();
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

  close() { closeOverlay(props().overlay); }

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
    const page = Math.max(LINE * 4, this.size.height - LINE * 3);
    if (k === "/" || e.key_char === "/") { this.search.focus(); cx.notify(); return done(); }
    if (k === "escape" && this.query) { this.clearSearch(cx); return done(); }
    if (k === "escape") {
      if (this.place === "pulls") this.stepOut(cx);
      else this.close();
      return done();
    }
    if (k === "[" || e.key_char === "[") { this.shiftOrg(-1, cx); return done(); }
    if (k === "]" || e.key_char === "]") { this.shiftOrg(1, cx); return done(); }
    if (/^[1-9]$/.test(k) && !m.shift) { const org = this.orgsShown()[Number(k) - 1]; if (org) this.pickOrg(org.login, cx); return done(); }
    if (m.shift && (k === "j" || k === "k")) { this.scrollBy(k === "j" ? LINE * 5 : -LINE * 5, cx); return done(); }
    if (m.shift && k === "g") { this.edge(true, cx); return done(); }
    const map = {
      j: () => this.move(1, cx), down: () => this.move(1, cx),
      k: () => this.move(-1, cx), up: () => this.move(-1, cx),
      l: () => this.stepIn(cx), right: () => this.stepIn(cx),
      h: () => this.back(cx), left: () => this.back(cx),
      g: () => this.edge(false, cx),
      f: () => this.cycleFilter(cx),
      enter: () => (this.place === "pulls" ? this.hand() : this.stepIn(cx)),
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
    const orgs = this.orgsShown();
    const repos = this.reposShown();
    const pulls = this.pullsShown();
    const cur = this.currentPull();
    const full = this.shown();
    const onPulls = this.place === "pulls";

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

    const strip = h_flex().id("pr-orgs").h(40).px(8).gap(6).flex_none().items_center().border_b(1).border_color(t.border).bg(t.chrome)
      .overflow_x_scroll()
      .child(div().flex_none().text_size(11).text_color(t.dim).child(this.account || "This computer"))
      .children(orgs.map((o, n) => {
        const on = o.login === this.org;
        return h_flex().id(`pr-org-${o.login}`).h(28).px(10).gap(7).items_center().rounded(6).flex_none()
          .border_1().border_color(on ? t.accent : quietBorder(t))
          .cursor_pointer().when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((s) => s.bg(t.hover)))
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => { this.handle.focus(); this.pickOrg(o.login, cx); })
          .when(n < 9, (e) => e.child(div().text_size(10.5).text_color(t.dim).child(String(n + 1))))
          .child(div().text_size(12.5).font_medium().text_color(on ? t.foreground : t.muted).child(o.login));
      }))
      .when(this.orgError, (e) => e.child(div().text_size(12).text_color(t.blocked).child(this.orgError)))
      .when(!this.orgError && this.orgsBusy && !this.orgs.length, (e) => e.child(div().text_size(12).text_color(t.muted).child("Reading…")))
      .when(!this.orgError && !this.orgsBusy && !this.orgs.length, (e) => e.child(div().text_size(12).text_color(t.muted).child("No organization on this account.")));

    const reposMessage = repoEmpty(this);
    const pullsMessage = pullEmpty(this);

    const repoRow = (r) => {
      const on = r.name === this.repo;
      const quiet = [r.private ? "private" : null, day(r.pushed), r.description].filter(Boolean).join(" · ");
      return h_flex().id(`pr-repo-${r.name}`).w_full().px(10).py(7).gap(8).items_center().rounded(6).flex_none()
        .cursor_pointer().when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((s) => s.bg(t.hover)))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { this.place = "repos"; this.handle.focus(); this.pickRepo(r.name, cx); })
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().text_size(12.5).font_medium().text_color(on ? t.foreground : t.muted).child(r.name))
          .child(div().truncate().text_size(11).text_color(t.dim).child(quiet)));
    };

    const pullRow = (p) => {
      const on = p.number === cur?.number;
      const label = mark(p);
      return h_flex().id(`pr-row-${p.number}`).w_full().px(10).py(7).gap(8).items_center().rounded(6).flex_none()
        .cursor_pointer().when(on, (e) => e.bg(t.selected)).when(!on, (e) => e.hover((s) => s.bg(t.hover)))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => { this.handle.focus(); this.stepIn(cx); this.pickPull(p.number, cx); })
        .child(div().size(8).flex_none().rounded(4).bg(tone(p, t)))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .child(div().truncate().text_size(12.5).font_medium().text_color(t.foreground).child(p.title))
          .child(div().truncate().text_size(11).text_color(t.muted)
            .child([`#${p.number}`, p.author, p.branch, label, day(p.updated)].filter(Boolean).join(" · "))));
    };

    const list = (id, rows, empty, scroll, toneError) => div().relative().flex_1().min_h(0)
      .child(v_flex().id(id).absolute().inset_0().p(6).gap(2).overflow_y_scroll().track_scroll(scroll)
        .children(rows.length ? rows : [div().p(12).text_size(12).text_color(toneError ? t.blocked : t.muted).child(empty)]));

    const left = v_flex().w(300).flex_none().h_full().border_r(1).border_color(t.border)
      .child(columnHead("Repositories", !onPulls, div().text_size(11).text_color(t.dim).child(this.repos.length ? String(repos.length) : "")))
      .when(Boolean(this.searching || this.query) && !onPulls, (e) => e.child(this.searchField(t, stop)))
      .child(list("pr-repos", repos.map(repoRow), reposMessage, this.repoScroll, Boolean(this.orgError || this.repoError)))
      .when(this.repos.length >= REPO_CAP, (e) => e.child(div().px(12).h(22).flex_none().text_size(10.5).text_color(t.dim)
        .child(`The ${REPO_CAP} most recently pushed.`)));

    const mid = v_flex().w(360).flex_none().h_full().border_r(1).border_color(t.border)
      .child(columnHead(this.repo || "Pull requests", onPulls, chip("pr-filter", this.filter, "f", (cx) => this.cycleFilter(cx))))
      .when(Boolean(this.searching || this.query) && onPulls, (e) => e.child(this.searchField(t, stop)))
      .child(list("pr-pulls", pulls.map(pullRow), pullsMessage, this.pullScroll, Boolean(this.pullError)))
      .when(this.pulls.length >= PR_CAP, (e) => e.child(div().px(12).h(22).flex_none().text_size(10.5).text_color(t.dim)
        .child(`The ${PR_CAP} most recently updated.`)));

    const detail = cur ? this.cache.details[this.detailKey(cur.number)]?.item : null;
    const facts = !full ? [] : [
      full.author, full.head && full.base ? `${full.head} → ${full.base}` : full.branch,
      mark(full),
      full.add != null ? `+${full.add} −${full.del ?? 0}` : null,
      full.files != null ? `${full.files} files` : null,
      day(full.updated),
    ].filter(Boolean);

    const width = Math.max(220, this.size.width - 28);
    const lines = (s) => s.split("\n").reduce((n, l) => n + Math.max(1, Math.ceil((l.length * 7.2) / width)), 0);
    const parts = [];
    const part = (el, px) => { parts.push({ el: el.flex_none(), px: px + 10 }); };
    if (full) {
      if (facts.length) part(div().text_size(11).text_color(t.muted).child(facts.join(" · ")), 16);
      if (detail) {
        const md = blocks(detail.body);
        if (!md.length) part(div().text_size(12.5).text_color(t.dim).child("No description."), LINE);
        md.forEach((b, n) => part(div().text_size(13).text_color(t.foreground)
          .child(TextView.markdown(`pr-md-${detail.number}-${n}`, b).selectable(true)), lines(b) * LINE));
        if (detail.cut) part(div().text_size(11).text_color(t.dim).child("The rest is on GitHub."), LINE);
      } else if (this.detailBusy) part(div().text_size(12.5).text_color(t.dim).child("Reading…"), LINE);
    } else {
      part(div().text_size(12.5).text_color(t.muted).child(this.repo ? "No pull request selected." : "Select a repository."), LINE);
    }
    this.heights = parts.map((p) => p.px);
    if (this.top > parts.length - 1) this.top = Math.max(0, parts.length - 1);

    const reader = div().size_full().relative().bg(t.background)
      .child(v_flex().id("pr-body").absolute().inset_0().px(14).py(10).gap(10).overflow_y_scroll().track_scroll(this.bodyScroll)
        .on_size_change((size, cx) => {
          if (this.size.width === size.width && this.size.height === size.height) return;
          this.size = size;
          cx.notify();
        })
        .children(parts.map((p) => p.el)))
      .child(Scrollbar.vertical("pr-body").absolute().inset_0());

    const right = v_flex().flex_1().min_w(0).h_full()
      .child(h_flex().px(12).h(38).flex_none().gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().text_size(11).text_color(t.dim).child(cur ? `#${cur.number}` : ""))
        .child(div().flex_1().min_w(0).truncate().text_size(13).font_semibold().text_color(t.foreground).child(cur ? cur.title : "")))
      .child(div().flex_1().min_h(0).child(reader))
      .child(h_flex().px(10).h(44).flex_none().gap(8).items_center().border_t(1).border_color(t.border)
        .child(button("pr-hand", "Send to pane", "↵", true, () => this.hand()))
        .child(button("pr-open", "Open", "o", false, () => this.open()))
        .child(button("pr-copy", "Copy", "y", false, (cx) => this.copy(cx)))
        .child(div().flex_1())
        .child(button("pr-refresh", "Refresh", "r", false, (cx) => this.refresh(cx)))
        .child(button("pr-close", "Close", "q", false, () => this.close())));

    const hint = onPulls
      ? "j k move · h back · g G first last · f filter · ↵ send · y copy · o open · J K scroll · esc back"
      : "j k move · l pull requests · h [ ] organization · 1-9 · / search · esc close";

    return v_flex().id("pr-root").size_full().bg(t.popover).text_color(t.foreground)
      .track_focus(this.handle).key_context("Prs")
      .on_action("prs-escape", (_e, cx) => this.keys({ key: "escape", keystroke: "escape", modifiers: {} }, cx))
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
