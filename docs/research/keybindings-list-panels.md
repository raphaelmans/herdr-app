# Keybinding audit: list panels (Files, Status, branch views, Worktrees, Submodules, Stash)

Answers [#4](https://github.com/raphaelmans/herdr-app/issues/4) (map: #2).

**Question.** For each binding Lazygit's keybinding reference lists under Files, Status, Local branches, Remotes, Remote branches, Tags, Worktrees, Submodules and Stash, is the native Git mod (`mods/git`) identical, missing it, or deviating (key, label, confirmation, disabled reason)?

**Sources.**

- Lazygit at pinned commit `54cc6af`: `docs/keybindings/Keybindings_en.md` (the row list), `pkg/gui/controllers/*.go` (behaviour), `pkg/gui/keybindings.go`, `pkg/i18n/english.go` (labels and messages), `pkg/commands/git_commands/*.go` (the Git commands it runs).
- The native mod as it stands in the live working copy, `~/.config/herdr-app/mods/git/`. Key dispatch runs in this order: `keybindings.js` `dispatchConfiguredKey` (remappable bindings, which mostly re-send the default key), then `features.js` `featureKeys` (action lists from `branchActionItems`, `repositoryActionItems`, `stashActionItems`, plus file-panel overrides), then the older panel map in `main.js` `keys()` (lines 785-815), then the global map (`main.js` 764-784). An earlier stage wins. A few `main.js` handlers are dead code because `featureKeys` catches the key first (Files `C`, `S`, `D`).
- Line numbers below refer to those files. Native paths are relative to `mods/git/`; Lazygit paths are relative to `pkg/`.
- Method: code reading only. Herdr was not run, so this has **not** been checked in the live window.

## Summary

The reference lists 115 bindings across the nine panels.

| Panel | Rows | Identical | Missing | Deviates |
| --- | ---: | ---: | ---: | ---: |
| Files | 28 | 15 | 4 | 9 |
| Status | 6 | 2 | 3 | 1 |
| Local branches | 26 | 15 | 3 | 8 |
| Remote branches | 14 | 9 | 1 | 4 |
| Remotes | 7 | 6 | 1 | 0 |
| Tags | 11 | 7 | 1 | 3 |
| Worktrees | 5 | 3 | 0 | 2 |
| Submodules | 9 | 4 | 2 | 3 |
| Stash | 9 | 8 | 0 | 1 |
| **Total** | **115** | **69** | **15** | **31** |

### Gaps that matter most

1. **`Ctrl+O` (copy name or path) is missing everywhere in scope except commits.** It is missing in Files, Local branches, Remote branches, Tags and Submodules. `featureKeys` handles `Ctrl+O` only when a commit is selected (`features.js:1140`). `main.js:756-757` drops every other Ctrl key, and the remappable `copyToClipboard` binding just re-sends the same key (`keybindings.js:90`). Branch views offer **`y` Copy name** instead (`features.js:437`), which Lazygit doesn't have there.
2. **Files `g` (upstream reset options) is missing.** Here `g` jumps to the top of the list (`main.js:767`). PARITY.md:36 says the contextual `g` applies to "branch and commit lists", and CLAUDE.md's rule exempts the Git mod "for Lazygit parity", but Files still uses the Vim meaning. Lazygit: `gui/controllers/files_controller.go:115-116,1599-1601` (`CreateGitResetMenu("@{upstream}")`).
3. **Missing Files actions:** `w` (commit without pre-commit hook) and `Ctrl+F` (find base commit for fixup). Both names are in the configuration schema (`config.js:43`), but nothing binds them, and `--no-verify` appears nowhere in the mod.
4. **Missing branch actions:** `N` (move commits to new branch), `F` (force checkout), Remotes `F` (add fork remote), Submodules `b` (bulk options). Status `a`/`A` (cycle all-branch logs) and `u` (check for update) are also missing. The update check does not apply to a Herdr mod.
5. **Menus replaced by one confirmation or one prompt:**
   - `r` (rebase onto selected) is a single confirmation (`features.js:434`). Lazygit opens a menu: simple rebase, interactive rebase, rebase onto base branch (`gui/controllers/helpers/merge_and_rebase_helper.go:487-540`).
   - `w` (new worktree) from branches, tags and stash prompts for a path, then an optional branch name (`features.js:432,475-477`). Lazygit opens a menu: new branch and worktree `b`, or worktree for the ref `w` (`gui/controllers/helpers/worktree_helper.go:221-320`).
   - Worktrees `d` is one confirmation (`features.js:404`). Lazygit opens a menu: remove `w`, remove and delete branch `b`, remove and delete both branches `r`. Lazygit also refuses with "You cannot remove the main worktree!" or "...the current worktree!" (`gui/controllers/helpers/branches_helper.go:236-275`). The native mod hides `d` on the current worktree with no message, has no main-worktree check, and doesn't retry with force (Lazygit's `worktree_helper.go:128-165` asks before forcing).
   - Local branches `u` offers only set and unset (`features.js:452-455`). Lazygit also shows divergence from the upstream and from the base branch, and offers reset to upstream (`gui/controllers/branches_controller.go:231-330`).
   - Files `D` lists five unkeyed items (`features.js:1072-1080`) with no soft or mixed reset. Lazygit's menu is keyed `x/u/c/S/s/m/h` and includes soft, mixed and hard reset (`gui/controllers/workspace_reset_controller.go:25-185`).
   - Files `S` has four items, only the first keyed (`features.js:1007-1015`). Lazygit has five keyed items `a/i/U/s/u`, including "stash unstaged changes" (`gui/controllers/files_controller.go:1386-1441`).
6. **Confirmations that differ:**
   - Tags `space` asks "Check out … without a branch?" (`features.js:374-376`). Lazygit checks out with no confirmation (`gui/controllers/tags_controller.go:160-166`).
   - Remote branches `u` sets the upstream with no confirmation (`features.js:465`). Lazygit asks "Are you sure you want to set the upstream branch…" (`gui/controllers/remote_branches_controller.go:172-190`).
   - Local `R` doesn't warn when the branch tracks a remote. Lazygit shows `RenameBranchWarning` (`gui/controllers/branches_controller.go:743`).
   - Local `space` doesn't report "already checked out", doesn't offer to switch to the worktree that has the branch checked out, and has no guard while a pull is running (`gui/controllers/branches_controller.go:45-50,408-450`).
   - Files `c` with nothing staged doesn't offer "You have not staged any files. Commit all files?". The native mod accepts the summary, then refuses (`main.js:630`). Lazygit: `gui/controllers/helpers/working_tree_helper.go:298-305`. PARITY.md:16,100 make this a deliberate choice ("never silently stages").
   - Files `A` uses different confirmation text, ignores `gui.skipAmendWarning`, and doesn't show Lazygit's conflict-time menu (cancel, continue, amend; `gui/controllers/files_controller.go:1183-1229`).
7. **Behaviour that differs:**
   - Files `s` runs `stash push --include-untracked` (`main.js:632`). Lazygit runs `git stash push -m` and stashes tracked files only (`commands/git_commands/stash.go:56-61`).
   - Submodules `u` runs `update --init --recursive`, labelled "Update recursively" (`features.js:411`). Lazygit runs `update --init -- <path>` without `--recursive` (`commands/git_commands/submodule.go:402-407`).
   - Local `O` "Into the current branch" opens a pull request from the selected branch into the checked-out branch (`features.js:443-447`). Lazygit's extra item is checked-out → selected, the reverse direction (`gui/controllers/branches_controller.go:800-810`).
8. **Disabled-reason text differs across the board.** Native range guards say "This action requires a single selected item" (`selection.js:28-31`). Lazygit says "Action does not support range selection, please select a single item" (`i18n/english.go:2256`). The Files discard "unstaged" item says "The selection must have both staged and unstaged changes" (`file-actions.js:30`) instead of "The selected items don't have both staged and unstaged changes." (`i18n/english.go:1463`). Files `-`/`=` do nothing silently in flat view, where Lazygit disables them with a reason.

### Where PARITY.md overstates

- **PARITY.md:36** says "`g` opens reset choices on branch and commit lists". That is true there, but Files `g` (upstream reset) is missing. "Ctrl-O copies the hash" covers commits only; no other panel copies with Ctrl+O.
- **PARITY.md:44** says "Worktree removal asks for force only after Git refuses the ordinary removal." That holds only inside branch deletion (`ref-actions.js:196-207`). The Worktrees panel's own `d` has no force retry and no menu (`features.js:404`).
- **PARITY.md:17,21** list "rebase" and "upstream selection" without qualification. Both are reduced forms of Lazygit's menus (item 5).
- **PARITY.md:33** lists "All/staged/keep-index/selected-file stash options". Lazygit's "unstaged" and tracked-only "all changes" options are missing, and so are its menu keys.
- **PARITY.md:22** says "Create/switch/remove … worktrees". Create uses a different prompt order (path first; Lazygit asks for the base branch first, `worktree_helper.go:59-100`), and remove lacks the remove-and-delete-branch choices.
- The in-app help table is stale. `main.js:108` says "`D` discard all changes", but `D` opens the reset-working-tree menu (`features.js:1224`). The Stash section (`main.js:122`) omits `n`, `r`, `w` and `enter`, which do exist.

### Native extras (not in Lazygit's list for these panels)

- Files: `t` (Markdown preview/diff), `+` (widen panel), `L` (open Lazygit), `m`/`x` (actions menu).
- Branch views: `y` (copy name), `W` (compare).
- Remotes: `R` (rename).
- Worktrees: `l` (lock/unlock), plus a "Prune" menu item with no key.

## Full table

Verdict: **=** identical, **✗** missing, **≠** deviates.

### Files

| Key | Lazygit action | Verdict | Native evidence | Lazygit evidence / note |
| --- | --- | :---: | --- | --- |
| `<c-o>` | Copy path to clipboard | ✗ | `features.js:1140` (commits only); `main.js:756-757` drops it | `gui/keybindings.go:103-108` |
| `<space>` | Stage | = | `main.js:787`, `selection.js:76-80` (range-aware) | `files_controller.go` keybindings (Select) |
| `<c-b>` | Filter files by status | = | `features.js:1138,149-151` (menu `s/u/t/T/r`) | `files_controller.go:1256-1288` same keys |
| `y` | Copy to clipboard | = | `keybindings.js:48`, `file-actions.js:83-103` (`n/p/P/s/a`) | `files_controller.go:1475-1567` same keys |
| `c` | Commit | ≠ | `main.js:788,626-631`: no stage-all offer; refuses after summary | `helpers/working_tree_helper.go:298-305` "Commit all files?" (deliberate per PARITY.md:100) |
| `w` | Commit without pre-commit hook | ✗ | schema only, `config.js:43`; no `--no-verify` | `files_controller.go` (CommitChangesWithoutHook → `HandleWIPCommitPress`) |
| `A` | Amend last commit | ≠ | `main.js:790`: own prompt text, ignores `gui.skipAmendWarning`, no conflict menu, no stage-all | `files_controller.go:1183-1229`; text `i18n/english.go:1265-1266` |
| `C` | Commit using git editor | ≠ | `features.js:1222`, `external.js:187-193`: errors "Stage changes before committing" | Lazygit offers stage-all (`WithEnsureCommittableFiles`) |
| `<c-f>` | Find base commit for fixup | ✗ | schema only, `config.js:43` | `files_controller.go` (FindBaseCommitForFixup) |
| `e` | Edit | = | `external.js:242` | |
| `o` | Open file | = | `external.js:243` | |
| `i` | Ignore or exclude file | = | `file-actions.js:60-81` (menu `i`/`e`, tracked-file confirm); range text differs (item 8) | `files_controller.go:1150-1172` |
| `r` | Refresh files | = | `keybindings.js:47` | |
| `s` | Stash | ≠ | `main.js:796,632`: `--include-untracked`; no error when clean | `git_commands/stash.go:56-61` (tracked only); "You have no files to stash" |
| `S` | View stash options | ≠ | `features.js:1223,1007-1015`: 4 items, only `s` keyed, no "unstaged" | `files_controller.go:1386-1441`: `a/i/U/s/u` |
| `a` | Stage all | = | `main.js:680-686` | |
| `<enter>` | Focus diff / collapse dir | = | `main.js:792`, `features.js:1226` | |
| `d` | Discard | ≠ | `file-actions.js:14-31`: keys `x` (configurable) / `u` match; disabled text differs | `files_controller.go:1849-1940`; `i18n/english.go:1463` |
| `g` | View upstream reset options | ✗ | `main.js:767` (`g` = first item) | `files_controller.go:115-116,1599-1601` |
| `D` | Reset | ≠ | `features.js:1224,1072-1080`: 5 unkeyed items, no soft/mixed reset | `workspace_reset_controller.go:25-185` (`x/u/c/S/s/m/h`) |
| `` ` `` | Toggle file tree view | = | `main.js:793` | |
| `<c-t>` | Open external diff tool | = | `external.js:233,163-180` | |
| `M` | View merge conflict options | = | `features.js:1225,1064` | |
| `f` | Fetch | = | `main.js:771`, `configuration-runtime.js:47` | |
| `-` | Collapse all files | ≠ | `main.js:793`: silent no-op in flat view | disabled reason `isInTreeMode` |
| `=` | Expand all files | ≠ | `main.js:793`: silent no-op in flat view | disabled reason `isInTreeMode` |
| `0` | Focus main view | = | `features.js:1226`, `main.js:776` | |
| `/` | Filter current view | = | `main.js:794` (path filter) | |

### Status

| Key | Lazygit action | Verdict | Native evidence | Lazygit evidence / note |
| --- | --- | :---: | --- | --- |
| `e` | Edit config file | = | `external.js:235`, `66-` | `status_controller.go:35` |
| `u` | Check for update | ✗ | none (doesn't apply to a mod) | `status_controller.go:42` |
| `<enter>` | Switch to a recent repo | ≠ | `main.js:783`: focuses the graph | `status_controller.go:48` (recent repos menu) |
| `a` | Show/cycle all branch logs | ✗ | none on Status; "All branches" toggle only in Commits `Ctrl+L` menu (`configuration-runtime.js:69-73`) | `status_controller.go:54` |
| `A` | Cycle all branch logs (reverse) | ✗ | none | `status_controller.go:59` |
| `0` | Focus main view | = | `main.js:776` | |

### Local branches

| Key | Lazygit action | Verdict | Native evidence | Lazygit evidence / note |
| --- | --- | :---: | --- | --- |
| `<c-o>` | Copy branch name | ✗ | none; `y` copies instead (`features.js:437`) | `gui/keybindings.go:110-115` |
| `i` | Git-flow options | = | `features.js:441`, `flow.js:13` | |
| `<space>` | Checkout | ≠ | `features.js:430,374-377`: no "already checked out", no worktree-switch prompt, no pulling guard | `branches_controller.go:45-50,408-450` |
| `n` | New branch | ≠ | `features.js:431,387`: empty prompt, generic title | `helpers/refs_helper.go:351-370` (title "branch is off of …", suggested name) |
| `N` | Move commits to new branch | ✗ | none | `branches_controller.go:61-66` |
| `w` | New worktree | ≠ | `features.js:432,475-477`: path then branch prompts | `helpers/worktree_helper.go:221-320` (menu `b`/`w`) |
| `o` | Create pull request | = | `features.js:442,533-536` | |
| `O` | Create PR options | ≠ | `features.js:443-447`: "Into the current branch" = selected → current | `branches_controller.go:757-817`: checked-out → selected; requires upstream |
| `G` | Open PR in browser | = | `features.js:448,537-` (gh lookup; errors "No pull request found") | `branches_controller.go:86-91` (disabled without PR) |
| `<c-y>` | Copy PR URL | = | `features.js:1141` | |
| `c` | Checkout by name | = | `features.js:449` (`-` accepted) | |
| `-` | Checkout previous branch | = | `features.js:450`, `keybindings.js:55` | |
| `F` | Force checkout | ✗ | none | `branches_controller.go:110-116,495-` |
| `d` | Delete | = | `ref-actions.js:150-209` (menu `c/r/b`, disabled reasons, worktree handling) | `branches_controller.go:594-620` |
| `r` | Rebase | ≠ | `features.js:434`: one confirmation | `helpers/merge_and_rebase_helper.go:487-540` (menu) |
| `M` | Merge | = | `merge.js:27-48` | |
| `f` | Fast-forward | = | `ref-actions.js:101-149` (range) | |
| `T` | New tag | ≠ | `features.js:458,388`: two prompts, no force-replace offer | `helpers/tags_helper.go:25-60` (one panel; force prompt) |
| `s` | Sort order | = | `features.js:438,128-131` | |
| `g` | Reset | = | `features.js:435,389-393` (`m/s/h`) | |
| `R` | Rename branch | ≠ | `features.js:451`: no tracking warning | `branches_controller.go:702-745` `RenameBranchWarning` |
| `u` | View upstream options | ≠ | `features.js:452-455`: set/unset only | `branches_controller.go:231-330` (divergence, reset to upstream) |
| `<c-t>` | Open external diff tool | = | `external.js:233,172` | |
| `0` | Focus main view | = | `main.js:776` | |
| `<enter>` | View commits | = | `features.js:429` | |
| `/` | Filter | = | `features.js:1178` | |

### Remote branches

| Key | Lazygit action | Verdict | Native evidence | Lazygit evidence / note |
| --- | --- | :---: | --- | --- |
| `<c-o>` | Copy branch name | ✗ | none; `y` instead | `gui/keybindings.go:117-122` |
| `<space>` | Checkout | = | `features.js:430,379-386` (local exists → checkout; else menu new tracking / detached) | `helpers/refs_helper.go:128-180` |
| `n` | New branch | ≠ | `features.js:431,387`: no suggested name | `remote_branches_controller.go:200-205` (suggests branch name) |
| `w` | New worktree | ≠ | `features.js:432`: prompts | `helpers/worktree_helper.go` (menu) |
| `M` | Merge | = | `features.js:433`, `merge.js:27` | |
| `r` | Rebase | ≠ | `features.js:434`: one confirmation | menu, as in Local branches |
| `d` | Delete | = | `ref-actions.js:258-271` (confirm, range) | `remote_branches_controller.go:141` |
| `u` | Set as upstream | ≠ | `features.js:465`: no confirmation | `remote_branches_controller.go:172-190`; `i18n/english.go:1882` |
| `s` | Sort order | = | `features.js:128-131` (alphabetical/date) | |
| `g` | Reset | = | `features.js:435` | |
| `<c-t>` | Open external diff tool | = | `external.js:172` | |
| `0` | Focus main view | = | `main.js:776` | |
| `<enter>` | View commits | = | `features.js:429` | |
| `/` | Filter | = | `features.js:1178` | |

### Remotes

| Key | Lazygit action | Verdict | Native evidence | Lazygit evidence / note |
| --- | --- | :---: | --- | --- |
| `<enter>` | View branches | = | `features.js:421` | `remotes_controller.go:49` |
| `n` | New remote | = | `features.js:422` (name, URL) | `remotes_controller.go:203-215` |
| `d` | Remove | = | `features.js:426` (confirm) | `remotes_controller.go:62` |
| `e` | Edit | = | `features.js:423` (name and URL prefilled) | `remotes_controller.go:70` |
| `f` | Fetch | = | `features.js:425` | `remotes_controller.go:78,365` |
| `F` | Add fork remote | ✗ | none | `remotes_controller.go:84-88` |
| `/` | Filter | = | `features.js:1178` | |

### Tags

| Key | Lazygit action | Verdict | Native evidence | Lazygit evidence / note |
| --- | --- | :---: | --- | --- |
| `<c-o>` | Copy tag | ✗ | none; `y` instead | `gui/keybindings.go:124-129` |
| `<space>` | Checkout | ≠ | `features.js:430,374-376`: adds "Detached checkout" confirmation | `tags_controller.go:160-166` (no confirmation) |
| `n` | New tag | ≠ | `features.js:431,388`: two prompts, no force | `helpers/tags_helper.go:25-60` |
| `w` | New worktree | ≠ | `features.js:432`: prompts | worktree menu |
| `d` | Delete | = | `ref-actions.js:226-250` (`c/r/b`, remote prefilled `origin`) | `tags_controller.go:277-310` |
| `P` | Push tag | = | `ref-actions.js:251-257` | `tags_controller.go:324-345` |
| `g` | Reset | = | `features.js:435` | |
| `<c-t>` | Open external diff tool | = | `external.js:172` | |
| `0` | Focus main view | = | `main.js:776` | |
| `<enter>` | View commits | = | `features.js:429` | |
| `/` | Filter | = | `features.js:1178` | |

### Worktrees

| Key | Lazygit action | Verdict | Native evidence | Lazygit evidence / note |
| --- | --- | :---: | --- | --- |
| `n` | New worktree | ≠ | `features.js:402,475-477`: path, then optional new branch | `helpers/worktree_helper.go:59-100`: base branch, then path |
| `<space>` | Switch | = | `features.js:1216,400,478-` (enters as nested repo; Escape returns) | `worktrees_controller.go:48-57,131-133` |
| `o` | Open in editor | = | `external.js:245-248` | `worktrees_controller.go:135-137` |
| `d` | Remove | ≠ | `features.js:404`: one confirm; silent on current; no main check, no force retry, no branch-delete choices | `helpers/branches_helper.go:236-275`, `helpers/worktree_helper.go:128-165` |
| `/` | Filter | = | `features.js:1178` | |

### Submodules

| Key | Lazygit action | Verdict | Native evidence | Lazygit evidence / note |
| --- | --- | :---: | --- | --- |
| `<c-o>` | Copy submodule name | ✗ | none | `gui/keybindings.go:243-248` |
| `<enter>` | Enter | = | `features.js:408` (Escape returns, `features.js:1176`) | `submodules_controller.go:45-55` |
| `d` | Remove | = | `features.js:413` (confirm) | `submodules_controller.go:302-` |
| `u` | Update | ≠ | `features.js:411`: `--recursive`, label "Update recursively" | `git_commands/submodule.go:402-407` (non-recursive) |
| `n` | New submodule | ≠ | `features.js:409`: URL, path | `submodules_controller.go:148-185`: URL, name (suggested), path (prefilled) |
| `e` | Update submodule URL | ≠ | `features.js:412`: empty initial value | `submodules_controller.go:186-200` (current URL prefilled) |
| `i` | Initialize | = | `features.js:410` | |
| `b` | Bulk submodule options | ✗ | none | `submodules_controller.go:220-290` (`i/u/r/d`) |
| `/` | Filter | = | `features.js:1178` | |

### Stash

| Key | Lazygit action | Verdict | Native evidence | Lazygit evidence / note |
| --- | --- | :---: | --- | --- |
| `<space>` | Apply | = | `features.js:1044` (confirm unless `gui.skipStashWarning`) | `stash_controller.go:41` |
| `g` | Pop | = | `features.js:1045` (same) | `stash_controller.go:49` |
| `d` | Drop | = | `features.js:1046`, `ref-actions.js:210-225` (range, confirm) | `stash_controller.go:57` |
| `n` | New branch | = | `features.js:1047` (`switch -c <name> <stash>`, same as Lazygit's checkout -b) | `stash_controller.go:234-236` |
| `w` | New worktree | ≠ | `features.js:1048`: prompts | worktree menu |
| `r` | Rename stash | = | `features.js:1049` | `stash_controller.go:238-` |
| `0` | Focus main view | = | `main.js:776` | |
| `<enter>` | View files | = | `features.js:1043` | |
| `/` | Filter | = | `features.js:1178` | |

## Not covered

- Global keys, list navigation, Commits, Reflog, Sub-commits, Commit files and the main panels belong to the sibling ticket on commits and global keys.
- Native rows count as "identical" when the key, the action and the confirmation match. Small wording differences in prompts aren't listed unless they change meaning. The range-guard text difference (item 8) applies to most single-item actions and isn't repeated in each row.
