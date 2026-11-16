# Keybinding audit: Commits, Reflog, Sub-commits, Commit files, main panels, menus and global keys

Answers [#5](https://github.com/raphaelmans/herdr-app/issues/5) (map: #2).

Sources:

- **Lazygit** at pinned commit `54cc6af1d77b5a6cec3dc9ad0b203afdb4ad3451`:
  - `docs/keybindings/Keybindings_en.md` (the sections audited here), cited as **LG-doc §Section**.
  - `pkg/config/user_config.go` → `GetDefaultConfigForPlatform` (default keys), cited as **LG-cfg**.
  - `pkg/gui/keybindings.go` and `pkg/gui/global_handlers.go` (Ctrl-O copy handlers), and these controllers in `pkg/gui/controllers/`: `local_commits_controller.go`, `basic_commits_controller.go`, `commits_files_controller.go`, `merge_conflicts_controller.go`, `menu_controller.go`, `confirmation_controller.go`, `prompt_controller.go`, `diffing_menu_action.go`, `sync_controller.go`, `helpers/refs_helper.go`, `helpers/working_tree_helper.go`.
  - `pkg/i18n/english.go` (labels and disabled reasons).
- **Native Git mod**: the live working copy at `~/.config/herdr-app/mods/git`. This repo's `main` branch doesn't have most of this code yet.
  - `keybindings.js` (`builtinBindings`, `dispatchConfiguredKey`) is the configurable binding table. It runs first.
  - `main.js` has `keys()` (the fallback key map), the `HELP` table and the footer hints.
  - `features.js` has `featureKeys`, `commitActionItems`, `patchMenu`, `resetMenu`, `operationMenu`, `moreMenu` and `copyCommitAttribute`.
  - `contexts.js` (`contextActions` for CommitFiles and sub-commits), `selection.js` (`guardListActions`, `listRangeKeys`), `todo.js` (pending rebase rows), `external.js` (`externalKeys`, `openDiffTool`), `configuration-runtime.js` (`configurationKeys`, Ctrl-L), `authors.js` (`a`) and `recovery.js` (`z`/`Z`).
  - `PARITY.md` (its claims, checked against the code above).

**Method.** Every verdict comes from reading the code. I didn't run the Herdr app, open the mod, or run the test suite. Where the code paths interact in a way that only a runtime check can settle, the row says so.

## Summary

- **Out of about 150 bindings in the 12 sections:** about 55 are identical, about 50 deviate (key, label, confirmation, disabled reason or semantics), and about 45 are missing. The native mod also adds about 12 keys of its own that clash with Lazygit's meanings.
- **The biggest structural gap is history rewriting.** In Lazygit, `s`, `f`, `d`, `e`, `r`, `p` and Ctrl-J/K act at once on the selected commit or range, mostly behind a single confirmation. `i` starts a rebase from HEAD down to the merge base, with the todo shown in the Commits list. In the native mod, `s`/`f`/`d`/`e`/`r` and `i` instead open a separate oldest-first **rebase plan** that has to be applied with Cmd-Enter (`features.js` `startRebase`/`applyPlan`). Ctrl-J/K on an ordinary commit does nothing, because it only works inside the plan or on pending todo rows (`todo.js` `pendingRebaseKeys`).
- **Range actions are narrower than Lazygit's.** In Lazygit, `s`, `f`, `d`, `e`, `p`, `t`, `a`, `C`, Ctrl-J/K and CommitFiles `d`/`e`/Space accept a range. In the native mod, `guardListActions` (`selection.js`) disables every commit action on a range except `C`, `a`, `V`, `w` and `enter`. This also seems to block range edits on pending rebase todo rows, even though `changePendingRebase` supports a selection. That last point needs a runtime check.
- **The disabled-reason text differs everywhere.** The native mod says "This action requires a single selected item". Lazygit says "Action does not support range selection, please select a single item" (`RangeSelectNotSupported`). CommitFiles `d` has one combined reason where Lazygit has three separate ones.
- **Missing commit keys:** `R` reword with editor, `N` move commits to new branch, `*` select commits of current branch, and `c` set fixup message outside a rebase. `c` is in the binding table but answers "This action is unavailable for the selected commit".
- **Commit keys that work differently:** Space (checkout) confirms a detached checkout instead of opening Lazygit's checkout menu, which also lists the branches at that commit. `G` looks up a PR by commit hash with `gh` instead of opening the checked-out branch's PR. `F` and `S` act directly instead of opening Lazygit's fixup/autosquash menus. `g` confirms every reset mode, where Lazygit confirms only a hard reset over a dirty tree. Ctrl-L is a flat order list without the git-graph submenu.
- **Ctrl-O is wrong in three places.**
  - In Commits and Sub-commits it copies the full hash, with no toast. Lazygit copies `git.truncateCopiedCommitHashesTo` (default 12) characters and toasts "'<hash>' copied to clipboard".
  - In Commit files it should copy the path. Instead `selectedCommit()` returns the file row, and the code writes its undefined `.hash`.
  - In the main diff it should copy the selected lines, which isn't implemented.
- **Global keys with a different meaning:**
  - `m`: Lazygit's merge/rebase options. Native: the item action menu, unless a Git operation is running.
  - `?`: Lazygit's executable keybindings menu. Native: a static help page.
  - `@`: Lazygit's command-log menu. Native: "Repository actions".
  - Ctrl-R: Lazygit's recent repos. Native: clears cherry-picks everywhere.
  - `L`: Lazygit scrolls right. Native: launches upstream Lazygit.
  - `p`: native runs `--ff-only`. Lazygit runs `git pull --no-edit`.
  - `P`: with no upstream, native silently pushes `-u origin HEAD`. Lazygit prompts for the upstream.
- **Global keys that are missing:**
  - `+` and `_` screen modes (`+` only widens Files, and only in Files).
  - `|` and `\` diff renderers.
  - Ctrl-G jump to file.
  - Ctrl-S filter menu.
  - `H`/`L` horizontal scroll.
  - Ctrl-Z suspend (doesn't apply to a GUI).
  - The Enter ref item in the `W` menu.
  - `W` and Ctrl-E outside Commits and Branches.
- **Main panel, normal and secondary.** Present: Tab, `a`, `v`, `e`, Space, `d`, `E`, `h`/`l`, `c`, Esc. Missing: `n`/`N` (next and previous file), Ctrl-G, `G`, `w` (commit without hook), `C`, Ctrl-F (find base commit for fixup), `/` and Ctrl-O. Lazygit's secondary pane doesn't exist here. One unified diff toggles staged and unstaged with Tab.
- **Main panel, merging.** The native mod rebinds it to `o`/`t`/`b` (ours, theirs, both). `j`/`k` and `h`/`l` both move between conflicts, so there is no hunk selection inside a conflict and no Space to pick a hunk. `z` runs the reflog undo instead of undoing the last conflict resolution. `o` means "use ours" instead of "open file". `b`, `e`, `M` and Esc match.
- **Popups mostly match.**
  - Menu: Enter, Space, Esc, `/` and item keys match. Home/End, `<`/`>` and PgUp/PgDn are missing. The native mod adds `q`, `g` and `G`.
  - Confirmation: Enter and Esc match, Ctrl-O (copy) is missing, and the native mod adds `y`, `n` and `q`.
  - Input prompt and Commit summary: Enter matches. Esc first leaves the field and keeps the text, which is this repo's "Escape steps back" rule (CLAUDE.md), not an accident.
- **PARITY.md overstates parity.**
  - It says the mod "follows … [Lazygit's] keybinding reference". That holds for list navigation and most read-only commit keys, but not for the rewrite keys, popups or main panels above.
  - "Ctrl-O copies the hash": a full hash, and broken in Commit files.
  - "`?` shows keys": not executable, and the `HELP` table is incomplete. It omits `c`, `C`, `r`, `S` and others in Files, and in Commits lists only `enter`, with the rest under "Commit actions".
  - "Interactive rebase (`i`)": the native `i` starts from the *selected* commit (Lazygit's `e` semantics, not its `i`).
  - Its line about destructive actions needing confirmation is accurate. It is itself a deviation, because native adds confirmations Lazygit doesn't have (Space checkout, every `g` mode, CommitFiles `c`).

Legend: **Identical**: same key and same effect; small wording differences are noted. **Deviates**: the key exists, but its label, confirmation, disabled reason or semantics differ. **Missing**: no native binding. **Extra**: a native-only key that clashes with or adds to Lazygit (listed at the end of each section).

## Global keybindings

| Key (Lazygit) | Lazygit action | Native | Verdict | Source |
|---|---|---|---|---|
| Ctrl-R | Switch to a recent repo | Clears copied cherry-picks in every context (`featureKeys`: `m.control&&k==="r"`) | Deviates (other action; no recent-repos feature) | LG-doc §Global; LG-cfg `OpenRecentRepos`; `features.js` featureKeys |
| PgUp, `K`, Ctrl-U | Scroll up main window | `keybindings.js` maps `scrollUpMain*` to `scrollMain(-20/-3/-20)`. `main.js` HELP says "pgup pgdn: previous / next page", and `keys()` `named.pageup` pages the list, but the binding table runs first | Identical in the binding table; HELP text wrong | `keybindings.js` builtinBindings; `main.js` HELP, keys() |
| PgDn, `J`, Ctrl-D | Scroll down main window | Same as above | Identical (HELP text wrong) | same |
| `@` | View command log options | Opens "Repository actions" (`moreMenu`: Open Lazygit, custom commands, config, fetch all, pull rebase, force push, undo/redo, command output) | Deviates (label and contents) | `keybindings.js` `extrasMenu`; `features.js` moreMenu |
| `P` | Push; prompt for upstream if none; offer stacked branches | `push()`: `git push`, or `git push -u origin HEAD` with no prompt when there is no upstream; no stacked-branch offer | Deviates (no upstream prompt) | `main.js` push(); LG `sync_controller.go` |
| `p` | Pull (`git pull --no-edit`); prompt for upstream if none | `git pull --ff-only` | Deviates (flag; no upstream prompt) | `main.js` keys() / `keybindings.js` `pullFiles`; LG `git_commands/sync.go`, `sync_controller.go` |
| `)` / `(` | Increase / decrease rename similarity threshold | ±5, clamped 0–100, refreshes | Identical | `configuration-runtime.js` configurationKeys |
| `}` / `{` | Increase / decrease diff context size | ±1, clamped 0–10000 | Identical | same |
| `:` | Execute shell command | Prompt "Run shell command in this repository", then runs it in a terminal | Identical (shown in a terminal instead of the command log) | `features.js` customCommand |
| Ctrl-P | View custom patch options | `patchMenu`, with the same rows and keys as Lazygit's | Identical | `features.js` patchMenu |
| `m` | View merge/rebase options; error "You are currently neither rebasing nor merging" otherwise | Operation menu only while an operation runs. Otherwise, in lists, `m` (and `x`) opens the selected item's action menu | Deviates (key reused when no operation) | `features.js` featureKeys, operationMenu; LG i18n `NotMergingOrRebasing` |
| `R` | Refresh | `refresh(cx,true)` | Identical | `keybindings.js` `refresh` |
| `+` / `_` | Next / previous screen mode | `+` toggles a wide Files panel, in Files only; `_` unbound | Missing (`+` only partly comparable) | `main.js` keys() files map |
| `\|` / `\` | Cycle diff renderers | — | Missing (native renders diffs itself) | — |
| Ctrl-G | Jump to file in diff | — | Missing | — |
| Esc | Cancel | Steps back: closes the peek, find, main focus, filter or range; with nothing left, closes the window | Deviates (by the repo rule: Lazygit does nothing at top level unless `quitOnTopLevelReturn`) | `main.js` keys() `named.escape`; LG `quit_actions.go` Escape |
| `?` | Open keybindings menu (executable, filterable) | Static `HELP` page; `?`, `x`, `q` or Esc closes it | Deviates (not executable; incomplete) | `main.js` HELP, keys() |
| Ctrl-S | View filter options (by path or author) | — | Missing | LG `filtering_menu_action.go` |
| `W`, Ctrl-E | View diffing options: Diff \<ref\>, Enter ref to diff, Reverse diff direction, Exit diff mode | "Compare with…" exists only on commits and branches: Mark as comparison base, Reverse comparison, Exit comparison. No "Enter ref"; not reachable from Files, Stash or Status | Deviates (labels; missing item; narrower scope) | `features.js` compareMenu; LG `diffing_menu_action.go` |
| `q`, Ctrl-C | Quit | Closes the window (no `confirmOnQuit`) | Identical | `keybindings.js` `quit`, `quit-alt1` |
| Ctrl-Z | Suspend the application | — | Missing (doesn't apply to a GUI pane) | — |
| Ctrl-W | Toggle whitespace | Toggles `ignoreWhitespace` | Identical | `configuration-runtime.js` |
| Alt-Shift-C | Edit config file | `editConfiguration` | Identical | `keybindings.js` `editConfig` |
| `z` / `Z` | Undo / Redo (reflog-based) | Reflog undo/redo with a confirmation and auto-stash; action selection tested against a Go oracle (PARITY.md, `reflog.test.js`) | Identical in action choice. The confirmation wording is native's own | `recovery.js` undo |

Extra native keys: `x` (help in lists; the action menu in panels), `f` (fetch from any panel: in Lazygit only Files has `f`), `L` (launch upstream Lazygit; Lazygit's `L` is scroll right), `Q` (close, like Lazygit's `quitWithoutChangingDirectory`), `1`–`5` and `0` (see below).

## List panel navigation

| Key | Lazygit action | Native | Verdict | Source |
|---|---|---|---|---|
| `,` / `.` | Previous / next page | Moves 20 rows (`PAGE`), not a view height | Identical (page size fixed) | `keybindings.js` prevPage/nextPage |
| `<`, Home | Scroll to top | `move(0)` | Identical | `keybindings.js` gotoTop |
| `>`, End | Scroll to bottom | `move(last)` | Identical | `keybindings.js` gotoBottom |
| `v` | Toggle range select (sticky) | Sticky anchor | Identical | `selection.js` listRangeKeys |
| Shift-Down / Shift-Up | Range select down / up (non-sticky) | Non-sticky anchor | Identical | same |
| `/` | Search the current view by text | Commits and Sub-commits: search with `n`/`N`, keeping all rows. Reflog and others: filter | Identical | `features.js` isCommitSearch, nextPanelMatch, commitItems |
| `H` / `L` | Scroll left / right | — (`L` launches Lazygit) | Missing | — |
| `]` / `[` | Next / previous tab | Commits ↔ Reflog, Files/Worktrees/Submodules, Local/Remotes/Tags | Identical | `features.js` switchView |
| (universal) `j`/`k`, arrows | Next / previous item | Same | Identical | `keybindings.js` |
| (universal) `h`/`l`, ←/→, Tab/Shift-Tab | Previous / next block | `step(±1)` | Identical | same |
| (universal) `1`–`5`, `0` | Jump to block; focus main view | Same | Identical | same |

Extra: `g`/`G` go to first and last row in contexts without a contextual `g`/`G` (`main.js` keys() `global`). In Reflog and Sub-commits `G` therefore goes to the last row. In Lazygit it's unbound there.

## Commits

The native actions come from `commitActionItems` (`features.js`). Keys are dispatched through `keybindings.js` (the `commits` group), then rerouted to the matching action row, so the label and disabled reason come from that row. "Range" means a `v` or Shift-arrow selection.

| Key | Lazygit action (range?) | Native | Verdict | Source |
|---|---|---|---|---|
| Ctrl-O | Copy abbreviated commit hash: 12 characters, `git.truncateCopiedCommitHashesTo`; toast; disabled on a range | Copies the full `hash`; no toast; no range check | Deviates | `features.js` featureKeys; LG `keybindings.go`, `global_handlers.go`, LG-cfg `TruncateCopiedCommitHashesTo: 12` |
| Ctrl-R | Reset copied cherry-pick selection | Clears `copied` | Identical | `features.js` featureKeys |
| `b` | View bisect options | "Bisect…": Mark good / Mark bad, plus Skip and End while bisecting | Identical (labels approximate) | `features.js` bisectMenu |
| `s` | Squash into the commit below; confirm "Are you sure you want to squash the selected commit(s) into the commit below?"; range OK | "Squash into previous commit…" opens a rebase plan with that row set to squash; applied with Cmd-Enter after "Apply rebase plan"; disabled on a range | Deviates (extra plan step; no range) | `features.js` startRebase, applyPlan; LG `local_commits_controller.go` squashDown; i18n `SureSquashThisCommit` |
| `f` | Fixup into the commit below; confirm; range OK | "Fix up into previous commit…", through the rebase plan | Deviates (same as `s`) | same |
| `c` | Set fixup message (`-C` option) | In the binding table, but there's no `c` row outside a rebase, so it answers "This action is unavailable for the selected commit". On pending todo rows, "Fixup options" (`f`/`c`) exists | Missing (outside a rebase); Identical (on todo rows) | `keybindings.js` commits group; `todo.js` pendingRebaseActions |
| `r` | Reword: commit message panel (summary and description); runs at once | "Reword commit…": a one-line prompt prefilled with the subject, then the rebase plan | Deviates (no description field; plan step) | `features.js` commitActionItems; LG reword → OpenCommitMessagePanel |
| `R` | Reword with editor | — | Missing | — |
| `d` | Drop; confirm "Are you sure you want to drop the selected commit(s)?"; range OK | "Drop commit…", through the rebase plan; danger-styled; disabled on a range. On a pending todo row it marks drop | Deviates | `features.js`; `todo.js`; i18n `DropCommitPrompt` |
| `e` | Edit: starts a rebase stopping at the commit, or marks edit mid-rebase; range OK | "Edit commit during rebase…", through the plan. Marks edit on todo rows | Deviates (plan step; no range) | same |
| `i` | Quick-start interactive rebase from HEAD to the merge base or main branch; disabled "Can't perform this action during a rebase" | "Interactive rebase from here…": a plan starting at the *selected* commit; refused mid-operation with "Finish the current Git operation before starting a rebase" | Deviates (different start point and model; different reason) | `features.js` startRebase; LG quickStartInteractiveRebase; i18n `AlreadyRebasing` |
| `p` | Pick (mid-rebase); range OK | On todo rows only, "Pick". In the plan, `p` sets pick | Identical on todo rows, except the range guard (see Summary) | `todo.js` |
| `F` | Create fixup commit: a **menu** (fixup! / amend! variants); disabled "No files staged" | "Create fixup commit from staged changes" runs `commit --fixup=<hash>` at once | Deviates (no menu) | `features.js`; LG createFixupCommit (`FixupMenu_*`) |
| `S` | Apply fixup commits: a **menu** (in current branch / above selected commit) | "Apply fixup commits…" confirms "above" only | Deviates (one option) | `features.js` autosquash; LG squashFixupCommits |
| Ctrl-J, Alt-Down | Move commit down one (range OK) | Only inside the rebase plan, or on pending todo rows. Nothing on an ordinary commit | Missing (ordinary commits); Identical (todo rows) | `todo.js` pendingRebaseKeys; `features.js` plan keys |
| Ctrl-K, Alt-Up | Move commit up one | Same | Same | same |
| `V` | Paste (cherry-pick); confirm | "Paste copied commits…" confirms, then cherry-picks in ancestry order | Identical | `features.js` |
| `B` | Mark as base commit for rebase | "Mark rebase base" sets `baseCommit` and shows info | Identical | `features.js` |
| `A` | Amend with staged changes; confirm "Are you sure you want to amend this commit with your staged files?" | "Amend with staged changes…" with its own prompt text | Identical (wording differs) | `features.js` amendCommit; i18n `AmendCommitPrompt` |
| `a` | Amend commit attribute: menu Reset author `a` / Set author `A` / Add co-author `c`; range OK | Same three rows and keys (`amendAttribute.*` configurable); range OK; confirms the rewrite | Identical (adds a confirmation) | `authors.js` authorMenu |
| `t` | Revert; confirm "Are you sure you want to revert {{.selectedCommit}}?"; range OK | "Revert…" confirms; disabled on a range | Deviates (no range) | `features.js`; i18n `ConfirmRevertCommit*` |
| `T` | Tag commit: name and description prompt | Two prompts: name, then description (empty means lightweight) | Identical (two steps) | `features.js` newTag |
| Ctrl-L | Log options: toggle whole graph (`--all`), Show git graph ▸ always/never/when maximised, Commit sort order ▸ topo/date/author-date/default | One flat menu: 4 sort orders (keys `1`–`4`) and "All branches" (`a`); no git-graph submenu | Deviates | `configuration-runtime.js`; LG handleOpenLogMenu |
| `G` | Open the checked-out branch's PR; disabled "No pull request found for this branch" | "Open pull request in browser" looks up the PR containing the *selected commit* (`gh api …/commits/<sha>/pulls`) | Deviates (target; disabled reason) | `features.js` openPullRequest(commit=true); LG openPRInBrowser |
| Space | Checkout: a **menu** with "Checkout commit … as detached head" plus one row per branch at the commit | Confirmation "Detached checkout" only | Deviates | `features.js` checkoutRef; LG `refs_helper.go` CreateCheckoutMenu |
| `y` | Copy commit attribute: Hash, Subject, Message, Message body, URL, Diff, Author, Tags (disabled reasons for body and tags) | Same 8 rows; same "Commit has no message body" / "Commit has no tags" | Identical | `features.js` copyCommitAttribute |
| `o` | Open commit in browser | Same | Identical | `features.js` openCommitWeb |
| `n` | Create new branch off the commit | "New branch here…" | Identical | `features.js` newBranch |
| `N` | Move commits to new branch (menu: from base / stacked) | — | Missing | — |
| `w` | New worktree (menu) | "New worktree here…" | Identical (per the native worktree flow) | `features.js` newWorktree |
| `g` | Reset: menu Mixed `m` / Soft `s` / Hard `h`; confirms only hard reset over a dirty tree | Menu Reset mixed / soft / hard with the same keys; **each** mode confirms | Deviates (labels "Reset mixed" vs "Mixed reset"; extra confirmations) | `features.js` resetMenu; LG `refs_helper.go` CreateGitResetMenu |
| `C` | Copy (cherry-pick); range OK | Toggles mark; range OK | Identical | `features.js` copyCommits |
| Ctrl-T | Open external diff tool | `openDiffTool` for the commit | Identical | `external.js` |
| `*` | Select commits of current branch | — | Missing | — |
| `0` | Focus main view | Same | Identical | `keybindings.js` |
| Enter | View files | "View changed files"; a range opens a combined range diff | Identical | `features.js` openChangedFiles |
| `/` | Search | Search with `n`/`N` | Identical | `features.js` |

Disabled reason for range-blocked actions: native "This action requires a single selected item" (`selection.js` guardListActions) vs Lazygit "Action does not support range selection, please select a single item" (i18n `RangeSelectNotSupported`). This applies to Space, `y`, `o`, `n`, `g`, `T`, `F`, `B`, `A`, Ctrl-T and Ctrl-O, which Lazygit also limits to one item, so only the text differs.

Extra native keys in Commits: `W` (compare), `m`/`x` (action menu), `L`, `f` outside Commits, Esc (clears copied commits and the comparison base). Lazygit's Esc also clears the cherry-pick selection, so that part matches.

## Reflog

Lazygit's Reflog has only the basic commit bindings. Native uses `commitActionItems` with `rewrite=false`, which removes every write action.

| Key | Lazygit action | Native | Verdict | Source |
|---|---|---|---|---|
| Ctrl-O | Copy the commit hash (full; reflog isn't truncated) | Full hash; no toast | Identical (no toast) | LG `keybindings.go` (reflogCommits uses the untruncated handler) |
| Space | Checkout menu | Detached checkout confirmation | Deviates (as in Commits) | as above |
| `y` | Copy attribute menu | Same | Identical | |
| `o` | Open commit in browser | Same | Identical | |
| `n` | New branch off commit | Same | Identical | |
| `N` | Move commits to new branch | — | Missing | |
| `w` | New worktree | Same | Identical | |
| `g` | Reset menu | Same menu, extra confirmations | Deviates | |
| `C` | Copy (cherry-pick) | Same | Identical | |
| Ctrl-R | Reset copied | Same | Identical | |
| Ctrl-T | Diff tool | Same | Identical | |
| `*` | Select commits of current branch | — | Missing | |
| `0` | Focus main view | Same | Identical | |
| Enter | View commits (sub-commits) | "View commits" | Identical | `features.js` (reflog row label) |
| `/` | Filter | Filter (`filters.reflog`) | Identical | `features.js` commitItems |

Extra native keys in Reflog: `t` revert, `T` tag, `b` bisect, `W` compare (Lazygit's Reflog has none of these), `f` fetch, `G` last row.

## Sub-commits

Opened from a branch, tag, remote branch or reflog entry with Enter. Native: `contexts.js` `openSubCommits` and `contextActions` → `commitActions(it,cx,false)`.

| Key | Lazygit action | Native | Verdict | Source |
|---|---|---|---|---|
| Ctrl-O | Copy hash, truncated to 12 | Full hash, no toast | Deviates | as in Commits |
| Space | Checkout menu | Detached confirmation | Deviates | |
| `y`, `o`, `n`, `w`, `C`, Ctrl-R, Ctrl-T, `0`, Enter | As in Commits | Same rows | Identical | `contexts.js`, `features.js` |
| `g` | Reset menu | Extra confirmations | Deviates | |
| `N`, `*` | Move to new branch; select branch commits | — | Missing | |
| `/` | Search | Search with `n`/`N` (`isCommitSearch` includes commit contexts) | Identical | `features.js` isCommitSearch |
| Esc | Back to the parent list | `popContext` restores the parent selection | Identical | `contexts.js` popContext; REA `ev_78893e…` in PARITY.md |

Extra: `t`, `T`, `b`, `W`, as in Reflog. Native loads 300 commits and offers "Load more commits" (`extendContext`). Lazygit loads lazily on scroll.

## Commit files

Native: `contexts.js` `contextActions` (type `files`). The binding table maps `checkoutCommitFile` `c` and the `files.*` group.

| Key | Lazygit action (disabled reason) | Native | Verdict | Source |
|---|---|---|---|---|
| Ctrl-O | Copy path to clipboard (range not supported) | `featureKeys` treats the file row as a commit (`selectedCommit()` returns `this.item()` when the panel is Commits) and writes `undefined`. Under Branches, the key does nothing | Deviates (broken) | `features.js` featureKeys, selectedCommit; LG `keybindings.go` commitFiles |
| `y` | Copy to clipboard menu | "Copy to clipboard…" (`copyFileMenu`) | Identical | `contexts.js` |
| `c` | Checkout file (single item; no confirmation; error "You have local modifications for the file(s)…"; works on a directory node) | "Checkout file…" **confirms**; hidden on directories; range reason "Range selection is not supported for checkout"; own modified-file error text | Deviates (extra confirmation; no directories; wording) | `contexts.js` checkoutCommitFile; LG `commits_files_controller.go` checkout; i18n `CannotCheckoutWithModifiedFilesErr` |
| `d` | Discard this commit's changes to the file(s); confirm; range OK; disabled: "Changes can only be discarded from local commits" / "Changes cannot be discarded from a multiselection of commits" / "You cannot build a patch or run patch commands while in a merging or rebasing state" | "Discard file changes…" confirms; range OK; one combined reason, "Only a single local commit outside an active Git operation can be changed" | Deviates (disabled-reason text) | `contexts.js`, `features.js` discardCommitFiles; LG canDiscardFileChanges |
| `o` | Open file (single item) | "Open file" | Identical | `contexts.js`; `external.js` |
| `e` | Edit (range OK; "Cannot edit directories: you can only edit individual files") | "Edit file" (`editSelectedFiles`) | Identical (directory behaviour not checked) | `contexts.js`; i18n `ErrCannotEditDirectory` |
| Ctrl-T | Open external diff tool (single item) | "Open diff tool"; refuses a range with "Select one file, directory or ref for the diff tool" | Identical (wording differs) | `external.js` openDiffTool |
| Space | Toggle file in custom patch (range OK) | "Toggle file in custom patch"; range OK; a folder stands for its files | Identical | `contexts.js`; `features.js` toggleCommitFiles |
| `a` | Toggle all files in patch | Same | Identical | same |
| Enter | Focus file diff / toggle directory (single item) | Folder: "Collapse/Expand folder". File: "Open diff", with Space in the diff adding lines | Identical | `contexts.js`; `features.js` addCustomPatch |
| `` ` `` | Toggle file tree view | Same (`gui.showFileTree` default) | Identical | `contexts.js` toggleCommitFilesTree |
| `-` / `=` | Collapse / expand all (disabled outside tree mode) | Rows exist only in tree mode; in flat mode the key does nothing and gives no reason | Deviates (no disabled reason) | `contexts.js` |
| `0` | Focus main view | Global `0` | Identical | `main.js` keys() |
| `/` | Filter | Filter; opens every folder | Identical | `features.js` featureKeys context branch |
| Ctrl-P | (global) Patch options | `patchMenu` | Identical | `features.js` |

Extra: `m`/`x` open the CommitFiles action menu.

## Commit summary

| Key | Lazygit | Native | Verdict | Source |
|---|---|---|---|---|
| Enter | Confirm (summary field) | Enter submits from the summary field; Cmd-Enter from the description | Identical | `main.js` keys() typing branch; PARITY.md "Commit form" |
| Esc | Close | The first Esc leaves the field and keeps the draft; the second closes | Deviates (repo rule "Escape steps back") | `main.js` keys(); CLAUDE.md |

Lazygit's commit menu (Ctrl-O in the commit message, `commitMessage.commitMenu`) isn't bound natively. The native mod has an **Add co-author** button and the Writer instead.

## Main panel (normal) and Secondary

Lazygit's Secondary section is the same bindings on the other staging pane. The native mod has one diff that toggles staged and unstaged with Tab, so each verdict applies to both. Native: `features.js` featureKeys `this.main&&this.panel==="files"` block; `external.js` (`e`, `E`).

| Key | Lazygit action | Native | Verdict | Source |
|---|---|---|---|---|
| Mouse wheel | Scroll | GPUI scroll | Identical | — |
| Tab | Switch diff pane | `switchDiff` (staged ↔ unstaged) | Identical | `features.js` |
| `a` | Toggle hunk / line selection | `lineMode` toggle | Identical | same |
| `v` | Toggle range select | Line range anchor | Identical | same |
| `e` | Edit file (at line) | `editMain` | Identical | `external.js` |
| Space | Stage / unstage selection | `applySelection(false)` | Identical | `features.js` |
| `d` | Discard (unstaged) / unstage (staged) | `applySelection(true)`. HELP says "discard selected unstaged lines"; staged-side behaviour not checked | Identical (staged side unverified) | `features.js`; `main.js` HELP |
| `E` | Edit hunk | `editHunk` | Identical | `external.js` |
| Ctrl-O | Copy selected diff lines | Not handled in the Files diff (`selectedCommit()` is null there) | Missing | `features.js` featureKeys |
| ←/`h`, →/`l` | Previous / next hunk | `moveHunk` (and `j`/`k` in hunk mode) | Identical | `features.js` |
| `N` / `n` | Previous / next file | Bound to a no-op (`nextMatch`/`prevMatch` placeholders when not searching) | Missing | `keybindings.js` |
| Ctrl-G | Jump to file | — | Missing | — |
| `G` | Open PR at selected line | — | Missing | — |
| Esc | Exit back to side panel | Clears a line range first, then `main=false` | Identical | `features.js`; `main.js` |
| `c` | Commit | Commit summary prompt | Identical | `features.js` |
| `w` | Commit without pre-commit hook | — | Missing | — |
| `C` | Commit using git editor | Not bound in the diff (only in the Files list) | Missing | `features.js` |
| Ctrl-F | Find base commit for fixup | — | Missing | — |
| `/` | Search the diff | — (only the graph has find) | Missing | `main.js` graphKeys |

## Main panel (merging)

Native: `features.js` featureKeys, the `this.conflicts?.conflicts.length` block, and `resolveHunk`.

| Key | Lazygit action | Native | Verdict | Source |
|---|---|---|---|---|
| Space | Pick hunk (the selected side) | No pick; `o`/`t` choose ours/theirs for the whole conflict | Missing (replaced by `o`/`t`) | `features.js`; LG `merge_conflicts_controller.go` |
| `b` | Pick both hunks | `resolveHunk("both")` | Identical | same |
| ↑/`k`, ↓/`j` | Previous / next hunk (side within a conflict) | Moves to the previous / next **conflict** | Deviates | same |
| ←/`h`, →/`l` | Previous / next conflict | Previous / next conflict | Identical | same |
| `z` | Undo last conflict resolution | Global reflog undo | Deviates (other action) | `features.js` featureKeys `z`/`Z` |
| `e` | Edit file | `editMain` | Identical | `external.js` |
| `o` | Open file | "Use ours" | Deviates (other action) | `features.js` |
| `M` | Merge conflict options | `conflictMenu`: ours `o` / theirs `t` for the entire file, mark resolved `r`, resolve individually Enter, merge tool `m` | Identical in role (rows differ from Lazygit's `CreateMergeConflictMenu`; not compared row by row) | `features.js` conflictMenu |
| Esc | Return to files panel | `main=false` | Identical | `main.js` |
| `H` / `L` | Scroll left / right | — | Missing | — |

Extra: `t` ("use theirs"). In Lazygit's merging panel `t` is unbound.

## Menu

Native: `main.js` keys() `this.menu` branch.

| Key | Lazygit | Native | Verdict | Source |
|---|---|---|---|---|
| Enter | Execute | `pickMenu` | Identical | `main.js` |
| Space | Execute (`universal.select`) | `pickMenu` | Identical | same; LG `menu_controller.go` |
| Esc | Close | Closes the filter first, then the menu | Identical (step-back rule) | same |
| `/` | Filter | Opens the menu search | Identical | same |
| Item keys | Run the item | `entries.findIndex(item.key===ch)`, checked first | Identical | same |
| ↑/↓, `k`/`j` | Previous / next | Same | Identical | same |
| PgUp/PgDn, `,`/`.`, Home/End, `<`/`>` | Page, top, bottom | — | Missing | LG `menu_controller.go` physicalKeyBindings |

Extra: `q` closes, `g`/`G` first/last. Item keys win, so a menu with a `g` row keeps it.

## Input prompt

| Key | Lazygit | Native | Verdict | Source |
|---|---|---|---|---|
| Enter | Confirm | Confirm | Identical | `main.js` keys() |
| Esc | Close / cancel | First leaves the field and keeps the text; then closes (`cancelPrompt`) | Deviates (step-back rule) | `main.js`; CLAUDE.md |
| Tab | Toggle the suggestions panel | Tab or `i` goes back into the field after stepping out | Deviates | LG `prompt_controller.go`; `main.js` |

## Confirmation panel

| Key | Lazygit | Native | Verdict | Source |
|---|---|---|---|---|
| Enter | Confirm | Confirm | Identical | `main.js` keys() `this.pending` |
| Esc | Close / cancel | Cancel | Identical | same |
| Ctrl-O | Copy the prompt text to the clipboard | — | Missing | LG `confirmation_controller.go` handleCopyToClipboard |

Extra: `y` confirms, `n` and `q` cancel.

## Follow-ups this suggests for the map

- Decide whether the native rebase plan stays (a deliberate deviation) or `s`/`f`/`d`/`e`/`r`/Ctrl-J/K become immediate. Either way, allow ranges where Lazygit does, and use `RangeSelectNotSupported` wording.
- Small fixes:
  - Ctrl-O in Commit files and in the diff.
  - A 12-character hash and a toast for Ctrl-O.
  - A Space checkout menu.
  - `g` confirmations only for a hard reset over a dirty tree.
  - `F` and `S` menus.
  - `R`, `N`, `*`, and `c` outside a rebase.
- Main panel: `n`/`N` file jumps, Ctrl-O, `w`/`C`, Ctrl-F. Merging: Space and `j`/`k` side picking, conflict undo on `z`, and `o` as open file.
- Global keys to settle as ruled out or planned: `+`/`_`, `|`/`\`, Ctrl-Z, Ctrl-R recent repos, `H`/`L` (`L` clashes with launching Lazygit), `?` as an executable menu, `@` contents, `m` reuse, `p`/`P` upstream prompts.
- Correct PARITY.md's claims (see Summary) and the `HELP` table (`pgup`/`pgdn`, the Commits section).
