# Dirty submodules and nested repositories in Files

Ticket: #7 (map #2). Question: what exactly does Lazygit do when you stage or
unstage a submodule that has modified content or new commits, and when you
discard an entry that is (or holds) a nested repository? How does the native Git
mod differ? `mods/git/PARITY.md` lists both as open: "exact dirty-submodule
staging fallback" and "nested-repository inspection before discard".

Sources:

- Lazygit at the pinned commit `54cc6af` (REA reference). Paths below are under
  `pkg/`. Line numbers are from that commit.
- The native mod, read from the live copy in `~/.config/herdr-app/mods/git` on
  2026-11-16. Line numbers will drift.
- Git 2.56.1, run against throwaway repositories made with `mktemp` (results
  quoted below). The Herdr app was not run. Nothing here was checked in a live
  window.

## Answer

**Dirty submodule.** The parent repository can only stage a submodule's commit
pointer (its gitlink). It can never stage the changes inside a submodule.
Lazygit builds its stage/unstage toggle on that fact:

1. Space or `a` on a submodule that only has changes inside it (no new commit)
   stages nothing. Lazygit shows the error *"Nothing to stage: the parent repo
   can only stage a new submodule commit, not the uncommitted changes inside a
   submodule. Commit inside the submodule first."*
2. A submodule with a new commit and changes inside it goes ` M` → `MM` on
   stage, and back to ` M` on the next press. The changes left inside the
   submodule never count as "something to stage".
3. If such a submodule sits next to other files, the toggle ignores the
   submodule, so stage all and unstage all keep alternating.

The native mod has none of this. It runs `git add` on a submodule with only
changes inside, which does nothing, and it shows no message. It also gets stuck
on `MM`: every press stages again, so space and `a` can never unstage that
submodule.

**Nested repository.** Lazygit sorts each `dir/` entry that `git status`
reports into one of three kinds: plain untracked directory, nested repository,
or removed submodule. A linked worktree is a nested repository marked as a
worktree. Lazygit then:

- refuses to stage a nested repository, whether it is selected or caught by
  stage all, because `git add` would record an embedded repository;
- explains the entry in the main view and shows the nested repository's own
  `git status` there;
- before a discard, checks each nested repository in the selection and asks only
  when something cannot be recovered. It lists, per path, either "the
  repository with all of its history" (the `.git` folder is inside the
  directory) or "uncommitted changes".

The native mod does stage nested repositories and makes embedded gitlinks. Its
preview command fails on these entries. Before a discard it asks every time the
selection has a `dir/` entry, plain directories included, with one generic
sentence.

## Lazygit: staging a submodule

### How the toggle decides
`gui/controllers/files_controller.go` `toggleStaged` (567–624) is shared by
space (`pressWithLock`, 626) and stage all (`toggleStagedAllWithLock`, 1045,
which passes the tree root as its one node).

1. Any node with inline merge conflicts: error `ErrStageDirWithInlineMergeConflicts`.
2. `unstagedNodes = filterNodesHaveUnstagedChanges(...)`. A file counts as
   stageable through `fileHasStageableUnstagedChanges` (1751). For a
   **submodule**, it counts only when it has unstaged changes **and nothing
   staged** (`return !file.HasStagedChanges`). So an `MM` submodule is never
   "stageable": its unstaged half is the content inside it.
3. If something looks stageable, `stagingWouldBeNoOp` (1769) runs:
   - any non-submodule file with unstaged changes → not a no-op;
   - otherwise, for the submodule paths it runs
     `git submodule status -- <paths…>` (`commands/git_commands/submodule.go`
     `AnyHaveStageableChanges`, 172) and treats a line starting with `+`
     (checked-out commit differs from the index) as stageable. No `+` line → no-op.
4. Stage when there is something real to stage. Otherwise fall through to unstage.
5. Nothing stageable **and** nothing staged among the nodes → error
   `NothingToStageForSubmodule` (`i18n/english.go` 2264, text above).
6. Unstage otherwise.

Commands used: stage with `git add -- <paths>` (`StageFiles`, `-u` added when
the status filter shows tracked files only); stage all with `git add -A` or
`git add -u` (`StageAll`). Unstage selection: `git reset HEAD -- <tracked>` and
`git rm --cached --force -- <untracked>`. Unstage all: `git reset`.

Optimistic status: the unstage map has `"MM": " M"` with the comment "A
submodule with both a staged commit and unstageable dirty content"
(`files_controller.go` 493–500).

### Integration tests that pin it
- `integration/tests/submodule/stage_dirty_only.go`: ` M my_submodule_path
  (submodule)`. Space shows an error popup containing "Nothing to stage", status
  unchanged. Stage all does the same.
- `integration/tests/submodule/stage.go`: a new commit plus changes inside. Space
  → `MM`, space → ` M`. Stage all → `MM`, stage all → ` M`.
- `integration/tests/submodule/stage_all_with_dirty_submodule.go`: a dirty
  submodule next to `?? regular_file`. Stage all → `A  regular_file` (submodule
  stays ` M`). Stage all again → `?? regular_file`, with no error.

### Related submodule behaviour
- Discard (`d`) on a submodule opens a menu with one item, "Stash uncommitted
  submodule changes and update" (`remove`, 1849; `ResetSubmodule`, 2004). It
  runs `git reset HEAD -- <path>` (unstages the gitlink), then
  `git -C <path> stash --include-untracked`, then
  `git submodule update --init --force -- <path>`. That puts the submodule back
  on the recorded commit. A selection that mixes a submodule with anything else
  is disabled ("MultiSelectNotSupportedForSubmodules", `canRemove`, 1818).
- `WorkingTreeHelper` has `AnyStagedFilesExceptSubmodules` /
  `IsWorkingTreeDirtyExceptSubmodules`, used to decide auto-stash and similar
  prompts. The native mod already copies the latter (`features.js` 838).

### What git does (fixture, git 2.56.1)
```
# changes inside only (untracked file in sub)
status v1:  " M sub"     status v2: "1 .M S..U …"   submodule status: " <sha> sub"
git add -A -- sub        → rc 0, status still " M sub"
# plus a new commit in sub
status v2:  "1 .M SC.U …"                           submodule status: "+<sha> sub"
git add -A -- sub        → "MM sub"   (v2 "1 MM S..U …", submodule status now " <sha>")
git add -A -- sub again  → still "MM sub";   git add -A → still "MM sub"
git restore --staged -- sub → " M sub"
# tracked edit inside only
status v2:  "1 .M S.M. …"
```
Porcelain v1 shows ` M` for all three cases. Porcelain v2's submodule field
`S<c><m><u>` tells them apart in the same `status` call: `C` means a new
commit, `M` tracked changes, `U` untracked files. That is an alternative to
Lazygit's extra `git submodule status` call.

## Lazygit: nested repositories and discard

### Telling them apart
`commands/git_commands/file_loader.go`: a status path ending in `/` is a
directory that git did not descend into. Lazygit strips the slash and sets
`DirectoryKind` via `directoryKind` (117), using `GitDirOfRepo`
(`repo_paths.go` 321):

- no `.git` (or not a valid `gitdir:` file) → `PlainDirectory`. This only
  happens when `status.showUntrackedFiles=normal`;
- a git dir under `<worktree git dir>/modules/` → `RemovedSubmodule` (what a
  checkout that dropped a submodule leaves behind; its `.git` file points into
  the parent's `.git/modules`);
- anything else → `NestedRepository`. `refresh_helper.go` `markWorktreeFiles`
  then sets `IsWorktree` when the path is one of this repository's linked
  worktrees.

`models/file.go` 38–61: `IsNestedRepository()` is true for `NestedRepository`
and `RemovedSubmodule`. List labels come from `gui/presentation/files.go`
(about lines 200–206): "(nested repository)", "(removed submodule)", and a
worktree label.

### Staging is refused
`canStageSelection` (847) and `canStageAll` (873) return a disabled reason
(shown as a "Disabled: …" toast) when the selection, or for stage all the whole
tree, contains a nested repository:

- *"Can't stage '{{path}}' because it is a git repository of its own. Discard it
  with d, or ignore it with i."* (`StageNestedRepositoryDisabled`)
- *"Can't stage '{{path}}' because it is a worktree. Remove it with d, or ignore
  it with i."* (`StageWorktreeDisabled`)

Stage-all scope matters. With a text filter on, only the visible files count,
so filtering the nested repository out makes stage all work again. With the
"tracked only" filter, stage all is never blocked, because a nested repository
is never tracked. Commit with nothing staged (`WithEnsureCommittableFiles`,
`working_tree_helper.go` 266) shows the same refusal as an error instead of
offering to stage all. Reason, in `CantStageNestedRepository` (139): "git add
records a nested repository as an embedded repository: a gitlink without an
entry in .gitmodules. Nobody wants that." Test:
`integration/tests/file/stage_nested_repository.go`.

### The main view explains the entry
`renderDirectoryEntry` (293) shows a description, then a titled rule, then a
live command:

- nested repository / worktree / removed submodule: the nested repository's own
  `git -c color.status=always -c advice.statusHints=false status`, run inside
  it (`NestedRepositoryStatusCmdObj`, 422);
- plain directory: `git ls-files --others --exclude-standard -- <dir>`.

The description (`nestedRepositoryDescription`, 323; strings at
`english.go` 1311–1323) depends on the kind. Nested repository: "a git
repository of its own … add it as a submodule … or ignore it with i". A
removed submodule and a worktree each get their own text. The discard hint is
"discards the directory, including any uncommitted changes in it", or, when
`<path>/.git` is a directory (`NestedRepositoryHasOwnGitDir`, 436), "including
the repository with all of its history". Test:
`integration/tests/file/explain_nested_repositories.go`.

### Checking before a discard
Both menu items, "Discard all changes" and "Discard unstaged changes", go
through `confirmDiscardingNestedRepositories` (1954):

1. Collect every file under the selected nodes where `IsNestedRepository()` is
   true. Plain directories and ordinary untracked files are not collected. If
   there are none, discard with no extra question.
2. Otherwise run, with the waiting status *"Checking for uncommitted changes"*,
   for each one:
   - `<path>/.git` is a directory → loss "'{{path}}': the repository with all of
     its history". No status is run.
   - otherwise (a `.git` file: removed submodule, or a worktree) run
     `git -C <path> status --porcelain --untracked-files=normal`
     (`NestedRepositoryHasUncommittedChanges`, 444). Any output, **or an error**,
     → loss "'{{path}}': uncommitted changes" ("If we can't tell, assume that
     there are changes, so that we ask").
3. No losses → discard at once, with no confirmation. Otherwise one
   confirmation, title "Discard changes", prompt
   `Discarding this also discards the following. Are you sure?\n\n- <loss>\n- <loss>`.
   Cancel leaves everything and keeps the range selection.

The discard itself, for an untracked nested entry, is `os.RemoveAll(path)`
(`DiscardAllDirChanges` 190 → `removeFiles` 281 → `oscommands/os.go` 50), then
empty parent directories under the selection are removed. A worktree never gets
here: `d` on it opens the remove-worktree menu instead (`remove`, 1849).

Tests: `integration/tests/file/discard_nested_repositories.go`. A removed
submodule with a new file plus a fresh `git init nested`, range-selected, give
exactly `- 'modules/sub': uncommitted changes` and
`- 'nested': the repository with all of its history`. After confirming, both
paths are gone. `integration/tests/submodule/discard_removed_submodule.go`: a
clean removed submodule is discarded with **no** confirmation, because its
history stays in `.git/modules`.

### What git does (fixture)
```
git init nested (no commits)  → status "?? nested/"; git add -- nested → rc 128
                                 "'nested/' does not have a commit checked out"
nested with a commit          → git add -A -- nested → rc 0, warning "adding embedded
                                 git repository", index "160000 <sha> 0 nested"
git add -A with a removed submodule and an in-tree worktree → both embedded ("AM sub", "A  wt")
removed submodule             → "?? sub/", sub/.git = "gitdir: ../.git/modules/sub"
--untracked-files=all         → nested repos are still reported as "dir/"
git clean -fd                 → keeps nested repos; only -ffd removes them
```

## Native today

### Staging (`main.js`)
- `toggleFile` (674) → `toggleFiles(node.dir ? node.files : [node.file])`;
  `toggleSelectedFiles` (`selection.js` 76).
- `toggleFiles` (687): `staging = files.some(f => f.unstaged || f.fresh)`, then
  `git --literal-pathspecs add -A -- <paths>`; unstage is `restore --staged`
  (or `rm -r --cached` before the first commit). It knows nothing about
  submodules or nested repositories.
- `toggleAll` (680): `git add -A` (or `-u`) / `git reset`, using the same
  `some(unstaged || fresh)` rule. With a filter it uses `toggleFiles`.

What this does:

| Case | Lazygit | Native |
|---|---|---|
| ` M` submodule, changes inside only, space or `a` | Error "Nothing to stage: …" | Runs `git add`, nothing changes, no message |
| ` M` submodule with new commit, space | `MM` | `MM` (same) |
| `MM` submodule, space or `a` | Unstage → ` M` | Stages again → still `MM`. **Stuck**: the toggle can never unstage it |
| Dirty submodule + other files, `a` twice | Stage, then unstage the others | Stage, then stages again (the submodule's `y` is still `M`). **Stuck** |
| `?? nested/` (repository with commits), space or `a` | Disabled toast, nothing run | `git add` makes an embedded gitlink (warning hidden) |
| `?? nested/` with no commits | Disabled toast | `git add` fails with "does not have a commit checked out" |
| In-tree worktree / removed submodule under `a` | Disabled toast | Embedded gitlink |

### Preview
A fresh entry is previewed with `git diff --no-index … -- /dev/null <path>`
(`features.js` 276). For a `dir/` entry git fails: fixture output
`error: Could not access 'nested/null'`, rc 1. There is no explanation and no
nested status.

### Discard (`file-actions.js`)
- `discardFilesMenu` (14): a submodule (matched by `.gitmodules` path) gets a
  one-item menu "Stash and reset", which runs
  `git -C <path> stash push --include-untracked` then
  `git -C <path> reset --hard`. This differs from Lazygit. It does not unstage
  the gitlink first. It resets to the submodule's own `HEAD`, so a new commit
  stays checked out, where Lazygit's `submodule update --init --force` goes
  back to the recorded commit. A removed submodule is not in `.gitmodules`, so
  it gets the normal discard menu (as in Lazygit).
- `discardFileScope` (33): `nested = scope.files.filter(f => f.directory)`, where
  `directory` is simply "the status record ended in `/`" (`status.js` 13). If
  there is any, it asks **every time**: "Discard nested repository" / "Discarding
  <paths> can remove the nested repository and its uncommitted changes.
  Continue?". Then it re-reads status and removes with `rm -rf`.

| Case | Lazygit | Native |
|---|---|---|
| Plain dir (`showUntrackedFiles=normal`) | No extra question | Asks, calling it a nested repository |
| Removed submodule, clean | No extra question | Asks |
| Removed submodule with changes | Asks: "'p': uncommitted changes" | Asks (generic) |
| Repository with its own `.git` folder | Asks: "'p': the repository with all of its history" | Asks (generic) |
| Several entries | One prompt listing each path with its own loss | One prompt with the paths joined |
| Status check failed | Treated as "has changes" (asks) | — (no check) |
| Waiting | "Checking for uncommitted changes" | — |
| `rm` itself | `os.RemoveAll` | `rm -rf --` (same effect) |

The native prompt always shows when a `dir/` entry is present, so it never
skips a needed question. It errs on the side of asking. What it lacks is
accuracy: what is actually at risk, and staying quiet when nothing is.

## What the native design needs (inputs, not a decision)

1. **Directory kind in the status model.** For each `dir/` record, read
   `<root>/<path>/.git`: a directory → own history; a `gitdir:` file under the
   repository's `.git/modules/` → removed submodule; a path in `this.worktrees`
   → worktree; no `.git` → plain directory. This is file reads only
   (`git rev-parse --git-dir` gives the modules base), so it fits ADR 0006.
2. **Staging guard.** Disable space and `a` with Lazygit's texts when the
   selection, or for `a` the scope (visible files with a text filter, none with
   the tracked filter, all otherwise), holds a nested repository. Use the same
   check before commit when nothing is staged.
3. **Submodule toggle.** Copy `fileHasStageableUnstagedChanges` (a submodule
   with something staged is never stageable) and the no-op check. The no-op
   check can use `git submodule status -- <paths>` (`+` prefix), as Lazygit
   does, or porcelain v2's `S C . .` field in the existing status read with no
   extra process. Then show the "Nothing to stage" error when nothing is staged
   either. Behaviour to match: the three tests above.
4. **Discard check.** Collect nested repositories only (not plain directories).
   Show the spinner with "Checking for uncommitted changes". Count an own `.git`
   folder as history lost; otherwise run
   `git -C <p> status --porcelain --untracked-files=normal` (output or error →
   changes lost). No losses → discard straight away. Otherwise one confirmation
   listing each path with its own loss. Drop the result if the scope changed
   while waiting.
5. **Preview.** Replace the failing `diff --no-index` on `dir/` entries with
   the description plus the nested repository's own `git status`, or
   `ls-files --others` for a plain directory.
6. Optional, outside this ticket: make submodule "Stash and reset" match
   Lazygit (unstage the gitlink, `stash --include-untracked`,
   `submodule update --init --force`).
