import { View, div } from "gpui-kit";
import { h_flex, v_flex, InputState, Input, ScrollHandle, TextareaState, Textarea } from "gpui-base";
import { exec, hc, openOverlay, checking, readTextFile, writeTextFile } from "herdr";
import { parsePatch, hunkAt, selectionRows, selectedPatch, parseConflicts, resolveConflict, rebaseTodo } from "./patch.js";

export const BRANCH_VIEWS = ["local", "remotes", "remote branches", "tags", "worktrees", "submodules"];
const CUT = "\n[herdr: output truncated]\n";
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const DIFF = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--src-prefix=a/", "--dst-prefix=b/"];
const SEQUENCE = 'sh -c \'printf "%s" "$HERDR_GIT_TODO" > "$1"\' sh';
const checked = (r) => { if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().slice(-1800) || `Git exited ${r.code}`); return r.stdout; };
const lines = (s) => s.split("\n").filter(Boolean);
const filter = (items, term) => {
  const words = term.toLowerCase().split(/\s+/).filter(Boolean);
  return !words.length ? items : items.filter((it) => words.every((w) => [it.name, it.path, it.hash, it.subject, it.who, it.url].join("\n").toLowerCase().includes(w)));
};

// Extra Git workflows live here; the original view keeps its graph, Markdown,
// Mermaid and Files tree. All actions capture the repository when invoked.
// Bound once: every open of the dialog runs initFeatures again.
let submitBound = false;

export class GitFeatures extends View {
  initFeatures(cx) {
    this.branchView = "local"; this.commitView = "commits";
    this.remotes = []; this.remoteBranches = []; this.tags = []; this.worktrees = []; this.submodules = []; this.reflog = [];
    this.filters = {}; this.diffSide = null; this.lineMode = false; this.anchor = null; this.patch = null;
    this.copied = new Map(); this.compareBase = null; this.compareReverse = false; this.baseCommit = null;
    this.operation = null; this.bisecting = false; this.plan = null; this.planAt = 0;
    this.planScroll = ScrollHandle.new(); this.menuScroll = ScrollHandle.new(); this.repoStack = [];
    this.undoStack = []; this.redoStack = []; this.commandLog = [];
    this.detail = null; this.historyPatch = null; this.customPatch = null;
    this.commitPage = 0; this.moreCommits = false;
    this.panelSearch = InputState.new({ placeholder: "Filter this view" });
    this.panelSearch.on("change", (_e, cx) => { this.filters[this.viewKey()] = this.panelSearch.value(); this.sel[this.panel] = 0; this.reload(cx); });
    this.panelSearch.on("submit", (_e, cx) => { this.handle.focus(); cx.notify(); });
    this.panelSearch.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.panelSearch.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    this.bodyInput = TextareaState.new({ placeholder: "Optional commit description", rows: 4 });
    this.bodyInput.on("change", (_e, cx) => { this.commitBody = this.bodyInput.value(); cx.notify(); });
    this.bodyInput.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.bodyInput.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    if (!submitBound) { cx.bind_keys([{keystroke: "cmd-enter", action: "git-submit", context: "GitMod"}, {keystroke: "ctrl-enter", action: "git-submit", context: "GitMod"}]); submitBound = true; }
  }

  viewKey() { return this.panel === "branches" ? this.branchView : this.panel === "commits" ? this.commitView : this.panel; }
  branchItems() { return filter(({local: this.branches, remotes: this.remotes, "remote branches": this.remoteBranches, tags: this.tags, worktrees: this.worktrees, submodules: this.submodules})[this.branchView] ?? [], this.filters[this.branchView] ?? ""); }
  commitItems() { return filter(this.commitView === "reflog" ? this.reflog : this.commits, this.filters[this.commitView] ?? ""); }
  stashItems() { return filter(this.stashes, this.filters.stash ?? ""); }

  async boundedGit(args, max = 262144) {
    // Reduce before QuickJS sees the output, with Git's exit status preserved.
    const script = 'umask 077; out=$(mktemp) || exit 1; trap \'rm -f "$out"\' EXIT; git "$@" > "$out"; code=$?; head -c "$0" "$out"; if [ "$(wc -c < "$out")" -gt "$0" ]; then printf "\\n[herdr: output truncated]\\n"; fi; exit "$code"';
    const r = await exec("sh", ["-c", script, String(max), ...READ, ...args], { cwd: this.root, on: this.on });
    const truncated = r.stdout.endsWith(CUT);
    let stdout = truncated ? r.stdout.slice(0, -CUT.length) : r.stdout;
    if (truncated) { const delimiter = args.includes("-z") ? "\0" : "\n"; stdout = stdout.slice(0, stdout.lastIndexOf(delimiter) + 1); }
    return { ...r, stdout, truncated };
  }

  async refreshFeatures() {
    const [refs, remotes, trees, reflog, modules, state] = await Promise.all([
      this.boundedGit(["for-each-ref", "--count=1000", "--sort=-committerdate", "--format=%(refname)%1f%(refname:short)%1f%(objectname)%1f%(symref)%1f%(contents:subject)", "refs/remotes", "refs/tags"]),
      this.boundedGit(["remote", "-v"]), this.boundedGit(["worktree", "list", "--porcelain", "-z"]),
      this.boundedGit(["reflog", "-n", "300", "--format=%H%x1f%gs%x1f%cr%x1f%gd"]),
      this.boundedGit(["config", "-z", "--file", ".gitmodules", "--get-regexp", "^submodule\\..*\\.path$"]),
      exec("sh", ["-c", 'for name in rebase-merge rebase-apply MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD BISECT_LOG; do p=$(git rev-parse --git-path "$name"); if [ -e "$p" ]; then printf "%s\\n" "$name"; fi; done'], { cwd: this.root, on: this.on }),
    ]);
    this.remoteBranches = []; this.tags = [];
    for (const l of lines(refs.stdout)) {
      const [ref, name, hash, sym, subject] = l.split("\x1f");
      if (!hash || sym) continue;
      (ref.startsWith("refs/tags/") ? this.tags : this.remoteBranches).push({ref, name, hash, subject});
    }
    this.remotes = lines(remotes.stdout).filter((l) => l.endsWith(" (fetch)")).map((l) => {
      const m = /^(\S+)\s+(.+) \(fetch\)$/.exec(l); return m ? {name: m[1], url: m[2]} : null;
    }).filter(Boolean);
    this.worktrees = []; let tree = null;
    for (const field of trees.stdout.split("\0")) {
      if (field.startsWith("worktree ")) { tree = {path: field.slice(9), name: field.slice(9)}; this.worktrees.push(tree); }
      else if (tree && field.startsWith("branch ")) tree.branch = field.slice(7).replace(/^refs\/heads\//, "");
      else if (tree && field.startsWith("HEAD ")) tree.hash = field.slice(5);
      else if (tree && field.startsWith("locked")) tree.locked = true;
      else if (tree && field === "bare") tree.bare = true;
    }
    this.reflog = reflog.code ? [] : lines(reflog.stdout).map((l) => { const [hash,subject,when,ref] = l.split("\x1f"); return {hash,subject,when,ref}; });
    this.submodules = modules.code ? [] : modules.stdout.split("\0").filter(Boolean).map((f) => { const n = f.indexOf("\n"); return { name: f.slice(0,n).replace(/^submodule\./, "").replace(/\.path$/, ""), path: f.slice(n+1) }; });
    this.operation = /rebase-/.test(state.stdout) ? "rebase" : state.stdout.includes("MERGE_HEAD") ? "merge" : state.stdout.includes("CHERRY_PICK_HEAD") ? "cherry-pick" : state.stdout.includes("REVERT_HEAD") ? "revert" : null;
    this.bisecting = state.stdout.includes("BISECT_LOG");
  }

  switchView(by, cx) {
    if (this.panel === "branches") this.branchView = BRANCH_VIEWS[(BRANCH_VIEWS.indexOf(this.branchView) + by + BRANCH_VIEWS.length) % BRANCH_VIEWS.length];
    else if (this.panel === "commits") this.commitView = this.commitView === "commits" ? "reflog" : "commits";
    else return;
    this.sel[this.panel] = 0; this.peek = null; this.main = false; this.panelSearchOpen = false; this.reload(cx);
  }

  featureSource() {
    if (this.detail?.file) {
      const d = this.detail, file = d.file.path;
      return {key:`detail:${d.key}:${file}`,title:file,custom:true,ref:d.ref,path:file,
        args:[...(d.untracked?.has(file) ? ["show","--format=",...DIFF,`${d.stashHash}^3`] : d.patchArgs),"--",file]};
    }
    if (this.peek) return null;
    const it = this.item();
    if (this.compareBase && it && ["branches", "commits"].includes(this.panel)) {
      const ref = it.hash ?? it.ref ?? it.name;
      if (ref && !["remotes", "submodules", "worktrees"].includes(this.viewKey())) return {key: `compare:${this.compareBase}:${ref}:${this.compareReverse}`, title: "Compare", args: ["diff", ...DIFF, "--stat", "--patch", ...(this.compareReverse ? [ref,this.compareBase] : [this.compareBase,ref]), "--"]};
    }
    if (this.panel !== "branches" || this.branchView === "local" || !it) return null;
    if (["tags", "remote branches"].includes(this.branchView)) return {key: it.ref, title: it.name, graph: [it.ref]};
    if (this.branchView === "remotes") return {key: `remote:${it.name}`, title: it.name, text: [`Remote: ${it.name}`, `URL: ${it.url}`, "", "Enter: remote branches · n: add · e: edit URL · R: rename · d: remove · f: fetch"]};
    if (this.branchView === "worktrees") return {key: `tree:${it.path}`, title: "Worktree", text: [it.path, `Branch: ${it.branch ?? "detached"}`, it.locked ? "Locked" : "", "", "Space: switch repository · n: create · d: remove · l: lock / unlock"]};
    return {key: `module:${it.path}`, title: "Submodule", text: [it.name, it.path, "", "Enter: open repository · i: initialize · u: update · e: URL · d: remove"]};
  }

  diffArgs(file, side = this.diffSide ?? (file.unstaged || file.fresh ? "unstaged" : "staged")) {
    if (file.fresh) return ["diff", "--no-index", ...DIFF, "--", "/dev/null", file.path];
    return ["diff", ...(side === "staged" ? ["--cached"] : []), ...DIFF, "--", file.path];
  }

  async readFilePatch(file) {
    const side = this.diffSide ?? (file.unstaged || file.fresh ? "unstaged" : "staged");
    if (file.conflict) {
      const text = await readTextFile(`${this.root}/${file.path}`, {on: this.on});
      if (text == null) throw new Error("Cannot read conflicted file");
      return {conflicts: parseConflicts(text), lines: text.replace(/\n$/, "").split("\n"), file, side};
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
    if (this.busy || !this.root || checking()) return;
    const context = {cwd: this.root, on: this.on, timeout: opts.network ? 120000 : 60000};
    this.busy = label; this.note = null; this.info = null; this.pending = null;
    cx.spawn(async (cx) => {
      const git = async (args) => {
        const r = await exec("env", ["GIT_TERMINAL_PROMPT=0", "GIT_EDITOR=true", "git", ...args], context);
        this.commandLog.push({label, command: "git " + args.join(" "), code: r.code, output: (r.stderr || r.stdout).slice(-2500)});
        if (this.commandLog.length > 30) this.commandLog.shift();
        return checked(r);
      };
      try {
        const before = opts.history ? (await git(["rev-parse", "HEAD"])).trim() : null;
        const branchResult = opts.history ? await exec("git", ["symbolic-ref", "--short", "HEAD"], context) : null;
        const branch = branchResult?.code === 0 ? branchResult.stdout.trim() : null;
        if (typeof work === "function") await work(git, context); else for (const args of work) await git(args);
        if (before && branch) {
          const after = (await git(["rev-parse", "HEAD"])).trim();
          if (after !== before) { this.undoStack.push({before,after,branch,root: context.cwd,label}); this.redoStack = []; }
        }
        this.info = opts.done ?? label; opts.after?.(cx);
      } catch (e) { this.note = `${label} failed: ${e?.message ?? e}`; }
      finally { this.busy = null; if (!this.closed) { this.refresh(cx, true); cx.notify(); } }
    }); cx.notify();
  }

  promptValue(title, value, submit, cx, opts = {}) {
    this.prompt = {kind: "value", title, submit, ...opts}; this.message = value ?? ""; this.input.set_value(this.message); this.input.focus(); cx.notify();
  }
  menuItems(title, items, cx) { this.openMenu({title, items: items.filter(Boolean).map(([label, hint, run, danger]) => ({label,hint,run,danger}))}, cx); }
  say(message, cx) { this.note = message; cx.notify(); }

  checkoutRef(ref, cx, detached = false) {
    const args = detached ? ["switch", "--detach", ref] : ["switch", ref];
    if (detached) this.ask("Detached checkout", `Check out ${ref} without a branch?`, (cx) => this.perform("Checkout", [args], cx), cx);
    else this.perform("Checkout", [args], cx);
  }
  newBranch(ref, cx) { this.promptValue("New branch name", "", (value, cx) => this.perform("Create branch", [["switch", "-c", value, ...(ref ? [ref] : [])]], cx), cx); }
  newTag(ref, cx) { this.promptValue("New tag name", "", (name, cx) => this.promptValue("Tag description (empty for lightweight)", "", (message, cx) => this.perform("Create tag", [["tag", ...(message ? ["-a", "-m", message] : []), "--", name, ref ?? "HEAD"]], cx), cx, {empty: true}), cx); }
  resetMenu(ref, cx) {
    this.menuItems(`Reset to ${ref.slice(0, 24)}`, [
      ...["soft", "mixed", "hard"].map((mode) => [`Reset ${mode}`, mode === "soft" ? "keep staged" : mode === "mixed" ? "keep unstaged" : "discard changes", (cx) => this.ask(`Reset ${mode}`, `Move the current branch to ${ref}? ${mode === "hard" ? "Tracked uncommitted changes will be discarded." : "Later commits become local changes."}`, (cx) => this.perform("Reset", [["reset", `--${mode}`, ref]], cx), cx), mode === "hard"]),
    ], cx);
  }
  chooseRemote(title, then, cx) { this.menuItems(title, this.remotes.map((r) => [r.name, r.url, (cx) => then(r.name, cx)]), cx); }

  branchActions(cx) {
    const it = this.item("branches"), ref = it?.ref ?? it?.name, view = this.branchView;
    if (view === "remotes") return [
      ["View branches", "enter", (cx) => { this.branchView = "remote branches"; this.filters[this.branchView] = `${it?.name ?? ""}/`; this.sel.branches = 0; this.reload(cx); }],
      ["Add remote…", "n", (cx) => this.promptValue("Remote name", "", (name, cx) => this.promptValue("Remote URL", "", (url, cx) => this.perform("Add remote", [["remote", "add", "--", name, url]], cx), cx), cx)],
      it && ["Edit URL…", "e", (cx) => this.promptValue(`URL for ${it.name}`, it.url, (url, cx) => this.perform("Set remote URL", [["remote", "set-url", "--", it.name, url]], cx), cx)],
      it && ["Rename remote…", "R", (cx) => this.promptValue("Remote name", it.name, (name, cx) => this.perform("Rename remote", [["remote", "rename", it.name, name]], cx), cx)],
      it && ["Fetch remote", "f", (cx) => this.perform("Fetch", [["fetch", "--prune", "--", it.name]], cx, {network:true})],
      it && ["Remove remote…", "d", (cx) => this.ask("Remove remote", `Remove ${it.name} from this repository?`, (cx) => this.perform("Remove remote", [["remote", "remove", it.name]], cx), cx), true],
    ];
    if (view === "worktrees") return [
      it && ["Switch repository", "space", (cx) => this.switchRepository(it.path, cx)],
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
    const actions = [
      it && ["Checkout", "space", (cx) => view === "remote branches" ? this.promptValue("Local tracking branch name", it.name.split("/").slice(1).join("/"), (name,cx) => this.perform("Checkout tracking branch", [["switch","--track","-c",name,it.ref]],cx),cx) : this.checkoutRef(ref,cx,view === "tags")],
      [view === "tags" ? "New tag…" : "New branch…", "n", (cx) => view === "tags" ? this.newTag("HEAD",cx) : this.newBranch(ref,cx)],
      it && ["New worktree here…", "w", (cx) => this.newWorktree(ref,cx)],
      it && ["Merge into current branch…", "M", (cx) => this.menuItems(`Merge ${it.name}`, [
        ["Merge", "", (cx) => this.ask("Merge", `Merge ${ref} into ${this.branch.name}?`, (cx) => this.perform("Merge", [["merge","--no-edit",ref]],cx,{history:true}),cx)],
        ["Squash merge", "", (cx) => this.ask("Squash merge", `Stage the changes from ${ref} as one new commit?`, (cx) => this.perform("Squash merge", [["merge","--squash",ref]],cx),cx)],
      ],cx)],
      it && ["Rebase current branch onto here…", "r", (cx) => this.ask("Rebase", `Replay ${this.branch.name} onto ${ref}${this.baseCommit ? ` from ${this.baseCommit.slice(0,7)}` : ""}?`, (cx) => this.perform("Rebase", [["rebase", ...(this.baseCommit ? ["--onto",ref,this.baseCommit] : [ref])]],cx,{history:true}),cx)],
      it && ["Reset current branch…", "", (cx) => this.resetMenu(ref,cx)],
      it && ["Compare with…", "W", (cx) => this.compareMenu(it,cx)],
      it && ["Copy name", "y", (cx) => cx.write_to_clipboard(it.name)],
    ];
    if (view === "local") actions.push(
      ["Checkout by name…", "c", (cx) => this.promptValue("Branch name (- for previous)", "", (name,cx) => this.checkoutRef(name,cx),cx)],
      ["Checkout previous branch", "-", (cx) => this.checkoutRef("-",cx)],
      it && ["Rename branch…", "R", (cx) => this.promptValue("Branch name", it.name, (name,cx) => this.perform("Rename branch", [["branch","-m",it.name,name]],cx),cx)],
      it && ["Upstream options…", "u", (cx) => this.menuItems(`Upstream for ${it.name}`, [
        ["Set upstream…", "", (cx) => this.promptValue("Upstream (remote/branch)", "", (upstream,cx) => this.perform("Set upstream", [["branch",`--set-upstream-to=${upstream}`,"--",it.name]],cx),cx)],
        ["Unset upstream", "", (cx) => this.perform("Unset upstream", [["branch","--unset-upstream","--",it.name]],cx)],
      ],cx)],
      it && ["Fast-forward from upstream", "f", (cx) => it.current ? this.perform("Fast-forward", [["merge","--ff-only",`${it.name}@{upstream}`]],cx) : this.say("Check out this branch before fast-forwarding it",cx)],
      it && !it.current && ["Delete branch…", "d", (cx) => this.menuItems(`Delete ${it.name}`, [
        ["Delete merged branch", "", (cx) => this.ask("Delete branch", `Delete ${it.name}?`, (cx) => this.perform("Delete branch", [["branch","-d","--",it.name]],cx),cx),true],
        ["Force delete…", "", (cx) => this.ask("Force delete branch", `Delete ${it.name} even if its commits are unmerged?`, (cx) => this.perform("Delete branch", [["branch","-D","--",it.name]],cx),cx),true],
      ],cx),true],
      ["New tag…", "T", (cx) => this.newTag(ref,cx)],
    );
    if (view === "remote branches" && it) actions.push(
      ["Set as current branch upstream", "u", (cx) => this.perform("Set upstream", [["branch",`--set-upstream-to=${it.name}`]],cx)],
      ["Delete remote branch…", "d", (cx) => this.ask("Delete remote branch", `Delete ${it.name} from its remote?`, (cx) => this.perform("Delete remote branch", [["push", "--delete", it.name.split("/")[0], it.name.split("/").slice(1).join("/")]],cx,{network:true}),cx),true],
    );
    if (view === "tags" && it) actions.push(
      ["Push tag…", "P", (cx) => this.chooseRemote("Push tag to", (remote,cx) => this.perform("Push tag", [["push",remote,it.ref]],cx,{network:true}),cx)],
      ["Delete tag…", "d", (cx) => this.menuItems(`Delete ${it.name}`, [
        ["Delete local tag", "", (cx) => this.ask("Delete tag", `Delete local tag ${it.name}?`, (cx) => this.perform("Delete tag", [["tag","-d","--",it.name]],cx),cx),true],
        ["Delete remote tag…", "", (cx) => this.chooseRemote("Delete tag from", (remote,cx) => this.ask("Delete remote tag", `Delete ${it.name} from ${remote}?`, (cx) => this.perform("Delete remote tag", [["push","--delete",remote,it.ref]],cx,{network:true}),cx),cx),true],
      ],cx),true],
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
    this.watched = null; this.watchTask?.cancel(); this.root = null; this.repoKey = null;
    this.files = []; this.nodes = []; this.branches = []; this.commits = []; this.stashes = []; this.peek = null; this.graph = null; this.patch = null;
    this.compareBase = null; this.baseCommit = null; this.copied.clear(); this.main = false; this.panel = "files"; this.sel.files = 0; this.shown = null;
    this.detail = null; this.historyPatch = null; this.customPatch = null; this.plan = null;
    this.commitPage = 0; this.moreCommits = false;
    this.refresh(cx,true); cx.notify();
  }

  selectedCommit() { return this.graph && this.main ? this.graph.rows[this.cursor]?.commit : this.peek ?? (this.panel === "commits" ? this.item() : null); }
  compareMenu(it, cx) {
    const ref = it.hash ?? it.ref ?? it.name;
    this.menuItems("Compare commits or refs", [
      ["Mark as comparison base", "", (cx) => { this.compareBase = ref; this.compareReverse = false; this.main = false; this.reload(cx); }],
      this.compareBase && ["Reverse comparison", "", (cx) => { this.compareReverse = !this.compareReverse; this.reload(cx); }],
      this.compareBase && ["Exit comparison", "esc", (cx) => { this.compareBase = null; this.reload(cx); }],
    ],cx);
  }
  commitActions(cm, cx) {
    if (!cm || cm.hash === "*" || cm.stash) return [];
    const ref = cm.hash, short = ref.slice(0,7);
    return [
      ["View changed files", "enter", (cx) => this.openChangedFiles(cm,cx)],
      ["Checkout detached…", "space", (cx) => this.checkoutRef(ref,cx,true)],
      ["New branch here…", "n", (cx) => this.newBranch(ref,cx)],
      ["New tag here…", "T", (cx) => this.newTag(ref,cx)],
      ["New worktree here…", "w", (cx) => this.newWorktree(ref,cx)],
      [this.copied.has(ref) ? "Unmark cherry-pick" : "Copy for cherry-pick", "C", (cx) => { if (this.copied.has(ref)) this.copied.delete(ref); else this.copied.set(ref,cm); cx.notify(); }],
      this.copied.size > 0 && ["Paste copied commits…", "V", (cx) => this.ask("Cherry-pick commits", `Cherry-pick ${this.copied.size} marked commits, in ancestry order?`, (cx) => this.perform("Cherry-pick", async (git,context) => {
        const copied = [...this.copied.keys()];
        // --no-walk sorts dates, not ancestry. Walk outside the script heap
        // and return only selected hashes, including with backdated commits.
        const r = await exec("sh",["-c",'wanted=$1; shift; git rev-list --topo-order --reverse "$@" | while IFS= read -r hash; do case " $wanted " in *" $hash "*) printf "%s\\n" "$hash";; esac; done',"sh",copied.join(" "),...copied],context);
        const order = lines(checked(r));
        if (order.length !== copied.length) throw new Error("Some copied commits are no longer available; select them again");
        await git(["cherry-pick",...order]);
      },cx,{history:true,after:()=>this.copied.clear()}),cx)],
      ["Revert…", "t", (cx) => this.ask("Revert commit", `Create a commit reversing ${short} — ${cm.subject}?`, (cx) => this.perform("Revert", [["revert","--no-edit",ref]],cx,{history:true}),cx)],
      ["Reset current branch…", "", (cx) => this.resetMenu(ref,cx)],
      ["Interactive rebase from here…", "i", (cx) => this.startRebase(cm,cx)],
      ["Reword commit…", "r", (cx) => this.promptValue("Commit summary",cm.subject,(message,cx)=>this.startRebase(cm,cx,{action:"reword",message}),cx)],
      ["Fix up into previous commit…", "f", (cx) => this.startRebase(cm,cx,{action:"fixup",previous:true})],
      ["Squash into previous commit…", "s", (cx) => this.startRebase(cm,cx,{action:"squash",previous:true})],
      ["Drop commit…", "d", (cx) => this.startRebase(cm,cx,{action:"drop"}),true],
      ["Edit commit during rebase…", "e", (cx) => this.startRebase(cm,cx,{action:"edit"})],
      ["Amend with staged changes…", "A", (cx) => this.ask("Amend commit", `Amend ${short} with staged changes${ref !== this.head ? " and replay later commits" : ""}?`, (cx) => this.amendCommit(cm,cx),cx)],
      ["Create fixup commit from staged changes", "F", (cx) => this.perform("Create fixup", [["commit",`--fixup=${ref}`]],cx,{history:true})],
      ["Apply fixup commits…", "S", (cx) => this.ask("Autosquash", `Apply fixup commits above ${short}?`, (cx) => this.autosquash(cm,cx),cx)],
      ["Mark rebase base", "B", (cx) => { this.baseCommit = ref; this.info = `Rebase base: ${short}`; cx.notify(); }],
      ["Compare with…", "W", (cx) => this.compareMenu(cm,cx)],
      ["Bisect…", "b", (cx) => this.bisectMenu(ref,cx)],
      ["Copy hash", "y", (cx) => cx.write_to_clipboard(ref)],
    ];
  }

  openChangedFiles(cm,cx,stash=false) {
    this.perform("Read changed files",async(git)=>{
      let args,patchArgs,ref=cm.hash,untracked=null;
      if (this.compareBase) {
        const other=cm.hash??cm.ref??cm.name;
        const refs=this.compareReverse?[other,this.compareBase]:[this.compareBase,other];
        args=["diff","--name-status","-z","--no-renames",...refs];patchArgs=["diff",...DIFF,...refs];ref=null;
      } else if(stash) {
        args=["stash","show","--include-untracked","--name-status","-z","--no-renames",cm.hash];patchArgs=["diff",...DIFF,`${cm.hash}^1`,cm.hash];ref=null;
        const r=await this.boundedGit(["ls-tree","--name-only","-r","-z",`${cm.hash}^3`]);
        untracked=new Set(r.code===0?r.stdout.split("\0").filter(Boolean):[]);
      } else {
        const parents=(await git(["rev-list","--parents","-n","1",cm.hash])).trim().split(" ");
        args=parents[1]?["diff","--name-status","-z","--no-renames",parents[1],cm.hash]:["diff-tree","--root","--no-commit-id","-r","--name-status","-z","--no-renames",cm.hash];
        patchArgs=parents[1]?["diff",...DIFF,parents[1],cm.hash]:["show","--format=",...DIFF,cm.hash];
      }
      const r=await this.boundedGit(args);checked(r);
      const fields=r.stdout.split("\0"),items=[];
      for(let i=0;i+1<fields.length;i+=2)if(fields[i]&&fields[i+1])items.push({status:fields[i],path:fields[i+1]});
      this.detail={key:args.join("\n"),title:cm.subject??cm.name??"Changed files",items,patchArgs,ref,untracked,stashHash:stash?cm.hash:null,at:0,file:null,truncated:r.truncated};
      this.historyPatch=null;this.main=true;
    },cx);
  }
  openDetailFile(index,cx) {const d=this.detail;if(!d?.items[index])return;d.at=index;d.file=d.items[index];this.historyPatch=null;this.main=true;this.reload(cx);}
  addCustomPatch(cx) {
    const data=this.historyPatch,rows=this.selectedRows();
    if(!data?.ref||!data.patch||!rows.length)return this.say("Select changed lines from a commit's file",cx);
    if(this.customPatch&&this.customPatch.ref!==data.ref)return this.say("Apply or clear the current custom patch before selecting another commit",cx);
    if(!this.customPatch)this.customPatch={ref:data.ref,parts:new Map()};
    let part=this.customPatch.parts.get(data.path);
    if(!part){part={path:data.path,patch:data.patch,rows:new Set()};this.customPatch.parts.set(data.path,part);}
    const remove=rows.every(n=>part.rows.has(n));for(const n of rows){if(remove)part.rows.delete(n);else part.rows.add(n);}
    if(!part.rows.size)this.customPatch.parts.delete(data.path);
    if(!this.customPatch.parts.size)this.customPatch=null;
    this.info=this.customPatch?`Custom patch: ${[...this.customPatch.parts.values()].reduce((n,p)=>n+p.rows.size,0)} changed lines` : "Custom patch cleared";cx.notify();
  }
  customPatchText(reverse=false) {return this.customPatch?[...this.customPatch.parts.values()].map(p=>selectedPatch(p.patch,p.path,[...p.rows],reverse)).join(""):"";}
  async applyPatchText(text,args,context) {
    const apply=(extra)=>exec("sh",["-c",'patch=$1; shift; printf "%s" "$patch" | git apply --whitespace=nowarn "$@" -',"sh",text,...args,...extra],context);
    checked(await apply(["--check"]));checked(await apply([]));
  }
  patchMenu(cx) {
    if(!this.customPatch)return this.say("Select hunks or lines in a commit file, then press Space to build a custom patch",cx);
    this.menuItems("Custom patch",[
      ["Copy patch", "",(cx)=>cx.write_to_clipboard(this.customPatchText())],
      ["Apply to working tree…", "",(cx)=>this.ask("Apply patch","Apply the custom patch to the working tree?",(cx)=>this.perform("Apply custom patch",async(_git,context)=>this.applyPatchText(this.customPatchText(),[],context),cx),cx)],
      ["Apply to index…", "",(cx)=>this.ask("Stage patch","Apply the custom patch to the index?",(cx)=>this.perform("Stage custom patch",async(_git,context)=>this.applyPatchText(this.customPatchText(),["--cached"],context),cx),cx)],
      ["Apply in reverse to index…", "",(cx)=>this.ask("Reverse patch","Stage the inverse of the custom patch?",(cx)=>this.perform("Reverse custom patch",async(_git,context)=>this.applyPatchText(this.customPatchText(true),["--cached","--reverse"],context),cx),cx)],
      ["Remove from original commit…", "",(cx)=>this.rewritePatch(null,cx),true],
      ["Split into a new commit…", "",(cx)=>this.promptValue("New commit summary","",(message,cx)=>this.rewritePatch(message,cx),cx)],
      ["Clear custom patch", "",(cx)=>{this.customPatch=null;cx.notify();}],
    ],cx);
  }
  rewritePatch(message,cx) {
    const custom=this.customPatch;if(!custom)return;
    // This patch is built against the original commit's NEW side. Its reverse
    // removes the selected changes; forward reapplies exactly those changes.
    const text=this.customPatchText(true),ref=custom.ref;
    this.ask(message?"Split commit":"Remove patch from commit",`${message?"Move the selected changes to a new commit after":"Remove the selected changes from"} ${ref.slice(0,7)} and replay later commits?`,(cx)=>this.perform(message?"Split commit":"Remove patch",async(git,context)=>{
      await this.clean(git);await git(["merge-base","--is-ancestor",ref,"HEAD"]);
      const parents=(await git(["rev-list","--parents","-n","1",ref])).trim().split(" "),base=parents[1];
      const history=await this.boundedGit(["log","--reverse","--format=%H%x1f%P%x1f%s",base?`${base}..HEAD`:"HEAD","--"]);checked(history);
      if(history.truncated)throw new Error("History is too large; use Lazygit");
      const entries=lines(history.stdout).map(l=>{const[hash,parents,subject]=l.split("\x1f");if(parents.includes(" "))throw new Error("This range has merge commits; use Lazygit");return {hash,subject,action:hash===ref?"edit":"pick"};});
      checked(await exec("env",[`HERDR_GIT_TODO=${rebaseTodo(entries)}`,`GIT_SEQUENCE_EDITOR=${SEQUENCE}`,"GIT_EDITOR=true","git","rebase","-i",...(base?[base]:["--root"])],context));
      if((await git(["rev-parse","HEAD"])).trim()!==ref)throw new Error("Rebase stopped before the source commit; resolve or abort it before retrying");
      await this.applyPatchText(text,["--index","--reverse"],context);await git(["commit","--amend","--no-edit","--allow-empty"]);
      if(message){await this.applyPatchText(text,["--index"],context);await git(["commit","-m",message]);}
      await git(["rebase","--continue"]);this.customPatch=null;this.detail=null;this.historyPatch=null;
    },cx,{history:true}),cx);
  }

  async clean(git) { if ((await git(["status","--porcelain"])).trim()) throw new Error("Commit or stash local changes first"); }
  startRebase(cm, cx, change = {}) {
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
    },cx);
  }
  applyPlan(cx) {
    const plan = this.plan; if (!plan) return;
    let todo; try { todo = rebaseTodo(plan.entries); } catch(e) { return this.say(e.message,cx); }
    this.ask("Apply rebase plan", `Rewrite ${plan.entries.length} commits on ${plan.branch}? This changes their hashes.`, (cx) => this.perform("Interactive rebase", async (git,context) => {
      await this.clean(git);
      if ((await git(["rev-parse","HEAD"])).trim() !== plan.head || (await git(["symbolic-ref","--short","HEAD"])).trim() !== plan.branch) throw new Error("HEAD changed; prepare the rebase again");
      this.plan = null;
      checked(await exec("env", [`HERDR_GIT_TODO=${todo}`,`GIT_SEQUENCE_EDITOR=${SEQUENCE}`,"GIT_EDITOR=true","git","rebase","-i",...(plan.base ? [plan.base] : ["--root"])],context));
    },cx,{history:true}),cx);
  }
  amendCommit(cm,cx) {
    if (cm.hash === this.head) return this.perform("Amend", [["commit","--amend","--no-edit"]],cx,{history:true});
    this.perform("Amend old commit", async (git,context) => {
      await git(["merge-base","--is-ancestor",cm.hash,"HEAD"]);
      if ((await git(["diff","--name-only"])).trim() || (await git(["ls-files","--others","--exclude-standard"])).trim()) throw new Error("Stage or stash other working changes first");
      const parents = (await git(["rev-list","--parents","-n","1",cm.hash])).trim().split(" ");
      await git(["commit",`--fixup=${cm.hash}`]);
      checked(await exec("env", ["GIT_SEQUENCE_EDITOR=true","GIT_EDITOR=true","git","rebase","-i","--autosquash",...(parents[1] ? [parents[1]] : ["--root"])],context));
    },cx,{history:true});
  }
  autosquash(cm,cx) { this.perform("Autosquash", async(git,context)=>{ await this.clean(git); const parents=(await git(["rev-list","--parents","-n","1",cm.hash])).trim().split(" "); checked(await exec("env",["GIT_SEQUENCE_EDITOR=true","GIT_EDITOR=true","git","rebase","-i","--autosquash",...(parents[1]?[parents[1]]:["--root"])],context)); },cx,{history:true}); }

  operationMenu(cx) {
    const op = this.operation;
    if (!op) return this.say("No merge, rebase, cherry-pick or revert in progress",cx);
    this.menuItems(`${op} in progress`, [
      ["Continue", "", (cx) => this.perform(`Continue ${op}`, [[op,"--continue"]],cx)],
      ["Abort…", "", (cx) => this.ask(`Abort ${op}`, `Abort ${op} and restore its starting state?`, (cx) => this.perform(`Abort ${op}`, [[op,"--abort"]],cx),cx),true],
      op !== "merge" && ["Skip current commit…", "", (cx) => this.ask(`Skip ${op}`, "Skip this commit and its conflict resolution?", (cx) => this.perform(`Skip ${op}`, [[op,"--skip"]],cx),cx),true],
    ],cx);
  }
  bisectMenu(ref,cx) {
    this.menuItems("Bisect", [
      ...["good","bad"].map((kind)=>[`Mark ${kind}`,ref.slice(0,7),(cx)=>this.perform(`Bisect ${kind}`,[...(!this.bisecting ? [["bisect","start"]] : []),["bisect",kind,ref]],cx)]),
      this.bisecting && ["Skip current commit", "", (cx)=>this.perform("Bisect skip",[["bisect","skip"]],cx)],
      this.bisecting && ["End bisect", "", (cx)=>this.perform("End bisect",[["bisect","reset"]],cx)],
    ],cx);
  }
  undo(redo,cx) {
    const stack = redo ? this.redoStack : this.undoStack, entry = stack.at(-1);
    if (!entry) return this.say("No recorded history action to undo; use Commits → Reflog for recovery",cx);
    this.ask(redo ? "Redo history action" : "Undo history action", `${redo ? "Redo" : "Undo"} ${entry.label} on ${entry.branch}?`, (cx)=>this.perform(redo ? "Redo" : "Undo",async(git)=>{
      await this.clean(git);
      if (this.root !== entry.root || (await git(["symbolic-ref","--short","HEAD"])).trim() !== entry.branch || (await git(["rev-parse","HEAD"])).trim() !== (redo ? entry.before : entry.after)) throw new Error("Repository or HEAD changed; use the reflog to recover");
      await git(["reset","--keep",redo ? entry.after : entry.before]); stack.pop(); (redo ? this.undoStack : this.redoStack).push(entry);
    },cx),cx);
  }

  conflictMenu(cx) {
    const f = this.item("files")?.file; if (!f?.conflict) return this.say("Select a conflicted file",cx);
    this.menuItems(`Resolve ${f.path}`, [
      ...["ours","theirs"].map((side)=>[`Use ${side} for entire file…`, "", (cx)=>this.ask("Resolve whole file", `Replace ${f.path} with ${side} and stage it? During a rebase, ours is the target branch; theirs is the replayed commit.`, (cx)=>this.perform("Resolve conflict",[["checkout",`--${side}`,"--",f.path],["add","--",f.path]],cx),cx)]),
      ["Mark file resolved", "", (cx)=>this.perform("Mark resolved",[["add","--",f.path]],cx)],
      ["Resolve individual conflicts", "enter", (cx)=>this.focusDiff(cx)],
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
      this.conflictAt=Math.min(at,Math.max(0,parseConflicts(next).conflicts.length-1));
    },cx);
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
      } else await git(["stash",kind,...(kind === "branch" ? [name] : []),stash.ref]);
    },cx);
  }
  stashActions(cx) {
    const it=this.item("stash"); if(!it)return [];
    return [
      ["View changed files", "enter",(cx)=>this.openChangedFiles(it,cx,true)],
      ["Apply", "space",(cx)=>this.stashAction("apply",it,cx)],
      ["Pop…", "g",(cx)=>this.ask("Pop stash",`Apply and remove ${it.ref}?`,(cx)=>this.stashAction("pop",it,cx),cx)],
      ["Drop…", "d",(cx)=>this.ask("Drop stash",`Permanently remove ${it.ref} — ${it.subject}?`,(cx)=>this.stashAction("drop",it,cx),cx),true],
      ["New branch from stash…", "n",(cx)=>this.promptValue("New branch from stash","",(name,cx)=>this.stashAction("branch",it,cx,name),cx)],
      ["Rename stash…", "r",(cx)=>this.promptValue("Stash description",it.subject,(name,cx)=>this.stashAction("rename",it,cx,name),cx)],
    ];
  }

  fileActions(cx) {
    const node=this.item("files"), f=node?.file;
    return [
      node && ["Stage / unstage", "space",(cx)=>this.toggleFile(node,cx)],
      ["Stage / unstage all", "a",(cx)=>this.toggleAll(cx)],
      ["Commit staged changes…", "c",(cx)=>this.ask2("commit","Commit summary",cx)],
      ["Stash options…", "S",(cx)=>this.stashMenu(cx)],
      ["Reset working tree…", "D",(cx)=>this.resetWorkingTree(cx)],
      f && ["Unstage file", "",(cx)=>this.perform("Unstage file",[this.hasHead?["restore","--staged","--",f.path]:["rm","--cached","--",f.path]],cx)],
      f && !f.fresh && ["Discard unstaged changes…", "",(cx)=>this.ask("Discard unstaged changes",`Restore ${f.path} from the index, keeping staged changes?`,(cx)=>this.perform("Discard unstaged changes",[["restore","--worktree","--",f.path]],cx),cx),true],
      f && ["Discard all changes to file…", "d",(cx)=>this.discard(f,cx),true],
      f?.conflict && ["Resolve conflict…", "M",(cx)=>this.conflictMenu(cx)],
      f && ["Copy path", "y",(cx)=>cx.write_to_clipboard(f.path)],
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
    if (checking()) return;
    try {
      const args=["run","--json","--bg","--rm","--no-parent","--cwd",this.root,"--name",`${title}-${Date.now()}`];
      if (this.on) args.push("--on",this.on);
      const r=await hc([...args,"--",...argv]); checked(r);
      const address=JSON.parse(r.stdout).address;
      openOverlay({kind:"dialog",modal:true,width:0.96,height:0.94,layout:{type:"block",content:{terminal:address}}});
    } catch(e) { this.say(`Could not open ${title}: ${e.message ?? e}`,cx); }
  }
  launchLazygit(cx) { cx.spawn(async(cx)=>this.launchTerminal(["lazygit"],"lazygit",cx)); }
  customCommand(cx) { this.promptValue("Run shell command in this repository", "", (command,cx)=>cx.spawn(async(cx)=>this.launchTerminal(["sh","-c",'eval "$1"; code=$?; printf "\\nExit %s. Press Enter to close." "$code"; read answer',"sh",command],"git-command",cx)),cx); }

  moreMenu(cx) {
    this.menuItems("Repository actions",[
      ["Open Lazygit", "L",(cx)=>this.launchLazygit(cx)],
      ["Run custom command…", ":",(cx)=>this.customCommand(cx)],
      ["Fetch all remotes", "",(cx)=>this.perform("Fetch all",[["fetch","--all","--prune"]],cx,{network:true})],
      ["Pull with rebase…", "",(cx)=>this.ask("Pull with rebase","Fetch and replay local commits on the upstream?",(cx)=>this.perform("Pull with rebase",[["pull","--rebase"]],cx,{network:true}),cx)],
      ["Force push with lease…", "",(cx)=>this.ask("Force push with lease","Replace the upstream branch only if it still matches the last fetched state?",(cx)=>this.perform("Force push",[["push","--force-with-lease"]],cx,{network:true}),cx),true],
      ["Undo recorded history action…", "z",(cx)=>this.undo(false,cx)],
      ["Redo recorded history action…", "Z",(cx)=>this.undo(true,cx)],
      this.operation && ["Continue / abort operation…", "m",(cx)=>this.operationMenu(cx)],
      this.bisecting && ["Bisect options…", "",(cx)=>this.bisectMenu("HEAD",cx)],
      ["Command output", "",(cx)=>{this.logOpen=true;this.main=true;cx.notify();}],
    ],cx);
  }

  featureKeys(e,cx) {
    const k=e.key, m=e.modifiers??{}, ch=e.key_char??(m.shift?k.toUpperCase():k);
    if (this.busy && !["escape","q"].includes(k)) return true;
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
    if (m.control&&k==="p") {this.patchMenu(cx);return true;}
    if (m.platform||m.control||m.alt) return false;
    if(this.detail){
      if(k==="escape") {if(this.detail.file){this.detail.file=null;this.historyPatch=null;}else{this.detail=null;this.historyPatch=null;this.main=false;}this.reload(cx);return true;}
      if(!this.detail.file){
        if(ch==="j"||k==="down")this.detail.at=Math.min(this.detail.at+1,this.detail.items.length-1);
        else if(ch==="k"||k==="up")this.detail.at=Math.max(0,this.detail.at-1);
        else if(ch==="g")this.detail.at=0;else if(ch==="G")this.detail.at=this.detail.items.length-1;
        else if(k==="enter")this.openDetailFile(this.detail.at,cx);
        this.planScroll.scroll_to_item(this.detail.at);cx.notify();return true;
      }
      if(this.historyPatch?.patch){
        if(ch==="a"){this.lineMode=!this.lineMode;this.anchor=null;cx.notify();return true;}
        if(ch==="v"){this.lineMode=true;this.anchor=this.anchor==null?this.cursor:null;cx.notify();return true;}
        if(ch===" "||k==="space"){this.addCustomPatch(cx);return true;}
        if(ch==="m"){this.patchMenu(cx);return true;}
        if(["h","l"].includes(ch)||["left","right"].includes(k)||(!this.lineMode&&(["j","k"].includes(ch)||["up","down"].includes(k)))){this.moveHunk(["h","k"].includes(ch)||["left","up"].includes(k)?-1:1,cx);return true;}
      }
    }
    if (ch==="L") {this.launchLazygit(cx);return true;}
    if (ch===":") {this.customCommand(cx);return true;}
    if (ch==="z"||ch==="Z") {this.undo(ch==="Z",cx);return true;}
    if (ch==="m"&&this.operation) {this.operationMenu(cx);return true;}
    if (k==="escape"&&this.compareBase) {this.compareBase=null;this.reload(cx);return true;}
    if (k==="escape"&&this.copied.size) {this.copied.clear();cx.notify();return true;}
    if (!this.main && k==="escape"&&this.panelSearchOpen) {this.panelSearchOpen=false;this.filters[this.viewKey()]="";this.reload(cx);return true;}
    if (!this.main && k==="escape"&&this.repoStack.length) {this.location=this.repoStack.pop();this.resetRepository(cx);return true;}
    if (!this.main&&["branches","commits"].includes(this.panel)&&["[","]"].includes(ch)) {this.switchView(ch==="["?-1:1,cx);return true;}
    if (!this.main&&this.panel!=="files"&&ch==="/") {this.panelSearchOpen=true;this.panelSearch.set_value(this.filters[this.viewKey()]??"");this.panelSearch.focus();cx.notify();return true;}
    if (this.main&&this.panel==="files"&&!this.peek&&!this.graph) {
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
      if(ch==="m"||ch==="x") {this.menuItems(this.branchView,actions,cx);return true;}
      const action=actions.find((a)=>a[1]===ch||a[1]===k);
      if(action){action[2](cx);return true;}
    }
    if ((this.panel==="commits"&&!this.main)||(this.main&&this.graph)) {
      const cm=this.selectedCommit(), actions=this.commitActions(cm,cx).filter(Boolean);
      if (!this.main&&(ch==="m"||ch==="x")) {this.menuItems(cm?.subject??"Commit",actions,cx);return true;}
      // Keep the graph's existing movement and quick cherry-pick keys.
      const action=actions.find((a)=>(a[1]===ch||a[1]===k)&&!(this.main&&["g","n","r","b","f","enter"].includes(ch)));
      if(action){action[2](cx);return true;}
    }
    if (!this.main&&this.panel==="files") {
      if (ch==="m"||ch==="x") {this.menuItems("File actions",this.fileActions(cx),cx);return true;}
      if (ch==="C") { if(!this.files.some(f=>f.staged))this.say("Stage changes before committing",cx);else cx.spawn(async(cx)=>this.launchTerminal(["git","commit"],"git-commit",cx)); return true; }
      if (ch==="S") {this.stashMenu(cx);return true;}
      if (ch==="D") {this.resetWorkingTree(cx);return true;}
      if (ch==="M") {this.conflictMenu(cx);return true;}
      if ((k==="enter"||ch==="0")&&this.item()?.file) {this.focusDiff(cx);return true;}
    }
    if (!this.main&&this.panel==="stash") {
      const actions=this.stashActions(cx);
      if (ch==="m"||ch==="x") {this.menuItems("Stash actions",actions,cx);return true;}
      const action=actions.find((a)=>a[1]===ch||a[1]===k); if(action){action[2](cx);return true;}
    }
    return false;
  }

  featureMain(c) {
    if(this.detail&&!this.detail.file)return v_flex().size_full().p(12).gap(10)
      .child(div().font_semibold().child(this.detail.title))
      .child(div().text_size(11).text_color(c.dim).child(`${this.detail.items.length}${this.detail.truncated?"+":""} files · enter to open · esc back`))
      .child(v_flex().id("git-detail-files").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.planScroll).children(this.detail.items.map((f,n)=>h_flex().id(`detail-file-${n}`).h(30).flex_none().px(10).gap(10).items_center().rounded(6).cursor_pointer().when(n===this.detail.at,e=>e.bg(c.selected)).on_click((_e,cx)=>{this.handle.focus();this.openDetailFile(n,cx);})
        .child(div().w(20).text_color(f.status==="D"?c.red:c.green).child(f.status)).child(div().flex_1().truncate().child(f.path)))));
    if (this.plan) return v_flex().size_full().gap(8).p(12)
      .child(h_flex().gap(10).items_center().child(div().flex_1().font_semibold().child(`Rebase ${this.plan.entries.length} commits · oldest first`)).child(this.button("apply-rebase","Apply plan",c,(cx)=>this.applyPlan(cx),{key:"⌘↵",primary:true})))
      .child(div().text_size(11).text_color(c.muted).child("p pick · r reword · e edit · s squash · f fixup · d drop · ctrl-j/k move · esc back"))
      .child(v_flex().id("git-plan").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.planScroll).children(this.plan.entries.map((cm,n)=>h_flex().id(`plan-${n}`).h(30).flex_none().px(10).gap(10).items_center().rounded(6).when(n===this.planAt,e=>e.bg(c.selected)).on_click((_e,cx)=>{this.planAt=n;this.handle.focus();cx.notify();})
        .child(div().w(56).text_color(cm.action==="drop"?c.red:c.accent).child(cm.action)).child(div().text_color(c.dim).font_family(c.mono).child(cm.hash.slice(0,7))).child(div().flex_1().truncate().child(cm.message??cm.subject)))));
    if (this.logOpen) return v_flex().id("git-output").size_full().overflow_y_scrollbar().p(16).gap(12).children(this.commandLog.map((r)=>v_flex().gap(4).child(div().text_color(r.code?c.red:c.accent).child(`${r.command}  [${r.code}]`)).child(div().text_size(12).text_color(c.muted).child(r.output))));
    return null;
  }
  viewBar(panel,c) {
    const names=panel==="branches"?BRANCH_VIEWS:["commits","reflog"], current=panel==="branches"?this.branchView:this.commitView;
    return h_flex().h(28).flex_none().px(8).gap(8).items_center().overflow_x_scroll().children(names.map((name)=>div().id(`view-${panel}-${name}`).flex_none().text_size(10.5).text_color(name===current?c.accent:c.dim).cursor_pointer().on_click((_e,cx)=>{this.panel=panel;if(panel==="branches")this.branchView=name;else this.commitView=name;this.sel[panel]=0;this.peek=null;this.detail=null;this.main=false;this.panelSearchOpen=false;this.handle.focus();this.reload(cx);}).child(name)))
      .when(panel==="commits"&&current==="commits",e=>e.child(div().flex_1()).children([
        ...(this.commitPage>0?[div().id("commits-newer").text_size(10.5).text_color(c.accent).cursor_pointer().on_click((_e,cx)=>this.pageCommits(-1,cx)).child("← Newer")]:[]),
        ...(this.moreCommits?[div().id("commits-older").text_size(10.5).text_color(c.accent).cursor_pointer().on_click((_e,cx)=>this.pageCommits(1,cx)).child("Older →")]:[]),
      ]));
  }
  pageCommits(by,cx) {if(this.loading||this.busy)return;this.commitPage=Math.max(0,this.commitPage+by);this.sel.commits=0;this.peek=null;this.detail=null;this.panel="commits";this.main=false;this.refresh(cx,true);}
  filterBar(c) { return h_flex().h(32).flex_none().px(12).items_center().border_b(1).border_color(c.border).child(Input.new(this.panelSearch).flex_1().h_full().text_size(12).text_color(c.foreground)); }
  diffBar(c) {
    if (this.panel!=="files"||this.peek||!this.item()?.file) return null;
    if (this.conflicts?.conflicts.length) return h_flex().h(34).flex_none().px(10).gap(8).items_center()
      .child(div().flex_1().text_size(11).text_color(c.yellow).child(`Conflict ${(this.conflictAt??0)+1}/${this.conflicts.conflicts.length} · ours = target during rebase`))
      .children(["ours","theirs","both"].map((side)=>this.button(`resolve-${side}`,side,c,(cx)=>this.resolveHunk(side,cx))));
    return h_flex().h(34).flex_none().px(10).gap(8).items_center()
      .children(["unstaged","staged"].map((side)=>this.button(`diff-${side}`,side,c,(cx)=>{this.diffSide=side;this.mdMode=false;this.main=true;this.reload(cx);},{primary:this.shownSide===side&&!this.md})))
      .child(div().flex_1().truncate().text_size(11).text_color(c.dim).child(this.patchTruncated?"Large diff: whole-file actions only":this.patch?`${this.lineMode?"Line":"Hunk"} selection · ${this.selectedRows().length} changed lines`:""))
      .when(Boolean(this.patch)&&!this.md,e=>e.child(this.button("apply-selection",this.shownSide==="staged"?"Unstage selection":"Stage selection",c,(cx)=>this.applySelection(false,cx),{key:"space"})));
  }
  commitBodyView(c) { return v_flex().gap(5).child(Textarea.new(this.bodyInput).h(100).px(10).py(8).bg(c.surface).rounded(8).border_1().border_color(c.border).text_size(13).text_color(c.foreground)).child(div().text_size(11).text_color(c.dim).child("⇧↵ new line · ⌘↵ commit")); }
}
