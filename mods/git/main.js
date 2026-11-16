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
import { ROW, UNCOMMITTED, GRAPH_FORMAT, graphWidth, parseLog, layout, graphCell, graphGap } from "./graph.js";
import { GitFeatures } from "./features.js";
import { fileNodes } from "./file-tree.js";
import { parsePatch } from "./patch.js";
import { parseStatus, filePaths } from "./status.js";
import { graphHistoryQuery, graphHistoryPage, GRAPH_INITIAL_LIMIT, GRAPH_PAGE_SIZE } from "./history.js";
import { literalSearchMatches } from "./search.js";

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
// Kept patches share the one script heap (ADR 0006), so they are bounded by
// their total size as well as by count; least recently used go first.
const PATCH_BUDGET = 4_000_000;
let patchChars = 0;
function keepPatch(key, lines, chars) {
  const old = PATCHES.get(key);
  if (old) { patchChars -= old.chars; PATCHES.delete(key); }
  lines.chars = chars; PATCHES.set(key, lines); patchChars += chars;
  for (const [k, v] of PATCHES) {
    if (patchChars <= PATCH_BUDGET && PATCHES.size <= 48) break;
    PATCHES.delete(k); patchChars -= v.chars;
  }
}
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

const PREFS = "git.files"; // { tree, wide }, kept in localStorage

// lazygit's default keys, as shown by ?.
const HELP = [
  ["Global", [
    ["q", "quit"], ["esc", "cancel / back"], ["?  x", "keybindings"],
    ["1-5", "jump to panel"], ["h l  ← →  tab", "previous / next panel"], ["0  enter", "focus main view"],
    ["j k  ↑ ↓", "move"], [", .  pgup pgdn", "previous / next page"], ["< >  home end", "top / bottom"],
    ["v", "toggle sticky list range"], ["shift-↑/↓", "extend list range"],
    ["J K  ctrl-d ctrl-u", "scroll main view"], ["R", "refresh"], ["f", "fetch"], ["p", "pull"], ["P", "push"],
    ["alt-shift-c", "edit Lazygit configuration"],
  ]],
  ["Files", [
    ["space", "stage / unstage"], ["a", "stage / unstage all"], ["c", "commit staged changes"], ["C", "commit in Git's editor"], ["A", "amend last commit"],
    ["d", "discard selected files"], ["D", "discard all changes"], ["s", "stash all changes"], ["S", "stash options"],
    ["e", "edit selected files"], ["o", "open file"], ["ctrl-t", "configured diff tool"], ["i", "ignore / exclude"], ["y", "copy file information"], ["t", "markdown: preview / diff"],
    ["`", "tree / flat list"], ["enter", "fold / unfold folder"], ["-  =", "fold / unfold all folders"],
    ["/", "filter by path (esc clears)"], ["ctrl-b", "filter by staged / unstaged / tracked / untracked"], ["+", "Files fills the side bar / all panels"],
  ]],
  ["Branches", [["space", "checkout"], ["n", "new branch"], ["d", "delete branch"], ["i", "Git-flow start / finish"]]],
  ["Graph (Status, Branches)", [["enter  0", "go into the graph"], ["j k", "previous / next commit"], ["g  G", "first / last commit"],
    ["enter  click", "toggle inline commit details"], ["ctrl/cmd-click", "compare with another commit"], ["/", "find commits (subject, author, hash, branch, tag)"], ["n  N", "next / previous match"],
    ["space", "checkout the commit with detached HEAD"], ["b", "new branch at the commit"], ["c", "cherry-pick options, including a merge parent"],
    ["t", "revert"], ["r", "reset the current branch to the commit (soft, mixed, hard)"], ["y", "copy the commit hash"],
    ["m  right-click", "menu of all of these (j k, enter, esc)"], ["space", "on a stash: apply (the menu also pops and drops)"]]],
  ["Commits", [["enter", "view commit"]]],
  ["Commit files", [["space", "toggle file / folder in custom patch"], ["a", "toggle all files in custom patch"], ["enter", "open diff / fold folder"], ["`", "tree / flat list"], ["-  =", "fold / unfold all folders"], ["ctrl-p", "custom patch options"]]],
  ["Stash", [["space", "apply"], ["g", "pop"], ["d", "drop"]]],
  ["Diff selection", [["enter  0", "open file diff"], ["tab", "staged / unstaged"], ["j k  h l", "previous / next hunk"], ["a", "hunk / line selection"], ["v", "extend line range"], ["space", "stage / unstage selection"], ["d", "discard selected unstaged lines"], ["e", "edit file at selected line"], ["E", "edit hunk before staging / unstaging"], ["c", "commit staged changes"]]],
  ["File views", [["[  ]", "files / worktrees / submodules"], ["enter", "enter worktree / submodule"], ["m  x", "actions for this view"], ["/", "filter this view"]]],
  ["Branch views", [["[  ]", "local branches / remotes / tags"], ["enter", "open a remote's branches / view commits"], ["esc", "return from branches to remotes"], ["/", "filter this view"], ["m  x", "all actions for selected item"], ["s", "sort branches"], ["g", "reset options"], ["M", "merge / squash merge"], ["r", "rebase current branch onto selection"], ["R", "rename branch / remote"], ["u", "set / unset upstream"], ["w", "new worktree"], ["T", "new tag"], ["W", "compare refs"]]],
  ["Commit actions", [["[  ]", "commits / reflog"], ["m  x", "all actions, including reset"], ["C  V", "mark commits / cherry-pick marked commits"], ["t", "revert"], ["g", "reset options"], ["<  >", "first / last commit"], ["i", "edit rebase plan from selected commit"], ["r  e  d", "reword / edit / drop in rebase plan"], ["s  f", "squash / fixup into previous commit"], ["F  S", "create fixup from staged changes / autosquash"], ["A", "amend selected commit with staged changes"], ["a", "reset author / set author / add co-author"], ["B", "mark base for branch rebase"], ["b", "bisect good / bad / skip / reset"], ["W", "compare two commits"]]],
  ["Rebase plan", [["j k", "select commit"], ["p r e s f d", "pick / reword / edit / squash / fixup / drop"], ["ctrl-j  ctrl-k", "move commit"], ["cmd-enter", "review and apply plan"], ["esc", "leave plan without changing history"]]],
  ["Conflict resolution", [["M", "whole file: ours / theirs / mark resolved"], ["enter", "open conflicts"], ["j k", "select conflict"], ["o  t  b", "use ours / theirs / both for this conflict"], ["m", "continue / skip / abort current operation"]]],
  ["Repository", [["L", "open upstream Lazygit in this repository"], [":", "run a shell command in a terminal"], ["z  Z", "undo / redo a reflog action (auto-stash when needed)"], ["More  @", "configured commands, force push, pull options and output"], ["esc", "step back; return from worktree or submodule"]]],
];

// ---------- the mod ----------

// Escape is bound to an action of this mod's own: while a text field has the
// keyboard, Herdr closes the dialog on Escape before any key handler here sees it.
let escapeBound = false;

export default class Git extends GitFeatures {
  init(_props, cx) {
    if (!escapeBound) { cx.bind_keys([{ keystroke: "escape", action: "git-escape", context: "GitMod" }]); escapeBound = true; }
    this.nodes = []; this.collapsed = new Set(); this.filter = ""; this.tree = true; this.wide = false;
    try { const saved = JSON.parse(localStorage.getItem(PREFS) ?? "{}"); this.tree = saved.tree ?? true; this.wide = saved.wide ?? false; } catch {}
    this.files = []; this.branches = []; this.commits = []; this.stashes = []; this.branch = null; this.repo = "";
    this.panel = "files"; this.main = false;
    this.sel = { status: 0, files: 0, branches: 0, commits: 0, stash: 0 };
    this.rows = []; this.cursor = 0; this.diffWidth = 0; this.md = null; this.mdMode = true; this.graph = null; this.graphLimits = new Map(); this.peek = null;
    this.prompt = null; this.pending = null; this.help = false; this.message = "";
    this.handle = cx.focus_handle(); this.handle.focus();
    cx.timer.after(150, () => { if (!this.typing) this.handle.focus(); });
    this.scroll = Object.fromEntries(PANELS.map((p) => [p, ScrollHandle.new()]));
    this.diffScroll = VirtualListScrollHandle.new(); this.graphScroll = VirtualListScrollHandle.new(); this.mdScroll = ScrollHandle.new();
    this.input = InputState.new({ placeholder: "" });
    this.input.on("change", (_e, cx) => { this.message = this.input.value(); cx.notify(); });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.input.on("focus", (_e, cx) => { if(this.prompt)this.prompt.focusPending=false;this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.initFeatures(cx);
    this.search = InputState.new({ placeholder: "Filter files" });
    this.search.on("change", (_e, cx) => { const v = this.search.value(); if (v !== this.filter) { this.filter = v; this.cancelRange("files"); this.layoutFiles(); this.reload(cx); } });
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
    cx.timer.every(1000, (cx) => this.tickRefresh(cx));
    const { cwd, on } = this.location;
    this.repoKey = ROOTS.get(`${on ?? ""}:${cwd}`) ?? null;
    const snap = REPOS.get(this.repoKey)?.snap;
    if (snap) { Object.assign(this, snap); this.loaded = true; this.updateFileFilter([]); this.layoutFiles(null); this.reload(cx); }
    this.refresh(cx);
    // What is on screen is from last time: say that it is being checked.
    if (snap && this.run) this.run.shown = true;
  }

  // The graph rows the find words all appear in: subject, author, hash, branch or tag.
  match() {
    this.matches = !this.query||!this.graph?[]:literalSearchMatches(this.query,this.graph.rows.map(({commit:cm})=>[cm.subject??"",cm.who??"",cm.hash,...cm.refs.flatMap(r=>[r.name,...r.remotes.map(o=>`${o}/${r.name}`)])])).map(match=>match.index);
  }
  // by 0: the match at or after the cursor; 1 / -1: the one after / before it, around the ends.
  nextMatch(by, cx) {
    const m = this.matches;
    if (m.length) {
      const to = by > 0 ? m.find((n) => n > this.cursor) ?? m[0] : by < 0 ? [...m].reverse().find((n) => n < this.cursor) ?? m[m.length - 1] : m.find((n) => n >= this.cursor) ?? m[0];
      this.cursor = to; this.graphScroll.scroll_to_item(this.graphDisplayIndex(to), "center");
    }
    cx.notify();
  }
  startFind(cx) { this.main = true; this.findOpen = true; this.find.focus(); cx.notify(); }
  clearFind(cx) { this.findOpen = false; this.query = ""; this.matches = []; this.find.set_value(""); this.handle.focus(); cx.notify(); }

  // Rebuilds the Files rows, keeping the selection on the same file or folder.
  layoutFiles(keep = this.item("files")?.key, preserveRange = false) {
    const previous = this.nodes, selected = this.sel.files;
    this.nodes = fileNodes(this.visibleFiles(), this);
    let at = this.nodes.findIndex((n) => n.key === keep || (keep?.startsWith("f:") && n.file?.previousPath === keep.slice(2)));
    if (at < 0 && keep != null) for (const old of previous.slice(selected + 1)) {
      at = this.nodes.findIndex(n => n.key === old.key);
      if (at >= 0) break;
    }
    if (this.fileView === "files" && !this.context("files")) {
      this.sel.files = Math.max(0, Math.min(at >= 0 ? at : selected, this.nodes.length - 1));
      if (at >= 0 && this.sel.files !== selected && !preserveRange) this.cancelRange("files");
      this.clampRange("files", this.nodes);
    }
  }
  savePrefs() { try { localStorage.setItem(PREFS, JSON.stringify({ tree: this.tree, wide: this.wide })); } catch {} }
  setTree(tree, cx) { this.tree = tree; this.savePrefs(); this.layoutFiles(this.item("files")?.key,true); this.reload(cx); }
  setWide(wide, cx) { this.wide = wide; this.savePrefs(); cx.notify(); }
  fold(node, cx) {
    if (!node?.dir || this.filter.trim()) return;
    if (node.open) this.collapsed.add(node.path); else this.collapsed.delete(node.path);
    this.layoutFiles(node.key); cx.notify();
  }
  foldAll(closed, cx) {
    this.collapsed = new Set(closed ? fileNodes(this.files, { tree: true, collapsed: new Set(), filter: "" }).filter((n) => n.dir).map((n) => n.path) : []);
    this.layoutFiles(this.item("files")?.key,true); this.reload(cx);
  }
  startSearch(cx) { this.panel = "files"; this.main = false; this.searchOpen = true; this.search.focus(); cx.notify(); }
  clearSearch(cx) {
    this.cancelRange("files");
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
  list(p = this.panel) { return this.contextItems(p) ?? { status: () => [this.branch].filter(Boolean), files: () => this.fileItems(), branches: () => this.branchItems(), commits: () => this.commitItems(), stash: () => this.stashItems() }[p]?.() ?? []; }
  item(p = this.panel) { const l = this.list(p); return l[Math.min(this.sel[p], l.length - 1)] ?? null; }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      // A burst of saves (a checkout, an agent writing) is one refresh.
      try { while (this.watched === root && !this.closed) { this.watchTask = watchFolder(root); await this.watchTask; if (this.watched === root && this.configValue("git.autoRefresh",true) && !this.due && !this.busy && !this.closed) this.due = cx.timer.after(150, (cx) => { this.due = null; this.refresh(cx); }); } }
      catch { this.watched = null; }
    });
  }

  // force: read history again even though no ref moved (R, and after an action).
  refresh(cx, force = false) {
    if(this.externalJob){this.externalRefreshNeeded=true;return;}
    if (this.loading) { this.again = true; this.forceAgain ||= force; if (force && !this.settling && this.run) this.run.shown = true; return; }
    if (checking() || this.closed) return;
    const loc = this.location, { cwd, on } = loc;
    if (!cwd) { this.error = "No folder"; return; }
    this.loading = true;
    // Asked for (R, a page, another repository, the first read): shown at once.
    // The timer's and the watcher's own checks, and the one after an action
    // (the footer has that one): only once they take long.
    const run = this.run = { shown: !this.loaded || (force && !this.settling) };
    if (!run.shown) cx.timer.after(400, (cx) => { if (this.run === run && this.loading && !this.closed) { run.shown = true; cx.notify(); } });
    // Another repository was asked for meanwhile: `again` reads that one.
    const gone = () => this.location !== loc || this.closed;
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (gone()) return;
        if (top.code !== 0) { this.root = null; this.repoKey = null; this.files = []; this.nodes = []; this.branches = []; this.commits = []; this.stashes = []; this.branch = null; this.error = "Not a git repository"; return; }
        this.root = top.stdout.replace(/\n$/,""); this.on = on; this.repo = this.root.split("/").pop();
        this.repoKey = `${on ?? ""}:${this.root}`;
        keep(ROOTS, `${on ?? ""}:${cwd}`, this.repoKey, 64);
        const repo = keep(REPOS, this.repoKey, REPOS.get(this.repoKey) ?? { graphs: new Map() }, 8);
        const configChanged=await this.refreshConfiguration({cwd:this.root,on:this.on});
        if (gone()) return;
        await this.stageResolvedConflicts();
        if (gone()) return;
        const [status, cached, work, stash, mark] = await Promise.all([
          (async () => {
            const setting = await this.git(["config", "--get", "status.showUntrackedFiles"]);
            const untracked = this.fileStatus === "untracked" ? "all" : setting.stdout.trim() || "all";
            return this.boundedGit(["status", "--porcelain=v1", "-z", "-b", `--find-renames=${this.renameThreshold}%`, `--untracked-files=${untracked}`]);
          })(),
          this.boundedGit(["diff", "--cached", "--numstat", "-z", "--no-renames"]),
          this.boundedGit(["diff", "--numstat", "-z", "--no-renames"]),
          // With its commit and the one it was made on: the graph hangs it there.
          // No %gd: with a date format it prints stash@{<date>}, so the ref is counted.
          this.boundedGit(["stash", "list", "-n", "300", "--format=%cr%x1f%gs%x1f%H%x1f%P%x1f%an%x1f%cd", DATE]),
          this.mark(),
        ]);
        if (gone()) return;
        if (status.code !== 0) throw new Error(status.stderr.trim());
        this.hasHead = Boolean(mark.head); this.head = mark.head;
        this.lastRefMark=mark.refs; this.lastRefresh=Date.now();
        const sStats = numstat(cached.stdout), wStats = numstat(work.stdout);
        const parsed = parseStatus(status.stdout, sStats, wStats), b = parsed.branch;
        this.filesLimited = status.truncated || parsed.limited;
        const m = /^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(b) ?? [];
        this.branch = { name: m[1] ?? "?", upstream: m[2] ?? null,
          ahead: Number(/ahead (\d+)/.exec(m[3] ?? "")?.[1] ?? 0), behind: Number(/behind (\d+)/.exec(m[3] ?? "")?.[1] ?? 0) };
        const keepAt = this.item("files")?.key;
        const previousFiles = this.files;
        this.files = parsed.files; this.updateFileFilter(previousFiles);
        this.layoutFiles(keepAt);
        this.stashes = stash.stdout.split("\n").filter(Boolean).map((l, n) => { const [when, subject, hash, parents, who, date] = l.split("\x1f"); return { ref: `stash@{${n}}`, when, subject, hash, base: (parents ?? "").split(" ")[0], who, date }; });
        // Branches and commits come from history: read only when a ref moved.
        let hist = repo.hist;
        if (force || configChanged || !mark.refs || hist?.refs !== mark.refs || hist?.limit !== this.commitLimit || Date.now() - hist.at > HISTORY_AGE) {
          const [refs, log, ahead] = await Promise.all([
            this.boundedGit(["for-each-ref", "--count=1000", "--sort=-committerdate", "refs/heads", "--format=%(HEAD)%1f%(refname:short)%1f%(committerdate:relative)%1f%(upstream:track,nobracket)%1f%(refname)%1f%(objectname)"]),
            this.boundedGit(["log", ...this.historyOrder(), ...(this.configValue("git.log.showWholeGraph",false)?["--all"]:[]), "-n", String(this.commitLimit+1), "--pretty=format:%H%x1f%s%x1f%an%x1f%cr"], Math.min(8_000_000,this.commitLimit*1024)),
            this.git(["rev-list", "-n", "300", "@{upstream}..HEAD"]),
          ]);
          const local = new Set(ahead.code === 0 ? ahead.stdout.split("\n").filter(Boolean) : []);
          if (force || hist?.refs !== mark.refs) repo.graphs.clear();
          hist = repo.hist = { refs: mark.refs, at: Date.now(), limit:this.commitLimit, more:log.stdout.split("\n").filter(Boolean).length>this.commitLimit,
            branches: refs.stdout.split("\n").filter(Boolean).map((l) => { const [h, _short, when, track, ref, hash] = l.split("\x1f"); return { current: h === "*", name:ref.replace(/^refs\/heads\//,""), when, track, ref, hash }; }),
            commits: this.hasHead && log.code === 0 ? log.stdout.split("\n").filter(Boolean).slice(0,this.commitLimit).map((l) => {
              const [hash, subject, who, when] = l.split("\x1f");
              return { hash, subject, who, when, unpushed: !this.branch.upstream || local.has(hash) };
            }) : [] };
        }
        this.branches = hist.branches; this.commits = hist.commits; this.moreCommits = hist.more;
        await this.refreshFeatures();
        if (gone()) return;
        this.offerContinue(previousFiles,cx);
        for (const p of PANELS) this.clampRange(p);
        this.finishRangeRefresh(cx);
        this.error = null; this.stale = true; this.loaded = true;
        repo.snap = { root: this.root, on: this.on, repo: this.repo, files: this.files, branches: this.branches, commits: this.commits,
          stashes: this.stashes, branch: this.branch, hasHead: this.hasHead, head: this.head };
        this.watch(this.root, cx);
        await this.load(cx);
      } catch (e) { this.error = String(e?.message ?? e); }
      finally {
        this.loading = false;
        if (this.again) { const f = this.forceAgain; this.again = false; this.forceAgain = false; this.refresh(cx, f); }
        else { this.run = null; this.settling = null; this.paging = false; if(this.externalSettling){this.externalSettling=null;this.busy=null;} }
        cx.notify();
      }
    });
  }

  // ---------- main view ----------

  source() {
    const graphFile=this.graphFileSource();if(graphFile)return graphFile;
    const p = this.panel, it = this.item(p);
    const feature = this.featureSource(); if (feature) return feature;
    const patch = (hash) => ["show", "--no-color", "--no-ext-diff", "--stat", "--patch", "--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n    %s%n%n%b", hash];
    // keep: the commit a patch is of; its lines are kept under it (PATCHES).
    // A commit opened from the graph.
    if (this.peek?.stash) return { key: `s:${this.peek.stash}`, title: "Stash", keep: this.peek.hash, args: ["stash", "show", "-p", "--no-color", "--include-untracked", this.peek.stash] };
    if (this.peek) return { key: `c:${this.peek.hash}`, title: "Patch", subject: this.peek.subject, hash: this.peek.hash.slice(0, 7), keep: this.peek.hash, args: patch(this.peek.hash) };
    if (p === "status") return { key: "status", title: "Graph", graph: ["--branches", "--remotes", "--tags", "HEAD"], graphAll: true };
    if (!it) return null;
    if (p === "files") {
      if (it.dir) return { key: `d:${it.path}`, title: `${it.name}/`, args: ["diff", this.hasHead ? "HEAD" : "--cached", "--no-ext-diff", "--no-color", "--stat", "--patch", "--", it.path] };
      const f = it.file;
      if (f.directory) return {key:`directory:${f.path}`,title:f.path, args:["ls-files","--others","--exclude-standard","--",f.path]};
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
    if(!src?.graph&&!src?.graphFile)this.resetGraph();
    if (!src) { this.setLines([]); this.md = null; this.graph = null; this.shown = null; this.patch = null; this.conflicts = null; this.diffFile = null; this.historyPatch = null; return; }
    if (src.key === this.shown && !this.stale) return;
    let lines = null, md = null, graph = null, filePatch = null, historyPatch = null;
    const repoKey = this.repoKey;
    // A held j or k asks for every row on the way: while one is being read,
    // the next waits a moment and is dropped if the selection has moved on.
    // Shown once it has taken long enough to notice; the newest read owns it.
    const wait = this.wait = { key: src.key, shown: false };
    cx.timer.after(180, (cx) => { if (this.wait === wait && this.reading > 0 && !this.closed) { wait.shown = true; cx.notify(); } });
    if (this.reading) { await pause(cx, 70); if (this.source()?.key !== src.key) return; }
    this.reading = (this.reading ?? 0) + 1;
    try {
      if (src.text) lines = src.text;
      else if (src.markdown) md = await this.markdown(`${this.root}/${src.file.path}`, async () => { wait.shown = true; cx.notify(); await pause(cx, 16); });
      else if (src.file) {
        filePatch = await this.readFilePatch(src.file); lines = filePatch.lines;
      } else if (src.range) {
        const context={cwd:this.root,on:this.on},base=await this.commitDiffBase(src.range.from,context);
        const r=await this.boundedGit(this.withDiffOptions(["diff","--no-ext-diff","--no-textconv","--no-color",`--find-renames=${this.renameThreshold??50}%`,"--stat","--patch",base,src.range.to,"--"]),262144,context);
        if(r.code)throw new Error(r.stderr||r.stdout);
        lines=r.stdout.replace(/\n$/,"").split("\n");if(r.truncated||lines.length>4000)lines=[...lines.slice(0,4000),"Diff exceeds the preview limit"];
      } else if (src.custom) {
        const r = await this.boundedGit(["--literal-pathspecs",...this.withDiffOptions(src.args)]);
        if (r.code !== 0 && !(src.allowDifferences && r.code===1)) throw new Error(r.stderr || r.stdout);
        lines = r.stdout.replace(/\n$/, "").split("\n");
        if (!src.folder) historyPatch = {patch: r.truncated || lines.length > 4000 ? null : parsePatch(r.stdout), ref:src.ref, path:src.path, canRebase:src.canRebase};
      } else if (src.graph) {
        if (!this.hasHead) graph = layout([]);
        else {
          // The commits are kept until a ref moves; the graph drawn from them
          // until a stash, HEAD or having uncommitted changes does (`with`).
          const repo = REPOS.get(this.repoKey), refs = repo?.hist?.refs;
          const query = graphHistoryQuery({refs:src.graphAll ? null : src.graph, limit:this.graphLimits.get(src.key) ?? GRAPH_INITIAL_LIMIT, format:GRAPH_FORMAT, date:DATE, stashBases:this.stashes.map(st=>st.base)}), name=query.key;
          let kept = refs ? recall(repo.graphs, name) : null;
          if (kept?.refs !== refs) kept = null;
          if (!kept) {
            const r = await this.boundedGit(query.args, Math.min(8_000_000,query.limit*1800));
            if (r.code !== 0) lines = r.stderr.replace(/\n$/, "").split("\n");
            else { kept = { refs, ...graphHistoryPage(parseLog(r.stdout),query.limit,{truncated:r.truncated}) }; if (refs && repo.hist?.refs === refs) keep(repo.graphs, name, kept, 12); }
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
              kept.graph = {...layout(commits), more:kept.hasMore, truncated:kept.truncated}; kept.with = made;
            }
            graph = kept.graph;
          }
        }
      } else {
        const at = src.keep ? `${this.repoKey}\n${src.keep}\n${this.diffStyleKey()}` : null;
        lines = at ? recall(PATCHES, at) ?? null : null;
        if (!lines) {
          const r = await this.top(this.withDiffOptions(src.args), 4000);
          lines = r.lines.map((l) => l.length > 4000 ? l.slice(0, 4000) + "…" : l);
          const chars = lines.reduce((n, l) => n + l.length, 0);
          if (at && r.ok && chars < 1_000_000) keepPatch(at, lines, chars);
        }
      }
    } catch (e) { lines = [`Cannot show this: ${e?.message ?? e}`]; }
    finally { this.reading--; }
    if (this.wait !== wait || this.repoKey !== repoKey || this.source()?.key !== src.key || this.closed) return;
    const fresh = src.key !== this.shown;
    this.shown = src.key; this.stale = false; this.md = md; this.graph = graph;
    if (filePatch) this.setFilePatch(filePatch); else { this.patch = null; this.conflicts = null; this.diffFile = null; }
    this.historyPatch = historyPatch;
    if (graph) {
      this.syncGraph(cx,src.key);
      this.setLines([]);
      // Back from a commit: the cursor returns to it.
      if (fresh) { this.cursor = this.graphAt ?? 0; this.graphAt = null; }
      this.cursor = Math.max(0, Math.min(this.cursor, graph.rows.length - 1));
      if (fresh) this.graphScroll.scroll_to_item(this.graphDisplayIndex(this.cursor), "center");
      this.match();
    } else if (lines) {
      this.setLines(lines.slice(0, 4000));
      if (filePatch && lines.length > 4000) { this.patch = null; this.patchTruncated = true; }
      if (fresh) { this.cursor = this.activePatch()?.hunks[0]?.row ?? 0; this.conflictAt = 0; this.diffScroll.scroll_to_item(this.cursor); }
      this.cursor = Math.max(0, Math.min(this.cursor, this.rows.length - 1));
      if (this.patch?.hunks.length && !this.patch.hunks.some(h => this.cursor >= h.row && this.cursor <= (h.lines.at(-1)?.row ?? h.row))) this.cursor = this.patch.hunks[0].row;
    }
    else { this.setLines([]); if (fresh) this.mdScroll.scroll_to_item(0); }
  }

  // Markdown segments: text, or Mermaid diagrams as SVGs in the hidden cache.
  // heavy: called before diagrams are drawn. Drawing holds the script, so the
  // wait has to be on screen first.
  async markdown(file, heavy) {
    const text = await readTextFile(file, { on: this.on });
    if (heavy && /^\s*```mermaid/m.test(text)) await heavy();
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
    this.rawDiffLines=lines;
    this.rows = diffRows(lines).map(row=>row.text.length>4000?{...row,text:row.text.slice(0,4000)+"…"}:row);
    this.diffWidth = Math.max(300, ...this.rows.map((r) => (r.text.length + 1) * 7.5 + 90));
  }

  show(cx) { cx.spawn(async (cx) => { await this.load(cx); cx.notify(); }); }
  reload(cx) { this.stale = true; cx.spawn(async (cx) => { await this.load(cx); cx.notify(); }); cx.notify(); }

  // ---------- navigation ----------

  move(to, cx, selecting = false) {
    this.pending = null;
    if (this.main) return this.scrollMain(to - this.cursor, cx);
    if (!selecting && this.rangeModes[this.viewKey()] === "nonsticky") this.cancelRange();
    this.peek = null;
    this.graphFile=null;
    this.diffSide = null; this.anchor = null;
    const n = this.list().length;
    if (!n) return;
    this.sel[this.panel] = Math.max(0, Math.min(to, n - 1));
    this.syncContext();
    if (this.sel[this.panel] >= n - 15) {
      if(this.context())this.extendContext(cx);
      else if(this.panel==="commits" && (this.commitView==="commits"?this.moreCommits:this.moreReflog)) this.pageCommits(cx);
    }
    this.scroll[this.panel].scroll_to_item(this.sel[this.panel]);
    cx.spawn(async (cx) => { await this.load(cx); cx.notify(); });
    cx.notify();
  }

  scrollMain(by, cx) {
    if (this.graph) {
      if (!this.graph.rows.length) return;
      this.cursor = Math.max(0, Math.min(this.cursor + by, this.graph.rows.length - 1));
      this.graphScroll.scroll_to_item(this.graphDisplayIndex(this.cursor));
      if (this.cursor >= this.graph.rows.length - 15) this.moreGraph(cx);
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
    this.graphFile=null;
    this.panel = panel; this.main = false; this.pending = null; this.help = false; this.peek = null;
    this.panelSearchOpen = false; this.diffSide = null; this.logOpen = false; this.syncContext(); this.historyPatch = null;
    this.reload(cx);
  }
  // Graph details open inline, independently of Lazygit's side-panel context.
  openCommit(cx) {
    const cm = this.graph?.rows[this.cursor]?.commit;
    if (!cm) return;
    this.inspectGraphCommit(cm.hash,{},cx);
  }
  closeCommit(cx) { this.peek = null; this.reload(cx); }

  // Git Graph's commit actions, on the graph's selected row: a commit, a
  // stash, or the uncommitted changes.
  graphKeys(cx) {
    const cm = this.graph.rows[this.cursor]?.commit, wip = cm?.hash === UNCOMMITTED, stash = cm?.stash;
    const real = cm && !wip && !stash ? this.graphCommitTarget(cm) : null, short = cm?.hash.slice(0, 7);
    const checkout = () => {
      if (stash) return this.stashAction("apply",{ref:stash,hash:cm.hash},cx);
      if (real) this.graphCheckoutCommit(real,cx);
    };
    const keys = {
      g: () => this.move(0, cx), G: () => this.move(this.graph.rows.length - 1, cx),
      "/": () => this.startFind(cx), n: () => this.nextMatch(1, cx), N: () => this.nextMatch(-1, cx),
      " ": checkout, space: checkout,
      b: () => real && this.graphCreateBranch(real,cx),
      c: () => real && this.graphCherryPick(real,cx),
      t: () => real && this.graphRevert(real,cx),
      r: () => real && this.graphReset(real,cx),
      y: () => { if (cm && !wip) { cx.write_to_clipboard(cm.hash); this.info = `Copied ${short}`; this.note = null; cx.notify(); } },
    };
    // The same actions as a menu: right-click (at the pointer) or m (centered).
    keys.menu = (at = {}) => {
      if (!cm) return;
      if(real)return this.graphCommitMenu(real,cx,at);
      if(stash)return this.graphReferenceMenu({kind:"stash",name:stash,ref:stash,hash:cm.hash,repo:this.repoKey,root:this.root,on:this.on},cx);
      this.graphWorktreeMenu(cx,at);
    };
    keys.m = () => keys.menu();
    return keys;
  }

  // A small menu inside the dialog: { x, y (absent: centered), title, items }.
  openMenu(menu, cx) { this.menu = { sel: 0, query:"", searchOpen:false, ...menu }; this.menuSearch.set_value(""); this.handle.focus(); cx.notify(); }
  cancelMenu(cx) { const menu=this.menu;this.menu=null;menu?.onCancel?.();this.handle.focus();cx.notify(); }
  cancelConfirmation(cx) { const pending=this.pending;this.pending=null;pending?.onCancel?.();this.handle.focus();cx.notify(); }
  menuEntries() {return this.filterItems(this.menu?.items??[],this.menu?.query??"",it=>it.label);}
  pickMenu(n, cx) {
    const it=this.menuEntries()[n];if(!it)return;
    if(it.disabled)return this.say(it.disabled,cx);
    this.menu=null;this.handle.focus();cx.notify();it.run(cx);
  }
  step(by, cx) { this.goto(PANELS[(PANELS.indexOf(this.panel) + by + PANELS.length) % PANELS.length], cx); }

  // ---------- actions ----------

  act(label, steps, cx, opts = {}) {
    this.perform(label, steps, cx, opts);
  }

  ask(title, text, then, cx) { this.pending = { title, text, then }; cx.notify(); }

  ask2(kind, title, cx) {
    this.writeError = null;
    this.openPrompt({kind,title},kind==="commit"?this.commitDraft??"":"",cx);
  }

  submit(cx) {
    const p = this.prompt, msg = p?.raw ? this.message : this.message.trim();
    if (!p) return;
    if (this.busy) return;
    if (p.kind === "value") {
      if (!msg && !p.empty) return;
      this.prompt = null; this.handle.focus(); p.submit(msg, cx); cx.notify(); return;
    }
    const clear = () => { this.prompt = null; this.message = ""; this.input.set_value(""); this.handle.focus(); };
    if (p.kind === "commit") {
      if (!msg) return this.generate(cx); // Enter on an empty summary writes one
      const commit = (cx) => this.act("Commit", [["commit", ...(this.configValue("git.commit.signOff",false)?["--signoff"]:[]), "-m", msg, ...(this.commitBody?.trim() ? ["-m", this.commitBody.trim()] : [])]], cx, { done: "Committed", after: () => { this.commitDraft = ""; this.commitBody = ""; this.bodyInput.set_value(""); } });
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
    if (p?.kind !== "commit" || this.writing === p || !this.root) return;
    const root = this.root, on = this.on;
    if (!this.files.some((f) => f.staged)) { this.writeError = "Stage changes before writing a commit summary"; cx.notify(); return; }
    const current = () => this.prompt === p && this.root === root;
    this.writing = p; this.note = null; // whose summary is being written: a later prompt is not waiting for it
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
      finally { if (this.writing === p) this.writing = null; cx.notify(); }
    });
    this.writeError = null; cx.notify();
  }

  cancelPrompt(cx) { const prompt=this.prompt;if (prompt?.kind === "commit") this.commitDraft = this.message; this.prompt = null;this.message = ""; this.input.set_value(""); this.handle.focus();prompt?.onCancel?.(cx);cx.notify(); }

  // A file, or everything shown under a folder.
  toggleFile(node, cx) {
    if (!node) return;
    if (node.file?.conflict) return node.file.inlineConflict ? this.focusDiff(cx) : this.conflictMenu(cx);
    this.toggleFiles(node.dir ? node.files : [node.file], false, cx);
  }

  toggleAll(cx) {
    const files=this.visibleFiles();if(!files.length)return;
    if(this.filter.trim())return this.toggleFiles(files,true,cx);
    if(files.some(f=>f.conflict))return this.say("Resolve conflicts before staging this selection",cx);
    const staging=files.some(f=>f.unstaged||f.fresh);
    this.act(staging?"Stage all":"Unstage all",[staging?["add",this.fileStatus==="tracked"?"-u":"-A"]:["reset"]],cx);
  }
  toggleFiles(files, all, cx) {
    const staging = files.some((f) => f.unstaged || f.fresh), selected = files.filter((f) => staging ? f.unstaged || f.fresh : f.staged);
    if (!selected.length) return;
    if (staging && selected.some((f) => f.conflict)) return this.say("Resolve conflicts before staging this selection", cx);
    // Explicit paths preserve status and path filters, including hidden untracked files.
    const paths = staging ? selected.map((f) => f.path) : filePaths(selected);
    this.act(`${staging ? "Stage" : "Unstage"}${all ? " all" : ""}`, [staging ? ["--literal-pathspecs", "add", "-A", "--", ...paths]
      : this.hasHead ? ["--literal-pathspecs", "restore", "--staged", "--", ...paths] : ["--literal-pathspecs", "rm", "-r", "--cached", "-q", "--", ...paths]], cx);
  }

  discard(f, cx) {
    if (!f) return;
    const steps = f.fresh ? [["clean", "-f", "-q", "--", f.path]]
      : f.x === "A" ? [["rm", "-f", "-q", "--", f.path]]
      : !this.hasHead ? [["restore", "--", f.path]]
      : [["restore", "--source=HEAD", "--staged", "--worktree", "--", ...filePaths([f])]];
    this.ask("Discard changes", `Discard all changes to ${f.path}?`, (cx) => this.act("Discard", steps, cx, { done: `Discarded ${f.path}` }), cx);
  }

  push(cx) { this.act("Push", this.branch?.upstream ? [["push"]] : [["push", "-u", "origin", "HEAD"]], cx, { network: true, done: "Pushed" }); }

  close() { if(this.closed)return;this.closed = true;this.dismissArchive();this.cancelRefPlan();this.resetGraph();this.graphDetailsView?.release();this.gitTerminalOnClose();this.cancelConfiguredCommand();for(const capture of this.commandCaptures??[])capture.timer?.cancel(); this.watched = null; this.watchTask?.cancel(); const o = props()?.overlay; if (o) closeOverlay(o); }

  keys(e, cx) {
    if(this.archive)return this.archiveKeys(e,cx);
    if(e.key==="escape"&&this.cancelRefPlan(cx)){cx.stop_propagation();return;}
    if(this.customFlowKeys(e,cx)){cx.stop_propagation();return;}
    if(this.dispatchConfiguredKey(e,cx)){cx.stop_propagation();return;}
    if (this.typing) {
      if(this.menu&&e.key==="enter"){this.pickMenu(this.menu.sel,cx);return cx.stop_propagation();}
      if ((e.modifiers?.platform || e.modifiers?.control) && e.key === "enter") { this.submit(cx); return cx.stop_propagation(); }
      // Escape steps back out of the field only: the prompt or search stays, with its text.
      if (e.key === "escape") { if(this.prompt)this.prompt.focusPending=false;this.typing = false; this.searching = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); }
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
      else if (k === "escape" || ch === "n" || ch === "q") this.cancelConfirmation(cx);
      return done();
    }
    if (this.menu) {
      const mn = this.menu, entries=this.menuEntries(), last = entries.length - 1;
      const shortcut = entries.findIndex((item) => item.key === ch);
      if (shortcut >= 0) return this.pickMenu(shortcut, cx), done();
      if (k === "escape" && mn.searchOpen) {mn.searchOpen=false;mn.query="";this.menuSearch.set_value("");mn.sel=0;}
      else if (k === "escape" || ch === "q") this.cancelMenu(cx);
      else if(ch==="/"){mn.searchOpen=true;this.menuSearch.focus();}
      else if (ch === "j" || k === "down") mn.sel = Math.min(mn.sel + 1, last);
      else if (ch === "k" || k === "up") mn.sel = Math.max(mn.sel - 1, 0);
      else if (ch === "g") mn.sel = 0; else if (ch === "G") mn.sel = last;
      else if (k === "enter" || k === "space" || ch === " ") return this.pickMenu(mn.sel, cx), done();
      this.menuScroll.scroll_to_item(mn.sel); cx.notify(); return done();
    }
    if (this.help) { if (k === "escape" || ch === "?" || ch === "q" || ch === "x") { this.help = false; cx.notify(); } return done(); }
    if(k==="escape"&&this.graphFile){this.closeGraphFile(cx);return done();}
    if(k==="escape"&&this.graphInspection&&!(this.main&&this.graph&&(this.query||this.findOpen))){this.closeGraphInspection(cx);return done();}
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
      f: () => this.fetch(cx),
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
      files: this.fileView === "files" ? {
        " ": () => this.toggleSelectedFiles(cx), space: () => this.toggleSelectedFiles(cx), a: () => this.toggleAll(cx),
        c: () => this.files.length ? this.ask2("commit", "Commit summary", cx) : (this.note = "Nothing to commit", cx.notify()),
        C: () => this.files.length ? this.ask2("commit", "Commit summary", cx) : (this.note = "Nothing to commit", cx.notify()),
        A: () => this.hasHead && this.ask("Amend last commit", `Amend HEAD (${this.head?.slice(0,7)}) with the staged changes?`, (cx) => this.act("Amend", [["commit", "--amend", "--no-edit"]], cx, { done: "Amended" }), cx),
        d: () => this.discardFilesMenu(cx),
        enter: () => { if(this.multipleSelected())this.say("This action requires a single selected item",cx);else if (it?.dir) this.fold(it, cx); else if (it) { this.main = true; cx.notify(); } },
        "`": () => this.setTree(!this.tree, cx), "-": () => this.tree && this.foldAll(true, cx), "=": () => this.tree && this.foldAll(false, cx),
        "/": () => this.startSearch(cx), "+": () => this.setWide(!this.wide, cx),
        D: () => this.ask("Discard all changes", "Discard ALL changes, including untracked files? (reset --hard, clean -fd)", (cx) => this.act("Discard all", [["reset", "--hard", "-q"], ["clean", "-fd", "-q"]], cx, { done: "Discarded all changes" }), cx),
        s: () => this.files.length && this.ask2("stash", "Stash changes (optional message)", cx),
        S: () => this.files.some((f) => f.staged) ? this.ask2("stash-staged", "Stash staged changes (optional message)", cx) : (this.note = "Nothing staged", cx.notify()),
        e: () => this.editSelectedFiles(cx),
        o: () => this.openSelectedFile(cx),
        i: () => this.ignoreFileMenu(cx),
        t: () => { if (file && isMarkdown(file.path)) { this.mdMode = !this.mdMode; this.reload(cx); } },
      } : {},
      branches: this.branchView === "local" ? {
        " ": () => it && !it.current && this.act("Checkout", [["checkout", it.name]], cx, { done: `Switched to ${it.name}` }),
        space: () => it && !it.current && this.act("Checkout", [["checkout", it.name]], cx, { done: `Switched to ${it.name}` }),
        n: () => this.ask2("branch", "New branch name", cx),
        d: () => it && !it.current && this.ask("Delete branch", `Delete branch ${it.name}?`, (cx) => this.act("Delete branch", [["branch", "-d", it.name]], cx, { done: `Deleted ${it.name}` }), cx),
      } : {},
      stash: {
        " ": () => it && this.act("Apply stash", [["stash", "apply", it.ref]], cx, { done: `Applied ${it.ref}` }),
        space: () => it && this.act("Apply stash", [["stash", "apply", it.ref]], cx, { done: `Applied ${it.ref}` }),
        g: () => it && this.ask("Pop stash", `Pop ${it.ref}?`, (cx) => this.act("Pop stash", [["stash", "pop", it.ref]], cx, { done: `Popped ${it.ref}` }), cx),
        d: () => it && this.ask("Drop stash", `Drop ${it.ref}?`, (cx) => this.act("Drop stash", [["stash", "drop", it.ref]], cx, { done: `Dropped ${it.ref}` }), cx),
      },
    };
    const graph = this.main && this.graph ? this.graphKeys(cx) : {};
    const fn = (ch !== "menu" && graph[ch]) || (k !== "menu" && graph[k]) || (!this.main && !this.context() && panel[this.panel]?.[ch]) || (!this.main && !this.context() && panel[this.panel]?.[k]) || global[ch] || named[k];
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
        .when(Boolean(opts.loading), (e) => e.child(this.spinner(c)))
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
      .on_mouse_up("left", () => { if (this.listPointer?.panel === panel) this.listPointer.released = true; })
      .on_hover(hovered => { if (!hovered && this.listPointer?.panel === panel) this.listPointer = null; })
      .child(v_flex().id(`list-${panel}`).absolute().inset_0().overflow_y_scroll().track_scroll(this.scroll[panel]).py(4)
        .children(items.map((it, n) => {
          const on = n === this.sel[panel];
          return h_flex().id(`${panel}-${n}`).h(28).flex_none().mx(6).px(8).gap(8).items_center().rounded(7).cursor_pointer()
            .when(on || this.inRange(panel,n), (e) => e.bg(active ? c.selected : c.raised)).hover((s) => s.bg(on ? (active ? c.selected : c.raised) : c.hover))
            .on_mouse_down("left", (e,cx) => this.beginListPointer(panel,n,e,cx))
            .on_mouse_move((e,cx) => this.extendListPointer(panel,n,e,cx))
            .on_click((e,cx) => this.clickListRow(panel,n,e,cx))
            .on_mouse_down("right", (_e, cx) => { this.listPointer=null; if(!this.inRange(panel,n)){this.cancelRange(panel);this.sel[panel]=n;} this.handle.focus(); this.panel = panel; this.main = false; this.syncContext(); this.peek = null; this.diffSide = null; this.anchor = null; this.show(cx); if(this.context())this.menuItems(this.context().title,this.contextActions(cx),cx); else if (panel === "branches") this.menuItems(this.branchContext(), this.branchActions(cx), cx); else if (panel === "commits") this.menuItems(it.subject, this.commitActions(it,cx), cx); else if (panel === "files") this.menuItems(this.fileView === "files" ? "File actions" : this.fileView, this.fileView === "files" ? this.fileActions(cx) : this.repositoryActions(cx),cx); else if (panel === "stash") this.menuItems("Stash actions",this.stashActions(cx),cx); cx.stop_propagation(); })
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
      .on_click((_e, cx) => { cx.stop_propagation(); this.listPointer=null; this.cancelRange("files"); this.panel = "files"; this.main=false; this.move(n, cx); this.toggleFile(node, cx); });
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
    const letter = f.unstaged ? f.y : f.x;
    return [
      ...indent,
      check,
      h_flex().w(22).flex_none().font_family(c.mono).text_size(11)
        .child(div().w(11).text_color(f.conflict ? c.red : c.green).child(f.x))
        .child(div().w(11).text_color(f.conflict ? c.red : f.fresh ? c.cyan : c.red).child(f.y)),
      h_flex().flex_1().min_w(0)
        .child(div().min_w(0).truncate().text_color(letter === "D" ? c.muted : c.foreground).child(f.previousPath ? `${f.previousPath} → ${node.name}` : `${node.name}${f.directory ? "/" : ""}`))
        .when(Boolean(node.where), (e) => e.child(div().ml(6).min_w(0).truncate().text_size(11).text_color(c.dim).child(node.where))),
      ...stats,
    ];
  }

  // The theme's green, red and blue: faint on the line, stronger in the gutter.
  // A theme color that is not #rrggbb falls back to GitHub's dark diff colors.
  diffRow(row, index, c) {
    const { kind, number, text } = row, at = this.main && (index === this.cursor || this.diffSelection?.has(index));
    const flash=this.editedLine?.lines===this.rawDiffLines&&this.editedLine?.index===index;
    const hex = (color, fallback) => (/^#[0-9a-f]{6}$/i.test(color ?? "") ? color : fallback);
    const green = hex(c.green, "#3fb950"), red = hex(c.red, "#f85149"), blue = hex(c.ansi4, "#388bfd");
    const ADD = { line: `${green}33`, gutter: `${green}59`, sign: green };
    const DEL = { line: `${red}33`, gutter: `${red}59`, sign: red };
    if (kind === "@") return div().w_full().px(12).h(22).flex_none().flex().items_center().truncate()
      .bg(flash?c.accent+"55":at ? c.selected : `${blue}1f`).text_color(hex(c.ansi12, blue)).child(text);
    const meta = kind === "" && /^(commit |diff --git|index |--- |\+\+\+ |Author:|Date:)/.test(text);
    const tone = kind === "+" ? ADD : kind === "-" ? DEL : null;
    return h_flex().w_full().h(22).flex_none().items_center()
      .when(Boolean(tone), (e) => e.bg(tone.line)).when(at, (e) => e.bg(c.selected)).when(flash,e=>e.bg(c.accent+"55"))
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
          .children(this.md.map((seg, n) => seg.kind === "md" ? TextView.markdown(`git-md-${n}`, seg.text).selectable(true).text_size(18).line_height("30px").on_link_click((url,cx)=>this.openLink(url,cx))
            : seg.kind === "diagram" ? h_flex().w_full().justify_center().py(20).child(image(seg.src).w(seg.w).h(seg.h))
            : v_flex().p(12).gap(4).rounded(8).border_1().border_color(c.red).child(div().text_color(c.red).text_size(12).child("Mermaid error")).child(div().text_color(c.muted).text_size(12).child(seg.text))))))
      .child(Scrollbar.vertical("git-md").absolute().inset_0());
    if (this.graph) return this.graphView(c);
    this.diffSelection = new Set(this.selectedRows());
    return div().size_full().relative().font_family(c.mono).text_size(12)
      .child(div().id("git-diff-x").size_full().overflow_x_scrollbar()
        .on_mouse_down("left",e=>{this.diffClickModifiers={...e.modifiers};})
        .child(div().w_full().min_w(this.diffWidth).h_full().child(v_virtual_list("git-diff", this.rows.length, 22, (n) => String(n),
          (range) => this.rows.slice(range.start, range.end).map((row, k) => this.diffRow(row, range.start + k, c)))
            .on_item_click((key, cx) => { const modifiers=this.diffClickModifiers;this.diffClickModifiers=null;this.clickDiff(Number(key),modifiers,cx); })
            .track_scroll(this.diffScroll).size_full())))
      .child(Scrollbar.vertical("git-diff").viewport_from_layout().absolute().inset_0())
      .when(!this.rows.length, (e) => e.child(div().absolute().top(10).px(14).text_color(c.dim).child(this.error ?? (this.reading > 0 || (this.loading && !this.loaded) ? "" : "Nothing to show"))));
  }

  // Git Graph's table: the graph, then description (labels and subject),
  // date, author and commit.
  moreGraph(cx) {
    const src=this.source();if(!src?.graph||!this.graph?.more||this.reading)return;
    this.graphLimits.set(src.key,(this.graphLimits.get(src.key)??GRAPH_INITIAL_LIMIT)+GRAPH_PAGE_SIZE);
    this.reload(cx);
  }
  graphView(c) {
    const g = this.graph, w = graphWidth(g.lanes);
    const palette = [c.ansi4, c.ansi5, c.ansi2, c.ansi3, c.ansi6, c.ansi1, c.ansi12, c.ansi13, c.ansi10, c.ansi11, c.ansi14, c.ansi9];
    const ink = (n) => n < 0 ? c.dim : palette[n % palette.length];
    const found = new Set(this.matches);
    const entries=g.rows.map((row,index)=>({key:row.commit.hash,row,index,height:ROW}));
    const primary=this.graphInspection?entries.findIndex(entry=>entry.key===this.graphInspection.primary):-1;
    if(primary>=0)entries.splice(primary+1,0,{key:`details:${this.graphInspection.primary}`,row:g.rows[primary],details:true,height:this.graphDetailsHeight});
    return v_flex().size_full().text_size(12)
      .when(this.findOpen || Boolean(this.query), (e) => e.child(h_flex().h(32).flex_none().px(12).gap(8).items_center().border_b(1).border_color(this.finding ? c.accent : c.border)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(svg("mods/workspace-chrome/search.svg").size(13).flex_none().text_color(this.finding ? c.accent : c.dim))
        .child(Input.new(this.find).flex_1().h_full().text_size(12).text_color(c.foreground))
        .child(div().flex_none().text_size(11).text_color(c.dim).child(this.query.trim() ? (found.size ? `${this.matches.indexOf(this.cursor) + 1 || "–"} of ${found.size}` : "No matches") : ""))))
      .child(v_flex().id("git-graph-horizontal").flex_1().min_h(0).overflow_x_scroll()
      .child(v_flex().w_full().min_w(w+600).h_full()
      .child(h_flex().h(26).flex_none().items_center().border_b(1).border_color(c.border).text_size(11).text_color(c.dim)
        .child(div().w(w).flex_none().pl(10).child("Graph"))
        .child(div().flex_1().min_w(0).child("Description"))
        .child(div().w(128).flex_none().child("Date"))
        .child(div().w(128).flex_none().child("Author"))
        .child(div().w(72).flex_none().child("Commit")))
      .child(div().flex_1().min_h(0).relative()
        .child(div().absolute().inset_0().on_click((event,cx)=>this.finishGraphClick(event,cx)).child(v_virtual_list("git-graph", entries.length, entries.map(entry=>entry.height), (n) => entries[n].key,
          (range) => entries.slice(range.start,range.end).map(entry=>entry.details?h_flex().w_full().h(entry.height).flex_none()
            .child(graphGap(entry.row,w,entry.height,ink)).child(div().flex_1().min_w(0).h_full().child(this.graphDetailsView))
            :this.graphRow(entry.row,entry.index,w,ink,c,found.has(entry.index))))
          // Item identity and modifiers arrive on separate, bubbling native callbacks.
          .on_item_click((key, _cx) => this.graphClickRow(key))
          // The row says which commit; the dialog's own handler (render) says where.
          .on_item_secondary_click((key, _e, cx) => {const index=this.graphOrder.indexOf(key);if(index<0)return;this.handle.focus();this.main=true;this.cursor=index;this.menuAsked=true;cx.notify();})
          .track_scroll(this.graphScroll).size_full()))
        .child(Scrollbar.vertical("git-graph").viewport_from_layout().absolute().inset_0())
        .when(!g.rows.length, (e) => e.child(div().absolute().top(10).px(14).text_color(c.dim).child("No commits yet")))))
      .when(Boolean(g.more),e=>e.child(h_flex().h(28).flex_none().px(12).items_center().child(this.reading ? this.waiting("Reading history",c) : div().id("graph-more").text_color(c.accent).cursor_pointer().on_click((_e,cx)=>this.moreGraph(cx)).child("Load more commits")))));
  }

  graphRow(row, n, w, ink, c, found) {
    const cm = row.commit, at = n === this.cursor, wip = cm.hash === UNCOMMITTED;
    const selected=this.graphInspection?.primary===cm.hash||this.graphInspection?.secondary===cm.hash;
    const bg = selected?c.selected:at ? (this.main ? c.selected : c.raised) : c.background;
    return h_flex().id(`graph-${cm.hash}`).w_full().h(ROW).flex_none().items_center().cursor_pointer()
      .when(found && !at && !selected, (e) => e.bg(c.yellow + "26")).when(at||selected, (e) => e.bg(bg)).hover((s) => s.bg(at||selected ? bg : c.hover))
      .child(graphCell(row, w, ink, bg, cm.hash === this.head))
      .child(h_flex().flex_1().min_w(0).pr(12).gap(6).items_center()
        .when(this.graphLabelViews.has(cm.hash),e=>e.child(div().flex_none().child(this.graphLabelViews.get(cm.hash))))
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
    const mn = this.menu, entries=this.menuEntries(), W = this.size?.width, H = this.size?.height, w = mn.pathLabels?Math.min(720,(W??752)-32):420, h = Math.min(entries.length * 28 + 62 + (mn.searchOpen?34:0), (H ?? 720) - 32);
    const place = (at, size, room) => at == null ? (room ? (room - size) / 2 : 240) : Math.max(8, Math.min(at, (room ?? 1e9) - size - 8));
    const shut = (_e, cx) => { this.menu = null; cx.stop_propagation(); cx.notify(); };
    return div().id("git-menu-back").absolute().inset_0().on_mouse_down("left", shut).on_mouse_down("right", shut)
      .child(v_flex().id("git-menu").absolute().left(place(mn.x, w, W)).top(place(mn.y, h, H)).w(w).h(h).pb(4).rounded(8).bg(c.popover).border_1().border_color(c.border).shadow_lg().text_size(12)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(div().h(30).flex_none().px(12).flex().items_center().border_b(1).border_color(c.border).mb(4).text_size(11).text_color(c.dim).truncate().child(mn.title))
        .when(mn.searchOpen,e=>e.child(Input.new(this.menuSearch).h(30).flex_none().mx(8).text_size(12)))
        .child(v_flex().id("git-menu-items").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.menuScroll).children(entries.map((it, n) => h_flex().id(`git-menu-${n}`).h(28).flex_none().mx(4).px(8).gap(8).items_center().rounded(5).cursor_pointer()
          .when(n === mn.sel, (e) => e.bg(c.selected)).hover((s) => s.bg(n === mn.sel ? c.selected : c.hover))
          .on_click((_e, cx) => this.pickMenu(n, cx))
          .child(div().flex_1().min_w(0).truncate().when(mn.pathLabels,e=>e.text_ellipsis_middle()).text_color(it.disabled ? c.dim : it.danger ? c.red : c.foreground).child(it.label))
          .child(div().flex_none().max_w(120).truncate().text_size(10.5).text_color(c.dim).child(it.hint ?? "")))))
        .child(div().h(20).px(12).flex_none().truncate().text_size(10.5).text_color(c.dim).child(entries[mn.sel]?.disabled??"/ filter · enter choose · esc back")));
  }

  kbd(k, c) {
    return div().flex_none().px(5).h(18).flex().items_center().rounded(4).bg(c.raised).border_1().border_color(c.border)
      .font_family(c.mono).text_size(10.5).text_color(c.muted).child(k);
  }

  button(id, label, c, onClick, opts = {}) {
    // busy: the action's label. While it runs, the spinner takes the key's place.
    const on = !this.busy || opts.duringBusy, spin = Boolean(opts.busy) && (this.busy === opts.busy || this.launching === opts.busy);
    return h_flex().id(id).h(28).px(10).gap(6).items_center().rounded(7).text_size(12)
      .bg(opts.primary ? c.solid : c.raised).text_color(opts.primary ? c.solid_foreground : on ? c.foreground : c.dim)
      .when(on, (e) => e.cursor_pointer().hover((s) => s.opacity(0.88)))
      .on_click((_e, cx) => { if (on) onClick(cx); })
      .child(label).when(spin || Boolean(opts.key), (e) => e.child(div().min_w(12).flex().items_center().justify_center().text_size(10.5).font_family(c.mono).text_color(opts.primary ? c.solid_foreground : c.dim)
        .child(spin ? this.spinner(c, 11, opts.primary ? c.solid_foreground : c.working) : opts.key)));
  }

  // Prompts and confirmations, styled like Herdr's confirm dialog.
  modal(c) {
    const p = this.prompt, q = this.pending, focusId=p?.focusId;
    if (!p && !q) return null;
    const writing = Boolean(p) && this.writing === p;
    const dbtn = (id, label, bg, fg, run) => h_flex().id(id).h(30).px(14).items_center().rounded(8).bg(bg).text_color(fg).cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => run(cx)).child(label);
    return div().id("git-modal-back").absolute().inset_0().flex().items_center().justify_center().bg(c.background + "88")
      .on_mouse_down("left",(_e,cx)=>cx.stop_propagation()).on_mouse_down("right",(_e,cx)=>cx.stop_propagation()).on_click((_e,cx)=>cx.stop_propagation())
      .child(v_flex().id("git-modal").w(520).p(18).gap(12).rounded(10).bg(c.popover).border_1().border_color(c.border).text_size(13)
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child(p ? p.title : q.title)).child(div().text_size(11).text_color(c.dim).child("Esc")))
        .when(Boolean(q), (e) => e.child(div().text_color(c.muted).child(q.text)))
        // The layout event supplies a live window even for prompts opened by child views.
        .when(Boolean(p), (e) => e.child(div().id(`git-prompt-field:${focusId}`).on_size_change((_size,cx)=>this.focusPrompt(p,focusId,cx))
          .h(34).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? c.accent : c.border).bg(c.surface)
          .child(Input.new(this.input).w_full().h_full().text_size(13).text_color(c.foreground))))
        .when(p?.kind === "commit", (e) => e.child(this.commitBodyView(c)))
        .when(Boolean(p?.suggestions?.length), (e) => e.child(this.suggestionView(c)))
        .when(p?.kind === "commit" && Boolean(this.writeError), (e) => e.child(div().text_size(11).text_color(c.ansi1 ?? c.blocked).child(this.writeError)))
        .child(h_flex().justify_end().items_center().gap(8).text_size(12)
          .when(p?.kind === "commit" && !shared("curtain")?.on, (e) => e.child(h_flex().id("m-write").h(30).px(10).gap(6).items_center().rounded(8).border_1().border_color(c.border).text_color(c.muted)
            .when(!writing, (b) => b.cursor_pointer().hover((s) => s.bg(c.hover).text_color(c.foreground))).on_click((_e, cx) => this.generate(cx))
            .child(writing ? this.spinner(c, 13) : svg("mods/git/sparkles.svg").size(13))
            .child(writing ? "Writing summary" : "Write summary")
            .when(!writing, (b) => b.child(div().text_size(10.5).text_color(c.dim).child("enter"))))
            // Who writes it: opens the Writer settings.
            .child(div().id("m-writer").flex_1().min_w(0).truncate().text_size(11).text_color(c.dim).cursor_pointer().hover((s) => s.text_color(c.foreground))
              .on_click(() => { setShared("config.page", "writer"); run("mod.open", { name: "config" }); }).child(shared("writer")?.label ?? "Claude Code · claude-haiku-5-5")))
          .child(dbtn("m-no", "Cancel", c.raised, c.foreground, (cx) => p ? this.cancelPrompt(cx) : this.cancelConfirmation(cx)))
          .child(dbtn("m-yes", p ? (p.kind === "commit" ? "Commit" : p.kind === "branch" ? "Create" : p.kind === "value" ? "Confirm" : "Stash") : "Confirm", c.solid, c.solid_foreground,
            (cx) => { if (p) this.submit(cx); else { const x = this.pending; this.pending = null; x.then(cx); } }))));
  }

  hints() {
    if (this.menu) return [["j k", "move"], ["enter", "choose"], ["/", "filter"], ["esc", "back"]];
    if (this.plan) return [["j k","commit"],["p r e s f d","action"],["ctrl-j/k","reorder"],["⌘↵","apply"],["esc","back"]];
    if (this.detail) return this.main ? [["space","mark patch"],["a","hunk / line"],["v","range"],["e","edit line"],["ctrl-p","patch options"],["esc","files"]] : [["j k","file"],["space","mark patch"],["a","all files"],["v","range"],["enter",this.item()?.dir?"fold":"open diff"],["`",this.commitFilesTree()?"flat":"tree"],["d","discard from commit"],["e","edit"],["esc","back"]];
    if (this.main && this.conflicts?.conflicts.length) return [["j k","conflict"],["o","ours"],["t","theirs"],["b","both"],["M","file options"],["m","continue / abort"],["esc","back"]];
    if (this.main && this.patch) return [["space",this.shownSide === "staged" ? "unstage" : "stage"],["a","hunk / line"],["v","range"],["tab","staged / unstaged"],["e","edit line"],["E","edit hunk"],["d","discard"],["c","commit"],["esc","back"]];
    if (this.main && this.graph) return [["j k", "commit"], ["enter", "view"], ["/", "find"], ...(this.query ? [["n N", "match"]] : []),
      ["space", "checkout"], ["b", "branch"], ["c", "cherry-pick"], ["t", "revert"], ["r", "reset"], ["m", "menu"], ["esc", this.query || this.findOpen ? "clear find" : "back"], ["?", "keys"]];
    if (this.main) return [["J K", "scroll"], ["j k", "line"], ["esc", this.peek ? "graph" : "back"], ["?", "keys"]];
    if (this.context()?.type === "commits") return [["j k","commit"],["enter","files"],["v","range"],["C","copy"],["g","reset"],["/","search"],["esc","back"]];
    if(this.item()?.todo)return [["j k","commit"],["p e s f d","action"],["ctrl-j/k","move"],["m","continue / abort"],["enter","files"]];
    if (this.panel === "files" && this.fileView !== "files") return [["[ ]","views"],["enter","open repository"],["m","actions"],["n","new"],["/","filter"],["?","keys"]];
    if (this.panel === "branches" && this.branchView === "remotes") return this.remoteContext
      ? [["enter","commits"],["esc","remotes"],["space","checkout"],["m","actions"],["/","filter"],["[ ]","views"]]
      : [["enter","branches"],["m","actions"],["n","new remote"],["f","fetch"],["/","filter"],["[ ]","views"]];
    return {
      status: [["enter", "graph"], ["e", "configuration"], ["f", "fetch"], ["p", "pull"], ["P", "push"], ["1-5", "panels"], ["?", "keys"], ["q", "close"]],
      files: [["[ ]","views"],["space", "stage"], ["a", "all"], ["v", "range"], ["c", "commit"], ...(this.item("files")?.dir ? [["enter", "fold"]] : [["d", "discard"], ["e", "edit"]]),
        ["ctrl-b", "status filter"], ["/", "path filter"], ["`", this.tree ? "flat" : "tree"], ["+", this.wide ? "all panels" : "expand"],
        ...(isMarkdown(this.item("files")?.file?.path ?? "") ? [["t", this.mdMode ? "diff" : "preview"]] : []), ["?", "keys"]],
      branches: [["[ ]","views"],["enter","commits"],["g","reset"],["m","actions"],["/","filter"],["space", "checkout"], ["n", "new"], ["?", "keys"]],
      commits: [["[ ]","reflog"],["enter","files"],["m","actions"],["C V","cherry-pick"],["v","range"],["g","reset"],["/",this.commitView==="commits"?"search":"filter"],["?", "keys"]],
      stash: [["space", "apply"], ["g", "pop"], ["d", "drop"], ["?", "keys"]],
    }[this.panel];
  }

  render(cx) {
    const c = this.colors(), b = this.branch, src = this.source();
    const act = (p) => this.panel === p && !this.main;
    // Files fills the side bar while it is the panel in use; 3, 4, 5 bring the rest back.
    const solo = this.wide && this.panel === "files";
    // An action from its key to the lists showing its result, then what it did.
    const working = this.busy ?? this.launching ?? this.settling;
    const status = this.note ? { text: this.note, color: c.red } : working ? { text: working, color: c.foreground, spin: true } : this.info ? { text: this.info, color: c.green } : null;
    const terminalRunning=Boolean(this.gitTask?.terminal&&!this.gitTask.finished);
    // The first read of a repository: nothing is known yet, so no panel says "none".
    const first = this.loading && !this.loaded, none = (label, text) => first ? this.waiting(label, c) : text, count = (n) => first ? null : n;
    const wait = this.mainWait(), blank = Boolean(wait?.fresh) && !this.rows.length && !this.md && !this.graph && !this.detail;
    const tag = this.help ? null : src?.file ? (src.markdown ? "preview" : src.file.conflict ? "conflicts" : this.shownSide) : src?.key?.startsWith("c:") ? "commit" : src?.key?.startsWith("s:") ? "stash" : null;
    const mainTitle = this.configOpen ? "Configuration" : this.help ? "Keybindings" : this.detail ? this.detail.file?.path ?? "Changed files" : src?.file ? src.file.path.split("/").pop() : src?.key?.startsWith("c:") ? src.subject ?? "Commit" : src?.title ?? "Diff";
    const mainRight = this.help ? "" : src?.file ? src.file.path.split("/").slice(0, -1).join("/") : src?.key?.startsWith("c:") ? src.hash : this.graph ? `${this.graph.rows.length} commits` : "";
    const age = (w) => (w ?? "").replace(/ ago$/, "").replace(/ (\w)\w*$/, "$1");

    return v_flex().id("git").relative().size_full().min_h(0).bg(c.chrome).text_color(c.foreground).text_size(13)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .on_mouse_down("right", (e, cx) => { if (this.menuAsked && this.graph) { this.menuAsked = false; this.graphKeys(cx).menu({ x: e.local_position?.x, y: e.local_position?.y }); } })
      .track_focus(this.handle).key_context("GitMod").on_action("git-escape", (_e, cx) => this.keys({ key: "escape", keystroke: "escape", modifiers: {} }, cx))
      .on_action("git-submit", (_e, cx) => { if (this.prompt) this.submit(cx); else if (this.plan) this.applyPlan(cx); cx.stop_propagation(); })
      .on_key_down((e, cx) => this.keys(e, cx))
      // Repository actions; the five numbered side panels remain below.
      .child(h_flex().id("head-status").h(48).flex_none().px(16).gap(10).items_center().cursor_pointer()
        .on_click((_e, cx) => { this.handle.focus(); this.goto("status", cx); })
        .child(svg("mods/git/branch.svg").size(15).text_color(c.accent))
        .child(b || !this.loading ? div().font_semibold().child(b?.name ?? "—") : this.waiting("Reading repository", c))
        .child(div().text_size(12).text_color(c.dim).child(this.repo))
        .when(Boolean(b?.upstream), (e) => e.child(div().text_size(11).text_color(c.dim).child(`→ ${b.upstream}`)))
        .when(Boolean(b?.ahead || b?.behind), (e) => e.child(this.pill(`↑${b.ahead} ↓${b.behind}`, c)))
        .when(Boolean(b) && !b?.upstream && this.hasHead, (e) => e.child(this.pill("no upstream", c)))
        .when(Boolean(b) && this.loading && Boolean(this.run?.shown), (e) => e.child(this.waiting("Updating", c)))
        .when(Boolean(b) && Boolean(this.error), (e) => e.child(div().min_w(0).max_w(420).truncate().text_size(12).text_color(c.red).child(this.error)))
        .child(div().flex_1())
        .child(this.button("git-more", "More", c, (cx) => this.moreMenu(cx), { busy: "Opening Lazygit" }))
        .child(this.button("fetch", "Fetch", c, (cx) => this.fetch(cx), { key: "f", busy: "Fetch" }))
        .child(this.button("pull", b?.behind ? `Pull ↓${b.behind}` : "Pull", c, (cx) => this.act("Pull", [["pull", "--ff-only"]], cx, { network: true, done: "Pulled" }), { key: "p", busy: "Pull" }))
        .child(this.button("push", b?.ahead ? `Push ↑${b.ahead}` : "Push", c, (cx) => this.push(cx), { key: "P", primary: Boolean(b?.ahead), busy: "Push" })))
      .when(Boolean(this.configuration?.stale),e=>e.child(div().id("config-error").flex_none().px(16).py(6).text_size(12).text_color(c.red).cursor_pointer().on_click((_e,cx)=>{this.configOpen=true;this.main=true;cx.notify();}).child("Configuration could not be loaded · Using the last valid settings · View error")))
      .when(Boolean(this.operation || this.bisecting || this.copied.size || this.compareBase || this.repoStack.length), (e) => e.child(h_flex().h(32).flex_none().px(16).gap(10).items_center()
        .child(div().flex_1().truncate().text_size(12).text_color(c.yellow).child([this.operation ? `${this.operation} in progress` : "", this.bisecting ? "Bisect in progress" : "", this.copied.size ? `${this.copied.size} commits marked for cherry-pick` : "", this.compareBase ? `Comparing from ${this.compareBase.slice(0,20)}` : "", this.repoStack.length ? "Esc returns to previous repository" : ""].filter(Boolean).join(" · ")))
        .when(Boolean(this.operation), (bar) => bar.child(this.button("operation-options", "Continue / abort", c, (cx) => this.operationMenu(cx), {key:"m"})))))
      .child(h_flex().flex_1().min_h(0).px(10).gap(10)
        // Lazygit's five side panels; Git Graph remains the Status preview.
        .child(v_flex().w(Math.min((this.size?.width??1200)*0.65,Math.max(200,(this.size?.width??1200)*this.configValue("gui.sidePanelWidth",0.3333)))).flex_none().h_full().gap(10)
          .when(!solo,side=>side.child(this.card("status","1","Status",act("status"),
            div().id("status-summary").px(12).py(8).cursor_pointer().on_click((_e,cx)=>this.goto("status",cx)).child(first?this.waiting("Reading repository",c):h_flex().gap(8).items_center()
              .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(c.muted).child(`${this.operation?`(${this.operation}) `:""}${this.repo} → ${b?.name??"—"}`))
              .when(Boolean(b?.ahead||b?.behind),e=>e.child(this.pill(`↑${b.ahead} ↓${b.behind}`,c)))),c,{size:e=>e.flex_none().h(70),onClick:cx=>this.goto("status",cx)})))
          .child(this.card("files", "2", "Files", act("files"),
            v_flex().size_full().child(this.viewBar("files", c))
              .when(this.fileView === "files", (body) => body
              .when(this.searchOpen || Boolean(this.filter), (e) => e.child(h_flex().h(32).flex_none().px(12).gap(8).items_center().border_b(1).border_color(this.searching ? c.accent : c.border)
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .child(svg("mods/workspace-chrome/search.svg").size(13).flex_none().text_color(this.searching ? c.accent : c.dim))
                .child(Input.new(this.search).flex_1().h_full().text_size(12).text_color(c.foreground))
                .child(div().flex_none().text_size(11).text_color(c.dim).child(`${this.nodes.filter((n) => !n.dir).length} of ${this.files.length}`))))
              .child(div().flex_1().min_h(0).child(this.rowsIn("files", this.nodes, (node, _on, n) => this.nodeRow(node, n, c), c,
                this.error ?? none("Reading changes", this.files.length ? "No files match" : "Working tree clean")))))
              .when(this.fileView !== "files", (body) => body
                .when(this.panel === "files" && this.panelSearchOpen, (e) => e.child(this.filterBar(c)))
                .child(div().flex_1().min_h(0).child(this.rowsIn("files", this.fileItems(), (it) => [
                  div().flex_1().min_w(0).truncate().text_color(c.muted).child(it.path),
                  div().flex_none().max_w(120).truncate().text_size(11).text_color(c.dim).child(it.branch ?? it.name),
                ], c, none(`Reading ${this.fileView}`, `No ${this.fileView}${this.filters[this.fileView] ? " match" : ""}`))))),
            c, { size: (e) => solo ? e.flex_1() : e.flex_grow(2).flex_basis(0).min_h(100), count: count(this.fileView === "files" ? (this.filesLimited ? `${this.files.length}+` : this.files.length) : this.fileItems().length), onClick: (cx) => this.goto("files", cx),
              tools: this.fileView === "files" ? [
                { id: "search", icon: "mods/workspace-chrome/search.svg", on: this.searchOpen || Boolean(this.filter), run: (cx) => this.searchOpen || this.filter ? this.clearSearch(cx) : this.startSearch(cx) },
                { id: "tree", icon: "mods/git/tree.svg", on: this.tree, run: (cx) => this.setTree(!this.tree, cx) },
                { id: "wide", icon: "mods/git/expand.svg", on: this.wide, run: (cx) => { this.panel = "files"; this.main = false; this.setWide(!this.wide, cx); } },
              ] : [],
              action: this.fileView !== "files" ? {label:"Actions",run:(cx)=>this.menuItems(this.fileView,this.repositoryActions(cx),cx)} : this.files.length ? { label: this.files.some((f) => f.unstaged || f.fresh) ? "Stage all" : "Unstage all", run: (cx) => this.toggleAll(cx) } : null }))
          .when(!solo, (side) => side
          .child(this.card("branches", "3", "Branches", act("branches"),
            this.contextBody("branches",c) ?? v_flex().size_full().child(this.viewBar("branches",c))
            .when(this.branchView === "remotes" && Boolean(this.remoteContext), (e) => e.child(this.remoteBar(c)))
            .when(this.panel === "branches" && this.panelSearchOpen, (e) => e.child(this.filterBar(c)))
            .child(div().flex_1().min_h(0).child(this.rowsIn("branches", this.branchItems(), (br) => [
              div().w(7).h(7).flex_none().rounded(4).when(br.current, (e) => e.bg(c.accent)).when(!br.current, (e) => e.border_1().border_color(c.dim)),
              div().flex_1().min_w(0).truncate().text_color(br.current ? c.foreground : c.muted).when(br.current, (e) => e.font_semibold()).child(this.branchContext() === "remote branches" ? this.remoteBranchParts(br).branch : br.name),
              ...(br.track ? [this.pill(br.track.replace("ahead ", "↑").replace("behind ", "↓").replace(", ", " "), c)] : []),
              div().flex_none().max_w(120).truncate().text_size(11).text_color(c.dim).child(br.branch ?? age(br.when)),
            ], c, none("Reading branches", this.remoteContext ? `No branches${this.filters[this.viewKey("branches")] ? " match" : ` for ${this.remoteContext.name}`}` : "No items")))), c, { size: (e) => e.flex_grow(2).flex_basis(0).min_h(120), count: count(this.list("branches").length), onClick: (cx) => this.goto("branches", cx), action: {label:"Actions",run:(cx)=>{this.panel="branches";this.main=false;this.syncContext();this.menuItems(this.context()?.title??this.branchContext(),this.contextActions(cx)??this.branchActions(cx),cx);}} }))
          .child(this.card("commits", "4", "Commits", act("commits"),
            this.contextBody("commits",c) ?? v_flex().size_full().child(this.viewBar("commits",c))
            .when(this.panel === "commits" && this.panelSearchOpen, (e) => e.child(this.filterBar(c)))
            .child(div().flex_1().min_h(0).child(this.rowsIn("commits", this.commitItems(), (cm) => [
              div().flex_none().font_family(c.mono).text_size(11).text_color(this.copied.has(cm.hash) ? c.yellow : cm.unpushed ? c.accent : c.dim).child(`${this.copied.has(cm.hash) ? "✓ " : ""}${cm.hash.slice(0, 7)}`),
              div().flex_1().min_w(0).truncate().child(cm.subject),
              div().flex_none().text_size(11).text_color(cm.todo?c.yellow:c.dim).child(cm.todo?`${cm.todo.action}${cm.todo.flag?` ${cm.todo.flag}`:""}`:age(cm.when)),
            ], c, none("Reading commits", "No commits yet")))), c, { size: (e) => e.flex_grow(2).flex_basis(0).min_h(110), count: count(this.list("commits").length), loading: this.paging && this.loading, onClick: (cx) => this.goto("commits", cx), action: {label:"Actions",run:(cx)=>{this.panel="commits";this.main=false;this.syncContext();this.menuItems("Commit actions",this.contextActions(cx)??this.commitActions(this.item("commits"),cx),cx);}} }))
          .child(this.card("stash", "5", "Stash", act("stash"),
            this.contextBody("stash",c) ?? v_flex().size_full().when(this.panel === "stash" && this.panelSearchOpen, (e) => e.child(this.filterBar(c)))
            .child(div().flex_1().min_h(0).child(this.rowsIn("stash", this.stashItems(), (st) => [
              div().flex_1().min_w(0).truncate().child(st.subject.replace(/^On [^:]+: /, "")),
              div().flex_none().text_size(11).text_color(c.dim).child(age(st.when)),
            ], c, none("Reading stashes", "No stashes")))), c, { size: (e) => e.flex_none().h(this.context("stash") ? 180 : this.stashes.length ? 120 : 76), count: count(this.list("stash").length), onClick: (cx) => this.goto("stash", cx) }))))
        // Main view.
        .child(this.card("main", "0", this.plan ? "Interactive rebase" : mainTitle, this.main || this.help,
          v_flex().size_full().when(!this.help && !this.plan && Boolean(this.diffBar(c)), (e) => e.child(this.diffBar(c)))// Waiting on something else than what is shown: that dims, or the wait takes its place.
            .child(blank ? div().flex_1().min_h(0).flex().items_center().justify_center().child(this.waiting(wait.label, c))
              : div().flex_1().min_h(0).when(Boolean(wait?.fresh), (e) => e.opacity(0.4)).child(this.mainView(c))), c,
          { size: (e) => e.flex_1().min_w(0).h_full(), tag, right: wait && !blank ? wait.label : mainRight, loading: Boolean(wait) && !blank, action: this.historyPatch?.ref || this.customPatch ? {label:"Custom patch",run:(cx)=>this.patchMenu(cx)} : null, onClick: (cx) => { this.main = true; cx.notify(); } })))
      // Footer: key hints like Herdr's status bar, messages on the right.
      .when(this.configValue("gui.showBottomLine",true)||Boolean(status)||terminalRunning,e=>e.child(h_flex().h(40).flex_none().px(16).gap(14).items_center()
        .child(h_flex().flex_1().min_w(0).gap(14).overflow_hidden().children((this.typing ? [["enter", "confirm"], ["esc", "back"]] : this.prompt ? [["i", "type"], ["enter", "confirm"], ["esc", "cancel"]] : this.hints()).map(([k, what]) =>
          h_flex().flex_none().gap(6).items_center().child(this.kbd(k, c)).child(div().text_size(11).text_color(c.dim).child(what)))))
        .when(terminalRunning,e=>e.child(this.button("git-terminal","Open terminal",c,()=>this.openGitTerminal(),{duringBusy:true})))
        .when(!this.main&&this.rangeAnchors[this.viewKey()]!=null,e=>e.child(div().flex_none().text_size(11).text_color(c.accent).child(`${this.selectedItems().length} selected · Esc clears range`)))
        .when(Boolean(status), (e) => e.child(h_flex().flex_none().max_w(520).gap(8).items_center()
          .when(Boolean(status.spin), (s) => s.child(this.spinner(c)))
          .child(div().min_w(0).truncate().text_size(12).text_color(status.color).child(status.text))))))
      .when(Boolean(this.customOutput?.popup), (e) => e.child(this.customOutputModal(c)))
      .when(Boolean(this.prompt || this.pending), (e) => e.child(div().absolute().inset_0().child(this.modal(c))))
      .when(Boolean(this.menu), (e) => e.child(this.menuView(c)))
      .when(Boolean(this.archive), (e) => e.child(this.archiveView(c)));
  }
}
