import { div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, ScrollHandle, TextareaState, Textarea } from "gpui-base";
import { exec, hc, openOverlay, checking, readTextFile, writeTextFile } from "herdr";
import { parsePatch, hunkAt, selectionRows, selectedPatch, parseConflicts, resolveConflict, rebaseTodo } from "./patch.js";
import { filterFiles, filePaths, OPERATION_STATE_SCRIPT, operationFromState, operationCommands } from "./status.js";
import { GitGraph } from "./graph-runtime.js";
import { hostingURLs } from "./hosting.js";
import { filterItems, literalSearchMatches } from "./search.js";

export const FILE_VIEWS = ["files", "worktrees", "submodules"];
export const BRANCH_VIEWS = ["local", "remotes", "tags"];
const CUT = "\n[herdr: output truncated]\n";
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const DIFF = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/"];
const SEQUENCE = 'sh -c \'printf "%s" "$HERDR_GIT_TODO" > "$1"\' sh';
const checked = (r) => { if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-1800) || `Git exited ${r.code}`); return r.stdout; };
const lines = (s) => s.split("\n").filter(Boolean);
const changedFiles = raw => {
  const fields=raw.split("\0"),items=[];
  for(let at=0;at<fields.length;){
    const status=fields[at++],first=fields[at++];if(!status||!first)break;
    if(/^[RC]/.test(status)){const path=fields[at++];if(!path)break;items.push({status:status[0],path,previousPath:first});}
    else items.push({status:status[0],path:first});
  }
  return items;
};

// Extra Git workflows live here; the original view keeps its graph, Markdown,
// Mermaid and Files tree. All actions capture the repository when invoked.
// Bound once: every open of the dialog runs initFeatures again.
let submitBound = false;

export class GitFeatures extends GitGraph {
  initFeatures(cx) {
    this.initConfiguration();
    this.initCommands();
    this.initGraph(cx);
    this.initArchive();
    this.fileView = "files"; this.branchView = "local"; this.commitView = "commits";
    this.remoteContext = null; this.viewSelections = {}; this.contexts = {}; this.contextSequence = 0;
    this.fileStatus = "all"; this.conflictedPaths = new Set();
    this.fileSortOrder="mixed"; this.fileSortCaseSensitive=true; this.branchSort="date"; this.remoteSort="date";
    this.remotes = []; this.remoteBranches = []; this.tags = []; this.worktrees = []; this.submodules = []; this.reflog = [];
    this.filters = {}; this.diffSide = null; this.lineMode = false; this.anchor = null; this.patch = null;
    this.copied = new Map(); this.compareBase = null; this.compareReverse = false; this.baseCommit = null;
    this.rangeAnchors = {}; this.rangeModes = {}; this.listPointer = null; this.rangeRefreshes=[];this.refReading=null;
    this.operation = null; this.startedOperation=null; this.bisecting = false; this.plan = null; this.planAt = 0;
    this.pendingRebase = null; this.pendingRebaseSelection = null;
    this.planScroll = ScrollHandle.new(); this.menuScroll = ScrollHandle.new(); this.repoStack = [];
    this.commandLog = [];
    this.detail = null; this.historyPatch = null; this.customPatch = null;
    this.commitLimit = 300; this.reflogLimit = 300; this.moreCommits = false; this.moreReflog = false;
    // Waits the person can see (see "waiting" below).
    this.loaded = false; this.run = null; this.wait = null; this.settling = null; this.opening = null; this.launching = null; this.paging = false;
    this.panelSearch = InputState.new({ placeholder: "Filter this view" });
    this.panelSearch.on("change", (_e, cx) => { this.filters[this.viewKey()] = this.panelSearch.value(); this.cancelRange(); if(this.isCommitSearch()) this.nextPanelMatch(0,cx); else this.sel[this.panel] = 0; this.syncContext(); this.reload(cx); });
    this.panelSearch.on("submit", (_e, cx) => { this.handle.focus(); cx.notify(); });
    this.panelSearch.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.panelSearch.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.menuSearch = InputState.new({placeholder:"Filter actions"});
    this.menuSearch.on("change", (_e,cx)=>{if(this.menu){this.menu.query=this.menuSearch.value();this.menu.sel=0;cx.notify();}});
    this.menuSearch.on("focus", (_e,cx)=>{this.typing=true;cx.notify();});
    this.menuSearch.on("blur", (_e,cx)=>{this.typing=false;cx.notify();});
    this.menuSearch.on("submit", (_e,cx)=>this.pickMenu(this.menu?.sel??0,cx));
    this.bodyInput = TextareaState.new({ placeholder: "Optional commit description", rows: 4 });
    this.bodyInput.on("change", (_e, cx) => { this.commitBody = this.bodyInput.value(); cx.notify(); });
    this.bodyInput.on("focus", (_e, cx) => { if(this.prompt)this.prompt.focusPending=false;this.typing = true; cx.notify(); });
    this.bodyInput.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    if (!submitBound) { cx.bind_keys([{keystroke: "cmd-enter", action: "git-submit", context: "GitMod"}, {keystroke: "ctrl-enter", action: "git-submit", context: "GitMod"}]); submitBound = true; }
  }

  // ---------- waiting ----------
  // Every wait shows where its result will land:
  //   loading  the repository is being read: the header, and each panel on the first read
  //   reading  the main view is being read: its header, over what it showed before
  //   busy     an action runs, then `settling` until the lists show its result: the footer and its button
  //   opening  an action whose result fills the main view (changed files, a rebase plan)
  //   launching  a terminal is being started
  // A read that is quick stays quiet (`run.shown`, `wait.shown`). The spinner
  // turns natively, so nothing here redraws on a timer.
  spinner(c, size = 12, color = c.working) { return svg("mods/workspace-chrome/spinner.svg").size(size).flex_none().text_color(color).spin(900); }
  waiting(label, c) { return h_flex().flex_none().gap(8).items_center().text_size(12).font_normal().text_color(c.muted).child(this.spinner(c)).child(label); }
  // What the main view is waiting for, or null.
  mainWait() {
    if (this.help || this.plan || this.logOpen || this.configOpen || this.customOutput) return null;
    if (this.opening) return { label: this.opening, fresh: true };
    if (this.loading && !this.loaded) return { label: "Reading repository", fresh: true };
    if (this.context()?.loading && !this.context().items.length) return {label:this.context().type === "files" ? "Reading changed files" : "Reading commits",fresh:true};
    const src = this.source(), wait = this.wait;
    if (!src || !this.reading || wait?.key !== src.key) return null;
    // Over other content a quick read stays quiet; an empty main view says at once what is coming.
    if (!wait.shown && (src.key === this.shown || this.rows.length || this.md || this.graph)) return null;
    const label = src.markdown ? "Rendering preview" : src.graph ? "Reading history" : src.file?.conflict ? "Reading conflicts"
      : src.key.startsWith("c:") ? "Reading commit" : src.key.startsWith("s:") ? "Reading stash" : src.key.startsWith("compare:") ? "Comparing" : "Reading diff";
    return { label, fresh: src.key !== this.shown };
  }

  viewKey(panel = this.panel) { if (this.context(panel)) return this.context(panel).key; return panel === "files" ? this.fileView : panel === "branches" ? (this.branchView === "remotes" && this.remoteContext ? `remote branches:${this.remoteContext.name}` : this.branchView) : panel === "commits" ? this.commitView : panel; }
  branchContext() { return this.branchView === "remotes" && this.remoteContext ? "remote branches" : this.branchView; }
  filterItems(items,term,text=it=>[it.name??"",it.path??"",it.hash??"",it.subject??"",it.who??"",it.url??""]) {return filterItems(items,term,text,{fuzzy:this.configValue("gui.filterMode","substring")==="fuzzy"});}
  fileItems() { return this.fileView === "files" ? this.nodes : this.filterItems(this[this.fileView] ?? [], this.filters[this.fileView] ?? ""); }
  // Ref names, not search text, decide which remote owns a branch. Prefer the
  // longest remote name because Git permits names such as "team/origin".
  remoteBranchParts(it) {
    const name = it.ref?.replace(/^refs\/remotes\//, "") ?? it.name;
    const remote = this.remotes.reduce((found, r) => name.startsWith(`${r.name}/`) && (!found || r.name.length > found.length) ? r.name : found, null);
    return { remote, branch: remote ? name.slice(remote.length + 1) : name };
  }
  branchItems() {
    let items = this.branchContext() === "remote branches" ? this.remoteBranches.filter((it) => this.remoteBranchParts(it).remote === this.remoteContext.name)
      : ({local: this.branches, remotes: this.remotes, tags: this.tags})[this.branchView] ?? [];
    const local=this.branchContext()==="local", order=local?this.branchSort:this.remoteSort;
    if(local||this.branchContext()==="remote branches"){
      items=[...items];const rank=new Map();
      if(order==="recency")for(const cm of this.reflog){const m=/^checkout: moving from (\S+) to (\S+)/.exec(cm.subject);if(m)for(const n of m.slice(1))if(!rank.has(n))rank.set(n,rank.size);}
      if(order==="alphabetical"||order==="recency")items.sort((a,b)=>(rank.get(a.name)??Infinity)-(rank.get(b.name)??Infinity)||(a.name<b.name?-1:a.name>b.name?1:0));
      if(local){
        const current=items.findIndex(it=>it.current);
        if(current>=0)items.unshift(...items.splice(current,1));
        else if(this.hasHead)items.unshift({name:`(${this.head.slice(0,7)})`,ref:this.head,hash:this.head,current:true,detached:true});
      }
    }
    return this.filterItems(items, this.filters[this.viewKey("branches")] ?? "");
  }
  sortBranches(cx) {
    const local=this.branchContext()==="local",current=local?this.branchSort:this.remoteSort;
    this.menuItems("Sort branches",[...(local?[["Recent checkouts","r","recency"]]:[]),["Alphabetical","a","alphabetical"],["Commit date","d","date"]]
      .map(([label,key,order])=>[`${current===order?"●":"○"} ${label}`,key,(cx)=>{if(local)this.branchSort=order;else this.remoteSort=order;this.sel.branches=0;this.reload(cx);}]),cx);
  }
  commitItems() { return this.commitView === "reflog" ? this.filterItems(this.reflog,this.filters.reflog??"") : [...this.pendingRebaseItems(),...this.commits]; }
  stashItems() { return this.filterItems(this.stashes, this.filters.stash ?? ""); }
  visibleFiles() { return filterFiles(this.files, this.fileStatus, this.filter, this.conflictedPaths,{fuzzy:this.configValue("gui.filterMode","substring")==="fuzzy"}); }
  updateFileFilter(previous) {
    const conflicts = this.files.filter((f) => f.conflict);
    if (conflicts.length && !previous.some((f) => f.conflict) && this.fileStatus === "all") this.fileStatus = "conflicted";
    if (!conflicts.length && this.fileStatus === "conflicted") { this.fileStatus = "all"; this.conflictedPaths.clear(); }
    if (this.fileStatus === "conflicted") for (const f of conflicts) this.conflictedPaths.add(f.path);
  }
  setFileStatus(status, cx) {
    const previous = this.fileStatus;
    this.fileStatus = status; this.conflictedPaths.clear(); this.panel = "files"; this.fileView = "files"; this.main = false;
    this.cancelRange("files"); this.sel.files=0; this.layoutFiles(null); this.handle.focus();
    if (previous === "untracked" || status === "untracked") this.refresh(cx, true);
    this.reload(cx);
  }
  fileStatusMenu(cx) {
    this.menuItems("Filter files", [["Staged files", "s", "staged"], ["Unstaged files", "u", "unstaged"], ["Tracked files", "t", "tracked"], ["Untracked files", "T", "untracked"], ["All files", "r", "all"]]
      .map(([label,key,status]) => [`${this.fileStatus === status ? "● " : "○ "}${label}`, key, (cx) => this.setFileStatus(status,cx), false, key]), cx);
  }

  async boundedGit(args, max = 262144, context = { cwd: this.root, on: this.on }) {
    // Reduce before QuickJS sees the output, with Git's exit status preserved.
    const script = 'umask 077; out=$(mktemp) || exit 1; trap \'rm -f "$out"\' EXIT; git "$@" > "$out"; code=$?; head -c "$0" "$out"; if [ "$(wc -c < "$out")" -gt "$0" ]; then printf "\\n[herdr: output truncated]\\n"; fi; exit "$code"';
    const r = await exec("sh", ["-c", script, String(max), ...READ, ...args], context);
    const truncated = r.stdout.endsWith(CUT);
    let stdout = truncated ? r.stdout.slice(0, -CUT.length) : r.stdout;
    if (truncated) { const delimiter = args.includes("-z") ? "\0" : "\n"; stdout = stdout.slice(0, stdout.lastIndexOf(delimiter) + 1); }
    return { ...r, stdout, truncated };
  }

  async refreshFeatures() {
    const repoKey=this.repoKey, root=this.root, on=this.on;
    const [refs, remotes, trees, reflog, modules, state, todo] = await Promise.all([
      this.boundedGit(["for-each-ref", "--count=1000", "--sort=-committerdate", "--format=%(refname)%1f%(refname:short)%1f%(objectname)%1f%(symref)%1f%(contents:subject)%1f%(objecttype)", "refs/remotes", "refs/tags"]),
      this.boundedGit(["remote", "-v"]), this.boundedGit(["worktree", "list", "--porcelain", "-z"]),
      this.boundedGit(["reflog", "-n", String(this.reflogLimit+1), "--format=%H%x1f%gs%x1f%cr%x1f%gd"], Math.min(8_000_000,this.reflogLimit*1024)),
      this.boundedGit(["config", "-z", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]),
      exec("sh", ["-c", OPERATION_STATE_SCRIPT], { cwd: this.root, on: this.on }),
      this.readPendingRebase({cwd:root,on}),
    ]);
    if(this.closed||this.repoKey!==repoKey||this.root!==root||this.on!==on)return;
    this.remoteBranches = []; this.tags = [];
    for (const l of lines(refs.stdout)) {
      const [ref, _short, hash, sym, subject, type] = l.split("\x1f");
      if (!hash || sym) continue;
      const name=ref.replace(/^refs\/(?:tags|remotes)\//,"");
      (ref.startsWith("refs/tags/") ? this.tags : this.remoteBranches).push({ref, name, hash, subject, type});
    }
    this.remotes = lines(remotes.stdout).filter((l) => l.endsWith(" (fetch)")).map((l) => {
      const m = /^(\S+)\s+(.+) \(fetch\)$/.exec(l); return m ? {name: m[1], url: m[2]} : null;
    }).filter(Boolean);
    if (this.remoteContext && !this.remotes.some((r) => r.name === this.remoteContext.name)) { this.remoteContext = null; this.sel.branches = 0; }
    this.worktrees = []; let tree = null;
    for (const field of trees.stdout.split("\0")) {
      if (field.startsWith("worktree ")) { tree = {path: field.slice(9), name: field.slice(9)}; this.worktrees.push(tree); }
      else if (tree && field.startsWith("branch ")) tree.branch = field.slice(7).replace(/^refs\/heads\//, "");
      else if (tree && field.startsWith("HEAD ")) tree.hash = field.slice(5);
      else if (tree && field.startsWith("locked")) tree.locked = true;
      else if (tree && field === "bare") tree.bare = true;
    }
    this.moreReflog = lines(reflog.stdout).length > this.reflogLimit;
    this.reflog = reflog.code ? [] : lines(reflog.stdout).slice(0,this.reflogLimit).map((l) => { const [hash,subject,when,ref] = l.split("\x1f"); return {hash,subject,when,ref}; });
    this.submodules = modules.code ? [] : modules.stdout.split("\0").filter(Boolean).map((f) => { const n = f.indexOf("\n"); return { name: f.slice(0,n).replace(/^submodule\./, "").replace(/\.path$/, ""), path: f.slice(n+1) }; });
    this.operation = operationFromState(state.stdout);
    this.pendingRebase = todo;
    if (this.pendingRebaseSelection && todo) {
      const row=this.pendingRebaseSelection, at=todo.doc.rows.findIndex(it=>it.hash===row.hash&&it.subject===row.subject&&it.action===row.action);
      if(at>=0)this.sel.commits=at;
      this.pendingRebaseSelection=null;
    }
    this.bisecting = state.stdout.includes("BISECT_LOG");
    if(this.recoverySelection?.repoKey===this.repoKey){
      const at=this.branchItems().findIndex(branch=>branch.ref===this.recoverySelection.ref);
      this.sel.branches=Math.max(0,at);this.recoverySelection=null;
    }
    if(this.operation === "squash-merge" && !this.files.some(f=>!f.fresh)) {
      const r=await exec("sh",["-c",'git diff --quiet && git diff --cached --quiet && git reset --merge'],{cwd:this.root,on:this.on});
      if(r.code===0)this.operation=null;
    }
  }

  switchView(by, cx) {
    const names = this.panel === "files" ? FILE_VIEWS : this.panel === "branches" ? BRANCH_VIEWS : this.panel === "commits" ? ["commits", "reflog"] : null;
    if (!names) return;
    const current = this.panel === "files" ? this.fileView : this.panel === "branches" ? this.branchView : this.commitView;
    this.selectView(this.panel, names[(names.indexOf(current) + by + names.length) % names.length], cx);
  }
  selectView(panel, name, cx) {
    this.graphFile=null;
    this.viewSelections[this.viewKey(panel)] = this.sel[panel];
    this.contexts[panel] = [];
    this.panel = panel;
    if (panel === "files") this.fileView = name;
    else if (panel === "branches") { this.branchView = name; this.remoteContext = null; }
    else this.commitView = name;
    this.sel[panel] = this.viewSelections[this.viewKey(panel)] ?? 0;
    this.peek = null; this.detail = null; this.historyPatch = null; this.main = false; this.panelSearchOpen = false;
    this.diffSide = null; this.anchor = null; this.handle.focus(); this.reload(cx);
  }
  openRemote(remote, cx) {
    if (!remote) return;
    this.viewSelections.remotes = this.sel.branches;
    this.remoteContext = {name: remote.name}; this.branchView = "remotes"; this.panel = "branches";
    this.sel.branches = 0; this.peek = null; this.detail = null; this.main = false; this.panelSearchOpen = false;
    this.handle.focus(); this.reload(cx);
  }
  leaveRemote(cx) {
    if (!this.remoteContext) return;
    const name = this.remoteContext.name;
    this.remoteContext = null;
    const at = this.branchItems().findIndex((it) => it.name === name);
    this.sel.branches = Math.max(0, at >= 0 ? at : Math.min(this.viewSelections.remotes ?? 0, this.branchItems().length - 1));
    this.peek = null; this.main = false; this.panelSearchOpen = false;
    this.handle.focus(); this.reload(cx);
  }

  featureSource() {
    if (this.detail?.file) {
      const d = this.detail, file = d.file.path;
      // A folder shows its combined diff, like Lazygit; line picking needs one file.
      return {key:`detail:${d.key}:${file}`,title:file,custom:true,folder:Boolean(d.file.dir),ref:d.ref,path:file,canRebase:d.canRebase,
        args:[...(d.untracked?.has(file) ? ["show","--format=",...DIFF,`${d.stashHash}^3`] : d.patchArgs),"--",...filePaths([d.file])]};
    }
    if (this.peek) return null;
    const it = this.item();
    if(it?.todo&&!it.hash)return {key:`todo:${it.todo.line}:${it.todo.raw}`,title:`Pending ${it.todo.action}`,text:[it.todo.text,"","This instruction belongs to the paused rebase. Use m to continue or abort."]};
    if (this.panel === "files" && it && this.fileView === "worktrees") return {key: `tree:${it.path}`, title: "Worktree", text: [it.path, `Branch: ${it.branch ?? "detached"}`, it.locked ? "Locked" : "", "", "Enter / Space: switch repository · n: create · d: remove · l: lock / unlock"]};
    if (this.panel === "files" && it && this.fileView === "submodules") return {key: `module:${it.path}`, title: "Submodule", text: [it.name, it.path, "", "Enter: open repository · i: initialize · u: update · e: URL · d: remove"]};
    const range=this.selectedCommitRange();
    if (this.compareBase && it && ["branches", "commits"].includes(this.panel)) {
      const ref = range?.to ?? it.hash ?? it.ref ?? it.name;
      if (ref && !(this.panel === "branches" && this.branchContext() === "remotes")) return {key: `compare:${this.compareBase}:${ref}:${this.compareReverse}`, title: "Compare", args: ["diff", ...DIFF, "--stat", "--patch", ...(this.compareReverse ? [ref,this.compareBase] : [this.compareBase,ref]), "--"]};
    }
    if(range)return {key:`range:${range.from}:${range.to}`,title:range.title,range};
    const context = this.contextSource(); if (context) return context;
    if (this.panel !== "branches" || this.branchView === "local" || !it) return null;
    if (["tags", "remote branches"].includes(this.branchContext())) return {key: it.ref, title: it.name, graph: [it.ref]};
    if (this.branchView === "remotes") return {key: `remote:${it.name}`, title: it.name, text: [`Remote: ${it.name}`, `URL: ${it.url}`, "", "Enter: remote branches · n: add · e: edit URL · R: rename · d: remove · f: fetch"]};
    return null;
  }

  diffArgs(file, side = this.diffSide ?? (file.unstaged || file.fresh ? "unstaged" : "staged")) {
    if (file.fresh) return ["diff", "--no-index", ...DIFF, ...this.diffOptions(), "--", "/dev/null", file.path];
    return ["diff", ...(side === "staged" ? ["--cached"] : []), ...DIFF, ...this.diffOptions(), "--", file.path];
  }

  async readFilePatch(file) {
    const side = this.diffSide ?? (file.unstaged || file.fresh ? "unstaged" : "staged");
    if (file.conflict && file.inlineConflict && !file.binary) {
      const r = await exec("sh", ["-c", 'test -f "$1" || exit 2; test "$(wc -c < "$1")" -le 262144 || exit 3; cat "$1"', "sh", `${this.root}/${file.path}`], {cwd:this.root,on:this.on});
      if (r.code === 0 && !r.stdout.includes("\0")) {
        const attr=await this.boundedGit(["check-attr","-z","conflict-marker-size","--",file.path]);
        return {conflicts: parseConflicts(r.stdout,Number(attr.stdout.split("\0")[2])||7), lines:r.stdout.replace(/\n$/, "").split("\n"), file, side};
      }
    }
    if (file.conflict) {
      const meaning = {DD:"Deleted on both sides",AU:"Added by us",UA:"Added by them",UD:"Deleted by them",DU:"Deleted by us",UU:"Both sides modified this file",AA:"Added on both sides"}[file.x+file.y];
      return {lines:[meaning??"Unmerged file",file.path,"","M: choose the version to keep, remove the file, or mark it resolved.","Use an external editor for binary or large conflicts."],file,side};
    }
    if (file.fresh && side === "staged") return {lines: [], file, side};
    const r = await this.boundedGit(this.diffArgs(file, side));
    if (r.code !== 0 && !(file.fresh && r.code === 1)) checked(r);
    return {patch: r.truncated ? null : parsePatch(r.stdout), lines: [...r.stdout.replace(/\n$/, "").split("\n"), ...(r.truncated ? ["[Preview truncated — use whole-file actions or open Lazygit]"] : [])], truncated: r.truncated, file, side};
  }

  setFilePatch(data) {
    const same = this.patch?.raw === data.patch?.raw && this.diffFile?.path === data.file?.path && this.shownSide === data.side;
    this.patch = data.patch ?? null; this.conflicts = data.conflicts ?? null; this.diffFile = data.file; this.shownSide = data.side; this.patchTruncated = data.truncated;
    if (!same) this.anchor = null;
  }
  activePatch() { return this.patch ?? this.historyPatch?.patch; }
  selectedRows() { return selectionRows(this.activePatch(), this.cursor, this.lineMode, this.anchor); }
  focusDiff(cx) { this.main = true; this.mdMode = false; this.anchor = null; this.reload(cx); }
  switchDiff(cx) { this.diffSide = this.shownSide === "staged" ? "unstaged" : "staged"; this.anchor = null; this.reload(cx); }
  moveHunk(by, cx) {
    const patch = this.activePatch(), list = patch?.hunks ?? [];
    const at = list.findIndex((h) => h === hunkAt(patch, this.cursor));
    this.cursor = list[Math.max(0, Math.min((at < 0 ? 0 : at) + by, list.length - 1))]?.row ?? this.cursor;
    this.diffScroll.scroll_to_item(this.cursor, "center"); cx.notify();
  }

  applySelection(discard, cx) {
    const file = this.diffFile, patch = this.patch, rows = this.selectedRows(), side = this.shownSide;
    if (!patch || !file || !rows.length) { this.note = this.patchTruncated ? "This diff is too large for partial changes; use whole-file staging or Lazygit" : "Select a changed hunk or line"; return cx.notify(); }
    const reverse = discard || side === "staged";
    let text; try { text = selectedPatch(patch, file.path, rows, reverse); } catch (e) { this.note = e.message; return cx.notify(); }
    const label = discard && side !== "staged" ? "Discard selected changes" : side === "staged" ? "Unstage selection" : "Stage selection";
    const work = (cx) => this.perform(label, async (git, context) => {
      const current = await this.boundedGit(this.diffArgs(file, side));
      if (current.truncated || current.stdout !== patch.raw) throw new Error("The file changed since this diff was loaded. Refresh and select again.");
      const args = ["apply", "--whitespace=nowarn", ...(!discard || side === "staged" ? ["--cached"] : []), ...(reverse ? ["--reverse"] : [])];
      // stdin is passed as a positional argument, never interpolated into shell code.
      const apply = (extra) => exec("sh", ["-c", 'patch=$1; shift; printf "%s" "$patch" | git "$@"', "sh", text, ...args, ...extra, "-"], context);
      checked(await apply(["--check"])); checked(await apply([]));
    }, cx);
    if (discard && side !== "staged") this.ask(label, `Discard ${rows.length} selected changed lines in ${file.path}?`, work, cx); else work(cx);
  }

  // Used by both the old actions and the new workflows. Refresh failures never
  // erase the command's result; stopped rebases/cherry-picks remain actionable.
  perform(label, work, cx, opts = {}) {
    if (this.busy || checking()) return;
    if (!this.root) return this.say(this.loading ? "Still reading the repository" : this.error ?? "No repository", cx);
    const context = {cwd: this.root, on: this.on, timeout: opts.timeout ?? (opts.network ? 120000 : 60000)};
    if(opts.operation)this.startedOperation=opts.operation;
    this.busy = label; this.opening = opts.reads ? label : null; this.note = null; this.info = null; this.pending = null;
    cx.spawn(async (cx) => {
      const git = async (args) => {
        if(!opts.reads&&["merge","rebase","cherry-pick","revert","am"].includes(args[0])&&!args.some(a=>["--continue","--abort","--skip","--squash"].includes(a)))this.startedOperation=args[0];
        const r = await exec("env", ["GIT_TERMINAL_PROMPT=0", "GIT_EDITOR=true", "git", ...args], context);
        this.commandLog.push({label, command: "git " + args.join(" "), code: r.code, output: (r.stderr || r.stdout).slice(-2500)});
        if (this.commandLog.length > 30) this.commandLog.shift();
        return checked(r);
      };
      try {
        if (typeof work === "function") await work(git, context, cx); else for (const args of work) await git(args);
        this.info = opts.done ?? label; opts.after?.(cx);
      } catch (e) { this.note = `${label} failed: ${e?.message ?? e}`; }
      finally {
        this.busy = null; this.opening = null;
        // A read changed nothing. Anything else is not over until the lists show it.
        if (!this.closed) { if (opts.reads) this.refresh(cx); else { this.settling = label; this.refresh(cx, true); } cx.notify(); }
      }
    }); cx.notify();
  }

  promptValue(title, value, submit, cx, opts = {}) {
    this.openPrompt({kind: "value", title, submit, ...opts},value,cx);
  }
  openPrompt(prompt,value,cx) {
    prompt.focusId=this.promptSequence=(this.promptSequence??0)+1;prompt.focusPending=true;
    this.prompt=prompt;this.message=value??"";this.input.set_value(this.message);cx.notify();
  }
  focusPrompt(prompt,id,cx) {
    if(this.closed||this.prompt!==prompt||prompt.focusId!==id||!prompt.focusPending)return;
    prompt.focusPending=false;this.input.focus();cx.notify();
  }
  menuItems(title, items, cx) { this.openMenu({title, items: items.filter(Boolean).map(([label, hint, run, danger, key, disabled]) => ({label,hint,run,danger,key:key??(hint?.length===1?hint:null),disabled}))}, cx); }
  say(message, cx) { this.note = message; cx.notify(); }

  checkoutRef(ref, cx, detached = false) {
    const args = detached ? ["switch", "--detach", ref] : ["switch", ref];
    if (detached) this.ask("Detached checkout", `Check out ${ref} without a branch?`, (cx) => this.perform("Checkout", [args], cx), cx);
    else this.perform("Checkout", [args], cx);
  }
  checkoutRemote(it,cx) {
    const {branch}=this.remoteBranchParts(it);
    if (this.branches.some((b)=>b.name===branch)) return this.checkoutRef(branch,cx);
    this.menuItems(`Checkout ${it.name}`, [
      ["Create local tracking branch…","n",(cx)=>this.promptValue("Local tracking branch name",branch,(name,cx)=>this.perform("Checkout tracking branch",[["switch","--track","-c",name,it.ref]],cx),cx)],
      ["Checkout detached HEAD…","d",(cx)=>this.checkoutRef(it.ref,cx,true)],
    ],cx);
  }
  newBranch(ref, cx) { this.promptValue("New branch name", "", (value, cx) => this.perform("Create branch", [["switch", "-c", value, ...(ref ? [ref] : [])]], cx), cx); }
  newTag(ref, cx) { this.promptValue("New tag name", "", (name, cx) => this.promptValue("Tag description (empty for lightweight)", "", (message, cx) => this.perform("Create tag", [["tag", ...(message ? ["-a", "-m", message] : []), "--", name, ref ?? "HEAD"]], cx), cx, {empty: true}), cx); }
  resetMenu(ref, cx) {
    this.menuItems(`Reset to ${ref.slice(0, 24)}`, [
      ...["mixed", "soft", "hard"].map((mode) => [`Reset ${mode}`, mode === "soft" ? "keep staged" : mode === "mixed" ? "keep unstaged" : "discard changes", (cx) => this.ask(`Reset ${mode}`, `Move the current branch to ${ref}? ${mode === "hard" ? "Tracked uncommitted changes will be discarded." : "Later commits become local changes."}`, (cx) => this.perform("Reset", [["reset", `--${mode}`, ref]], cx), cx), mode === "hard",mode[0]]),
    ], cx);
  }
  chooseRemote(title, then, cx) { this.menuItems(title, this.remotes.map((r) => [r.name, r.url, (cx) => then(r.name, cx)]), cx); }

  repositoryActions(cx) { return this.guardListActions(this.repositoryActionItems(cx),["n"]); }
  repositoryActionItems(cx) {
    const it = this.item("files"), view = this.fileView;
    if (view === "worktrees") return [
      it && ["Switch repository", "enter", (cx) => this.switchRepository(it.path, cx)],
      it && ["Open in editor", "o", (cx) => this.editFiles([],cx,{dir:it.path})],
      ["New worktree…", "n", (cx) => this.newWorktree(null, cx)],
      it && [it.locked ? "Unlock worktree" : "Lock worktree", "l", (cx) => this.perform("Worktree lock", [["worktree", it.locked ? "unlock" : "lock", "--", it.path]], cx)],
      it && it.path !== this.root && ["Remove worktree…", "d", (cx) => this.ask("Remove worktree", `Remove ${it.path}? Git will refuse if it has changes or is locked.`, (cx) => this.perform("Remove worktree", [["worktree", "remove", "--", it.path]], cx), cx), true],
      ["Prune missing worktrees…", "", (cx) => this.ask("Prune worktrees", "Remove metadata for worktree folders that no longer exist?", (cx) => this.perform("Prune worktrees", [["worktree", "prune"]], cx), cx)],
    ];
    if (view === "submodules") return [
      it && ["Enter submodule", "enter", (cx) => this.switchRepository(`${this.root}/${it.path}`, cx)],
      ["Add submodule…", "n", (cx) => this.promptValue("Submodule URL", "", (url,cx) => this.promptValue("Submodule path", "", (path,cx) => this.perform("Add submodule", [["submodule", "add", "--", url,path]], cx,{network:true}),cx),cx)],
      it && ["Initialize", "i", (cx) => this.perform("Initialize submodule", [["submodule","init","--",it.path]],cx)],
      it && ["Update recursively", "u", (cx) => this.perform("Update submodule", [["submodule","update","--init","--recursive","--",it.path]],cx,{network:true})],
      it && ["Edit URL…", "e", (cx) => this.promptValue("Submodule URL", "", (url,cx) => this.perform("Set submodule URL", [["submodule","set-url","--",it.path,url]],cx),cx)],
      it && ["Remove submodule…", "d", (cx) => this.ask("Remove submodule", `Deinitialize and remove ${it.path}? Git will refuse if it has changes.`, (cx) => this.perform("Remove submodule", [["submodule","deinit","--",it.path],["rm","--",it.path]],cx),cx),true],
    ];
    return [];
  }
  branchActions(cx) { return this.guardListActions(this.branchActionItems(cx),this.branchContext()==="local"?["c","-","s","w","i","d","f"]:this.branchContext()==="remotes"?["n"]:this.branchContext()==="tags"?["n","w","d","P"]:["s","w","d"]); }
  branchActionItems(cx) {
    const it = this.item("branches"), ref = it?.ref ?? it?.name, view = this.branchContext();
    if (view === "remotes") return [
      it && ["View branches", "enter", (cx) => this.openRemote(it, cx)],
      ["Add remote…", "n", (cx) => this.promptValue("Remote name", "", (name, cx) => this.promptValue("Remote URL", "", (url, cx) => this.perform("Add remote", [["remote", "add", "--", name, url]], cx), cx), cx)],
      it && ["Edit remote…", "e", (cx) => this.promptValue("Remote name",it.name,(name,cx)=>this.promptValue(`URL for ${name}`,it.url,(url,cx)=>this.perform("Edit remote",[...(name!==it.name?[["remote","rename",it.name,name]]:[]),["remote","set-url","--",name,url]],cx),cx),cx)],
      it && ["Rename remote…", "R", (cx) => this.promptValue("Remote name", it.name, (name, cx) => this.perform("Rename remote", [["remote", "rename", it.name, name]], cx), cx)],
      it && ["Fetch remote", "f", (cx) => this.perform("Fetch", [["fetch", "--prune", "--", it.name]], cx, {network:true})],
      it && ["Remove remote…", "d", (cx) => this.ask("Remove remote", `Remove ${it.name} from this repository?`, (cx) => this.perform("Remove remote", [["remote", "remove", it.name]], cx), cx), true],
    ];
    const actions = [
      it && ["View commits", "enter", (cx) => this.openSubCommits(it,cx)],
      it && ["Checkout", "space", (cx) => view === "remote branches" ? this.checkoutRemote(it,cx) : this.checkoutRef(ref,cx,view === "tags")],
      [view === "tags" ? "New tag…" : "New branch…", "n", (cx) => view === "tags" ? this.newTag("HEAD",cx) : this.newBranch(ref,cx)],
      it && ["New worktree here…", "w", (cx) => this.newWorktree(ref,cx)],
      view !== "tags" && it && ["Merge into current branch…", "M", (cx) => this.mergeMenu(it,cx),false,null,this.selectedItems().length>1?"Select one branch to merge":null],
      view !== "tags" && it && ["Rebase current branch onto here…", "r", (cx) => this.ask("Rebase", `Replay ${this.branch.name} onto ${ref}${this.baseCommit ? ` from ${this.baseCommit.slice(0,7)}` : ""}?`, (cx) => this.perform("Rebase", [["rebase", ...(this.baseCommit ? ["--onto",ref,this.baseCommit] : [ref])]],cx),cx)],
      it && ["Reset current branch…", "g", (cx) => this.resetMenu(ref,cx)],
      it && ["Compare with…", "W", (cx) => this.compareMenu(it,cx)],
      it && ["Copy name", "y", (cx) => cx.write_to_clipboard(it.name)],
      view!=="tags" && ["Sort branches…", "s", (cx)=>this.sortBranches(cx)],
    ];
    if (view === "local") actions.push(
      it && ["Git-flow…", "i", (cx)=>this.gitFlowMenu(it,cx)],
      it && !it.detached && ["Create pull request", "o", (cx)=>this.createPullRequest(it,cx)],
      it && !it.detached && ["Pull request options…", "O", (cx)=>this.menuItems("Create pull request",[
        ["Into the default branch","d",(cx)=>this.createPullRequest(it,cx)],
        ["Into the current branch","c",(cx)=>this.createPullRequest(it,cx,this.branch.name)],
        ["Into another branch…","b",(cx)=>this.promptValue("Target branch","",(name,cx)=>this.createPullRequest(it,cx,name),cx)],
      ],cx)],
      it && !it.detached && ["Open pull request in browser", "G", (cx)=>this.openPullRequest(it,cx)],
      ["Checkout by name…", "c", (cx) => this.promptValue("Branch name (- for previous)", "", (name,cx) => this.checkoutRef(name,cx),cx)],
      ["Checkout previous branch", "-", (cx) => this.checkoutRef("-",cx)],
      it && !it.detached && ["Rename branch…", "R", (cx) => this.promptValue("Branch name", it.name, (name,cx) => this.perform("Rename branch", [["branch","-m",it.name,name]],cx),cx)],
      it && ["Upstream options…", "u", (cx) => this.menuItems(`Upstream for ${it.name}`, [
        ["Set upstream…", "", (cx) => this.promptValue("Upstream (remote/branch)", "", (upstream,cx) => this.perform("Set upstream", [["branch",`--set-upstream-to=${upstream}`,"--",it.name]],cx),cx)],
        ["Unset upstream", "", (cx) => this.perform("Unset upstream", [["branch","--unset-upstream","--",it.name]],cx)],
      ],cx)],
      it && ["Fast-forward from upstream", "f", (cx) => this.fastForward(null,cx)],
      it && !it.detached && ["Delete branches…", "d", (cx) => this.localBranchDeleteMenu(cx),true],
      ["New tag…", "T", (cx) => this.newTag(ref,cx)],
    );
    if (view === "remote branches") {
      const remote = this.remoteContext.name;
      actions.push(["Fetch remote", "f", (cx) => this.perform("Fetch", [["fetch", "--prune", "--", remote]], cx, {network:true})]);
    }
    if (view === "remote branches" && it) actions.push(
      ["Set as current branch upstream", "u", (cx) => this.perform("Set upstream", [["branch",`--set-upstream-to=${it.name}`]],cx)],
      ["Delete remote branches…", "d", (cx) => this.deleteRemoteBranches(cx),true],
    );
    if (view === "tags" && it) actions.push(
      ["Push tags…", "P", (cx) => this.pushTagSelection(cx)],
      ["Delete tags…", "d", (cx) => this.tagSelectionMenu(cx),true],
    );
    return actions;
  }

  newWorktree(ref, cx) {
    this.promptValue("Worktree path", "", (path,cx) => this.promptValue("New branch name (empty uses selected ref)", "", (branch,cx) => this.perform("Create worktree", [["worktree","add",...(branch ? ["-b",branch] : []),"--",path,...(ref ? [ref] : [])]],cx),cx,{empty:true}),cx);
  }
  switchRepository(cwd, cx) {
    if (this.busy || this.loading) return this.say("Wait for the current operation to finish",cx);
    this.repoStack.push(this.location); this.location = {cwd,on:this.on}; this.resetRepository(cx);
  }
  resetRepository(cx) {
    this.dismissArchive(cx);
    this.resetGraph();
    this.cancelConfiguredCommand();this.customOutput=null;this.prompt=null;this.pending=null;this.menu=null;
    this.initConfiguration();
    this.watched = null; this.watchTask?.cancel(); this.root = null; this.repoKey = null;
    this.files = []; this.nodes = []; this.branches = []; this.commits = []; this.stashes = []; this.peek = null; this.graph = null; this.patch = null;
    this.compareBase = null; this.baseCommit = null; this.copied.clear(); this.main = false; this.panel = "files"; this.sel.files = 0; this.shown = null;
    this.detail = null; this.historyPatch = null; this.customPatch = null; this.plan = null;
    this.pendingRebase = null; this.pendingRebaseSelection = null; this.rangeAnchors = {}; this.rangeModes = {}; this.listPointer = null; this.rangeRefreshes=[];this.refReading=null; this.graphLimits.clear();
    this.commitLimit = 300; this.reflogLimit = 300; this.moreCommits = false; this.moreReflog = false;
    this.fileView = "files"; this.branchView = "local"; this.commitView = "commits"; this.remoteContext = null; this.viewSelections = {}; this.contexts = {}; this.contextSequence = 0; this.filters = {};
    this.fileStatus = "all"; this.conflictedPaths.clear(); this.operation = null; this.startedOperation=null; this.bisecting = false;
    this.remotes = []; this.remoteBranches = []; this.tags = []; this.worktrees = []; this.submodules = []; this.reflog = [];
    this.loaded = false; this.md = null; this.setLines([]);
    this.refresh(cx,true); cx.notify();
  }

  selectedCommit() { return this.graph && this.main ? this.graph.rows[this.cursor]?.commit : this.peek ?? (this.context()?.type === "commits" || this.panel === "commits" ? this.item() : null); }
  copyCommits(cm,cx) {
    const selected=this.main?[cm]:this.selectedItems().filter(it=>it.hash), remove=selected.every(it=>this.copied.has(it.hash));
    for(const it of selected)if(remove)this.copied.delete(it.hash);else this.copied.set(it.hash,it);
    this.cancelRange();cx.notify();
  }
  copyCommitAttribute(cm,cx) {
    this.perform("Reading commit attributes",async(_git,_context,cx)=>{
      const r=await this.boundedGit(["show","-s","--format=%s%x00%b%x00%an <%ae>%x00%B",cm.hash]);checked(r);
      if(r.truncated)throw new Error("Commit message exceeds the preview limit");
      const [subject,body,author,message]=r.stdout.split("\0"),tags=this.tags.filter(t=>t.hash===cm.hash).map(t=>t.name);
      const copy=(label,value)=>cx=>{cx.write_to_clipboard(value);this.info=`Copied ${label}`;cx.notify();};
      this.menuItems("Copy commit attribute",[
        ["Hash","",copy("hash",cm.hash)],
        ["Subject","s",copy("subject",subject)],
        ["Message","m",copy("message",message.trimEnd())],
        ["Message body","b",copy("body",body.trimEnd()),false,null,body.trim()?null:"Commit has no message body"],
        ["URL","u",(cx)=>this.copyCommitURL(cm,cx)],
        ["Diff","d",(cx)=>this.perform("Reading commit diff",async(_git,_context,cx)=>{const r=await this.boundedGit(["show","--format=","--no-ext-diff","--no-color",cm.hash],2_000_000);checked(r);if(r.truncated)throw new Error("Diff exceeds the clipboard limit");cx.write_to_clipboard(r.stdout);},cx,{reads:true,done:"Copied diff"})],
        ["Author","a",copy("author",author)],
        ["Tags","t",copy("tags",tags.join("\n")),false,null,tags.length?null:"Commit has no tags"],
      ],cx);
    },cx,{reads:true,done:"Commit attributes"});
  }
  copyCommitURL(cm,cx) {
    try{cx.write_to_clipboard(this.hosting().commit(cm.hash));this.info="Copied commit URL";cx.notify();}
    catch(e){this.say(e.message,cx);}
  }
  hosting() {return hostingURLs(this.remotes.find(r=>r.name==="origin")?.url??"",this.lazygitConfig?.services??{});}
  openCommitWeb(cm,cx) {
    try{this.openLink(this.hosting().commit(cm.hash),cx,"Open commit in browser");}
    catch(e){this.say(e.message,cx);}
  }
  createPullRequest(it,cx,to="") {
    try{this.openLink(this.hosting().pullRequest(it.name,to),cx,"Open pull request form");}
    catch(e){this.say(e.message,cx);}
  }
  openPullRequest(it,cx,commit=false,copy=false) {
    let host;try{host=this.hosting();}catch(error){return this.say(error.message,cx);}
    const ref=commit?it.hash:it.name;
    this.externalWork(copy?"Copy pull request URL":"Open pull request",async(plan,cx)=>{
      if(host.provider!=="github")throw new Error("Existing pull request lookup requires a GitHub repository");
      this.externalStage(plan,"Reading pull request",cx,true);plan.context.timeout=120000;
      const args=commit?["api","--hostname",host.webDomain,`repos/${host.owner}/${host.repository}/commits/${ref}/pulls`,"--jq",".[0].html_url // empty"]
        :["pr","view",ref,"--repo",host.repoURL,"--json","url","--jq",".url"];
      const result=await exec("gh",args,plan.context),url=checked(result).trim();if(!/^https?:\/\//.test(url))throw new Error("No pull request found");
      if(!this.externalCurrent(plan))return;
      if(copy)cx.write_to_clipboard(url);else await this.browseURL(url,plan,cx);
    },cx);
  }
  compareMenu(it, cx) {
    const ref = it.hash ?? it.ref ?? it.name;
    this.menuItems("Compare commits or refs", [
      ["Mark as comparison base", "", (cx) => { this.compareBase = ref; this.compareReverse = false; this.main = false; this.reload(cx); }],
      this.compareBase && ["Reverse comparison", "", (cx) => { this.compareReverse = !this.compareReverse; this.reload(cx); }],
      this.compareBase && ["Exit comparison", "esc", (cx) => { this.compareBase = null; this.reload(cx); }],
    ],cx);
  }
  commitActions(cm,cx,rewrite = !this.context() && this.panel === "commits" && this.commitView === "commits") { const actions=this.commitActionItems(cm,cx,rewrite);return this.main?actions:this.guardListActions(actions,["C","a","V","w",...(!cm?.todo&&(this.context()?.type==="commits"||this.commitView!=="reflog")?["enter"]:[])]); }
  commitActionItems(cm, cx, rewrite) {
    if(cm?.todo)return this.pendingRebaseActions(cm,cx);
    if (!cm || cm.hash === "*" || cm.stash) return [];
    const ref = cm.hash, short = ref.slice(0,7);
    const reflog = !this.context() && this.panel === "commits" && this.commitView === "reflog";
    const actions = [
      [reflog ? "View commits" : "View changed files", "enter", (cx) => reflog ? this.openSubCommits(cm,cx) : this.openChangedFiles(cm,cx)],
      ["Checkout detached…", "space", (cx) => this.checkoutRef(ref,cx,true)],
      ["New branch here…", "n", (cx) => this.newBranch(ref,cx)],
      ["New tag here…", "T", (cx) => this.newTag(ref,cx)],
      ["New worktree here…", "w", (cx) => this.newWorktree(ref,cx)],
      ["Open commit in browser", "o", (cx)=>this.openCommitWeb(cm,cx)],
      rewrite && ["Open pull request in browser", "G", (cx)=>this.openPullRequest(cm,cx,true)],
      [this.copied.has(ref) ? "Unmark cherry-pick" : "Copy for cherry-pick", "C", (cx) => this.copyCommits(cm,cx)],
      this.copied.size > 0 && ["Paste copied commits…", "V", (cx) => this.ask("Cherry-pick commits", `Cherry-pick ${this.copied.size} marked commits, in ancestry order?`, (cx) => this.perform("Cherry-pick", async (git,context) => {
        const copied = [...this.copied.keys()];
        // --no-walk sorts dates, not ancestry. Walk outside the script heap
        // and return only selected hashes, including with backdated commits.
        const r = await exec("sh",["-c",'wanted=$1; shift; git rev-list --topo-order --reverse "$@" | while IFS= read -r hash; do case " $wanted " in *" $hash "*) printf "%s\\n" "$hash";; esac; done',"sh",copied.join(" "),...copied],context);
        const order = lines(checked(r));
        if (order.length !== copied.length) throw new Error("Some copied commits are no longer available; select them again");
        await git(["cherry-pick",...order]);
      },cx,{after:()=>this.copied.clear()}),cx)],
      ["Revert…", "t", (cx) => this.ask("Revert commit", `Create a commit reversing ${short} — ${cm.subject}?`, (cx) => this.perform("Revert", [["revert","--no-edit",ref]],cx),cx)],
      ["Reset current branch…", "g", (cx) => this.resetMenu(ref,cx)],
      ["Interactive rebase from here…", "i", (cx) => this.startRebase(cm,cx)],
      ["Reword commit…", "r", (cx) => this.promptValue("Commit summary",cm.subject,(message,cx)=>this.startRebase(cm,cx,{action:"reword",message}),cx)],
      ["Fix up into previous commit…", "f", (cx) => this.startRebase(cm,cx,{action:"fixup",previous:true})],
      ["Squash into previous commit…", "s", (cx) => this.startRebase(cm,cx,{action:"squash",previous:true})],
      ["Drop commit…", "d", (cx) => this.startRebase(cm,cx,{action:"drop"}),true],
      ["Edit commit during rebase…", "e", (cx) => this.startRebase(cm,cx,{action:"edit"})],
      ["Amend with staged changes…", "A", (cx) => this.ask("Amend commit", `Amend ${short} with staged changes${ref !== this.head ? " and replay later commits" : ""}?`, (cx) => this.amendCommit(cm,cx),cx)],
      ["Amend commit attribute…", "a", (cx) => this.authorMenu(cm,cx)],
      ["Create fixup commit from staged changes", "F", (cx) => this.perform("Create fixup", [["commit",`--fixup=${ref}`]],cx)],
      ["Apply fixup commits…", "S", (cx) => this.ask("Autosquash", `Apply fixup commits above ${short}?`, (cx) => this.autosquash(cm,cx),cx)],
      ["Mark rebase base", "B", (cx) => { this.baseCommit = ref; this.info = `Rebase base: ${short}`; cx.notify(); }],
      ["Compare with…", "W", (cx) => this.compareMenu(cm,cx)],
      ["Bisect…", "b", (cx) => this.bisectMenu(ref,cx)],
      ["Copy attribute…", "y", (cx) => this.copyCommitAttribute(cm,cx)],
    ];
    const writes = new Set(["i","r","f","s","d","e","a","A","F","S","B","V"]);
    return actions.filter((a) => a && ((rewrite&&!this.operation) || !writes.has(a[1])));
  }

  openChangedFiles(cm,cx,stash=false) {
    const range=stash?null:this.selectedCommitRange(cm),context={cwd:this.root,on:this.on};
    const canRebase=!this.context()&&this.panel==="commits"&&this.commitView==="commits"&&!stash&&!this.compareBase&&!cm.todo&&!this.operation&&!range;
    const parentCommitContext=this.keyContext();
    const frame=this.pushContext("files",range?.title??cm.subject??cm.name??"Changed files",cx);
    frame.canRebase=canRebase;frame.range=range;frame.parentCommit={...cm};frame.parentCommitContext=parentCommitContext;
    const compare=this.compareBase, reverse=this.compareReverse;
    const rename=`--find-renames=${this.renameThreshold??50}%`;
    this.readContext(frame,async()=>{
      let args,patchArgs,ref=range?null:cm.hash,untracked=null,diffFrom,diffTo=range?.to??cm.hash;
      if (compare) {
        const other=range?.to??cm.hash??cm.ref??cm.name, refs=[compare,other];
        args=["diff","--submodule","--no-ext-diff","--name-status","-z",rename,...(reverse?["-R"]:[]),...refs];patchArgs=["diff",...DIFF,rename,...(reverse?["-R"]:[]),...refs];ref=null;
        diffFrom=compare;diffTo=other;
      } else if(stash) {
        args=["stash","show","--include-untracked","--name-status","-z","--no-renames",cm.hash];patchArgs=["diff",...DIFF,`${cm.hash}^1`,cm.hash];ref=null;
        diffFrom=`${cm.hash}^1`;
        const r=await this.boundedGit(["ls-tree","--name-only","-r","-z",`${cm.hash}^3`],262144,context);
        untracked=new Set(r.code===0?r.stdout.split("\0").filter(Boolean):[]);
      } else {
        diffFrom=await this.commitDiffBase(range?.from??cm.hash,context);
        args=["diff","--submodule","--no-ext-diff","--name-status","-z",rename,diffFrom,diffTo];
        patchArgs=["diff",...DIFF,rename,diffFrom,diffTo];
      }
      const r=await this.boundedGit(args,262144,context);checked(r);
      const items=changedFiles(r.stdout);
      return {items,patchArgs,ref,diffFrom,diffTo,adjustRef:diffTo,checkoutRef:compare&&reverse?compare:diffTo,untracked,stashHash:stash?cm.hash:null,file:items[0]??null,truncated:r.truncated};
    },cx);
  }
  openDetailFile(index,cx) {const d=this.detail;if(!d)return;this.sel[this.panel]=index;this.syncContext();if(!d.file)return;this.main=true;this.historyPatch=null;this.reload(cx);}
  patchSourceKey(frame=this.detail) { return frame ? JSON.stringify([frame.diffFrom,frame.diffTo,frame.patchArgs]) : null; }
  patchFileStatus(file,frame=this.detail) {
    const custom=this.customPatch;
    if(!custom||custom.sourceKey&&custom.sourceKey!==this.patchSourceKey(frame)||!custom.sourceKey&&custom.ref!==frame?.ref)return "";
    if(file.dir){const states=file.files.map(f=>this.patchFileStatus(f,frame));return states.every(x=>x==="whole")?"whole":states.some(Boolean)?"partial":"";}
    const part=custom.parts.get(file.path);return !part?"":part.whole||part.patch.changes.length&&part.rows.size===part.patch.changes.length?"whole":"partial";
  }
  toggleCommitFiles(cx,all=false,replace=false) {
    const frame=this.context();if(frame?.type!=="files"||frame.loading||this.busy)return;
    if(this.configValue("git.diffContextSize",3)===0)return this.say("Increase the diff context before building a custom patch",cx);
    const files=this.selectedCommitFiles(all);if(!files.length)return;
    const sourceKey=this.patchSourceKey(frame), current=this.customPatch;
    const different=current&&(current.sourceKey?current.sourceKey!==sourceKey:current.ref!==frame.ref);
    if(different&&!replace)return this.ask("Discard custom patch","Discard the current custom patch and start one from this comparison?",cx=>{
      if(this.context()===frame)this.toggleCommitFiles(cx,all,true);
    },cx);
    const adding=different||files.some(file=>this.patchFileStatus(file,frame)!=="whole"), repo=this.repoKey;
    const custom=different||!current?{ref:frame.ref??frame.diffTo,sourceKey,canRebase:Boolean(frame.canRebase),parts:new Map()}:{...current,sourceKey,parts:new Map(current.parts)};
    this.perform("Updating patch",async(_git,context)=>{
      for(const file of files){
        if(!adding){custom.parts.delete(file.path);continue;}
        const args=frame.untracked?.has(file.path)?["show","--format=",...DIFF,`${frame.stashHash}^3`]:frame.patchArgs;
        const result=await this.boundedGit(["--literal-pathspecs",...args,"--binary","--full-index",...this.diffOptions(),"--",...filePaths([file])],1_000_000,context);checked(result);
        if(result.truncated)throw new Error(`Patch for ${file.path} exceeds the output limit`);
        // Whole files need their bytes, not a per-line object graph. Parse only
        // when a person opens a bounded preview for partial line selection.
        const patch={raw:result.stdout,changes:[]};if(patch.raw.trim())custom.parts.set(file.path,{path:file.path,patch,rows:new Set(),whole:true});
        if([...custom.parts.values()].reduce((size,part)=>size+part.patch.raw.length,0)>8_000_000)throw new Error("Custom patch exceeds the output limit; select fewer files");
      }
      if(!this.closed&&this.repoKey===repo&&this.root===context.cwd&&this.context()===frame){
        this.customPatch=custom.parts.size?custom:null;this.info=this.customPatch?`Custom patch: ${custom.parts.size} files`:"Custom patch cleared";
      }
    },cx,{reads:true});
  }
  addCustomPatch(cx,replace=false) {
    const data=this.historyPatch,rows=this.selectedRows();
    if(!data?.patch||!rows.length||!this.detail)return this.say("Select changed lines from a commit's file",cx);
    if(this.configValue("git.diffContextSize",3)===0)return this.say("Increase the diff context before building a custom patch",cx);
    const sourceKey=this.patchSourceKey(),ref=data.ref??this.detail.diffTo;
    const different=this.customPatch&&(this.customPatch.sourceKey?this.customPatch.sourceKey!==sourceKey:this.customPatch.ref!==ref);
    if(different&&!replace)return this.ask("Discard custom patch","Discard the current custom patch and start one from this comparison?",cx=>{if(this.historyPatch===data)this.addCustomPatch(cx,true);},cx);
    if(different)this.customPatch=null;
    if(!this.customPatch)this.customPatch={ref,sourceKey,canRebase:Boolean(data.canRebase),parts:new Map()};
    else this.customPatch.canRebase=this.customPatch.canRebase&&Boolean(data.canRebase);
    let part=this.customPatch.parts.get(data.path);
    if(part?.whole){part={path:data.path,patch:data.patch,rows:new Set(data.patch.changes)};this.customPatch.parts.set(data.path,part);}
    if(!part){part={path:data.path,patch:data.patch,rows:new Set()};this.customPatch.parts.set(data.path,part);}
    const remove=rows.every(n=>part.rows.has(n));for(const n of rows){if(remove)part.rows.delete(n);else part.rows.add(n);}
    if(!part.rows.size)this.customPatch.parts.delete(data.path);
    if(!this.customPatch.parts.size)this.customPatch=null;
    this.info=this.customPatch?`Custom patch: ${[...this.customPatch.parts.values()].reduce((n,p)=>n+p.rows.size,0)} changed lines` : "Custom patch cleared";cx.notify();
  }
  customPatchText(reverse=false) {return this.customPatch?[...this.customPatch.parts.values()].map(p=>p.whole?p.patch.raw:selectedPatch(p.patch,p.path,[...p.rows],reverse)).join(""):"";}
  async applyPatchText(text,args,context) {
    const apply=(extra)=>exec("sh",["-c",'patch=$1; shift; printf "%s" "$patch" | git apply --whitespace=nowarn "$@" -',"sh",text,...args,...extra],context);
    checked(await apply(["--check"]));checked(await apply([]));
  }
  // Lazygit's Patch options (custom_patch_options_menu_action.go): same rows,
  // keys and order. Rewrites start an interactive rebase at the patch's commit.
  patchMenu(cx) {
    const custom=this.customPatch;
    if(!custom)return this.say("No patch created yet. To start building a patch, use 'space' on a commit file or enter to add specific lines",cx);
    if(!custom.parts.size)return this.say("Patch is still empty. Add some files or lines to your patch first.",cx);
    const items=[
      ["Reset patch","c",cx=>{this.customPatch=null;this.info="Custom patch cleared";cx.notify();}],
      ["Apply patch","a",cx=>this.applyCustomPatch(false,cx)],
      ["Apply patch in reverse","r",cx=>this.applyCustomPatch(true,cx)],
    ];
    if(custom.canRebase&&!this.operation){
      items.push(
        [`Remove patch from original commit (${custom.ref.slice(0,7)})`,"d",cx=>this.rewritePatch("remove",cx),true],
        ["Move patch out into index","i",cx=>this.rewritePatch("index",cx)],
        ["Move patch into new commit after the original commit","n",cx=>this.promptValue("Commit summary","",(message,cx)=>this.rewritePatch("after",cx,{message}),cx)],
        ["Move patch into new commit before the original commit","N",cx=>this.promptValue("Commit summary","",(message,cx)=>this.rewritePatch("before",cx,{message}),cx)],
      );
      const target=!this.main&&!this.context()&&this.panel==="commits"&&this.commitView!=="reflog"?this.item():null;
      if(target?.hash&&!target.todo&&target.hash!==custom.ref)
        items.splice(1,0,[`Move patch to selected commit (${target.hash.slice(0,7)})`,"m",cx=>this.rewritePatch("move",cx,{target:target.hash}),false,null,this.multipleSelected()?"Range select not supported":null]);
    }
    items.push(["Copy patch to clipboard","y",cx=>{cx.write_to_clipboard(this.customPatchText());this.info="Patch copied to clipboard";cx.notify();}]);
    this.menuItems("Patch options",items,cx);
  }
  // git apply --index --3way, as Lazygit's ApplyPatch. No --check first: a
  // three-way apply may succeed where a plain check fails.
  async applyPatch3(text,args,context) {
    checked(await exec("sh",["-c",'patch=$1; shift; printf "%s" "$patch" | git apply --whitespace=nowarn --index --3way "$@" -',"sh",text,...args],context));
  }
  applyCustomPatch(reverse,cx) {
    const custom=this.customPatch;if(!custom)return;
    const inPatch=new Set([...custom.parts.keys()]),affected=this.files.filter(f=>(f.unstaged||f.fresh)&&inPatch.has(f.path)).map(f=>f.path);
    const text=this.customPatchText(reverse);
    const run=cx=>this.perform(reverse?"Apply patch in reverse":"Apply patch",async(git,context)=>{
      if(affected.length)await git(["--literal-pathspecs","add","--",...affected]);
      await this.applyPatch3(text,reverse?["--reverse"]:[],context);
    },cx);
    if(affected.length)this.ask("Must stage files","Applying a patch to the index requires staging the unstaged files that are affected by the patch. Note that you might get conflicts when applying the patch. Continue?",run,cx);
    else run(cx);
  }
  // Lazygit's onSuccessfulContinue: work that must wait until the rebase
  // reaches a later stop. A conflict on the way keeps it for the person's own
  // Continue; Abort drops it.
  async continueRebase(git,context,next) {
    this.rebaseContinuation=next?{repo:this.repoKey,cwd:context.cwd,on:context.on,run:next}:null;
    await git(["rebase","--continue"]);
    await this.runRebaseContinuation(git,context);
  }
  async runRebaseContinuation(git,context) {
    const next=this.rebaseContinuation;
    if(!next||next.repo!==this.repoKey||next.cwd!==context.cwd||next.on!==context.on)return;
    this.rebaseContinuation=null;await next.run(git,context);
  }
  async parentsOf(hash,git) { return (await git(["rev-list","--parents","-n","1",hash])).trim().split(" ").slice(1); }
  // A copy of `hash` whose parent is a new commit holding the parent's tree plus
  // the patch: picking the copy then applies the commit's changes minus the
  // patch (Lazygit's copyCommitWithPatchInParent). Signatures are dropped.
  async copyCommitWithPatchInParent(hash,text,git,context) {
    const [parent]=await this.parentsOf(hash,git);
    const tree=checked(await exec("sh",["-c",`set -eu; dir=$(mktemp -d); trap 'rm -rf -- "$dir"' EXIT; export GIT_INDEX_FILE="$dir/index"; git read-tree "$1"; printf "%s" "$2" | git apply --cached --whitespace=nowarn -; git write-tree`,"sh",parent,text],context)).trim();
    const object=await git(["cat-file","commit",hash]);
    const write=async body=>checked(await exec("sh",["-c",'printf "%s" "$1" | git hash-object -t commit -w --stdin',"sh",body],context)).trim();
    const withHeader=(body,name,value)=>{
      const cut=body.indexOf("\n\n"),headers=cut<0?body:body.slice(0,cut),message=cut<0?"":body.slice(cut+2),kept=[];let signature=false;
      for(let line of headers.split("\n")){
        if(signature&&line.startsWith(" "))continue;
        signature=line.startsWith("gpgsig ")||line.startsWith("gpgsig-sha256 ");if(signature)continue;
        if(line.startsWith(name+" "))line=`${name} ${value}`;kept.push(line);
      }
      return kept.join("\n")+"\n\n"+message;
    };
    const parentCopy=await write(withHeader(object,"tree",tree));
    return write(withHeader(object,"parent",parentCopy));
  }
  rewritePatch(kind,cx,opts={}) {
    const custom=this.customPatch;if(!custom)return;
    if(!custom.canRebase)return this.say("Only commits in the local Commits pane can be rewritten",cx);
    if(this.operation)return this.say("Finish the current Git operation first",cx);
    const ref=custom.ref,forward=this.customPatchText(false),reverse=this.customPatchText(true),repo=this.repoKey;
    const reset=async()=>{if(this.repoKey===repo&&this.customPatch===custom){this.customPatch=null;this.detail=null;this.historyPatch=null;}};
    const abort=async(git,error)=>{try{await git(["rebase","--abort"]);}catch{}throw error;};
    const amend=git=>git(["commit","--amend","--no-edit","--allow-empty"]);
    // Removes the patch from the stopped commit and returns it as Git's own diff.
    const takeOut=async(git,context)=>{
      try{await this.applyPatch3(reverse,["--reverse"],context);}catch(e){await abort(git,e);}
      await amend(git);
      const diff=await this.boundedGit(["diff","--no-ext-diff","--no-color","--binary",`HEAD..${ref}`],8_000_000,context);
      if(diff.code||diff.truncated)await abort(git,new Error(diff.truncated?"Patch exceeds the output limit":(diff.stderr||diff.stdout).trim()));
      return diff.stdout;
    };
    const commitArgs=message=>["commit",...(this.configValue("git.commit.signOff",false)?["--signoff"]:[]),"-m",message];
    const work={
      remove:async(git,context)=>{
        await this.beginHistoryEdit(ref,git,context);
        try{await this.applyPatch3(reverse,["--reverse"],context);}catch(e){await abort(git,e);}
        await amend(git);await this.continueRebase(git,context,reset);
      },
      index:async(git,context)=>{
        const stash=opts.stash;
        if(stash)await git(["stash","push","-m",`Auto-stashing changes for moving custom patch to index from ${ref.slice(0,7)}`]);
        await this.beginHistoryEdit(ref,git,context,{untracked:true});
        const diff=await takeOut(git,context);
        await this.continueRebase(git,context,async(git,context)=>{
          try{await this.applyPatch3(diff,[],context);}catch(e){if(await this.rebaseActive(context))await abort(git,e);throw e;}
          if(stash)await git(["stash","pop","stash@{0}"]);
          await reset();
        });
      },
      after:async(git,context)=>{
        await this.beginHistoryEdit(ref,git,context);
        const diff=await takeOut(git,context);
        try{await this.applyPatch3(diff,[],context);}catch(e){await abort(git,e);}
        await git(commitArgs(opts.message));await reset();await this.continueRebase(git,context);
      },
      before:async(git,context)=>{
        const parents=await this.parentsOf(ref,git);
        if(parents.length>1)throw new Error("Not supported for a patch from a merge commit");
        if(!parents.length)throw new Error("The patch's commit has no parent to put a new commit before");
        const copy=await this.copyCommitWithPatchInParent(ref,forward,git,context);
        await this.beginHistoryEdit(parents[0],git,context,{keepEmpty:true,replace:new Map([[ref,copy]]),within:ref});
        try{await this.applyPatch3(forward,[],context);}catch(e){await abort(git,e);}
        await git(commitArgs(opts.message));await reset();await this.continueRebase(git,context);
      },
      move:async(git,context)=>{
        const target=opts.target;
        if((await this.parentsOf(target,git)).length>1)throw new Error("Cannot move a patch to a merge commit");
        if((await this.parentsOf(ref,git)).length>1)throw new Error("Not supported for a patch from a merge commit");
        const sourceIsNewer=(await exec("git",["merge-base","--is-ancestor",target,ref],context)).code===0;
        if(sourceIsNewer){
          const copy=await this.copyCommitWithPatchInParent(ref,forward,git,context);
          await this.beginHistoryEdit(target,git,context,{keepEmpty:true,replace:new Map([[ref,copy]]),within:ref});
          // As Lazygit, a conflict here stays for the person to resolve.
          await this.applyPatch3(forward,[],context);
          await amend(git);await this.continueRebase(git,context,reset);
          return;
        }
        await this.beginHistoryEdit(ref,git,context,{edits:[ref,target]});
        const diff=await takeOut(git,context);
        await this.continueRebase(git,context,async(git,context)=>{
          await this.applyPatch3(diff,[],context);
          await amend(git);await this.continueRebase(git,context,reset);
        });
      },
    }[kind];
    const label={remove:"Remove patch",index:"Move patch into index",after:"Move patch into new commit",before:"Move patch into new commit",move:"Move patch to selected commit"}[kind];
    const start=cx=>this.perform(label,(git,context)=>work(git,context),cx,{operation:"rebase"});
    if(kind==="index"){
      // Lazygit's IsWorkingTreeDirtyExceptSubmodules: staged or tracked files.
      const modules=new Set(this.submodules.map(m=>m.path));
      opts.stash=this.files.some(f=>!modules.has(f.path)&&(f.staged||!f.fresh));
      if(opts.stash)return this.ask("Must stash","Pulling a patch out into the index requires stashing and unstashing your changes. If something goes wrong, you'll be able to access your files from the stash. Continue?",start,cx);
    }
    start(cx);
  }
  async rebaseActive(context) { return (await exec("sh",["-c",'test -d "$(git rev-parse --git-path rebase-merge)" || test -d "$(git rev-parse --git-path rebase-apply)"'],context)).code===0; }

  async beginHistoryEdit(ref,git,context,opts={}) {
    if(opts.untracked){if((await git(["status","--porcelain","--untracked-files=no"])).trim())throw new Error("Commit or stash local changes first");}
    else await this.clean(git);
    await git(["merge-base","--is-ancestor",ref,"HEAD"]);
    const edits=new Set(opts.edits??[ref]),replace=opts.replace??new Map();
    for(const hash of [...edits,...replace.keys()])await git(["merge-base","--is-ancestor",hash,"HEAD"]);
    const parents=(await git(["rev-list","--parents","-n","1",ref])).trim().split(" "),base=parents[1];
    const history=await this.boundedGit(["log","--reverse","--format=%H%x1f%P%x1f%s",base?`${base}..HEAD`:"HEAD","--"],262144,context);checked(history);
    if(history.truncated)throw new Error("History is too large; use Lazygit");
    const entries=lines(history.stdout).map(l=>{const[hash,parents,subject]=l.split("\x1f");if(parents.includes(" "))throw new Error("This range has merge commits; use Lazygit");return {hash:replace.get(hash)??hash,original:hash,subject,action:edits.has(hash)?"edit":"pick"};});
    for(const hash of [...edits,...replace.keys()])if(!entries.some(entry=>entry.original===hash))throw new Error("The commit is not in the rewritten history");
    checked(await exec("env",[`HERDR_GIT_TODO=${rebaseTodo(entries)}`,`GIT_SEQUENCE_EDITOR=${SEQUENCE}`,"GIT_EDITOR=true","git","rebase","-i",...(opts.keepEmpty?["--empty=keep"]:[]),...(base?[base]:["--root"])],context));
    if((await git(["rev-parse","HEAD"])).trim()!==ref)throw new Error("Rebase stopped before the source commit; resolve or abort it before retrying");
    return {base,after:entries.length-entries.findIndex(entry=>entry.original===ref)-1};
  }

  discardCommitFiles(cx) {
    const frame=this.context(),selected=frame?.type==="files"?this.selectedCommitFiles():[],repo=this.repoKey,head=this.head;
    if(frame?.type!=="files"||!selected.length)return;
    if(!frame.canRebase||this.operation)return this.say("Only a single local commit outside an active Git operation can be changed",cx);
    const ref=frame.ref,paths=[...new Set(selected.flatMap(file=>file.previousPath?[file.path,file.previousPath]:[file.path]))];
    this.ask("Discard file changes",`Remove changes to ${paths.length} selected file${paths.length===1?"":"s"} from ${ref.slice(0,7)} and replay later commits?${this.customPatch?" The current custom patch will be cleared.":""}`,cx=>{
      if(this.repoKey!==repo||this.context()!==frame||this.operation)return this.say("The selected commit or repository changed; select the files again",cx);
      this.perform("Rebasing",async(git,context)=>{
        if((await git(["rev-parse","HEAD"])).trim()!==head)throw new Error("HEAD changed; select the files again");
        this.customPatch=null;
        const edit=await this.beginHistoryEdit(ref,git,context);
        for(const path of paths){
          const existed=edit.base&&(await git(["--literal-pathspecs","ls-tree","--name-only","-z",edit.base,"--",path])).split("\0").includes(path);
          if(existed)await git(["--literal-pathspecs","checkout",edit.base,"--",path]);
          else await git(["--literal-pathspecs","rm","-rf","--ignore-unmatch","--",path]);
        }
        await git(["commit","--amend","--no-edit","--allow-empty"]);await git(["rebase","--continue"]);
        const next=(await git(["rev-parse",`HEAD~${edit.after}`])).trim();
        const parent=await this.commitDiffBase(next,context),rename=`--find-renames=${this.renameThreshold??50}%`;
        const patchArgs=["diff",...DIFF,rename,parent,next];
        const raw=await this.boundedGit(["diff","--submodule","--no-ext-diff","--name-status","-z",rename,parent,next],262144,context);checked(raw);
        const items=changedFiles(raw.stdout);
        if(!this.closed&&this.repoKey===repo&&this.context()===frame){
          Object.assign(frame,{ref:next,diffFrom:parent,diffTo:next,adjustRef:next,checkoutRef:next,patchArgs,items,truncated:raw.truncated});
          frame.parentCommit={...frame.parentCommit,hash:next};this.cancelRange();this.clampRange();this.syncContext();this.historyPatch=null;
        }
      },cx);
    },cx);
  }

  async clean(git) { if ((await git(["status","--porcelain"])).trim()) throw new Error("Commit or stash local changes first"); }
  startRebase(cm, cx, change = {}) {
    if(this.operation)return this.say("Finish the current Git operation before starting a rebase",cx);
    this.perform("Prepare rebase", async (git) => {
      await this.clean(git); await git(["merge-base","--is-ancestor",cm.hash,"HEAD"]);
      const selected = change.previous ? (await git(["rev-parse",`${cm.hash}^`])).trim() : cm.hash;
      const parents = (await git(["rev-list","--parents","-n","1",selected])).trim().split(" ");
      const base = parents[1] ?? null;
      const r = await this.boundedGit(["log","--reverse","--format=%H%x1f%P%x1f%s",...(base ? [`${base}..HEAD`] : ["HEAD"]),"--"]);
      checked(r); if (r.truncated) throw new Error("Rebase plan is too large; use Lazygit");
      const entries = lines(r.stdout).map((l) => { const [hash,parents,subject] = l.split("\x1f"); if (parents?.includes(" ")) throw new Error("This range contains merge commits; use Lazygit to preserve its topology"); return {hash,subject,action: hash === cm.hash ? change.action ?? "pick" : "pick",message: hash === cm.hash ? change.message : null}; });
      if (entries.length > 500) throw new Error("Rebase range exceeds 500 commits; select a later base");
      const head = (await git(["rev-parse","HEAD"])).trim(), branch = (await git(["symbolic-ref","--short","HEAD"])).trim();
      this.plan = {base, entries, head, branch}; this.planAt = entries.findIndex((x)=>x.hash===cm.hash); this.main = true; this.handle.focus();
    },cx,{reads:true});
  }
  applyPlan(cx) {
    const plan = this.plan; if (!plan) return;
    let todo; try { todo = rebaseTodo(plan.entries); } catch(e) { return this.say(e.message,cx); }
    this.ask("Apply rebase plan", `Rewrite ${plan.entries.length} commits on ${plan.branch}? This changes their hashes.`, (cx) => this.perform("Interactive rebase", async (git,context) => {
      await this.clean(git);
      if ((await git(["rev-parse","HEAD"])).trim() !== plan.head || (await git(["symbolic-ref","--short","HEAD"])).trim() !== plan.branch) throw new Error("HEAD changed; prepare the rebase again");
      this.plan = null;
      checked(await exec("env", [`HERDR_GIT_TODO=${todo}`,`GIT_SEQUENCE_EDITOR=${SEQUENCE}`,"GIT_EDITOR=true","git","rebase","-i",...(plan.base ? [plan.base] : ["--root"])],context));
    },cx),cx);
  }
  amendCommit(cm,cx) {
    if (cm.hash === this.head) return this.perform("Amend", [["commit","--amend","--no-edit"]],cx);
    this.perform("Amend old commit", async (git,context) => {
      await git(["merge-base","--is-ancestor",cm.hash,"HEAD"]);
      if ((await git(["diff","--name-only"])).trim() || (await git(["ls-files","--others","--exclude-standard"])).trim()) throw new Error("Stage or stash other working changes first");
      const parents = (await git(["rev-list","--parents","-n","1",cm.hash])).trim().split(" ");
      await git(["commit",`--fixup=${cm.hash}`]);
      checked(await exec("env", ["GIT_SEQUENCE_EDITOR=true","GIT_EDITOR=true","git","rebase","-i","--autosquash",...(parents[1] ? [parents[1]] : ["--root"])],context));
    },cx);
  }
  autosquash(cm,cx) { this.perform("Autosquash", async(git,context)=>{ await this.clean(git); const parents=(await git(["rev-list","--parents","-n","1",cm.hash])).trim().split(" "); checked(await exec("env",["GIT_SEQUENCE_EDITOR=true","GIT_EDITOR=true","git","rebase","-i","--autosquash",...(parents[1]?[parents[1]]:["--root"])],context)); },cx); }

  operationMenu(cx) {
    const op = this.operation, commands=operationCommands(op);
    if (!commands) return this.say("No Git operation in progress",cx);
    this.menuItems(`${commands.label} in progress`, [
      ["Continue", "c", (cx) => this.continueOperation(op,cx)],
      ["Abort…", "a", (cx) => this.ask(`Abort ${commands.label}`, `Abort ${commands.label} and restore its starting state? Conflict resolutions will be discarded.`, (cx) => {this.rebaseContinuation=null;this.perform(`Abort ${commands.label}`, [commands.abort],cx);},cx),true],
      commands.skip && ["Skip current commit…", "s", (cx) => this.ask(`Skip ${commands.label}`, "Skip this commit and its conflict resolution?", (cx) => this.perform(`Skip ${commands.label}`, [commands.skip],cx),cx),true],
    ],cx);
  }
  offerContinue(previous,cx) {
    if(this.pending?.operation && (this.pending.operation!==this.operation||this.files.some(f=>f.conflict)))this.pending=null;
    if(!this.operation){this.startedOperation=null;return;}
    if(this.startedOperation!==this.operation||!previous.some(f=>f.conflict)||this.files.some(f=>f.conflict)||this.pending||this.prompt)return;
    const commands=operationCommands(this.operation);if(!commands)return;
    const op=this.operation;
    this.ask(`Continue ${commands.label}`,`All conflicts are resolved. Continue ${commands.label}?`,(cx)=>this.continueOperation(op,cx),cx);
    this.pending.operation=op;
  }
  bisectMenu(ref,cx) {
    this.menuItems("Bisect", [
      ...["good","bad"].map((kind)=>[`Mark ${kind}`,ref.slice(0,7),(cx)=>this.perform(`Bisect ${kind}`,[...(!this.bisecting ? [["bisect","start"]] : []),["bisect",kind,ref]],cx)]),
      this.bisecting && ["Skip current commit", "", (cx)=>this.perform("Bisect skip",[["bisect","skip"]],cx)],
      this.bisecting && ["End bisect", "", (cx)=>this.perform("End bisect",[["bisect","reset"]],cx)],
    ],cx);
  }

  conflictMenu(cx) {
    const f = this.item("files")?.file; if (!f?.conflict) return this.say("Select a conflicted file",cx);
    this.menuItems(`Resolve ${f.path}`, [
      ...["ours","theirs"].map((side,index)=>{
        const deleted=(index===0?f.x:f.y)==="D";
        return [deleted?`Accept ${side} deletion…`:`Use ${side} for entire file…`,index===0?"o":"t",(cx)=>this.ask("Resolve whole file",deleted?`Remove ${f.path} and mark its deletion resolved?`:`Replace ${f.path} with ${side} and stage it? During a rebase, ours is the target branch; theirs is the replayed commit.`,(cx)=>this.perform("Resolve conflict",deleted?[["rm","--",f.path]]:[["checkout",`--${side}`,"--",f.path],["add","--",f.path]],cx),cx)];
      }),
      ["Mark file resolved", "r", (cx)=>this.perform("Mark resolved",async(git,context)=>{
        if(f.inlineConflict&&!await this.conflictResolved(f,context))throw new Error("Conflict markers remain; resolve them before staging");
        await git(["add","--",f.path]);
      },cx)],
      f.inlineConflict && ["Resolve individual conflicts", "enter", (cx)=>this.focusDiff(cx)],
      ["Open merge tool", "m", (cx)=>this.openMergeTool(cx)],
    ],cx);
  }
  resolveHunk(side,cx) {
    const parsed=this.conflicts, file=this.diffFile, at=this.conflictAt ?? 0;
    if (!parsed?.conflicts[at] || !file) return;
    const next=resolveConflict(parsed,at,side);
    this.perform("Resolve conflict",async(git,context)=>{
      const current=await readTextFile(`${context.cwd}/${file.path}`,{on:context.on});
      if (current!==parsed.text) throw new Error("File changed since this conflict was loaded; refresh first");
      if (!context.on) await writeTextFile(`${context.cwd}/${file.path}`, next, parsed.text);
      else {
        checked(await exec("sh",["-c",'umask 077; file=$1; content=$2; expected=$3; tmp=$(mktemp "${file}.herdr-XXXXXX") || exit 1; trap \'rm -f "$tmp"\' EXIT; cp -p "$file" "$tmp" && printf "%s" "$content" > "$tmp" || exit 1; test "$(git hash-object -- "$file")" = "$(printf "%s" "$expected" | git hash-object --stdin)" || { printf "File changed; refresh first" >&2; exit 1; }; mv "$tmp" "$file"',"sh",`${context.cwd}/${file.path}`,next,parsed.text],context));
      }
      this.conflictAt=Math.min(at,Math.max(0,parseConflicts(next,parsed.markerSize).conflicts.length-1));
      if(this.configValue("git.autoStageResolvedConflicts",true)&&await this.conflictResolved(file,context))await git(["add","--",file.path]);
    },cx);
  }

  async conflictResolved(file, context={cwd:this.root,on:this.on}) {
    if(!file.inlineConflict||file.binary)return false;
    // Scan outside the JS heap. A remaining opening/separator/closing marker
    // (even an incomplete conflict) prevents automatic staging.
    const script="test -f \"$1\" || exit 2\ntest \"$(wc -c < \"$1\")\" = \"$(LC_ALL=C tr -d '\\000' < \"$1\" | wc -c)\" || exit 1\nsize=$(git check-attr conflict-marker-size -- \"$1\"); size=${size##*: }\ncase \"$size\" in \"\"|*[!0-9]*) size=7;; esac\ntest \"$size\" -gt 0 || size=7\nLC_ALL=C awk -v n=\"$size\" 'BEGIN {bad=0} {c=substr($0,1,1); if(c==\"<\"||c==\">\"){p=\"\";for(i=0;i<n;i++)p=p c;if(substr($0,1,n)==p && (length($0)==n || substr($0,n+1,1) ~ /[ \\r]/))bad=1}} END {exit bad}' \"$1\"";
    return (await exec("sh",["-c",script,"sh",file.path],context)).code===0;
  }
  async stageResolvedConflicts() {
    if(!this.configValue("git.autoStageResolvedConflicts",true))return;
    const repo=this.repoKey, context={cwd:this.root,on:this.on};
    const currentRepo=()=>!this.closed&&this.repoKey===repo&&this.root===context.cwd&&this.on===context.on;
    const previous=this.files.filter(f=>f.conflict&&f.inlineConflict&&!f.binary);
    if(!previous.length)return;
    const current=await this.boundedGit(["diff","--name-only","--diff-filter=U","-z"]);
    if(current.code)return;
    const paths=new Set(current.stdout.split("\0"));
    for(const file of previous)if(currentRepo()&&paths.has(file.path)&&await this.conflictResolved(file,context)&&currentRepo())checked(await exec("git",["--literal-pathspecs","add","--",file.path],context));
  }

  stashMenu(cx) {
    const f=this.item("files")?.file;
    this.menuItems("Stash changes",[
      ["All changes, including untracked", "s",(cx)=>this.stashPrompt(["--include-untracked"],cx)],
      ["Staged changes only", "",(cx)=>this.stashPrompt(["--staged"],cx)],
      ["Keep staged changes in working tree", "",(cx)=>this.stashPrompt(["--keep-index","--include-untracked"],cx)],
      f && ["Selected file", "",(cx)=>this.stashPrompt(["--include-untracked"],cx,[f.path])],
    ],cx);
  }
  stashPrompt(flags,cx,paths=[]) { this.promptValue("Stash description (optional)","",(message,cx)=>this.perform("Stash",[["stash","push",...flags,...(message?["-m",message]:[]),...(paths.length?["--",...paths]:[])]],cx),cx,{empty:true}); }

  stashAction(kind, stash, cx, name) {
    this.perform(`${kind} stash`, async(git)=>{
      if ((await git(["rev-parse",stash.ref])).trim() !== stash.hash) throw new Error("The stash list changed; select the stash again");
      if (kind === "rename") {
        if (name === stash.subject) return;
        const tree = (await git(["rev-parse",`${stash.hash}^{tree}`])).trim();
        const parents = (await git(["rev-list","--parents","-n","1",stash.hash])).trim().split(" ").slice(1);
        const renamed = (await git(["commit-tree",tree,...parents.flatMap(p=>["-p",p]),"-m",name])).trim();
        if (renamed === stash.hash) throw new Error("The stash already has this description");
        // Store a distinct commit first; storing the current hash creates no
        // reflog entry on Git 2.39. The original remains until this succeeds.
        await git(["stash","store","-m",name,renamed]);
        const shifted = `stash@{${Number(/\{(\d+)\}/.exec(stash.ref)[1])+1}}`;
        if ((await git(["rev-parse",shifted])).trim() !== stash.hash) throw new Error("Stash list changed; both copies have been kept");
        await git(["stash","drop",shifted]);
      } else if (kind === "branch") await git(["switch","-c",name,stash.hash]);
      else await git(["stash",kind,stash.ref]);
    },cx,{after:cx=>{
      if((kind==="apply"&&this.configValue("gui.switchToFilesAfterStashApply",true))||(kind==="pop"&&this.configValue("gui.switchToFilesAfterStashPop",true)))this.selectView("files","files",cx);
    }});
  }
  stashActions(cx) { return this.guardListActions(this.stashActionItems(cx),["enter","w","d"]); }
  stashActionItems(cx) {
    const it=this.item("stash"); if(!it)return [];
    return [
      ["View changed files", "enter",(cx)=>this.openChangedFiles(it,cx,true)],
      ["Apply…", "space",(cx)=>this.configValue("gui.skipStashWarning",false)?this.stashAction("apply",it,cx):this.ask("Apply stash",`Apply ${it.ref} and keep it in the stash list?`,(cx)=>this.stashAction("apply",it,cx),cx)],
      ["Pop…", "g",(cx)=>this.configValue("gui.skipStashWarning",false)?this.stashAction("pop",it,cx):this.ask("Pop stash",`Apply and remove ${it.ref}?`,(cx)=>this.stashAction("pop",it,cx),cx)],
      ["Drop…", "d",(cx)=>this.dropStashes(cx),true],
      ["New branch from stash…", "n",(cx)=>this.promptValue("New branch from stash","",(name,cx)=>this.stashAction("branch",it,cx,name),cx)],
      ["New worktree here…", "w",(cx)=>this.newWorktree(it.hash,cx)],
      ["Rename stash…", "r",(cx)=>this.promptValue("Stash description",it.subject,(name,cx)=>this.stashAction("rename",it,cx,name),cx)],
    ];
  }

  fileActions(cx) {
    const node=this.item("files"), f=node?.file;
    return [
      node && ["Stage / unstage", "space",(cx)=>this.toggleSelectedFiles(cx)],
      ["Stage / unstage all", "a",(cx)=>this.toggleAll(cx)],
      ["Filter files…", "ctrl-b",(cx)=>this.fileStatusMenu(cx)],
      ["Commit staged changes…", "c",(cx)=>this.ask2("commit","Commit summary",cx)],
      ["Stash options…", "S",(cx)=>this.stashMenu(cx)],
      ["Reset working tree…", "D",(cx)=>this.resetWorkingTree(cx)],
      node && ["Discard changes…", "d",(cx)=>this.discardFilesMenu(cx),true],
      node && ["Ignore / exclude file…", "i",(cx)=>this.ignoreFileMenu(cx),false,null,this.multipleSelected()?"Range selection is not supported for ignoring files":null],
      f?.conflict && ["Resolve conflict…", "M",(cx)=>this.conflictMenu(cx),false,null,this.multipleSelected()?"Select one file to resolve conflicts":null],
      node && ["Edit file", "e",(cx)=>this.editSelectedFiles(cx)],
      node && ["Open file", "o",(cx)=>this.openSelectedFile(cx)],
      node && ["Open diff tool", "ctrl-t",(cx)=>this.openDiffTool(cx)],
      node && ["Copy to clipboard…", "y",(cx)=>this.copyFileMenu(cx)],
      ["Open Lazygit", "L",(cx)=>this.launchLazygit(cx)],
    ];
  }
  resetWorkingTree(cx) {
    const offer=(label,description,steps)=>[label,"",(cx)=>this.ask(label,description,(cx)=>this.perform(label,steps,cx),cx),true];
    this.menuItems("Reset working tree",[
      ["Unstage all", "",(cx)=>this.perform("Unstage all",[this.hasHead?["reset"]:["rm","-r","--cached","--","."]],cx)],
      offer("Discard unstaged tracked changes…","Restore tracked files from the index, keeping staged changes?",[["restore","--worktree","--","."]]),
      this.hasHead&&offer("Discard all tracked changes…","Reset all tracked files and the index to HEAD?",[["reset","--hard"]]),
      offer("Delete untracked files…","Delete all untracked, non-ignored files and folders?",[["clean","-fd"]]),
      this.hasHead&&offer("Nuke working tree and submodules…","Discard all tracked changes and delete untracked files, including inside submodules?",[["reset","--hard","--recurse-submodules"],["submodule","foreach","--recursive","git reset --hard && git clean -fd"],["clean","-fd"]]),
    ],cx);
  }

  async launchTerminal(argv, title, cx) {
    if (checking() || this.launching) return;
    this.launching = ({lazygit:"Opening Lazygit","git-commit":"Opening Git's editor"})[title] ?? "Starting command"; this.note = null; cx.notify();
    try {
      const args=["run","--json","--bg","--rm","--no-parent","--cwd",this.root,"--name",`${title}-${Date.now()}`];
      if (this.on) args.push("--on",this.on);
      const r=await hc([...args,"--",...argv]); checked(r);
      const address=JSON.parse(r.stdout).address;
      openOverlay({kind:"dialog",modal:true,width:0.96,height:0.94,layout:{type:"block",content:{terminal:address}}});
    } catch(e) { this.note = `Could not open ${title}: ${e.message ?? e}`; }
    finally { this.launching = null; cx.notify(); }
  }
  launchLazygit(cx) { cx.spawn(async(cx)=>this.launchTerminal(["lazygit"],"lazygit",cx)); }
  customCommand(cx) { this.promptValue("Run shell command in this repository", "", (command,cx)=>cx.spawn(async(cx)=>this.launchTerminal(["sh","-c",'eval "$1"; code=$?; printf "\\nExit %s. Press Enter to close." "$code"; read answer',"sh",command],"git-command",cx)),cx); }

  moreMenu(cx) {
    this.menuItems("Repository actions",[
      ["Open Lazygit", "L",(cx)=>this.launchLazygit(cx)],
      ["Run custom command…", ":",(cx)=>this.customCommand(cx)],
      ["Configured commands…", "",(cx)=>this.customCommandsMenu(cx)],
      this.gitTask?.terminal && [`Open ${this.gitTask.kind} terminal`, "",()=>this.openGitTerminal()],
      ["Lazygit configuration", "",(cx)=>{this.configOpen=true;this.main=true;cx.notify();}],
      ["Edit Lazygit configuration…", "",(cx)=>this.editConfiguration(cx)],
      ["Fetch all remotes", "",(cx)=>this.perform("Fetch all",[["fetch","--all","--prune"]],cx,{network:true})],
      ["Pull with rebase…", "",(cx)=>this.ask("Pull with rebase","Fetch and replay local commits on the upstream?",(cx)=>this.perform("Pull with rebase",[["pull","--rebase"]],cx,{network:true}),cx)],
      ["Force push with lease…", "",(cx)=>this.ask("Force push with lease","Replace the upstream branch only if it still matches the last fetched state?",(cx)=>this.perform("Force push",async git=>{if(this.configValue("git.disableForcePushing",false))throw new Error("Force pushing is disabled in Lazygit configuration");await git(["push","--force-with-lease"]);},cx,{network:true}),cx),true,null,this.configValue("git.disableForcePushing",false)?"Force pushing is disabled in Lazygit configuration":null],
      ["Undo reflog action…", "z",(cx)=>this.undo(false,cx)],
      ["Redo reflog action…", "Z",(cx)=>this.undo(true,cx)],
      this.operation && ["Continue / abort operation…", "m",(cx)=>this.operationMenu(cx)],
      this.bisecting && ["Bisect options…", "",(cx)=>this.bisectMenu("HEAD",cx)],
      ["Command output", "",(cx)=>{this.logOpen=true;this.main=true;cx.notify();}],
      this.lastEditedPatch && ["Copy saved hunk folder", "",(cx)=>cx.write_to_clipboard(this.lastEditedPatch.folder)],
    ],cx);
  }

  featureKeys(e,cx) {
    const k=e.key, m=e.modifiers??{}, ch=e.key_char??(m.shift?k.toUpperCase():k);
    if (this.busy && !["escape","q"].includes(k)) return true;
    if (this.configurationKeys(e,cx)) return true;
    if (this.plan) {
      const plan=this.plan.entries, at=this.planAt, row=plan[at];
      if (k==="escape") { this.plan=null;cx.notify();return true; }
      if ((m.platform||m.control)&&k==="enter") this.applyPlan(cx);
      else if (m.control&&(k==="j"||k==="k")) { const to=Math.max(0,Math.min(at+(k==="j"?1:-1),plan.length-1)); [plan[at],plan[to]]=[plan[to],plan[at]];this.planAt=to; }
      else if (ch==="j"||k==="down") this.planAt=Math.min(at+1,plan.length-1);
      else if (ch==="k"||k==="up") this.planAt=Math.max(0,at-1);
      else if (ch==="g") this.planAt=0; else if (ch==="G") this.planAt=plan.length-1;
      else if (ch==="r"&&row) this.promptValue("New commit summary",row.message??row.subject,(message,cx)=>{row.action="reword";row.message=message;cx.notify();},cx);
      else if (row&&({p:"pick",s:"squash",f:"fixup",d:"drop",e:"edit"})[ch]) row.action=({p:"pick",s:"squash",f:"fixup",d:"drop",e:"edit"})[ch];
      this.planScroll.scroll_to_item(this.planAt); cx.notify(); return true;
    }
    if (this.logOpen) { if (k==="escape") {this.logOpen=false;cx.notify();} return true; }
    if (this.pendingRebaseKeys(e,cx)) return true;
    if (this.externalKeys(e,cx)) return true;
    if (m.control&&k==="p") {this.patchMenu(cx);return true;}
    if (m.control&&k==="b"&&!this.main&&this.panel==="files"&&this.fileView==="files") {this.fileStatusMenu(cx);return true;}
    if (m.control&&k==="r") {this.copied.clear();cx.notify();return true;}
    if (m.control&&k==="o"&&this.selectedCommit()) {cx.write_to_clipboard(this.selectedCommit().hash);return true;}
    if (m.control&&k==="y"&&!this.main&&!this.context()&&this.panel==="branches"&&this.branchView==="local"&&this.item()) {if(this.multipleSelected())this.say("This action requires a single selected item",cx);else this.openPullRequest(this.item(),cx,false,true);return true;}
    if (m.platform||m.control||m.alt) return false;
    if (this.listRangeKeys(k,ch,m,cx)) return true;
    if(k==="escape"&&this.compareBase){this.compareBase=null;this.reload(cx);return true;}
    if(k==="escape"&&this.copied.size){this.copied.clear();cx.notify();return true;}
    if (!this.main && this.isCommitSearch() && this.filters[this.viewKey()] && (ch==="n"||ch==="N")) {this.nextPanelMatch(ch==="n"?1:-1,cx);return true;}
    if (ch==="m"&&this.operation) {this.operationMenu(cx);return true;}
    if (this.context() && !this.main) {
      if (k === "escape") {
        if(this.panelSearchOpen){this.panelSearchOpen=false;this.filters[this.viewKey()]="";this.reload(cx);}
        else this.popContext(cx);
        return true;
      }
      if (ch === "/") {this.panelSearchOpen=true;this.panelSearch.set_value(this.filters[this.viewKey()]??"");this.panelSearch.focus();cx.notify();return true;}
      const actions=this.contextActions(cx);
      if (ch === "m" || ch === "x") {this.menuItems(this.context().title,actions,cx);return true;}
      const action=actions.find(a=>a[1]===ch||a[1]===k);if(action){if(action[5])this.say(action[5],cx);else action[2](cx);return true;}
      if (!["[","]"].includes(ch)) return false;
    }
    if (this.detail && this.main && this.historyPatch?.patch) {
      if(k==="escape"&&this.anchor!=null){this.anchor=null;cx.notify();return true;}
      if(ch==="a"){this.lineMode=!this.lineMode;this.anchor=null;cx.notify();return true;}
      if(ch==="v"){this.lineMode=true;this.anchor=this.anchor==null?this.cursor:null;cx.notify();return true;}
      if(ch===" "||k==="space"){this.addCustomPatch(cx);return true;}
      if(ch==="m"){this.patchMenu(cx);return true;}
      if(["h","l"].includes(ch)||["left","right"].includes(k)||(!this.lineMode&&(["j","k"].includes(ch)||["up","down"].includes(k)))){this.moveHunk(["h","k"].includes(ch)||["left","up"].includes(k)?-1:1,cx);return true;}
    }
    if (ch==="L") {this.launchLazygit(cx);return true;}
    if (ch===":") {this.customCommand(cx);return true;}
    if (ch==="z"||ch==="Z") {this.undo(ch==="Z",cx);return true;}
    if (ch==="m"&&this.operation) {this.operationMenu(cx);return true;}
    if (k==="escape"&&this.compareBase) {this.compareBase=null;this.reload(cx);return true;}
    if (k==="escape"&&this.copied.size) {this.copied.clear();cx.notify();return true;}
    if (!this.main && k==="escape"&&this.panelSearchOpen) {this.panelSearchOpen=false;this.filters[this.viewKey()]="";this.reload(cx);return true;}
    if (!this.main && k==="escape" && this.panel==="branches" && this.remoteContext) {this.leaveRemote(cx);return true;}
    if (!this.main && k==="escape"&&this.repoStack.length) {if(this.busy)return this.say("Wait for the current operation to finish",cx),true;this.location=this.repoStack.pop();this.resetRepository(cx);return true;}
    if (!this.main&&["files","branches","commits"].includes(this.panel)&&["[","]"].includes(ch)) {this.switchView(ch==="["?-1:1,cx);return true;}
    if (!this.main&&(this.panel!=="files"||this.fileView!=="files")&&ch==="/") {this.panelSearchOpen=true;this.panelSearch.set_value(this.filters[this.viewKey()]??"");this.panelSearch.focus();cx.notify();return true;}
    if (this.main&&this.panel==="files"&&this.fileView==="files"&&!this.peek&&!this.graph) {
      if (this.conflicts?.conflicts.length) {
        const list=this.conflicts.conflicts;
        if (["j","k","h","l"].includes(ch)||["down","up","left","right"].includes(k)) {
          this.conflictAt=Math.max(0,Math.min((this.conflictAt??0)+(["k","h"].includes(ch)||["up","left"].includes(k)?-1:1),list.length-1));
          this.cursor=list[this.conflictAt].start;this.diffScroll.scroll_to_item(this.cursor,"center");cx.notify();return true;
        }
        if (["o","t","b"].includes(ch)) {this.resolveHunk(({o:"ours",t:"theirs",b:"both"})[ch],cx);return true;}
      }
      if (this.patch) {
        if (ch==="a") {this.lineMode=!this.lineMode;this.anchor=null;cx.notify();return true;}
        if (ch==="v") {this.lineMode=true;this.anchor=this.anchor==null?this.cursor:null;cx.notify();return true;}
        if (ch===" "||k==="space"||ch==="d") {this.applySelection(ch==="d",cx);return true;}
        if (["h","l"].includes(ch)||["left","right"].includes(k)||(!this.lineMode&&(["j","k"].includes(ch)||["up","down"].includes(k)))) {this.moveHunk(["h","k"].includes(ch)||["left","up"].includes(k)?-1:1,cx);return true;}
      }
      if (k==="tab") {this.switchDiff(cx);return true;}
      if (ch==="c") {this.ask2("commit","Commit summary",cx);return true;}
      if (ch==="M") {this.conflictMenu(cx);return true;}
      if (k==="escape"&&this.anchor!=null) {this.anchor=null;cx.notify();return true;}
    }
    if (!this.main&&this.panel==="branches") {
      const actions=this.branchActions(cx).filter(Boolean);
      if(ch==="m"||ch==="x") {this.menuItems(this.branchContext(),actions,cx);return true;}
      const action=actions.find((a)=>a[1]===ch||a[1]===k);
      if(action){if(action[5])this.say(action[5],cx);else action[2](cx);return true;}
    }
    if ((this.panel==="commits"&&!this.main)||(this.main&&this.graph)) {
      const cm=this.selectedCommit(), actions=this.commitActions(cm,cx).filter(Boolean);
      if (!this.main&&(ch==="m"||ch==="x")) {this.menuItems(cm?.subject??"Commit",actions,cx);return true;}
      // Graph row shortcuts have their own captured targets and option menus.
      const graphBindings=this.main&&this.graph?this.graphKeys(cx):null;
      const action=actions.find((a)=>(a[1]===ch||a[1]===k)&&!(graphBindings&&(graphBindings[ch]||graphBindings[k]||["f","enter"].includes(ch))));
      if(action){if(action[5])this.say(action[5],cx);else action[2](cx);return true;}
    }
    if (!this.main&&this.panel==="files"&&this.fileView!=="files") {
      const actions=this.repositoryActions(cx).filter(Boolean);
      if(ch==="m"||ch==="x") {this.menuItems(this.fileView,actions,cx);return true;}
      const action=actions.find((a)=>a[1]===ch||a[1]===k||(this.fileView==="worktrees"&&a[1]==="enter"&&(ch===" "||k==="space")));
      if(action){if(action[5])this.say(action[5],cx);else action[2](cx);return true;}
      return false;
    }
    if (!this.main&&this.panel==="files") {
      if (ch==="m"||ch==="x") {this.menuItems("File actions",this.fileActions(cx),cx);return true;}
      if (ch==="C") { this.commitInEditor(cx);return true; }
      if (ch==="S") {this.stashMenu(cx);return true;}
      if (ch==="D") {this.resetWorkingTree(cx);return true;}
      if (ch==="M") {if(this.multipleSelected())this.say("Select one file to resolve conflicts",cx);else this.conflictMenu(cx);return true;}
      if ((k==="enter"||ch==="0")&&this.item()?.file) {if(this.multipleSelected())this.say("This action requires a single selected item",cx);else this.focusDiff(cx);return true;}
    }
    if (!this.main&&this.panel==="stash") {
      const actions=this.stashActions(cx);
      if (ch==="m"||ch==="x") {this.menuItems("Stash actions",actions,cx);return true;}
      const action=actions.find((a)=>a[1]===ch||a[1]===k); if(action){if(action[5])this.say(action[5],cx);else action[2](cx);return true;}
    }
    return false;
  }

  featureMain(c) {
    if(this.customOutput&&!this.customOutput.popup)return this.customOutputView(c);
    if(this.configOpen)return this.configurationView(c);
    if (this.plan) return v_flex().size_full().gap(8).p(12)
      .child(h_flex().gap(10).items_center().child(div().flex_1().font_semibold().child(`Rebase ${this.plan.entries.length} commits · oldest first`)).child(this.button("apply-rebase","Apply plan",c,(cx)=>this.applyPlan(cx),{key:"⌘↵",primary:true,busy:"Interactive rebase"})))
      .child(div().text_size(11).text_color(c.muted).child("p pick · r reword · e edit · s squash · f fixup · d drop · ctrl-j/k move · esc back"))
      .child(v_flex().id("git-plan").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.planScroll).children(this.plan.entries.map((cm,n)=>h_flex().id(`plan-${cm.hash}`).h(30).flex_none().px(10).gap(10).items_center().rounded(6).when(n===this.planAt,e=>e.bg(c.selected)).on_click((_e,cx)=>{this.planAt=n;this.handle.focus();cx.notify();})
        .child(div().w(56).text_color(cm.action==="drop"?c.red:c.accent).child(cm.action)).child(div().text_color(c.dim).font_family(c.mono).child(cm.hash.slice(0,7))).child(div().flex_1().truncate().child(cm.message??cm.subject)))));
    if (this.logOpen) return v_flex().id("git-output").size_full().overflow_y_scrollbar().p(16).gap(12).children(this.commandLog.map((r)=>v_flex().gap(4).child(div().text_color(r.code?c.red:c.accent).child(`${r.command}  [${r.code}]`)).child(div().text_size(12).text_color(c.muted).child(r.output))));
    return null;
  }
  viewBar(panel,c) {
    const names=panel==="files"?FILE_VIEWS:panel==="branches"?BRANCH_VIEWS:["commits","reflog"], current=panel==="files"?this.fileView:panel==="branches"?this.branchView:this.commitView;
    return h_flex().h(28).flex_none().px(8).gap(12).items_center().overflow_x_scroll().children(names.map((name)=>div().id(`view-${panel}-${name}`).flex_none().text_size(10.5).text_color(name===current?c.accent:c.dim).cursor_pointer().on_click((_e,cx)=>this.selectView(panel,name,cx)).child(name==="local"?"Local branches":name[0].toUpperCase()+name.slice(1))))
      .when(panel==="files"&&current==="files",e=>e.child(div().flex_1()).child(div().id("file-status-filter").flex_none().text_size(10.5).text_color(this.fileStatus==="all"?c.dim:c.accent).cursor_pointer().on_click((_e,cx)=>this.fileStatusMenu(cx)).child(this.fileStatus==="all"?"Filter":this.fileStatus)))
      .when(panel==="commits" && (current==="commits"?this.moreCommits:this.moreReflog),e=>e.child(div().flex_1()).child(div().id("commits-older").flex_none().text_size(10.5).text_color(c.accent).cursor_pointer().on_click((_e,cx)=>this.pageCommits(cx)).child("Load more")));
  }

  remoteBar(c) {
    return h_flex().h(28).flex_none().px(12).gap(8).items_center().border_b(1).border_color(c.border)
      .child(div().id("remote-back").flex_none().text_size(11).text_color(c.accent).cursor_pointer().on_click((_e,cx)=>{this.panel="branches";this.leaveRemote(cx);}).child("← Remotes"))
      .child(div().flex_1().truncate().text_size(11).text_color(c.muted).child(this.remoteContext.name))
      .child(div().flex_none().text_size(10).text_color(c.dim).child("esc back"));
  }
  pageCommits(cx) {
    if(this.busy||this.loading)return;
    if(this.commitView==="reflog")this.reflogLimit+=100;else this.commitLimit+=100;
    this.paging=true;this.refresh(cx,true);
  }
  isCommitSearch() {return this.context()?.type==="commits"||(!this.context()&&this.panel==="commits"&&this.commitView==="commits");}
  nextPanelMatch(by,cx) {
    const term=this.filters[this.viewKey()]??"", items=this.list(), matches=literalSearchMatches(term,items.map(it=>[it.hash??"",it.subject??"",it.who??""])).map(match=>items[match.index]);
    if(!term.trim()||!matches.length)return;
    this.cancelRange();
    const indices=matches.map(it=>items.indexOf(it)),current=this.sel[this.panel];
    this.move(by>0 ? indices.find(n=>n>current)??indices[0] : by<0 ? [...indices].reverse().find(n=>n<current)??indices.at(-1) : indices.find(n=>n>=current)??indices[0],cx);
  }
  filterBar(c) { return h_flex().h(32).flex_none().px(12).items_center().border_b(1).border_color(c.border).child(Input.new(this.panelSearch).flex_1().h_full().text_size(12).text_color(c.foreground)); }
  diffBar(c) {
    if (this.panel!=="files"||this.peek||this.detail||!this.item()?.file) return null;
    if (this.conflicts?.conflicts.length) return h_flex().h(34).flex_none().px(10).gap(8).items_center()
      .child(div().flex_1().text_size(11).text_color(c.yellow).child(`Conflict ${(this.conflictAt??0)+1}/${this.conflicts.conflicts.length} · ours = target during rebase`))
      .children(["ours","theirs","both"].map((side)=>this.button(`resolve-${side}`,side,c,(cx)=>this.resolveHunk(side,cx),{busy:"Resolve conflict"})));
    return h_flex().h(34).flex_none().px(10).gap(8).items_center()
      .children(["unstaged","staged"].map((side)=>this.button(`diff-${side}`,side,c,(cx)=>{this.diffSide=side;this.mdMode=false;this.main=true;this.reload(cx);},{primary:this.shownSide===side&&!this.md})))
      .child(div().flex_1().truncate().text_size(11).text_color(c.dim).child(this.patchTruncated?"Large diff: whole-file actions only":this.patch?`${this.lineMode?"Line":"Hunk"} selection · ${this.selectedRows().length} changed lines`:""))
      .when(Boolean(this.patch)&&!this.md,e=>e.child(this.button("apply-selection",this.shownSide==="staged"?"Unstage selection":"Stage selection",c,(cx)=>this.applySelection(false,cx),{key:"space",busy:this.shownSide==="staged"?"Unstage selection":"Stage selection"})));
  }
  commitBodyView(c) { return v_flex().gap(5).child(Textarea.new(this.bodyInput).h(100).px(10).py(8).bg(c.surface).rounded(8).border_1().border_color(c.border).text_size(13).text_color(c.foreground)).child(h_flex().gap(10).items_center().child(div().flex_1().text_size(11).text_color(c.dim).child("⇧↵ new line · ⌘↵ commit")).child(this.button("commit-co-author","Add co-author",c,cx=>this.commitCoAuthor(cx)))); }
}
