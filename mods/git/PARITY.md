# Native Git workflows

`Cmd-G` opens this native mod. It follows [Lazygit's feature guide](https://github.com/jesseduffield/lazygit#features) and [keybinding reference](https://github.com/jesseduffield/lazygit/blob/master/docs/keybindings/Keybindings_en.md), while keeping Herdr's graph, Markdown/Mermaid previews, Writer and Vim motions. `L` or **Lazygit** opens the installed upstream program on the same repository and machine; quit it to return to the native view. This is broad workflow coverage, not an identical implementation of every upstream option.

## Where to find things

| Area | Native workflows |
| --- | --- |
| Files (`2`) | Tree/flat list, path filtering, whole-file/folder staging, stage/unstage all, ignore, edit/open, copy path, discard unstaged or all changes, reset/clean including submodules |
| File diff (`Enter`) | Staged/unstaged views (`Tab`), hunk selection, line mode (`a`), range (`v`), stage/unstage (`Space`), discard selection (`d`), commit (`c`) |
| Commit form | Explicit staged changes only; summary, optional description, Writer, retained draft. Enter submits the summary field; Cmd-Enter submits from the description. `C` in Files opens Git's configured editor in a terminal. |
| Branches (`3`) | Checkout, create, rename, safe/force delete, merge/squash merge, rebase, reset, upstream, fast-forward, worktree, tags, comparison |
| Branch views (`[` / `]`) | Local branches, remotes, remote branches, tags, worktrees, submodules; filter with `/`, actions with `m` or right-click |
| Remotes/tags | Add/rename/remove remote, edit URL, fetch, tracking checkout, upstream selection, remote branch deletion, lightweight/annotated tags, local/remote tag deletion, tag push |
| Worktrees/submodules | Create/switch/remove/lock/prune worktrees; add/enter/init/update/remove submodules and change their URL. Escape returns from a repository entered here. |
| Commits (`4`) | Files in commit (`Enter`), patch (`0`), mark/paste cherry-picks (`C` / `V`), revert, reset, branch/tag/worktree, amend current or older commit, fixup/autosquash, bisect, compare refs, copy hash |
| History | Newer/Older pages of 300 commits; reflog via `[` / `]`; undo/redo recorded history changes via `z` / `Z` |
| Interactive rebase (`i`) | Review oldest-first plan; `p` pick, `r` reword, `e` edit, `s` squash, `f` fixup, `d` drop; Ctrl-j/k reorder; Cmd-Enter reviews/applies. One-off commit actions prepare a plan for review too. |
| Custom patches | Enter a commit, open a file, select hunks/lines, Space to mark/unmark. Repeat across files of the same commit. Ctrl-p opens copy, apply to worktree/index, reverse into index, remove from old commit, split into a new commit, and clear. |
| Comparison | `W` marks a commit/ref; select another to see the diff. The menu can reverse direction; Escape exits. Enter from a commit opens files in the comparison. |
| Conflicts | `M` offers whole-file ours/theirs or mark resolved. In the diff, j/k selects a conflict; `o` ours, `t` theirs, `b` both. Individual resolution changes the file without automatically staging it. During a rebase, ours is the target branch. |
| Operation in progress | Visible banner and `m`: continue, abort, or skip a rebase/cherry-pick/revert; continue/abort a merge |
| Stash (`5`) | All/staged/keep-index/selected-file stash options (`S` in Files), files/patch, apply/pop/drop, rename, branch from stash; stale numbered refs are checked before mutations |
| Repository | Fetch, pull fast-forward, push/upstream; More offers fetch-all, pull with rebase, force-with-lease, history recovery and command output. `:` runs an explicit shell command in an interactive terminal. |

`?` shows keys. `m`, Actions buttons and right-click expose operations without memorizing keys. `g`/`G` keep Herdr's first/last navigation (Stash retains its existing `g` for pop). The graph keeps its previous quick keys; its menu includes the new commit operations. Escape leaves a text field first, retaining its draft, then steps out of the component.

## What still uses upstream Lazygit

`L` provides the actual installed Lazygit, including its YAML configuration, configured custom-command prompts, external diff renderers, Git-flow, GitHub PR integration, editor-based hunk editing, author/co-author menus, movement of patches into arbitrary existing commits and broader reflog-based undo/redo. Its features follow the installed version (0.55.1 at implementation time), not a vendored snapshot. The native rebase editor and custom-patch history rewrites reject ranges containing merge commits; use upstream for those histories. No user Git or Lazygit configuration is changed by the mod.

Native history undo/redo records successful rebase, merge, revert, cherry-pick, fixup and amend operations made in this open dialog. It requires a clean tree and unchanged branch/HEAD. It does not undo working-file edits, stash changes, branch deletion or interrupted operations. The reflog view remains available after reopening.

## Data and mutation boundaries

- Actions are anchored to the repository and machine captured when the dialog opens. Entering a worktree/submodule changes that anchor explicitly.
- Git arguments are arrays. Patch bytes enter a fixed shell script as an argument, never executable shell text. Custom commands entered with `:` intentionally run as shell code.
- Partial changes retain the original diff bytes, compare the current diff before applying, and run `git apply --check`. Display truncation and expanded tabs never become patches.
- Reads are reduced outside the mod's script heap. Files show up to 2,000 entries; local/remote refs are bounded to 1,000 per query; the graph shows up to 400 commits, and reflog/stash up to 300. Commit history is paged. Lists filter the loaded page.
- Patch reads are capped at 256 KiB and 4,000 display lines. Larger patches disable partial actions and direct the user to whole-file actions or upstream. Rebase plans are capped at 500 commits; merge-containing ranges are rejected before rewriting.
- Destructive actions and history rewrites require a concrete confirmation in the mod. Commit submission never silently stages the working tree. Rebase conflicts leave Git's operation state available for continue/abort.
- Tests use disposable repositories and a local bare remote. They do not operate on the user's working repository.

## Validation

```sh
node --experimental-vm-modules --test mods/git/*.test.js
herdr-app check mods/git
herdr-app check mods/lazygit
herdr-app status | jq .errors
```

`patch.test.js` applies real patches with Git. `workflows.test.js` exercises native event handlers against real temporary repositories with a mocked Herdr host. `render.test.js` runs the real Herdr checker with populated diff, menu, commit form, branch, worktree, submodule, reflog, rebase, conflict and help states. These checks do not substitute for laying out and interacting with the dialog in a live window.
