// Git: lazygit, drawn natively by Herdr (Cmd-G, keys.json).
//
// Lazygit's panel layout and familiar keys: [1] Status, [2] Files,
// [3] Branches, [4] Commits, [5] Stash on the left, the main view on the
// right, key hints along the bottom. Markdown files show as a rendered
// preview in the main view (t switches to the diff); ```mermaid blocks are
// drawn by Pele, Obsidian's Mermaid renderer (./pele.js, ./mermaid.js).
// Status and Branches show the commit graph of VS Code's Git Graph
// (./graph.js): enter goes into it, enter on a commit shows its patch.
// Works on the focused pane's repo, on whichever machine that space lives.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, ScrollHandle, VirtualListScrollHandle, v_virtual_list, TextView } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, watchFolder, theme, settings, props, closeOverlay, run, appHome, shared, setShared, checking } from "herdr";
import * as fs from "fs/promises";
import { renderMermaid, splitMermaid } from "./mermaid.js";
import { ROW, UNCOMMITTED, GRAPH_FORMAT, graphWidth, parseLog, dateOrder, layout, graphCell } from "./graph.js";
import { GitFeatures } from "./features.js";
import { parsePatch } from "./patch.js";

// ---------- helpers ----------

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
// Reads never write under .git, so the folder watch doesn't wake itself.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));
const PAGE = 20;

// What git said last, kept in memory for as long as this version of the mod
// is loaded, so it outlives the dialog: opening Git again shows the repo as
// it was at once, then checks it. History is only read again when a ref
// moved (MARK); a commit's patch never changes, so it is read once.
const REPOS = new Map();   // "machine:root" -> { snap, hist, graphs }
const ROOTS = new Map();   // "machine:folder" -> its REPOS key
const PATCHES = new Map(); // "machine:root\ncommit" -> the patch's lines
// Least recently used first: a map keeps the order its keys were set in.
const keep = (map, key, value, max) => { map.delete(key); map.set(key, value); while (map.size > max) map.delete(map.keys().next().value); return value; };
const recall = (map, key) => { const v = map.get(key); if (v !== undefined) { map.delete(key); map.set(key, v); } return v; };
// HEAD, the branch it is on, and one hash over every ref and every branch's
// upstream. While R stays the same nothing read from history has changed.
const MARK = 'echo "H $(git rev-parse -q --verify HEAD)"; echo "S $(git symbolic-ref -q HEAD)"; echo "R $({ git for-each-ref --format="%(objectname) %(refname)"; git config --get-regexp "^branch\\."; } | git hash-object --stdin)"';
// "3 hours ago" goes stale by itself, so the lists are read again after this long anyway.
const HISTORY_AGE = 5 * 60_000;
const DATE = "--date=format:%d %b %Y %H:%M";
const pause = (cx, ms) => new Promise((done) => cx.timer.after(ms, () => done()));
// Writes the commit summary: the prompt goes in on stdin, the summary comes out
// on stdout. The Config dialog's Writer page choice (shared "writer": agent and model) is the
// command used; this one only until a choice exists.
const WRITER = "MAX_THINKING_TOKENS=0 claude -p --model claude-haiku-5-5 --tools='' --disable-slash-commands --setting-sources='' --system-prompt='' --no-session-persistence";
const WRITE_PROMPT = "Reply with only a git commit subject line for the changes below: imperative mood, at most 72 characters, no trailing period, no quotes, no explanation. Follow the style of the recent subjects if there are any.";
// Lock files say nothing and would use up the diff's share of the prompt.
const NO_LOCKS = ["--", ".", ":(exclude)*.lock", ":(exclude)*-lock.json", ":(exclude)*-lock.yaml"];
const PANELS = ["status", "files", "branches", "commits", "stash"];
const CACHE = "mods/git/.cache";
const isMarkdown = (p) => /\.(md|markdown|mdx)$/i.test(p);

function hashOf(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0") + s.length.toString(16);
}

function diffRows(lines) {
  let old = 0, next = 0, inHunk = false;
  return lines.map((line) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) { old = +m[1]; next = +m[2]; inHunk = true; return { kind: "@", text: line }; }
    if (/^(diff --git|commit [0-9a-f]{7,})/.test(line)) inHunk = false;
    const kind = line[0];
    if (inHunk && kind === "-") return { kind, number: old++, text: untab(line.slice(1)) || " " };
    if (inHunk && kind === "+") return { kind, number: next++, text: untab(line.slice(1)) || " " };
    if (inHunk && kind === " ") { old++; return { kind, number: next++, text: untab(line.slice(1)) || " " }; }
    return { kind: "", text: untab(line) || " " };
  });
}

function numstat(text) {
  const out = {};
  for (const entry of text.split("\0")) {
    const [a, d, ...parts] = entry.split("\t");
    if (parts.length) out[parts.join("\t")] = { add: Number(a) || 0, del: Number(d) || 0, binary: a === "-" };
  }
  return out;
}

// The Files panel's rows: every changed file whose path has all the filter's
// words, flat or as a tree. A folder with nothing but one folder in it shares
// its row ("mods/git"); a filter opens every folder.
function fileNodes(files, { tree, collapsed, filter }) {
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = terms.length ? files.filter((f) => { const p = f.path.toLowerCase(); return terms.every((t) => p.includes(t)); }) : files;
  // An untracked nested repo is listed as "dir/".
  const clean = (p) => p.endsWith("/") ? p.slice(0, -1) : p;
  const base = (p) => clean(p).slice(clean(p).lastIndexOf("/") + 1) + (p.endsWith("/") ? "/" : "");
  if (!tree) return shown.map((f) => ({ key: `f:${f.path}`, file: f, depth: 0, name: base(f.path), where: clean(f.path).slice(0, Math.max(0, clean(f.path).lastIndexOf("/"))) }));
  const make = () => ({ dirs: new Map(), files: [], all: [] });
  const root = make();
  for (const f of shown) {
    let at = root;
    for (const part of clean(f.path).split("/").slice(0, -1)) {
      if (!at.dirs.has(part)) at.dirs.set(part, make());
      at = at.dirs.get(part); at.all.push(f);
    }
    at.files.push(f);
  }
  const out = [];
  const walk = (dir, prefix, depth) => {
    for (let [name, d] of [...dir.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      while (d.dirs.size === 1 && !d.files.length) { const [next, only] = [...d.dirs][0]; name += "/" + next; d = only; }
      const path = prefix + name, open = terms.length > 0 || !collapsed.has(path);
      out.push({ key: `d:${path}`, dir: true, path, name, depth, files: d.all, open });
      if (open) walk(d, path + "/", depth + 1);
    }
    for (const f of dir.files) out.push({ key: `f:${f.path}`, file: f, depth, name: base(f.path), where: "" });
  };
  walk(root, "", 0);
  return out;
}
const PREFS = "git.files"; // { tree, wide }, kept in localStorage

// lazygit's default keys, as shown by ?.
const HELP = [
  ["Global", [
    ["q", "quit"], ["esc", "cancel / back"], ["?  x", "keybindings"],
    ["1-5", "jump to panel"], ["h l  ← →  tab", "previous / next panel"], ["0  enter", "focus main view"],
    ["j k  ↑ ↓", "move"], [", .  pgup pgdn", "previous / next page"], ["< >  home end", "top / bottom"],
    ["J K  ctrl-d ctrl-u", "scroll main view"], ["R", "refresh"], ["f", "fetch"], ["p", "pull"], ["P", "push"],
  ]],
  ["Files", [
    ["space", "stage / unstage"], ["a", "stage / unstage all"], ["c", "commit staged changes"], ["C", "commit in Git's editor"], ["A", "amend last commit"],
    ["d", "discard changes to file"], ["D", "discard all changes"], ["s", "stash all changes"], ["S", "stash options"],
    ["e", "edit file"], ["o", "open file"], ["i", "add to .gitignore"], ["t", "markdown: preview / diff"],
    ["`", "tree / flat list"], ["enter", "fold / unfold folder"], ["-  =", "fold / unfold all folders"],
    ["/", "filter by path (esc clears)"], ["+", "Files fills the side bar / all panels"],
  ]],
  ["Branches", [["space", "checkout"], ["n", "new branch"], ["d", "delete branch"]]],
  ["Graph (Status, Branches)", [["enter  0", "go into the graph"], ["j k", "previous / next commit"], ["g  G", "first / last commit"],
    ["enter", "view commit (esc: back to the graph)"], ["/", "find commits (subject, author, hash, branch, tag)"], ["n  N", "next / previous match"],
    ["space", "checkout the commit's branch, or the commit"], ["b", "new branch at the commit"], ["c", "cherry-pick onto the current branch"],
    ["t", "revert"], ["r", "reset the current branch to the commit (soft, mixed, hard)"], ["y", "copy the commit hash"],
    ["m  right-click", "menu of all of these (j k, enter, esc)"], ["space", "on a stash: apply (the menu also pops and drops)"]]],
  ["Commits", [["enter", "view commit"]]],
  ["Stash", [["space", "apply"], ["g", "pop"], ["d", "drop"]]],
  ["Diff selection", [["enter  0", "open file diff"], ["tab", "staged / unstaged"], ["j k  h l", "previous / next hunk"], ["a", "hunk / line selection"], ["v", "extend line range"], ["space", "stage / unstage selection"], ["d", "discard selected unstaged lines"], ["c", "commit staged changes"]]],
  ["Branch views", [["[  ]", "local / remotes / remote branches / tags / worktrees / submodules"], ["/", "filter this view"], ["m  x", "all actions for selected item"], ["M", "merge / squash merge"], ["r", "rebase current branch onto selection"], ["R", "rename branch / remote"], ["u", "set / unset upstream"], ["w", "new worktree"], ["T", "new tag"], ["W", "compare refs"]]],
  ["Commit actions", [["[  ]", "commits / reflog"], ["m  x", "all actions, including reset"], ["C  V", "mark commits / cherry-pick marked commits"], ["t", "revert"], ["g  G", "first / last commit"], ["i", "edit rebase plan from selected commit"], ["r  e  d", "reword / edit / drop in rebase plan"], ["s  f", "squash / fixup into previous commit"], ["F  S", "create fixup from staged changes / autosquash"], ["A", "amend selected commit with staged changes"], ["B", "mark base for branch rebase"], ["b", "bisect good / bad / skip / reset"], ["W", "compare two commits"]]],
  ["Rebase plan", [["j k", "select commit"], ["p r e s f d", "pick / reword / edit / squash / fixup / drop"], ["ctrl-j  ctrl-k", "move commit"], ["cmd-enter", "review and apply plan"], ["esc", "leave plan without changing history"]]],
  ["Conflict resolution", [["M", "whole file: ours / theirs / mark resolved"], ["enter", "open conflicts"], ["j k", "select conflict"], ["o  t  b", "use ours / theirs / both for this conflict"], ["m", "continue / skip / abort current operation"]]],
  ["Repository", [["L", "open upstream Lazygit in this repository"], [":", "run a shell command in a terminal"], ["z  Z", "undo / redo a recorded history action (clean tree required)"], ["More", "force push with lease, pull with rebase, command output"], ["esc", "step back; return from worktree or submodule"]]],
];

// ---------- the mod ----------

// Escape is bound to an action of this mod's own: while a text field has the
// keyboard, Herdr closes the dialog on Escape before any key handler here sees it.
let escapeBound = false;

export default class Git extends GitFeatures {
  init(_props, cx) {
    if (!escapeBound) { cx.bind_keys([{ keystroke: "escape", action: "git-escape", context: "GitMod" }]); escapeBound = true; }
    this.nodes = []; this.collapsed = new Set(); this.filter = ""; this.tree = true; this.wide = true;
    try { const saved = JSON.parse(localStorage.getItem(PREFS) ?? "{}"); this.tree = saved.tree ?? true; this.wide = saved.wide ?? true; } catch {}
    this.files = []; this.branches = []; this.commits = []; this.stashes = []; this.branch = null; this.repo = "";
    this.panel = "files"; this.main = false;
    this.sel = { status: 0, files: 0, branches: 0, commits: 0, stash: 0 };
    this.rows = []; this.cursor = 0; this.diffWidth = 0; this.md = null; this.mdMode = true; this.graph = null; this.peek = null;
    this.prompt = null; this.pending = null; this.help = false; this.message = "";
    this.handle = cx.focus_handle(); this.handle.focus();
    cx.timer.after(150, () => { if (!this.typing) this.handle.focus(); });
    this.scroll = Object.fromEntries(PANELS.map((p) => [p, ScrollHandle.new()]));
    this.diffScroll = VirtualListScrollHandle.new(); this.graphScroll = VirtualListScrollHandle.new(); this.mdScroll = ScrollHandle.new();
    this.input = InputState.new({ placeholder: "" });
    this.input.on("change", (_e, cx) => { this.message = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.initFeatures(cx);
    this.search = InputState.new({ placeholder: "Filter files" });
    this.search.on("change", (_e, cx) => { const v = this.search.value(); if (v !== this.filter) { this.filter = v; this.layoutFiles(); this.reload(cx); } });
    this.search.on("submit", (_e, cx) => { this.handle.focus(); cx.notify(); });
    this.search.on("focus", (_e, cx) => { this.typing = true; this.searching = true; cx.notify(); });
    this.search.on("blur", (_e, cx) => { this.typing = false; this.searching = false; cx.notify(); });
    this.query = ""; this.matches = [];
    this.find = InputState.new({ placeholder: "Find commits" });
    this.find.on("change", (_e, cx) => { const v = this.find.value(); if (v !== this.query) { this.query = v; this.match(); this.nextMatch(0, cx); } });
    this.find.on("submit", (_e, cx) => { this.handle.focus(); cx.notify(); });
    this.find.on("focus", (_e, cx) => { this.typing = true; this.finding = true; cx.notify(); });
    this.find.on("blur", (_e, cx) => { this.typing = false; this.finding = false; cx.notify(); });
    // Opened on this repo before: show what it had, then check it.
    this.location = _props?.folder ? {cwd: _props.folder, on: _props.on ?? null} : location();
    if (checking()) return;
    cx.timer.every(10000, (cx) => { if (!this.busy && !this.closed) this.refresh(cx); });
    const { cwd, on } = this.location;
    this.repoKey = ROOTS.get(`${on ?? ""}:${cwd}`) ?? null;
    const snap = REPOS.get(this.repoKey)?.snap;
    if (snap) { Object.assign(this, snap); this.layoutFiles(null); this.reload(cx); }
    this.refresh(cx);
  }

  // The graph rows the find words all appear in: subject, author, hash, branch or tag.
  match() {
    const terms = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    this.matches = !terms.length || !this.graph ? [] : this.graph.rows.flatMap((row, n) => {
      const cm = row.commit, text = [cm.subject, cm.who, cm.hash, ...cm.refs.flatMap((r) => [r.name, ...r.remotes.map((o) => `${o}/${r.name}`)])].join("\n").toLowerCase();
      return terms.every((t) => text.includes(t)) ? [n] : [];
    });
  }
  // by 0: the match at or after the cursor; 1 / -1: the one after / before it, around the ends.
  nextMatch(by, cx) {
    const m = this.matches;
    if (m.length) {
      const to = by > 0 ? m.find((n) => n > this.cursor) ?? m[0] : by < 0 ? [...m].reverse().find((n) => n < this.cursor) ?? m[m.length - 1] : m.find((n) => n >= this.cursor) ?? m[0];
      this.cursor = to; this.graphScroll.scroll_to_item(to, "center");
    }
    cx.notify();
  }
  startFind(cx) { this.main = true; this.findOpen = true; this.find.focus(); cx.notify(); }
  clearFind(cx) { this.findOpen = false; this.query = ""; this.matches = []; this.find.set_value(""); this.handle.focus(); cx.notify(); }

  // Rebuilds the Files rows, keeping the selection on the same file or folder.
  layoutFiles(keep = this.item("files")?.key) {
    this.nodes = fileNodes(this.files, this);
    const at = this.nodes.findIndex((n) => n.key === keep);
    this.sel.files = Math.max(0, Math.min(at >= 0 ? at : this.sel.files, this.nodes.length - 1));
  }
  savePrefs() { try { localStorage.setItem(PREFS, JSON.stringify({ tree: this.tree, wide: this.wide })); } catch {} }
  setTree(tree, cx) { this.tree = tree; this.savePrefs(); this.layoutFiles(); this.reload(cx); }
  setWide(wide, cx) { this.wide = wide; this.savePrefs(); cx.notify(); }
  fold(node, cx) {
    if (!node?.dir || this.filter.trim()) return;
    if (node.open) this.collapsed.add(node.path); else this.collapsed.delete(node.path);
    this.layoutFiles(node.key); cx.notify();
  }
  foldAll(closed, cx) {
    this.collapsed = new Set(closed ? fileNodes(this.files, { tree: true, collapsed: new Set(), filter: "" }).filter((n) => n.dir).map((n) => n.path) : []);
    this.layoutFiles(); this.reload(cx);
  }
  startSearch(cx) { this.panel = "files"; this.main = false; this.searchOpen = true; this.search.focus(); cx.notify(); }
  clearSearch(cx) {
    this.searchOpen = false; this.filter = ""; this.search.set_value(""); this.handle.focus();
    this.layoutFiles(); this.reload(cx);
  }

  git(args, opts = {}) { return exec("git", [...READ, ...args], { cwd: this.root, on: this.on, ...opts }); }
  // Bound bytes outside the script heap, then cap visible lines.
  async top(args, max) {
    const cut = (text) => text.replace(/\n$/, "").split("\n").slice(0, max);
    const p = await this.boundedGit(args);
    const raw = p.code === 0 ? p.stdout : p.stderr, clipped = cut(raw);
    if (p.truncated || raw.split("\n").length > max) clipped.push("[Preview truncated — open Lazygit for the complete diff]");
    return { ok: p.code === 0, lines: clipped };
  }
  // HEAD and the refs' hash (MARK). No hash where sh is missing: nothing is kept then.
  async mark() {
    const r = await exec("sh", ["-c", MARK], { cwd: this.root, on: this.on }).catch(() => null);
    const line = (c) => r?.stdout.split("\n").find((l) => l.startsWith(`${c} `))?.slice(2).trim() || null;
    if (line("R")) return { head: line("H"), refs: `${line("H")} ${line("S")} ${line("R")}` };
    const head = await this.git(["rev-parse", "--verify", "-q", "HEAD"]);
    return { head: head.code === 0 ? head.stdout.trim() : null, refs: null };
  }
  list(p = this.panel) { return { status: [this.branch].filter(Boolean), files: this.nodes, branches: this.branchItems(), commits: this.commitItems(), stash: this.stashItems() }[p] ?? []; }
  item(p = this.panel) { const l = this.list(p); return l[Math.min(this.sel[p], l.length - 1)] ?? null; }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      // A burst of saves (a checkout, an agent writing) is one refresh.
      try { while (this.watched === root && !this.closed) { this.watchTask = watchFolder(root); await this.watchTask; if (this.watched === root && !this.due && !this.busy && !this.closed) this.due = cx.timer.after(150, (cx) => { this.due = null; this.refresh(cx); }); } }
      catch { this.watched = null; }
    });
  }

  // force: read history again even though no ref moved (R, and after an action).
  refresh(cx, force = false) {
    if (this.loading) { this.again = true; this.forceAgain ||= force; return; }
    if (checking() || this.closed) return;
    const { cwd, on } = this.location;
    if (!cwd) { this.error = "No folder"; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (top.code !== 0) { this.root = null; this.repoKey = null; this.files = []; this.nodes = []; this.branches = []; this.commits = []; this.stashes = []; this.branch = null; this.error = "Not a git repository"; return; }
        this.root = top.stdout.trim(); this.on = on; this.repo = this.root.split("/").pop();
        this.repoKey = `${on ?? ""}:${this.root}`;
        keep(ROOTS, `${on ?? ""}:${cwd}`, this.repoKey, 64);
        const repo = keep(REPOS, this.repoKey, REPOS.get(this.repoKey) ?? { graphs: new Map() }, 8);
        const [status, cached, work, stash, mark] = await Promise.all([
          this.boundedGit(["status", "--porcelain=v1", "-z", "-b", "--no-renames", "--untracked-files=all"]),
          this.boundedGit(["diff", "--cached", "--numstat", "-z", "--no-renames"]),
          this.boundedGit(["diff", "--numstat", "-z", "--no-renames"]),
          // With its commit and the one it was made on: the graph hangs it there.
          // No %gd: with a date format it prints stash@{<date>}, so the ref is counted.
          this.boundedGit(["stash", "list", "-n", "300", "--format=%cr%x1f%gs%x1f%H%x1f%P%x1f%an%x1f%cd", DATE]),
          this.mark(),
        ]);
        if (status.code !== 0) throw new Error(status.stderr.trim());
        this.hasHead = Boolean(mark.head); this.head = mark.head;
        const sStats = numstat(cached.stdout), wStats = numstat(work.stdout);
        const entries = status.stdout.split("\0").filter(Boolean);
        this.filesLimited = status.truncated || entries.length > 2001;
        const b = entries[0]?.startsWith("## ") ? entries.shift().slice(3) : "";
        const m = /^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(b) ?? [];
        this.branch = { name: m[1] ?? "?", upstream: m[2] ?? null,
          ahead: Number(/ahead (\d+)/.exec(m[3] ?? "")?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(m[3] ?? "")?.[1] ?? 0) };
        const keepAt = this.item("files")?.key;
        this.files = entries.slice(0, 2000).map((e) => {
          const x = e[0], y = e[1], path = e.slice(3), s = sStats[path], w = wStats[path];
          return { path, x, y, fresh: x === "?", staged: x !== " " && x !== "?", unstaged: y !== " ",
            conflict: x === "U" || y === "U" || (x === y && (x === "A" || x === "D")),
            add: (s?.add ?? 0) + (w?.add ?? 0), del: (s?.del ?? 0) + (w?.del ?? 0), binary: s?.binary || w?.binary };
        });
        this.layoutFiles(keepAt);
        this.stashes = stash.stdout.split("\n").filter(Boolean).map((l, n) => { const [when, subject, hash, parents, who, date] = l.split("\x1f"); return { ref: `stash@{${n}}`, when, subject, hash, base: (parents ?? "").split(" ")[0], who, date }; });
        // Branches and commits come from history: read only when a ref moved.
        let hist = repo.hist;
        if (force || !mark.refs || hist?.refs !== mark.refs || hist?.page !== this.commitPage || Date.now() - hist.at > HISTORY_AGE) {
          const [refs, log, ahead] = await Promise.all([
            this.boundedGit(["for-each-ref", "--count=1000", "--sort=-committerdate", "refs/heads", "--format=%(HEAD)%1f%(refname:short)%1f%(committerdate:relative)%1f%(upstream:track,nobracket)"]),
            this.boundedGit(["log", "--skip", String(this.commitPage*300), "-n", "301", "--pretty=format:%H%x1f%s%x1f%an%x1f%cr"]),
            this.git(["rev-list", "-n", "300", "@{upstream}..HEAD"]),
          ]);
          const local = new Set(ahead.code === 0 ? ahead.stdout.split("\n").filter(Boolean) : []);
          if (force || hist?.refs !== mark.refs) repo.graphs.clear();
          hist = repo.hist = { refs: mark.refs, at: Date.now(), page:this.commitPage, more:log.stdout.split("\n").filter(Boolean).length>300,
            branches: refs.stdout.split("\n").filter(Boolean).map((l) => { const [h, name, when, track] = l.split("\x1f"); return { current: h === "*", name, when, track }; }),
            commits: this.hasHead && log.code === 0 ? log.stdout.split("\n").filter(Boolean).slice(0,300).map((l) => {
              const [hash, subject, who, when] = l.split("\x1f");
              return { hash, subject, who, when, unpushed: !this.branch.upstream || local.has(hash) };
            }) : [] };
        }
        this.branches = hist.branches; this.commits = hist.commits; this.moreCommits = hist.more;
        await this.refreshFeatures();
        for (const p of PANELS) this.sel[p] = Math.max(0, Math.min(this.sel[p], this.list(p).length - 1));
        this.error = null; this.stale = true;
        repo.snap = { root: this.root, on: this.on, repo: this.repo, files: this.files, branches: this.branches, commits: this.commits,
          stashes: this.stashes, branch: this.branch, hasHead: this.hasHead, head: this.head };
        this.watch(this.root, cx);
        await this.load(cx);
      } catch (e) { this.error = String(e?.message ?? e); }
      finally {
        this.loading = false; cx.notify();
        if (this.again) { const f = this.forceAgain; this.again = false; this.forceAgain = false; this.refresh(cx, f); }
      }
    });
  }

  // ---------- main view ----------

  source() {
    const p = this.panel, it = this.item(p);
    const feature = this.featureSource(); if (feature) return feature;
    const patch = (hash) => ["show", "--no-color", "--no-ext-diff", "--stat", "--patch", "--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n    %s%n%n%b", hash];
    // keep: the commit a patch is of; its lines are kept under it (PATCHES).
    // A commit opened from the graph.
    if (this.peek?.stash) return { key: `s:${this.peek.stash}`, title: "Stash", keep: this.peek.hash, args: ["stash", "show", "-p", "--no-color", "--include-untracked", this.peek.stash] };
    if (this.peek) return { key: `c:${this.peek.hash}`, title: "Patch", subject: this.peek.subject, hash: this.peek.hash.slice(0, 7), keep: this.peek.hash, args: patch(this.peek.hash) };
    if (p === "status") return { key: "status", title: "Graph", graph: ["--branches", "--remotes", "--tags", "HEAD"] };
    if (!it) return null;
    if (p === "files") {
      if (it.dir) return { key: `d:${it.path}`, title: `${it.name}/`, args: ["diff", this.hasHead ? "HEAD" : "--cached", "--no-ext-diff", "--no-color", "--stat", "--patch", "--", it.path] };
      const f = it.file;
      if (isMarkdown(f.path) && this.mdMode && !f.conflict && f.x !== "D" && f.y !== "D") return { key: `md:${f.path}`, title: "Preview", file: f, markdown: true };
      const side = this.diffSide ?? (f.unstaged || f.fresh ? "unstaged" : "staged");
      return { key: `f:${side}:${f.path}`, title: f.conflict ? "Resolve conflicts" : `${side} changes`, file: f };
    }
    if (p === "branches") return { key: `b:${it.name}`, title: it.name, graph: [it.name] };
    if (p === "commits") return { key: `c:${it.hash}`, title: "Patch", subject: it.subject, hash: it.hash.slice(0, 7), keep: it.hash, args: patch(it.hash) };
    if (p === "stash") return { key: `s:${it.ref}`, title: "Stash", keep: it.hash, args: ["stash", "show", "-p", "--no-color", "--include-untracked", it.ref] };
  }

  async load(cx) {
    const src = this.source();
    if (!src) { this.setLines([]); this.md = null; this.graph = null; this.shown = null; this.patch = null; this.conflicts = null; this.diffFile = null; this.historyPatch = null; return; }
    if (src.key === this.shown && !this.stale) return;
    let lines = null, md = null, graph = null, filePatch = null, historyPatch = null;
    const repoKey = this.repoKey;
    // A held j or k asks for every row on the way: while one is being read,
    // the next waits a moment and is dropped if the selection has moved on.
    if (this.reading) { await pause(cx, 70); if (this.source()?.key !== src.key) return; }
    this.reading = (this.reading ?? 0) + 1;
    try {
      if (src.text) lines = src.text;
      else if (src.markdown) md = await this.markdown(`${this.root}/${src.file.path}`);
      else if (src.file) {
        filePatch = await this.readFilePatch(src.file); lines = filePatch.lines;
      } else if (src.custom) {
        const r = await this.boundedGit(src.args);
        if (r.code !== 0) throw new Error(r.stderr || r.stdout);
        lines = r.stdout.replace(/\n$/, "").split("\n");
        historyPatch = {patch: r.truncated || lines.length > 4000 ? null : parsePatch(r.stdout), ref:src.ref, path:src.path};
      } else if (src.graph) {
        if (!this.hasHead) graph = layout([]);
        else {
          // The commits are kept until a ref moves; the graph drawn from them
          // until a stash, HEAD or having uncommitted changes does (`with`).
          const repo = REPOS.get(this.repoKey), refs = repo?.hist?.refs, name = src.graph.join(" ");
          let kept = refs ? recall(repo.graphs, name) : null;
          if (kept?.refs !== refs) kept = null;
          if (!kept) {
            // No --date-order: dateOrder() sorts what git streams.
            const r = await this.boundedGit(["log", "--decorate=full", "-n", "400", `--format=${GRAPH_FORMAT}`, DATE, ...src.graph, "--"]);
            if (r.code !== 0) lines = r.stderr.replace(/\n$/, "").split("\n");
            else { kept = { refs, commits: dateOrder(parseLog(r.stdout)) }; if (refs && repo.hist?.refs === refs) keep(repo.graphs, name, kept, 12); }
          }
          if (kept) {
            const wip = this.files.length > 0;
            const made = `${this.head} ${wip ? this.files.length : ""} ${this.stashes.map((st) => st.hash).join(" ")}`;
            if (kept.with !== made) {
              const commits = [...kept.commits];
              // A stash hangs off the commit it was made on, newest on top.
              for (const st of this.stashes) {
                const at = commits.findIndex((cm) => cm.hash === st.base);
                if (at >= 0) commits.splice(at, 0, { hash: st.hash, parents: [st.base], refs: [{ kind: "stash", name: st.ref, remotes: [] }], stash: st.ref,
                  subject: (st.subject ?? "Stash").replace(/^(WIP on|On) [^:]+: /, ""), who: st.who, when: st.date });
              }
              // What isn't committed yet sits on top of HEAD, as in Git Graph.
              if (wip && commits.some((cm) => cm.hash === this.head))
                commits.unshift({ hash: UNCOMMITTED, parents: [this.head], refs: [], subject: `Uncommitted changes (${this.files.length})`, who: "*", when: "" });
              kept.graph = layout(commits); kept.with = made;
            }
            graph = kept.graph;
          }
        }
      } else {
        const at = src.keep ? `${this.repoKey}\n${src.keep}` : null;
        lines = at ? recall(PATCHES, at) ?? null : null;
        if (!lines) {
          const r = await this.top(src.args, 4000);
          lines = r.lines.map((l) => l.length > 4000 ? l.slice(0, 4000) + "…" : l);
          if (at && r.ok && lines.reduce((n, l) => n + l.length, 0) < 1_000_000) keep(PATCHES, at, lines, 48);
        }
      }
    } catch (e) { lines = [`Cannot show this: ${e?.message ?? e}`]; }
    finally { this.reading--; }
    if (this.repoKey !== repoKey || this.source()?.key !== src.key || this.closed) return;
    const fresh = src.key !== this.shown;
    this.shown = src.key; this.stale = false; this.md = md; this.graph = graph;
    if (filePatch) this.setFilePatch(filePatch); else { this.patch = null; this.conflicts = null; this.diffFile = null; }
    this.historyPatch = historyPatch;
    if (graph) {
      this.setLines([]);
      // Back from a commit: the cursor returns to it.
      if (fresh) { this.cursor = this.graphAt ?? 0; this.graphAt = null; }
      this.cursor = Math.max(0, Math.min(this.cursor, graph.rows.length - 1));
      if (fresh) this.graphScroll.scroll_to_item(this.cursor, "center");
      this.match();
    } else if (lines) {
      this.setLines(lines.slice(0, 4000).map((l) => l.length > 4000 ? l.slice(0, 4000) + "…" : l));
      if (filePatch && lines.length > 4000) { this.patch = null; this.patchTruncated = true; }
      if (fresh) { this.cursor = this.activePatch()?.hunks[0]?.row ?? 0; this.conflictAt = 0; this.diffScroll.scroll_to_item(this.cursor); }
      this.cursor = Math.max(0, Math.min(this.cursor, this.rows.length - 1));
      if (this.patch?.hunks.length && !this.patch.hunks.some(h => this.cursor >= h.row && this.cursor <= (h.lines.at(-1)?.row ?? h.row))) this.cursor = this.patch.hunks[0].row;
    }
    else { this.setLines([]); if (fresh) this.mdScroll.scroll_to_item(0); }
  }

  // Markdown segments: text, or Mermaid diagrams as SVGs in the hidden cache.
  async markdown(file) {
    const text = await readTextFile(file, { on: this.on });
    const t = theme(), dir = `${appHome()}/${CACHE}`;
    await fs.mkdir(dir, { recursive: true });
    const out = [];
    for (const seg of splitMermaid(text.slice(0, 500000))) {
      if (seg.kind === "md") { if (seg.text.trim()) out.push(seg); continue; }
      const r = renderMermaid(seg.text, t, "Helvetica Neue, Helvetica, Arial, sans-serif");
      if (r.error) { out.push({ kind: "error", text: r.error }); continue; }
      const name = `${hashOf(r.svg)}.svg`;
      if (!(await fs.exists(`${dir}/${name}`))) await fs.writeFile(`${dir}/${name}`, r.svg);
      const scale = Math.min(1, 880 / r.width);
      out.push({ kind: "diagram", src: `${CACHE}/${name}`, w: r.width * scale, h: r.height * scale });
    }
    return out;
  }

  setLines(lines) {
    this.rows = diffRows(lines);
    this.diffWidth = Math.max(300, ...this.rows.map((r) => (r.text.length + 1) * 7.5 + 90));
  }

  reload(cx) { this.stale = true; cx.spawn(async (cx) => { await this.load(cx); cx.notify(); }); cx.notify(); }

  // ---------- navigation ----------

  move(to, cx) {
    this.pending = null;
    if (this.main) return this.scrollMain(to - this.cursor, cx);
    this.peek = null;
    this.diffSide = null; this.anchor = null;
    const n = this.list().length;
    if (!n) return;
    this.sel[this.panel] = Math.max(0, Math.min(to, n - 1));
    this.scroll[this.panel].scroll_to_item(this.sel[this.panel]);
    cx.spawn(async (cx) => { await this.load(cx); cx.notify(); });
    cx.notify();
  }

  scrollMain(by, cx) {
    if (this.graph) {
      if (!this.graph.rows.length) return;
      this.cursor = Math.max(0, Math.min(this.cursor + by, this.graph.rows.length - 1));
      this.graphScroll.scroll_to_item(this.cursor);
      cx.notify(); return;
    }
    if (this.md) {
      this.mdAt = Math.max(0, Math.min((this.mdAt ?? 0) + Math.sign(by), this.md.length - 1));
      this.mdScroll.scroll_to_item(this.mdAt); cx.notify(); return;
    }
    if (!this.rows.length) return;
    this.cursor = Math.max(0, Math.min(this.cursor + by, this.rows.length - 1));
    this.diffScroll.scroll_to_item(this.cursor, "center");
    cx.notify();
  }

  goto(panel, cx) {
    this.panel = panel; this.main = false; this.pending = null; this.help = false; this.peek = null;
    this.panelSearchOpen = false; this.diffSide = null; this.logOpen = false; this.detail = null; this.historyPatch = null;
    this.reload(cx);
  }
  // Enter in the graph: the commit's patch (esc comes back), or the Files
  // panel for the uncommitted row.
  openCommit(cx) {
    const cm = this.graph?.rows[this.cursor]?.commit;
    if (!cm) return;
    if (cm.hash === UNCOMMITTED) return this.goto("files", cx);
    this.graphAt = this.cursor; this.peek = { hash: cm.hash, subject: cm.subject, stash: cm.stash };
    this.reload(cx);
  }
  closeCommit(cx) { this.peek = null; this.reload(cx); }

  // Git Graph's commit actions, on the graph's selected row: a commit, a
  // stash, or the uncommitted changes.
  graphKeys(cx) {
    const cm = this.graph.rows[this.cursor]?.commit, wip = cm?.hash === UNCOMMITTED, stash = cm?.stash;
    const real = cm && !wip && !stash ? cm : null, short = cm?.hash.slice(0, 7), on = this.branch?.name ?? "HEAD";
    const checkout = () => {
      if (stash) return this.act("Apply stash", [["stash", "apply", stash]], cx, { done: `Applied ${stash}` });
      if (!real) return;
      const heads = real.refs.filter((r) => r.kind === "head" && r.name !== "HEAD"), remote = real.refs.find((r) => r.kind === "remote");
      const branch = heads.find((r) => !r.current)?.name ?? (heads.length ? null : remote ? remote.name.slice(remote.name.indexOf("/") + 1) : null);
      if (branch) return this.act("Checkout", [["checkout", branch]], cx, { done: `Switched to ${branch}` });
      if (heads.length) { this.info = `Already on ${heads[0].name}`; this.note = null; return cx.notify(); }
      this.ask("Checkout commit", `Check out ${short} "${real.subject}"? No branch points at it, so HEAD will be detached.`, (cx) => this.act("Checkout", [["checkout", real.hash]], cx, { done: `Checked out ${short}` }), cx);
    };
    const reset = (mode, what) => this.ask(`Reset ${on} (${mode})`, `Move ${on} to ${short} "${real.subject}"? ${what}`,
      (cx) => this.act("Reset", [["reset", `--${mode}`, real.hash]], cx, { done: `Reset ${on} to ${short}` }), cx);
    const resetMenu = (at) => real && this.openMenu({ ...at, title: `Reset ${on} to ${short}`, items: [
      { label: "Soft", hint: "keep changes staged", run: () => reset("soft", "The commits after it become staged changes.") },
      { label: "Mixed", hint: "keep changes unstaged", run: () => reset("mixed", "The commits after it become unstaged changes.") },
      { label: "Hard", hint: "discard changes", danger: true, run: () => reset("hard", "The commits after it AND all uncommitted changes are discarded.") },
    ] }, cx);
    const keys = {
      g: () => this.move(0, cx), G: () => this.move(this.graph.rows.length - 1, cx),
      "/": () => this.startFind(cx), n: () => this.nextMatch(1, cx), N: () => this.nextMatch(-1, cx),
      " ": checkout, space: checkout,
      b: () => { if (real) { this.ask2("branch", `New branch at ${short}`, cx); this.prompt.at = real.hash; } },
      c: () => real && this.ask("Cherry-pick", `Cherry-pick ${short} "${real.subject}" onto ${on}?`, (cx) => this.act("Cherry-pick", [["cherry-pick", real.hash]], cx, { done: `Cherry-picked ${short}` }), cx),
      t: () => real && this.ask("Revert commit", `Revert ${short} "${real.subject}" with a new commit?`, (cx) => this.act("Revert", [["revert", "--no-edit", real.hash]], cx, { done: `Reverted ${short}` }), cx),
      r: () => resetMenu({}),
      y: () => { if (cm && !wip) { cx.write_to_clipboard(cm.hash); this.info = `Copied ${short}`; this.note = null; cx.notify(); } },
    };
    // The same actions as a menu: right-click (at the pointer) or m (centered).
    keys.menu = (at = {}) => {
      if (!cm) return;
      const item = (label, hint, run, danger) => ({ label, hint, run, danger });
      const items = wip ? [
        item("Go to Files", "enter", (cx) => this.goto("files", cx)),
        item("Stash changes…", "", (cx) => this.stashMenu(cx)),
      ] : stash ? [
        item("View stash", "enter", (cx) => this.openCommit(cx)),
        item("Apply", "space", (cx) => this.stashAction("apply", {ref:stash,hash:cm.hash}, cx)),
        item("Pop…", "", (cx) => this.ask("Pop stash", `Pop ${stash}?`, (cx) => this.stashAction("pop", {ref:stash,hash:cm.hash}, cx), cx)),
        item("Drop…", "", (cx) => this.ask("Drop stash", `Drop ${stash}?`, (cx) => this.stashAction("drop", {ref:stash,hash:cm.hash}, cx), cx), true),
        item("Copy hash", "y", (cx) => cx.write_to_clipboard(cm.hash)),
      ] : [
        item("View commit", "enter", (cx) => this.openCommit(cx)),
        item("Checkout branch / commit", "space", (cx) => this.graphKeys(cx).space()),
        item("Cherry-pick…", "c", (cx) => this.graphKeys(cx).c()),
        ...this.commitActions(cm, cx).filter(Boolean).map(([label,hint,run,danger]) => item(label,hint,run,danger)),
      ];
      this.openMenu({ ...at, title: wip ? "Uncommitted changes" : `${short}  ${cm.subject}`, items }, cx);
    };
    keys.m = () => keys.menu();
    return keys;
  }

  // A small menu inside the dialog: { x, y (absent: centered), title, items }.
  openMenu(menu, cx) { this.menu = { sel: 0, ...menu }; cx.notify(); }
  pickMenu(n, cx) { const it = this.menu?.items[n]; this.menu = null; cx.notify(); it?.run(cx); }
  step(by, cx) { this.goto(PANELS[(PANELS.indexOf(this.panel) + by + PANELS.length) % PANELS.length], cx); }

  // ---------- actions ----------

  act(label, steps, cx, opts = {}) {
    this.perform(label, steps, cx, opts);
  }

  ask(title, text, then, cx) { this.pending = { title, text, then }; cx.notify(); }

  ask2(kind, title, cx) {
    this.prompt = { kind, title }; this.message = ""; this.input.set_value(""); this.writeError = null;
    if (kind === "commit") { this.message = this.commitDraft ?? ""; this.input.set_value(this.message); }
    this.input.focus(); cx.notify();
  }

  submit(cx) {
    const msg = this.message.trim(), p = this.prompt;
    if (!p) return;
    if (this.busy) return;
    if (p.kind === "value") {
      if (!msg && !p.empty) return;
      this.prompt = null; this.handle.focus(); p.submit(msg, cx); cx.notify(); return;
    }
    const clear = () => { this.prompt = null; this.message = ""; this.input.set_value(""); this.handle.focus(); };
    if (p.kind === "commit") {
      if (!msg) return this.generate(cx); // Enter on an empty summary writes one
      const commit = (cx) => this.act("Commit", [["commit", "-m", msg, ...(this.commitBody?.trim() ? ["-m", this.commitBody.trim()] : [])]], cx, { done: "Committed", after: () => { this.commitDraft = ""; this.commitBody = ""; this.bodyInput.set_value(""); } });
      this.commitDraft = msg;
      if (!this.files.some((f) => f.staged)) { this.note = "Stage the changes to include before committing"; cx.notify(); return; }
      commit(cx);
    } else if (p.kind === "stash") this.act("Stash", [["stash", "push", "--include-untracked", ...(msg ? ["-m", msg] : [])]], cx, { done: "Stashed" });
    else if (p.kind === "stash-staged") this.act("Stash", [["stash", "push", "--staged", ...(msg ? ["-m", msg] : [])]], cx, { done: "Stashed staged changes" });
    else if (p.kind === "branch") { if (!msg) return; this.act("New branch", [["checkout", "-b", msg, ...(p.at ? [p.at] : [])]], cx, { done: `Switched to ${msg}` }); }
    clear(); cx.notify();
  }

  // Fills the commit summary from staged changes. The person reads it,
  // then explicitly commits.
  generate(cx) {
    if (shared("curtain")?.on) return; // the curtain (mods/curtain) is drawn: no Writer
    const p = this.prompt;
    if (p?.kind !== "commit" || this.writing || !this.root) return;
    const root = this.root, on = this.on;
    if (!this.files.some((f) => f.staged)) { this.writeError = "Stage changes before writing a commit summary"; cx.notify(); return; }
    const current = () => this.prompt === p && this.root === root;
    this.writing = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        const [stat, diff, log] = await Promise.all([
          this.git(["diff", "--cached", "--stat"]),
          this.boundedGit(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", ...NO_LOCKS], 28000),
          this.hasHead ? this.git(["log", "-8", "--format=%s"]) : { stdout: "" },
        ]);
        if (stat.code !== 0) throw new Error(stat.stderr.trim());
        const prompt = [WRITE_PROMPT, `Recent subjects:\n${log.stdout.trim() || "(none)"}`, `Files:\n${stat.stdout.slice(0, 4000)}`,
          `Diff:\n${diff.stdout.slice(0, 24000)}`].join("\n\n");
        const r = await exec("sh", ["-c", `printf %s "$1" | ${shared("writer")?.command || WRITER}`, "sh", prompt], { cwd: root, on, timeout: 90_000 });
        // The last line: an agent's own notices come before its answer.
        const line = r.stdout.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("```")).pop() ?? "";
        const message = line.replace(/^["'`]+|["'`]+$/g, "");
        if (r.code !== 0 || !message) throw new Error((r.stderr || r.stdout).trim().split("\n").pop() || "no reply");
        // Typed meanwhile, or the prompt is gone: theirs stays.
        if (current() && !this.message.trim()) { this.message = message; this.input.set_value(message); }
      } catch (e) { if (current()) this.writeError = `Could not write a summary: ${e?.message ?? e}`; }
      finally { this.writing = false; cx.notify(); }
    });
    this.writeError = null; cx.notify();
  }

  cancelPrompt(cx) { if (this.prompt?.kind === "commit") this.commitDraft = this.message; this.prompt = null; this.message = ""; this.input.set_value(""); this.handle.focus(); cx.notify(); }

  // A file, or everything shown under a folder.
  toggleFile(node, cx) {
    if (!node) return;
    if (node.dir) {
      const paths = this.filter.trim() ? node.files.map((f) => f.path) : [node.path];
      if (node.files.some((f) => f.unstaged || f.fresh)) return this.act("Stage", [["add", "-A", "--", ...paths]], cx);
      return this.act("Unstage", [this.hasHead ? ["restore", "--staged", "--", ...paths] : ["rm", "-r", "--cached", "-q", "--", ...paths]], cx);
    }
    const f = node.file;
    if (f.unstaged || f.fresh) this.act("Stage", [["add", "-A", "--", f.path]], cx);
    else this.act("Unstage", [this.hasHead ? ["restore", "--staged", "--", f.path] : ["rm", "--cached", "-q", "--", f.path]], cx);
  }

  toggleAll(cx) {
    if (this.files.some((f) => f.unstaged || f.fresh)) this.act("Stage all", [["add", "-A"]], cx);
    else if (this.files.length) this.act("Unstage all", [this.hasHead ? ["reset", "-q"] : ["rm", "-r", "--cached", "-q", "."]], cx);
  }

  discard(f, cx) {
    if (!f) return;
    const steps = f.fresh ? [["clean", "-f", "-q", "--", f.path]]
      : f.x === "A" ? [["rm", "-f", "-q", "--", f.path]]
      : !this.hasHead ? [["restore", "--", f.path]]
      : [["restore", "--source=HEAD", "--staged", "--worktree", "--", f.path]];
    this.ask("Discard changes", `Discard all changes to ${f.path}?`, (cx) => this.act("Discard", steps, cx, { done: `Discarded ${f.path}` }), cx);
  }

  push(cx) { this.act("Push", this.branch?.upstream ? [["push"]] : [["push", "-u", "origin", "HEAD"]], cx, { network: true, done: "Pushed" }); }

  close() { this.closed = true; this.watched = null; this.watchTask?.cancel(); const o = props()?.overlay; if (o) closeOverlay(o); }

  keys(e, cx) {
    if (this.typing) {
      if ((e.modifiers?.platform || e.modifiers?.control) && e.key === "enter") { this.submit(cx); return cx.stop_propagation(); }
      // Escape steps back out of the field only: the prompt or search stays, with its text.
      if (e.key === "escape") { this.typing = false; this.searching = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
      return;
    }
    if (this.prompt) {
      // Stepped back out of the prompt's field: Escape closes the prompt, i or tab goes back in.
      const ch = e.key_char ?? e.key;
      if (e.key === "escape") this.cancelPrompt(cx);
      else if (e.key === "enter") this.submit(cx);
      else if (ch === "i" || e.key === "tab") { this.input.focus(); cx.notify(); }
      return cx.stop_propagation();
    }
    const m = e.modifiers, k = e.key, ch = e.key_char ?? (m.shift ? k.toUpperCase() : k);
    const done = () => cx.stop_propagation();

    if (this.pending) {
      if (k === "enter" || ch === "y") { const p = this.pending; this.pending = null; p.then(cx); }
      else if (k === "escape" || ch === "n" || ch === "q") { this.pending = null; cx.notify(); }
      return done();
    }
    if (this.menu) {
      const mn = this.menu, last = mn.items.length - 1;
      if (k === "escape" || ch === "q") this.menu = null;
      else if (ch === "j" || k === "down") mn.sel = Math.min(mn.sel + 1, last);
      else if (ch === "k" || k === "up") mn.sel = Math.max(mn.sel - 1, 0);
      else if (ch === "g") mn.sel = 0; else if (ch === "G") mn.sel = last;
      else if (k === "enter" || k === "space" || ch === " ") return this.pickMenu(mn.sel, cx), done();
      this.menuScroll.scroll_to_item(mn.sel); cx.notify(); return done();
    }
    if (this.help) { if (k === "escape" || ch === "?" || ch === "q" || ch === "x") { this.help = false; cx.notify(); } return done(); }
    if (this.featureKeys(e,cx)) return done();
    if (m.platform || m.alt) return;
    if (m.control) {
      if (k === "d") this.scrollMain(PAGE, cx); else if (k === "u") this.scrollMain(-PAGE, cx); else return;
      return done();
    }

    const n = this.main ? (this.graph ? this.graph.rows.length : this.rows.length) : this.list().length, i = this.main ? this.cursor : this.sel[this.panel];
    const it = this.item(), file = this.panel === "files" ? it?.file : null;
    const pickFile = () => { this.note = "Select a file"; cx.notify(); };
    const global = {
      j: () => this.move(i + 1, cx), k: () => this.move(i - 1, cx),
      ".": () => this.move(i + PAGE, cx), ",": () => this.move(i - PAGE, cx),
      ">": () => this.move(n - 1, cx), "<": () => this.move(0, cx), g: () => this.move(0, cx), G: () => this.move(n - 1, cx),
      J: () => this.scrollMain(3, cx), K: () => this.scrollMain(-3, cx),
      "?": () => { this.help = true; cx.notify(); }, x: () => { this.help = true; cx.notify(); },
      q: () => this.close(), R: () => this.refresh(cx, true),
      f: () => this.act("Fetch", [["fetch", "--prune"]], cx, { network: true, done: "Fetched" }),
      p: () => this.act("Pull", [["pull", "--ff-only"]], cx, { network: true, done: "Pulled" }),
      P: () => this.push(cx),
      1: () => this.goto("status", cx), 2: () => this.goto("files", cx), 3: () => this.goto("branches", cx),
      4: () => this.goto("commits", cx), 5: () => this.goto("stash", cx),
      0: () => { this.main = true; cx.notify(); },
      h: () => this.step(-1, cx), l: () => this.step(1, cx), "[": () => this.step(-1, cx), "]": () => this.step(1, cx),
    };
    const named = {
      down: global.j, up: global.k, pagedown: global["."], pageup: global[","], home: global["<"], end: global[">"],
      left: global.h, right: global.l, tab: global.l,
      escape: () => { if (this.peek) this.closeCommit(cx); else if (this.main && this.graph && (this.query || this.findOpen)) this.clearFind(cx); else if (this.main) { this.main = false; cx.notify(); } else if (this.filter || this.searchOpen) this.clearSearch(cx); else this.close(); },
      enter: () => { if (this.main) this.openCommit(cx); else { this.main = true; cx.notify(); } },
    };
    const panel = {
      files: {
        " ": () => this.toggleFile(it, cx), space: () => this.toggleFile(it, cx), a: () => this.toggleAll(cx),
        c: () => this.files.length ? this.ask2("commit", "Commit summary", cx) : (this.note = "Nothing to commit", cx.notify()),
        C: () => this.files.length ? this.ask2("commit", "Commit summary", cx) : (this.note = "Nothing to commit", cx.notify()),
        A: () => this.hasHead && this.ask("Amend last commit", `Amend HEAD (${this.head?.slice(0,7)}) with the staged changes?`, (cx) => this.act("Amend", [["commit", "--amend", "--no-edit"]], cx, { done: "Amended", history:true }), cx),
        d: () => it?.dir ? pickFile() : this.discard(file, cx),
        enter: () => { if (it?.dir) this.fold(it, cx); else if (it) { this.main = true; cx.notify(); } },
        "`": () => this.setTree(!this.tree, cx), "-": () => this.tree && this.foldAll(true, cx), "=": () => this.tree && this.foldAll(false, cx),
        "/": () => this.startSearch(cx), "+": () => this.setWide(!this.wide, cx),
        D: () => this.ask("Discard all changes", "Discard ALL changes, including untracked files? (reset --hard, clean -fd)", (cx) => this.act("Discard all", [["reset", "--hard", "-q"], ["clean", "-fd", "-q"]], cx, { done: "Discarded all changes" }), cx),
        s: () => this.files.length && this.ask2("stash", "Stash changes (optional message)", cx),
        S: () => this.files.some((f) => f.staged) ? this.ask2("stash-staged", "Stash staged changes (optional message)", cx) : (this.note = "Nothing staged", cx.notify()),
        e: () => { if (file && file.x !== "D" && file.y !== "D") { this.close(); run("pane.split", { direction: "right", argv: [this.on ? "vi" : "nvim", `${this.root}/${file.path}`] }); } },
        o: () => { if (it && !this.on) exec("open", [`${this.root}/${it.dir ? it.path : file.path}`]); },
        i: () => it && this.ask(it.dir ? "Ignore folder" : "Ignore file", `Add ${it.dir ? it.path + "/" : file.path} to .gitignore?`, (cx) => {
          cx.spawn(async (cx) => {
            const r = await exec("sh", ["-c", 'printf "%s\\n" "$1" >> .gitignore', "sh", it.dir ? `/${it.path}/` : `/${file.path}`], { cwd: this.root, on: this.on });
            if (r.code !== 0) this.note = `Ignore failed: ${r.stderr.trim()}`; else this.info = `Ignored ${it.dir ? it.path + "/" : file.path}`;
            this.refresh(cx); cx.notify();
          });
        }, cx),
        t: () => { if (file && isMarkdown(file.path)) { this.mdMode = !this.mdMode; this.reload(cx); } },
      },
      branches: {
        " ": () => it && !it.current && this.act("Checkout", [["checkout", it.name]], cx, { done: `Switched to ${it.name}` }),
        space: () => it && !it.current && this.act("Checkout", [["checkout", it.name]], cx, { done: `Switched to ${it.name}` }),
        n: () => this.ask2("branch", "New branch name", cx),
        d: () => it && !it.current && this.ask("Delete branch", `Delete branch ${it.name}?`, (cx) => this.act("Delete branch", [["branch", "-d", it.name]], cx, { done: `Deleted ${it.name}` }), cx),
      },
      stash: {
        " ": () => it && this.act("Apply stash", [["stash", "apply", it.ref]], cx, { done: `Applied ${it.ref}` }),
        space: () => it && this.act("Apply stash", [["stash", "apply", it.ref]], cx, { done: `Applied ${it.ref}` }),
        g: () => it && this.ask("Pop stash", `Pop ${it.ref}?`, (cx) => this.act("Pop stash", [["stash", "pop", it.ref]], cx, { done: `Popped ${it.ref}` }), cx),
        d: () => it && this.ask("Drop stash", `Drop ${it.ref}?`, (cx) => this.act("Drop stash", [["stash", "drop", it.ref]], cx, { done: `Dropped ${it.ref}` }), cx),
      },
    };
    const graph = this.main && this.graph ? this.graphKeys(cx) : {};
    const fn = (ch !== "menu" && graph[ch]) || (k !== "menu" && graph[k]) || (!this.main && panel[this.panel]?.[ch]) || (!this.main && panel[this.panel]?.[k]) || global[ch] || named[k];
    if (!fn) return;
    fn(); done();
  }

  // ---------- drawing (Herdr's own look: Geist, cards, accent focus) ----------

  colors() {
    const t = theme();
    return { ...t, green: t.ansi2, red: t.ansi1, yellow: t.ansi3, cyan: t.ansi6, mono: settings().font_family ?? "JetBrains Mono" };
  }

  pill(text, c, opts = {}) {
    return div().flex_none().px(5).py(1).rounded(4).border_1().border_color(opts.accent ? c.accent : c.border)
      .text_size(10).text_color(opts.accent ? c.accent : c.muted).child(text);
  }

  // A panel card, like Herdr's panes: header row, border that turns accent when focused.
  card(id, num, title, active, body, c, opts = {}) {
    return v_flex().id(`card-${id}`).min_h(0).rounded(10).overflow_hidden().bg(c.background)
      .border_1().border_color(active ? c.accent : c.border)
      .when(Boolean(opts.size), (e) => opts.size(e))
      .child(h_flex().id(`head-${id}`).h(34).flex_none().px(12).gap(8).items_center().cursor_pointer()
        .on_click((_e, cx) => { this.handle.focus(); opts.onClick?.(cx); })
        .when(Boolean(num), (e) => e.child(div().w(16).h(16).flex_none().rounded(4).bg(active ? c.accent : c.raised)
          .flex().items_center().justify_center().text_size(10).font_semibold().text_color(active ? c.accent_foreground : c.dim).child(num)))
        .child(div().text_size(12).font_semibold().text_color(active ? c.foreground : c.muted).child(title))
        .when(opts.count !== undefined && opts.count !== null, (e) => e.child(this.pill(String(opts.count), c)))
        .when(Boolean(opts.tag), (e) => e.child(this.pill(opts.tag, c, { accent: active })))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(c.dim).child(opts.right ?? ""))
        .children((opts.tools ?? []).map((tool) => div().id(`tool-${id}-${tool.id}`).w(22).h(22).flex_none().flex().items_center().justify_center().rounded(5).cursor_pointer()
          .text_color(tool.on ? c.accent : c.dim).when(Boolean(tool.on), (e) => e.bg(c.raised)).hover((s) => s.bg(c.hover).text_color(c.foreground))
          .on_click((_e, cx) => { cx.stop_propagation(); this.handle.focus(); tool.run(cx); }).child(svg(tool.icon).size(13))))
        .when(Boolean(opts.action), (e) => e.child(div().id(`act-${id}`).flex_none().text_size(11).text_color(c.accent).cursor_pointer()
          .hover((s) => s.opacity(0.75)).on_click((_e, cx) => { cx.stop_propagation(); opts.action.run(cx); }).child(opts.action.label))))
      .child(div().flex_1().min_h(0).border_t(1).border_color(c.border).child(body));
  }

  rowsIn(panel, items, render, c, empty) {
    const active = this.panel === panel && !this.main;
    if (!items.length) return div().px(14).py(8).text_size(12).text_color(c.dim).child(empty ?? "");
    return div().size_full().relative()
      .child(v_flex().id(`list-${panel}`).absolute().inset_0().overflow_y_scroll().track_scroll(this.scroll[panel]).py(4)
        .children(items.map((it, n) => {
          const on = n === this.sel[panel];
          return h_flex().id(`${panel}-${n}`).h(28).flex_none().mx(6).px(8).gap(8).items_center().rounded(7).cursor_pointer()
            .when(on, (e) => e.bg(active ? c.selected : c.raised)).hover((s) => s.bg(on ? (active ? c.selected : c.raised) : c.hover))
            .on_click((_e, cx) => { this.handle.focus(); this.panel = panel; this.main = false; this.move(n, cx); })
            .on_mouse_down("right", (_e, cx) => { this.handle.focus(); this.panel = panel; this.main = false; this.sel[panel] = n; this.peek = null; if (panel === "branches") this.menuItems(this.branchView, this.branchActions(cx), cx); else if (panel === "commits") this.menuItems(it.subject, this.commitActions(it,cx), cx); else if (panel === "files") this.menuItems("File actions",this.fileActions(cx),cx); else if (panel === "stash") this.menuItems("Stash actions",this.stashActions(cx),cx); cx.stop_propagation(); })
            .children(render(it, on, n));
        })))
      .child(Scrollbar.vertical(`list-${panel}`).absolute().inset_0());
  }

  // A Files row: a folder (fold arrow, a checkbox for everything shown under
  // it, totals) or a file.
  nodeRow(node, n, c) {
    const fs = node.dir ? node.files : [node.file];
    const some = fs.some((f) => f.staged), full = some && fs.every((f) => f.staged && !f.unstaged);
    const add = fs.reduce((sum, f) => sum + f.add, 0), del = fs.reduce((sum, f) => sum + f.del, 0);
    const check = div().id(`chk-${n}`).w(16).h(16).flex_none().rounded(4).border_1()
      .border_color(some ? c.accent : c.input).bg(full ? c.accent : c.background)
      .flex().items_center().justify_center().text_size(10).font_bold().text_color(full ? c.accent_foreground : c.accent)
      .child(full ? "✓" : some ? "–" : "")
      .on_click((_e, cx) => { cx.stop_propagation(); this.panel = "files"; this.move(n, cx); this.toggleFile(node, cx); });
    const stats = [
      ...(add > 0 ? [div().flex_none().text_size(11).text_color(c.green).child(`+${add}`)] : []),
      ...(del > 0 ? [div().flex_none().text_size(11).text_color(c.red).child(`−${del}`)] : []),
    ];
    const indent = node.depth ? [div().flex_none().w(node.depth * 14 - 8)] : [];
    if (node.dir) return [
      ...indent,
      div().id(`fold-${n}`).w(14).h(16).flex_none().flex().items_center().justify_center()
        .on_click((_e, cx) => { cx.stop_propagation(); this.handle.focus(); this.fold(node, cx); })
        .child(svg(`mods/workspace-chrome/chevron-${node.open ? "down" : "right"}.svg`).size(12).text_color(c.dim)),
      check,
      div().flex_1().min_w(0).truncate().text_color(c.muted).child(`${node.name}/`),
      div().flex_none().text_size(11).text_color(c.dim).child(String(fs.length)),
      ...stats,
      div().w(12).flex_none(),
    ];
    const f = node.file;
    const letter = f.conflict ? "!" : f.fresh ? "U" : (f.unstaged ? f.y : f.x);
    const color = f.conflict || letter === "D" ? c.red : letter === "U" || letter === "A" ? c.green : c.blocked;
    return [
      ...indent,
      check,
      h_flex().flex_1().min_w(0)
        .child(div().min_w(0).truncate().text_color(letter === "D" ? c.muted : c.foreground).child(node.name))
        .when(Boolean(node.where), (e) => e.child(div().ml(6).min_w(0).truncate().text_size(11).text_color(c.dim).child(node.where))),
      ...stats,
      div().w(12).flex_none().text_size(11).font_semibold().text_color(color).child(letter),
    ];
  }

  // GitHub's dark diff colors: clear green and red, stronger in the gutter.
  diffRow(row, index, c) {
    const { kind, number, text } = row, at = this.main && (index === this.cursor || this.diffSelection?.has(index));
    const ADD = { line: "#2ea04333", gutter: "#3fb95059", sign: "#3fb950" };
    const DEL = { line: "#f8514933", gutter: "#f8514959", sign: "#f85149" };
    if (kind === "@") return div().w_full().px(12).h(22).flex_none().flex().items_center().truncate()
      .bg(at ? c.selected : "#388bfd1f").text_color("#79c0ff").child(text);
    const meta = kind === "" && /^(commit |diff --git|index |--- |\+\+\+ |Author:|Date:)/.test(text);
    const tone = kind === "+" ? ADD : kind === "-" ? DEL : null;
    return h_flex().w_full().h(22).flex_none().items_center()
      .when(Boolean(tone), (e) => e.bg(tone.line)).when(at, (e) => e.bg(c.selected))
      .child(div().w(44).h_full().flex_none().pr(8).flex().items_center().justify_end()
        .bg(tone ? tone.gutter : c.raised + "80").text_color(tone ? c.foreground : c.dim).child(number === undefined ? "" : String(number)))
      .child(div().w(20).flex_none().text_center().font_bold().text_color(tone ? tone.sign : c.dim).child(kind === "+" ? "+" : kind === "-" ? "−" : ""))
      .child(div().flex_1().min_w(0).pr(12).truncate().text_color(meta ? c.muted : c.foreground).child(text));
  }

  mainView(c) {
    if (this.help) return v_flex().id("git-help").size_full().overflow_y_scroll().px(18).py(14).gap(16).text_size(12).children(HELP.map(([group, rows]) => v_flex().gap(4)
      .child(div().text_size(11).font_semibold().text_color(c.dim).child(group.toUpperCase()))
      .children(rows.map(([key, what]) => h_flex().gap(12).items_center()
        .child(h_flex().w(180).flex_none().gap(4).children(key.split(/\s{2,}|\s(?=\S)/).filter(Boolean).slice(0, 4).map((k) => this.kbd(k, c))))
        .child(div().text_color(c.foreground).child(what))))));
    const feature = this.featureMain(c); if (feature) return feature;
    if (this.md) return div().size_full().relative()
      .child(v_flex().id("git-md").absolute().inset_0().overflow_y_scroll().track_scroll(this.mdScroll)
        .child(v_flex().w_full().max_w(900).mx_auto().px(48).pt(32).pb(72).gap(18).text_size(18)
          .children(this.md.map((seg, n) => seg.kind === "md" ? TextView.markdown(`git-md-${n}`, seg.text).selectable(true).text_size(18).line_height("30px")
            : seg.kind === "diagram" ? h_flex().w_full().justify_center().py(20).child(image(seg.src).w(seg.w).h(seg.h))
            : v_flex().p(12).gap(4).rounded(8).border_1().border_color(c.red).child(div().text_color(c.red).text_size(12).child("Mermaid error")).child(div().text_color(c.muted).text_size(12).child(seg.text))))))
      .child(Scrollbar.vertical("git-md").absolute().inset_0());
    if (this.graph) return this.graphView(c);
    this.diffSelection = new Set(this.selectedRows());
    return div().size_full().relative().font_family(c.mono).text_size(12)
      .child(div().id("git-diff-x").size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("git-diff", this.rows.length, 22, (n) => String(n),
          (range) => this.rows.slice(range.start, range.end).map((row, k) => this.diffRow(row, range.start + k, c)))
            .on_item_click((key, cx) => { this.handle.focus(); this.main = true; this.cursor = Number(key); cx.notify(); })
            .track_scroll(this.diffScroll).size_full())))
      .child(Scrollbar.vertical("git-diff").viewport_from_layout().absolute().inset_0())
      .when(!this.rows.length, (e) => e.child(div().absolute().top(10).px(14).text_color(c.dim).child(this.error ?? (this.loading ? "Loading…" : "Nothing to show"))));
  }

  // Git Graph's table: the graph, then description (labels and subject),
  // date, author and commit.
  graphView(c) {
    const g = this.graph, w = graphWidth(g.lanes);
    const palette = [c.ansi4, c.ansi5, c.ansi2, c.ansi3, c.ansi6, c.ansi1, c.ansi12, c.ansi13, c.ansi10, c.ansi11, c.ansi14, c.ansi9];
    const ink = (n) => n < 0 ? c.dim : palette[n % palette.length];
    const found = new Set(this.matches);
    return v_flex().size_full().text_size(12)
      .when(this.findOpen || Boolean(this.query), (e) => e.child(h_flex().h(32).flex_none().px(12).gap(8).items_center().border_b(1).border_color(this.finding ? c.accent : c.border)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(svg("mods/workspace-chrome/search.svg").size(13).flex_none().text_color(this.finding ? c.accent : c.dim))
        .child(Input.new(this.find).flex_1().h_full().text_size(12).text_color(c.foreground))
        .child(div().flex_none().text_size(11).text_color(c.dim).child(this.query.trim() ? (found.size ? `${this.matches.indexOf(this.cursor) + 1 || "–"} of ${found.size}` : "No matches") : ""))))
      .child(h_flex().h(26).flex_none().items_center().border_b(1).border_color(c.border).text_size(11).text_color(c.dim)
        .child(div().w(w).flex_none().pl(10).child("Graph"))
        .child(div().flex_1().min_w(0).child("Description"))
        .child(div().w(128).flex_none().child("Date"))
        .child(div().w(128).flex_none().child("Author"))
        .child(div().w(72).flex_none().child("Commit")))
      .child(div().flex_1().min_h(0).relative()
        .child(div().absolute().inset_0().child(v_virtual_list("git-graph", g.rows.length, ROW, (n) => String(n),
          (range) => g.rows.slice(range.start, range.end).map((row, k) => this.graphRow(row, range.start + k, w, ink, c, found.has(range.start + k))))
          // A click selects; a click on the selected commit opens it.
          .on_item_click((key, cx) => { const n = Number(key); this.handle.focus(); if (this.main && n === this.cursor) return this.openCommit(cx); this.main = true; this.cursor = n; cx.notify(); })
          // The row says which commit; the dialog's own handler (render) says where.
          .on_item_secondary_click((key, _e, cx) => { this.handle.focus(); this.main = true; this.cursor = Number(key); this.menuAsked = true; cx.notify(); })
          .track_scroll(this.graphScroll).size_full()))
        .child(Scrollbar.vertical("git-graph").viewport_from_layout().absolute().inset_0())
        .when(!g.rows.length, (e) => e.child(div().absolute().top(10).px(14).text_color(c.dim).child("No commits yet"))));
  }

  graphRow(row, n, w, ink, c, found) {
    const cm = row.commit, at = n === this.cursor, wip = cm.hash === UNCOMMITTED;
    const bg = at ? (this.main ? c.selected : c.raised) : c.background;
    return h_flex().id(`graph-${n}`).w_full().h(ROW).flex_none().items_center().cursor_pointer()
      .when(found && !at, (e) => e.bg(c.yellow + "26")).when(at, (e) => e.bg(bg)).hover((s) => s.bg(at ? bg : c.hover))
      .child(graphCell(row, w, ink, bg, cm.hash === this.head))
      .child(h_flex().flex_1().min_w(0).pr(12).gap(6).items_center()
        .children(cm.refs.slice(0, 4).map((r) => this.refLabel(r, ink(row.color), c)))
        .when(cm.refs.length > 4, (e) => e.child(div().flex_none().text_size(10.5).text_color(c.dim).child(`+${cm.refs.length - 4}`)))
        .child(div().flex_1().min_w(0).truncate().text_color(wip ? c.muted : c.foreground).when(cm.hash === this.head, (e) => e.font_semibold()).child(cm.subject)))
      .child(div().w(128).flex_none().pr(8).truncate().text_size(11).text_color(c.muted).child(cm.when))
      .child(div().w(128).flex_none().pr(8).truncate().text_size(11).text_color(c.muted).child(cm.who))
      .child(div().w(72).flex_none().font_family(c.mono).text_size(11).text_color(c.dim).child(wip ? "*" : cm.hash.slice(0, 7)));
  }

  // A branch or tag on its commit, in its lane's color; remotes on the same
  // commit follow the name ("main | origin").
  refLabel(r, color, c) {
    return h_flex().flex_none().max_w(240).h(18).items_center().rounded(4).overflow_hidden().border_1().border_color(color).text_size(10.5)
      .child(h_flex().h_full().px(5).gap(4).items_center().min_w(0).bg(color + "33").text_color(c.foreground)
        .child(svg(r.kind === "tag" ? "mods/git/tag.svg" : r.kind === "stash" ? "mods/workspace-chrome/archive.svg" : "mods/git/branch.svg").size(10).flex_none().text_color(color))
        .child(div().min_w(0).truncate().when(Boolean(r.current), (e) => e.font_bold()).child(r.name)))
      .children(r.remotes.map((remote) => div().h_full().px(5).flex().items_center().flex_none().border_l(1).border_color(color).text_color(c.muted).child(remote)));
  }

  menuView(c) {
    const mn = this.menu, w = 360, W = this.size?.width, H = this.size?.height, h = Math.min(mn.items.length * 28 + 38, (H ?? 720) - 32);
    const place = (at, size, room) => at == null ? (room ? (room - size) / 2 : 240) : Math.max(8, Math.min(at, (room ?? 1e9) - size - 8));
    const shut = (_e, cx) => { this.menu = null; cx.stop_propagation(); cx.notify(); };
    return div().id("git-menu-back").absolute().inset_0().on_mouse_down("left", shut).on_mouse_down("right", shut)
      .child(v_flex().id("git-menu").absolute().left(place(mn.x, w, W)).top(place(mn.y, h, H)).w(w).h(h).pb(4).rounded(8).bg(c.popover).border_1().border_color(c.border).shadow_lg().text_size(12)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(div().h(30).flex_none().px(12).flex().items_center().border_b(1).border_color(c.border).mb(4).text_size(11).text_color(c.dim).truncate().child(mn.title))
        .child(v_flex().id("git-menu-items").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.menuScroll).children(mn.items.map((it, n) => h_flex().id(`git-menu-${n}`).h(28).flex_none().mx(4).px(8).gap(8).items_center().rounded(5).cursor_pointer()
          .when(n === mn.sel, (e) => e.bg(c.selected)).hover((s) => s.bg(n === mn.sel ? c.selected : c.hover))
          .on_click((_e, cx) => this.pickMenu(n, cx))
          .child(div().flex_1().min_w(0).truncate().text_color(it.danger ? c.red : c.foreground).child(it.label))
          .child(div().flex_none().max_w(120).truncate().text_size(10.5).text_color(c.dim).child(it.hint ?? ""))))));
  }

  kbd(k, c) {
    return div().flex_none().px(5).h(18).flex().items_center().rounded(4).bg(c.raised).border_1().border_color(c.border)
      .font_family(c.mono).text_size(10.5).text_color(c.muted).child(k);
  }

  button(id, label, c, onClick, opts = {}) {
    const on = !this.busy;
    return h_flex().id(id).h(28).px(10).gap(6).items_center().rounded(7).text_size(12)
      .bg(opts.primary ? c.solid : c.raised).text_color(opts.primary ? c.solid_foreground : on ? c.foreground : c.dim)
      .when(on, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88)))
      .on_click((_e, cx) => { if (on) onClick(cx); })
      .child(label).when(Boolean(opts.key), (e) => e.child(div().text_size(10.5).font_family(c.mono).text_color(opts.primary ? c.solid_foreground : c.dim).child(opts.key)));
  }

  // Prompts and confirmations, styled like Herdr's confirm dialog.
  modal(c) {
    const p = this.prompt, q = this.pending;
    if (!p && !q) return null;
    const dbtn = (id, label, bg, fg, run) => h_flex().id(id).h(30).px(14).items_center().rounded(8).bg(bg).text_color(fg).cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => run(cx)).child(label);
    return div().absolute().inset_0().flex().items_center().justify_center().bg(c.background + "88")
      .child(v_flex().id("git-modal").w(520).p(18).gap(12).rounded(10).bg(c.popover).border_1().border_color(c.border).text_size(13)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child(p ? p.title : q.title)).child(div().text_size(11).text_color(c.dim).child("Esc")))
        .when(Boolean(q), (e) => e.child(div().text_color(c.muted).child(q.text)))
        .when(Boolean(p), (e) => e.child(div().h(34).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? c.accent : c.border).bg(c.surface)
          .child(Input.new(this.input).w_full().h_full().text_size(13).text_color(c.foreground))))
        .when(p?.kind === "commit", (e) => e.child(this.commitBodyView(c)))
        .when(p?.kind === "commit" && Boolean(this.writeError), (e) => e.child(div().text_size(11).text_color(c.ansi1 ?? c.blocked).child(this.writeError)))
        .child(h_flex().justify_end().items_center().gap(8).text_size(12)
          .when(p?.kind === "commit" && !shared("curtain")?.on, (e) => e.child(h_flex().id("m-write").h(30).px(10).gap(6).items_center().rounded(8).border_1().border_color(c.border).text_color(c.muted)
            .when(!this.writing, (b) => b.cursor_pointer().hover((s) => s.bg(c.hover).text_color(c.foreground))).on_click((_e, cx) => this.generate(cx))
            .child(this.writing ? svg("mods/workspace-chrome/spinner.svg").size(13).text_color(c.working).spin(900) : svg("mods/git/sparkles.svg").size(13))
            .child(this.writing ? "Writing…" : "Write summary")
            .when(!this.writing, (b) => b.child(div().text_size(10.5).text_color(c.dim).child("enter"))))
            // Who writes it: opens the Writer settings.
            .child(div().id("m-writer").flex_1().min_w(0).truncate().text_size(11).text_color(c.dim).cursor_pointer().hover((s) => s.text_color(c.foreground))
              .on_click(() => { setShared("config.page", "writer"); run("mod.open", { name: "config" }); }).child(shared("writer")?.label ?? "Claude Code · claude-haiku-5-5")))
          .child(dbtn("m-no", "Cancel", c.raised, c.foreground, (cx) => p ? this.cancelPrompt(cx) : (this.pending = null, cx.notify())))
          .child(dbtn("m-yes", p ? (p.kind === "commit" ? "Commit" : p.kind === "branch" ? "Create" : p.kind === "value" ? "Confirm" : "Stash") : "Confirm", c.solid, c.solid_foreground,
            (cx) => { if (p) this.submit(cx); else { const x = this.pending; this.pending = null; x.then(cx); } }))));
  }

  hints() {
    if (this.menu) return [["j k", "move"], ["enter", "choose"], ["esc", "close"]];
    if (this.plan) return [["j k","commit"],["p r e s f d","action"],["ctrl-j/k","reorder"],["⌘↵","apply"],["esc","back"]];
    if (this.detail) return this.detail.file ? [["space","mark patch"],["a","hunk / line"],["v","range"],["ctrl-p","patch options"],["esc","files"]] : [["j k","file"],["enter","open diff"],["esc","back"]];
    if (this.main && this.conflicts?.conflicts.length) return [["j k","conflict"],["o","ours"],["t","theirs"],["b","both"],["M","file options"],["m","continue / abort"],["esc","back"]];
    if (this.main && this.patch) return [["space",this.shownSide === "staged" ? "unstage" : "stage"],["a","hunk / line"],["v","range"],["tab","staged / unstaged"],["d","discard"],["c","commit"],["esc","back"]];
    if (this.main && this.graph) return [["j k", "commit"], ["enter", "view"], ["/", "find"], ...(this.query ? [["n N", "match"]] : []),
      ["space", "checkout"], ["b", "branch"], ["c", "cherry-pick"], ["t", "revert"], ["r", "reset"], ["m", "menu"], ["esc", this.query || this.findOpen ? "clear find" : "back"], ["?", "keys"]];
    if (this.main) return [["J K", "scroll"], ["j k", "line"], ["esc", this.peek ? "graph" : "back"], ["?", "keys"]];
    return {
      status: [["enter", "graph"], ["f", "fetch"], ["p", "pull"], ["P", "push"], ["1-5", "panels"], ["?", "keys"], ["q", "close"]],
      files: [["space", "stage"], ["a", "all"], ["c", "commit"], ...(this.item("files")?.dir ? [["enter", "fold"]] : [["d", "discard"], ["e", "edit"]]),
        ["/", "filter"], ["`", this.tree ? "flat" : "tree"], ["+", this.wide ? "all panels" : "expand"],
        ...(isMarkdown(this.item("files")?.file?.path ?? "") ? [["t", this.mdMode ? "diff" : "preview"]] : []), ["?", "keys"]],
      branches: [["[ ]","views"],["m","actions"],["/","filter"],["space", "checkout"], ["n", "new"], ["?", "keys"]],
      commits: [["[ ]","reflog"],["m","actions"],["C V","cherry-pick"],["i","rebase"],["W","compare"],["/","filter"],["?", "keys"]],
      stash: [["space", "apply"], ["g", "pop"], ["d", "drop"], ["?", "keys"]],
    }[this.panel];
  }

  render(cx) {
    const c = this.colors(), b = this.branch, src = this.source();
    const act = (p) => this.panel === p && !this.main;
    // Files fills the side bar while it is the panel in use; 3, 4, 5 bring the rest back.
    const solo = this.wide && this.panel === "files";
    const status = this.note ? { text: this.note, color: c.red } : this.busy ? { text: `${this.busy}…`, color: c.muted } : this.info ? { text: this.info, color: c.green } : null;
    const tag = this.help ? null : src?.file ? (src.markdown ? "preview" : src.file.conflict ? "conflicts" : this.shownSide) : src?.key?.startsWith("c:") ? "commit" : src?.key?.startsWith("s:") ? "stash" : null;
    const mainTitle = this.help ? "Keybindings" : this.detail ? this.detail.file?.path ?? "Changed files" : src?.file ? src.file.path.split("/").pop() : src?.key?.startsWith("c:") ? src.subject ?? "Commit" : src?.title ?? "Diff";
    const mainRight = this.help ? "" : src?.file ? src.file.path.split("/").slice(0, -1).join("/") : src?.key?.startsWith("c:") ? src.hash : this.graph ? `${this.graph.rows.length} commits` : "";
    const age = (w) => (w ?? "").replace(/ ago$/, "").replace(/ (\w)\w*$/, "$1");

    return v_flex().id("git").relative().size_full().min_h(0).bg(c.chrome).text_color(c.foreground).text_size(13)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .on_mouse_down("right", (e, cx) => { if (this.menuAsked && this.graph) { this.menuAsked = false; this.graphKeys(cx).menu({ x: e.local_position?.x, y: e.local_position?.y }); } })
      .track_focus(this.handle).key_context("GitMod").on_action("git-escape", (_e, cx) => this.keys({ key: "escape", keystroke: "escape", modifiers: {} }, cx))
      .on_action("git-submit", (_e, cx) => { if (this.prompt) this.submit(cx); else if (this.plan) this.applyPlan(cx); cx.stop_propagation(); })
      .on_key_down((e, cx) => this.keys(e, cx))
      // [1] Status lives in the header: branch, upstream, sync, remote actions.
      .child(h_flex().id("head-status").h(48).flex_none().px(16).gap(10).items_center().cursor_pointer()
        .on_click((_e, cx) => { this.handle.focus(); this.goto("status", cx); })
        .child(div().w(16).h(16).flex_none().rounded(4).bg(act("status") ? c.accent : c.raised).flex().items_center().justify_center().text_size(10).font_semibold().text_color(act("status") ? c.accent_foreground : c.dim).child("1"))
        .child(svg("mods/git/branch.svg").size(15).text_color(c.accent))
        .child(div().font_semibold().child(b?.name ?? (this.error ? "—" : "…")))
        .child(div().text_size(12).text_color(c.dim).child(this.repo))
        .when(Boolean(b?.upstream), (e) => e.child(div().text_size(11).text_color(c.dim).child(`→ ${b.upstream}`)))
        .when(Boolean(b?.ahead || b?.behind), (e) => e.child(this.pill(`↑${b.ahead} ↓${b.behind}`, c)))
        .when(Boolean(b) && !b?.upstream && this.hasHead, (e) => e.child(this.pill("no upstream", c)))
        .child(div().flex_1())
        .child(this.button("git-more", "More", c, (cx) => this.moreMenu(cx)))
        .child(this.button("git-lazygit", "Lazygit", c, (cx) => this.launchLazygit(cx), {key:"L"}))
        .child(this.button("fetch", "Fetch", c, (cx) => this.act("Fetch", [["fetch", "--prune"]], cx, { network: true, done: "Fetched" }), { key: "f" }))
        .child(this.button("pull", b?.behind ? `Pull ↓${b.behind}` : "Pull", c, (cx) => this.act("Pull", [["pull", "--ff-only"]], cx, { network: true, done: "Pulled" }), { key: "p" }))
        .child(this.button("push", b?.ahead ? `Push ↑${b.ahead}` : "Push", c, (cx) => this.push(cx), { key: "P", primary: Boolean(b?.ahead) })))
      .when(Boolean(this.operation || this.bisecting || this.copied.size || this.compareBase || this.repoStack.length), (e) => e.child(h_flex().h(32).flex_none().px(16).gap(10).items_center()
        .child(div().flex_1().truncate().text_size(12).text_color(c.yellow).child([this.operation ? `${this.operation} in progress` : "", this.bisecting ? "Bisect in progress" : "", this.copied.size ? `${this.copied.size} commits marked for cherry-pick` : "", this.compareBase ? `Comparing from ${this.compareBase.slice(0,20)}` : "", this.repoStack.length ? "Esc returns to previous repository" : ""].filter(Boolean).join(" · ")))
        .when(Boolean(this.operation), (bar) => bar.child(this.button("operation-options", "Continue / abort", c, (cx) => this.operationMenu(cx), {key:"m"})))))
      .child(h_flex().flex_1().min_h(0).px(10).gap(10)
        // Side panels.
        .child(v_flex().w(400).flex_none().h_full().gap(10)
          .child(this.card("files", "2", "Files", act("files"),
            v_flex().size_full()
              .when(this.searchOpen || Boolean(this.filter), (e) => e.child(h_flex().h(32).flex_none().px(12).gap(8).items_center().border_b(1).border_color(this.searching ? c.accent : c.border)
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .child(svg("mods/workspace-chrome/search.svg").size(13).flex_none().text_color(this.searching ? c.accent : c.dim))
                .child(Input.new(this.search).flex_1().h_full().text_size(12).text_color(c.foreground))
                .child(div().flex_none().text_size(11).text_color(c.dim).child(`${this.nodes.filter((n) => !n.dir).length} of ${this.files.length}`))))
              .child(div().flex_1().min_h(0).child(this.rowsIn("files", this.nodes, (node, _on, n) => this.nodeRow(node, n, c), c,
                this.error ?? (this.loading ? "Loading…" : this.files.length ? "No files match" : "Working tree clean")))),
            c, { size: (e) => solo ? e.flex_1() : e.flex_grow(2).flex_basis(0).min_h(100), count: this.filesLimited ? `${this.files.length}+` : this.files.length, onClick: (cx) => this.goto("files", cx),
              tools: [
                { id: "search", icon: "mods/workspace-chrome/search.svg", on: this.searchOpen || Boolean(this.filter), run: (cx) => this.searchOpen || this.filter ? this.clearSearch(cx) : this.startSearch(cx) },
                { id: "tree", icon: "mods/git/tree.svg", on: this.tree, run: (cx) => this.setTree(!this.tree, cx) },
                { id: "wide", icon: "mods/git/expand.svg", on: this.wide, run: (cx) => { this.panel = "files"; this.main = false; this.setWide(!this.wide, cx); } },
              ],
              action: this.files.length ? { label: this.files.some((f) => f.unstaged || f.fresh) ? "Stage all" : "Unstage all", run: (cx) => this.toggleAll(cx) } : null }))
          .when(!solo, (side) => side
          .child(this.card("branches", "3", "Branches", act("branches"),
            v_flex().size_full().child(this.viewBar("branches",c))
            .when(this.panel === "branches" && this.panelSearchOpen, (e) => e.child(this.filterBar(c)))
            .child(div().flex_1().min_h(0).child(this.rowsIn("branches", this.branchItems(), (br) => [
              div().w(7).h(7).flex_none().rounded(4).when(br.current, (e) => e.bg(c.accent)).when(!br.current, (e) => e.border_1().border_color(c.dim)),
              div().flex_1().min_w(0).truncate().text_color(br.current ? c.foreground : c.muted).when(br.current, (e) => e.font_semibold()).child(br.name),
              ...(br.track ? [this.pill(br.track.replace("ahead ", "↑").replace("behind ", "↓").replace(", ", " "), c)] : []),
              div().flex_none().max_w(120).truncate().text_size(11).text_color(c.dim).child(br.branch ?? age(br.when)),
            ], c, "No items"))), c, { size: (e) => e.flex_grow(2).flex_basis(0).min_h(120), count: this.branchItems().length, onClick: (cx) => this.goto("branches", cx), action: {label:"Actions",run:(cx)=>this.menuItems(this.branchView,this.branchActions(cx),cx)} }))
          .child(this.card("commits", "4", "Commits", act("commits"),
            v_flex().size_full().child(this.viewBar("commits",c))
            .when(this.panel === "commits" && this.panelSearchOpen, (e) => e.child(this.filterBar(c)))
            .child(div().flex_1().min_h(0).child(this.rowsIn("commits", this.commitItems(), (cm) => [
              div().flex_none().font_family(c.mono).text_size(11).text_color(this.copied.has(cm.hash) ? c.yellow : cm.unpushed ? c.accent : c.dim).child(`${this.copied.has(cm.hash) ? "✓ " : ""}${cm.hash.slice(0, 7)}`),
              div().flex_1().min_w(0).truncate().child(cm.subject),
              div().flex_none().text_size(11).text_color(c.dim).child(age(cm.when)),
            ], c, "No commits yet"))), c, { size: (e) => e.flex_grow(2).flex_basis(0).min_h(110), count: this.commitItems().length, onClick: (cx) => this.goto("commits", cx), action: {label:"Actions",run:(cx)=>this.menuItems("Commit actions",this.commitActions(this.item("commits"),cx),cx)} }))
          .child(this.card("stash", "5", "Stash", act("stash"),
            v_flex().size_full().when(this.panel === "stash" && this.panelSearchOpen, (e) => e.child(this.filterBar(c)))
            .child(div().flex_1().min_h(0).child(this.rowsIn("stash", this.stashItems(), (st) => [
              div().flex_1().min_w(0).truncate().child(st.subject.replace(/^On [^:]+: /, "")),
              div().flex_none().text_size(11).text_color(c.dim).child(age(st.when)),
            ], c, "No stashes"))), c, { size: (e) => e.flex_none().h(this.stashes.length ? 120 : 76), count: this.stashes.length, onClick: (cx) => this.goto("stash", cx) }))))
        // Main view.
        .child(this.card("main", "0", this.plan ? "Interactive rebase" : mainTitle, this.main || this.help,
          v_flex().size_full().when(!this.help && !this.plan && Boolean(this.diffBar(c)), (e) => e.child(this.diffBar(c))).child(div().flex_1().min_h(0).child(this.mainView(c))), c,
          { size: (e) => e.flex_1().min_w(0).h_full(), tag, right: mainRight, action: this.historyPatch?.ref || this.customPatch ? {label:"Custom patch",run:(cx)=>this.patchMenu(cx)} : null, onClick: (cx) => { this.main = true; cx.notify(); } })))
      // Footer: key hints like Herdr's status bar, messages on the right.
      .child(h_flex().h(40).flex_none().px(16).gap(14).items_center()
        .child(h_flex().flex_1().min_w(0).gap(14).overflow_hidden().children((this.typing ? [["enter", "confirm"], ["esc", "back"]] : this.prompt ? [["i", "type"], ["enter", "confirm"], ["esc", "cancel"]] : this.hints()).map(([k, what]) =>
          h_flex().flex_none().gap(6).items_center().child(this.kbd(k, c)).child(div().text_size(11).text_color(c.dim).child(what)))))
        .when(Boolean(status), (e) => e.child(div().flex_none().max_w(520).truncate().text_size(12).text_color(status.color).child(status.text))))
      .when(Boolean(this.prompt || this.pending), (e) => e.child(div().absolute().inset_0().child(this.modal(c))))
      .when(Boolean(this.menu), (e) => e.child(this.menuView(c)));
  }
}
