# Lazygit config keys honoured by the native Git mod

Answers [#6](https://github.com/raphaelmans/herdr-app/issues/6) (map: #2).

Sources:

- Lazygit at pinned commit `54cc6af1d77b5a6cec3dc9ad0b203afdb4ad3451`: `pkg/config/user_config.go` (schema and defaults), `pkg/config/app_config.go` (loading and migrations), `pkg/config/user_config_validation.go`, `pkg/config/keybinding.go`.
- Native Git mod, live working copy at `~/.config/herdr-app/mods/git`: `config.js` (parser, layer merge, path resolution, key normalisation), `configuration.js` (defaults and loader), `configuration-runtime.js` (`configValue`, refresh timers), and every `configValue(` / `lazygitConfig` read in `*.js`. Also `PARITY.md` → "Configuration and custom commands".

## Summary

- **The schema is complete; what each key does is not.** `config.js`'s `TYPES` table has every struct and YAML key in the pinned `UserConfig`, with no extras (checked by script against the Go struct tags). So every key is parsed with yaml.v3 typing, and layers merge the way Lazygit merges them. File discovery, layer order and `customCommands` prepend-on-merge also match. Unknown keys are kept untyped and never cause an error.
- **About 35 non-keybinding keys are honoured**, mostly in `git.*`, `refresher.*`, `os.*`, `services`, `customCommands` and a few `gui.*` keys. Nearly all of `gui.*` (theme, layout, icons, time formats, screen mode, and similar) is ignored. That is harmless, because the native UI draws itself with GPUI and has no such knobs.
- **Ignored keys that are real gaps**, because the native mod has the feature but not the setting: `git.commit.autoWrapCommitMessage`/`autoWrapWidth` (on by default, 72), `git.autoForwardBranches` (default `onlyMainBranches`), `git.skipHookPrefix` (default `WIP`), `git.commitPrefix`/`commitPrefixes`, `git.branchPrefix`, `git.truncateCopiedCommitHashesTo` (the native mod copies the full hash), `worktree.defaultPath`, `git.overrideGpg`, `os.copyToClipboardCmd`/`readFromClipboardCmd`, the `gui.skip*Warning` set other than `skipStashWarning`, and `git.diffRenderers`/`branchLogCmd`/`allBranchesLogCmds`/`log.showGraph`. The native mod renders diffs and the graph itself.
- **Keybindings:** about 133 of the 170 keybinding names are bound (sections `universal`, `files`, `branches`, `commits`, `stash`, `commitFiles`, `main`, `submodules`). The rest name features the native mod lacks (`status.*`, `amendAttribute.*`, `commitMessage.commitMenu`, screen modes, diff-renderer cycling, word motions in text fields, and similar).
- **Migrations: the native reader applies none of Lazygit's `migrateUserConfig` rewrites.** Two have equivalent results anyway: null keybindings mean disabled, and legacy `*-alt*` keys add to the main key. The rest silently ignore the old spelling. Two are hazards, not silent: a legacy `git.commitPrefix` mapping, or legacy mapping values under `git.commitPrefixes`, fails type checking, and the *whole* config falls back to the last valid settings. Lazygit would have migrated it. The silent losses that matter are the legacy custom-command `subprocess`/`stream`/`showOutput` keys (the command runs with output `none` instead of in a terminal, log or popup), `keybinding.universal.executeCustomCommand`, `keybinding.files.openMergeTool` and `keybinding.worktrees.viewWorktreeOptions`. All the other migrated keys target settings the native mod ignores anyway.
- **Validation is looser.** Lazygit's `Validate()` rejects bad enum values (`git.log.order`, `localBranchSortOrder`, `fileTreeSortOrder`, and others), bad side panels and bad spinners, and refuses to load the file. The native reader rejects only YAML or type errors and unrecognised key names. It keeps the last valid config in that case. Bad enum values fall back quietly (for example, an unknown `git.log.order` passes no order flag). The native reader also never creates the global config file, while Lazygit does (`ConfigFilePolicyCreateIfMissing`).

Legend: **Honoured**: same meaning as Lazygit. **Differently**: read, but its behaviour differs. **Ignored (harmless)**: the native UI has no such feature, or the default is a no-op. **Ignored (gap)**: the native mod has the feature, so a user who sets the key sees a difference.

## Top level (`UserConfig`)

| Key | Status | Notes |
|---|---|---|
| `promptToReturnFromSubprocess` | Honoured | `subprocess.js` passes it to the subprocess wrapper; git-flow and manual merge continuation use it. |
| `services` | Honoured | `hosting.js` `hostingURLs(remote, services)` uses the `domain: "provider:webDomain"` form. |
| `customCommands` | Honoured (broadly) | See [Custom commands](#custom-commands). |
| `keybinding` | Honoured (partly) | See [Keybindings](#keybindings). |
| `confirmOnQuit`, `quitOnTopLevelReturn` | Ignored (harmless) | The mod is a Herdr pane; Escape steps back under the repo's rules. |
| `disableStartupPopups` | Ignored (harmless) | There are no startup popups. |
| `notARepository` | Ignored (harmless) | There is no repo picker or skip/quit prompt. |

## `gui`

| Key | Status | Notes |
|---|---|---|
| `showFileTree` | Differently | Sets the starting tree/flat mode and is reapplied only when the value changes on reload (`configuration-runtime.js`). The commit-files tree also reads it (`contexts.js`). |
| `fileTreeSortOrder`, `fileTreeSortCaseSensitive` | Honoured | Reapplied on change. Values are not enum-validated. |
| `filterMode` | Honoured | `substring` (smart case, whitespace terms) or `fuzzy` (`features.js`). |
| `sidePanelWidth` | Differently | Fraction of window width, clamped to 200 px minimum and 65% maximum (`main.js`). |
| `showBottomLine` | Differently | Hides the footer unless a status message or a running terminal needs it. |
| `skipStashWarning` | Honoured | Skips the apply/pop confirmation. |
| `switchToFilesAfterStashPop`, `switchToFilesAfterStashApply` | Honoured | |
| `showCommandLog` | Ignored (harmless) | Present in `LAZYGIT_DEFAULTS` but never read; there is no command-log view. |
| `skipAmendWarning`, `skipDiscardChangeWarning`, `skipNoStagedFilesWarning`, `skipRewordInEditorWarning`, `skipSwitchWorktreeOnCheckoutWarning` | Ignored (gap, minor) | The native confirmations follow its own design, not these flags. |
| `theme.*`, `darkTheme`, `lightTheme`, `colorScheme`, `customIcons`, `showIcons`, `showFileIcons`, `nerdFontsVersion`, `border`, `spinner`, `animateExplosion` | Ignored (harmless) | GPUI rendering follows Herdr's theme. |
| `scrollHeight`, `scrollPastBottom`, `scrollOffMargin`, `scrollOffBehavior`, `tabWidth`, `mouseEvents` | Ignored (harmless) | Native scrolling and mouse handling. |
| `sidePanels`, `expandFocusedSidePanel`, `expandedSidePanelWeight`, `shrinkSidePanelsToContent`, `mainPanelSplitMode`, `enlargedSideViewLocation`, `screenMode`, `portraitMode`, `portraitModeAutoMaxWidth`, `portraitModeAutoMinHeight`, `splitDiff`, `statusPanelView`, `switchTabsWithPanelJumpKeys`, `showPanelJumps` | Ignored (harmless) | The native layout is fixed. |
| `wrapLinesInDiffView`, `useHunkModeInDiffView` | Ignored (harmless/minor) | The native diff view has its own wrapping and hunk handling. |
| `language`, `timeFormat`, `shortTimeFormat` | Ignored (minor) | The native mod shows git's relative dates (`%cr`). |
| `commitLength.show`, `showListFooter`, `showRandomTip`, `showRootItemInFileTree`, `showNumstatInFilesView`, `showBranchCommitHash`, `showDivergenceFromBaseBranch`, `commitGraphStyle`, `commitAuthorShortLength`, `commitAuthorLongLength`, `commitHashLength`, `commandLogSize` | Ignored (harmless/minor) | Display details the native rows don't offer as settings. |

## `git`

| Key | Status | Notes |
|---|---|---|
| `autoFetch`, `autoRefresh`, `autoDetectExternalChanges` | Honoured | They gate the timers in `tickRefresh`. `autoRefresh` also gates the folder watcher (`main.js`). |
| `fetchAll` | Honoured | `git fetch --all --prune` or `git fetch --prune`. |
| `mainBranches` | Honoured | `ref-actions.js` and custom-command data. |
| `localBranchSortOrder`, `remoteBranchSortOrder` | Honoured | `date`, `recency`, `alphabetical`. Reapplied on change; not enum-validated. |
| `diffContextSize`, `ignoreWhitespaceInDiffView`, `renameSimilarityThreshold` | Honoured | Starting values (context clamped 0..10000, rename 0..100). Runtime `{`/`}`, `ctrl+w`, `(`/`)` change them without writing config, as Lazygit does. |
| `log.order` | Honoured | `topo-order`, `date-order`, `author-date-order`; `default` passes no flag. |
| `log.showWholeGraph` | Honoured | Adds `--all`. The Ctrl+L menu toggles it in memory. |
| `log.showGraph` | Ignored (gap, minor) | The native graph view always draws. |
| `commit.signOff` | Honoured | Adds `--signoff` to commits (`main.js`, `features.js`). |
| `commit.autoWrapCommitMessage`, `commit.autoWrapWidth` | Ignored (gap) | Lazygit wraps at 72 by default; the native commit box does not. |
| `merging.args`, `merging.squashMergeMessage`, `merging.manualCommit` | Honoured | `merge.js`/`merge-config.js` split on whitespace the way Lazygit's `strings.Fields` does. |
| `autoStageResolvedConflicts` | Honoured | `features.js`. |
| `disableForcePushing` | Differently | Force push is still offered, then fails with an error when run. Lazygit refuses with an error at the same point. |
| `autoForwardBranches` | Ignored (gap) | Lazygit fast-forwards main branches after a fetch (default `onlyMainBranches`); the native fetch does not. |
| `skipHookPrefix` | Ignored (gap) | Lazygit adds `--no-verify` when the message starts with `WIP`. |
| `commitPrefix`, `commitPrefixes` | Ignored (gap) | No commit-message prefill from the branch name. |
| `branchPrefix` | Ignored (gap) | No prefill in new-branch prompts. |
| `overrideGpg` | Ignored (gap, niche) | Matters only for GPG-signing users. |
| `truncateCopiedCommitHashesTo` | Ignored (gap, minor) | The native mod copies the full hash (`features.js` `copyCommitAttribute`). |
| `diffRenderers` (pagers: delta, difftastic, extDiff) | Ignored (differently by design) | The native mod renders diffs itself. |
| `branchLogCmd`, `allBranchesLogCmds` | Ignored (differently by design) | The native mod draws its own graph and branch log. |
| `parseEmoji` | Ignored (harmless) | Default `false`. |

## `refresher`

| Key | Status | Notes |
|---|---|---|
| `refreshInterval`, `fetchInterval`, `externalChangeCheckInterval` | Honoured | Seconds. A value of 0 or less disables that job, as upstream does. A non-number keeps the default. |

## `os`

| Key | Status | Notes |
|---|---|---|
| `edit`, `editAtLine`, `editAtLineAndWait`, `openDirInEditor`, `editPreset`, `editInTerminal` | Honoured | `editor-config.js` has Lazygit's preset table, guesses the preset from `GIT_EDITOR`/`VISUAL`/`EDITOR` the way Lazygit does, and fills `{{filename}}`/`{{line}}`/`{{dir}}`. |
| `open`, `openLink` | Honoured | Platform defaults include the WSL variant. |
| `shellFunctionsFile` | Honoured | Sourced before editor/open commands and custom commands. |
| `copyToClipboardCmd`, `readFromClipboardCmd` | Ignored (gap, minor) | Herdr's clipboard is used. |

## `update`, `worktree`

| Key | Status | Notes |
|---|---|---|
| `update.method`, `update.days` | Ignored (harmless) | The mod is not a self-updating binary. |
| `worktree.defaultPath` | Ignored (gap) | The native new-worktree prompt doesn't use it. |

## Custom commands

The schema is honoured broadly (`command-runtime.js`, `command-data.js`, `command-hydration.js`, `templates.js`):

- Command fields read: `key`, `context` (comma lists, `global`), `command`, `commandMenu` (groups whose leaves inherit the active context), `description`, `loadingText`, `output` (`none`, `popup`, `log`, `logWithPty`, `terminal`), `outputTitle`, `after.checkForConflicts`, `prompts`.
- Prompt types: `input` (`initialValue`, `suggestions.preset`/`suggestions.command`), `confirm` (`body`), `menu` (`options` with `name`/`description`/`value`/`key`), and `menuFromCommand` (`command`, `filter`, `valueFormat`, `labelFormat`). Every prompt type takes `condition`.
- Merge across config files prepends later files' commands, the same as upstream's append-after-Unmarshal.
- Templates are Go-style with `quote` and `runCommand`. Template or RE2 syntax the mod doesn't support reports an error instead of changing meaning (PARITY.md).

## Keybindings

All 11 sections are parsed and every value is validated through `normalizeKey`; an unrecognised key makes the reload stale. Lazygit's `LAZYGIT_KEYBINDING_PLATFORM` is read. Counts come from matching names in `keybindings.js`:

| Section | Bound | Not bound (no matching native feature) |
|---|---|---|
| `universal` | 67/84 | `suspendApp`, `scrollLeft`, `scrollRight`, `jumpToFile`, `moveWordLeft`, `moveWordRight`, `backspaceWord`, `forwardDeleteWord`, `confirmSuggestion`, `confirmInEditor-alt`, `nextScreenMode`, `prevScreenMode`, `cycleDiffRenderers`, `cycleDiffRenderersReverse`, `filteringMenu`, `openRecentRepos`, `submitEditorText` |
| `status` | 0/4 | all (no status panel) |
| `files` | 16/19 | `commitChangesWithoutHook`, `findBaseCommitForFixup`, `confirmDiscard` |
| `branches` | 16/19 | `forceCheckoutBranch`, `moveCommitsToNewBranch`, `addForkRemote` |
| `commits` | 24/27 | `renameCommitWithEditor`, `tagCommit`, `selectCommitsOfCurrentBranch` |
| `amendAttribute` | 0/3 | all |
| `stash`, `commitFiles` | all | |
| `main` | 5/7 | `prevFile`, `nextFile` |
| `submodules` | 2/3 | `bulkMenu` |
| `commitMessage` | 0/1 | `commitMenu` |

A remapped or disabled default key can't fall through to its old action. A context-specific binding beats a global one (PARITY.md). Text input keeps ordinary typing, as the repo's rules require.

## Lazygit's legacy-key migrations

Lazygit's `migrateUserConfig` (`app_config.go`, `computeMigratedConfig`) rewrites each file before it is decoded, and writes the result back to disk. After loading, `MergeLegacyAltKeybindings` folds the `*-alt*` keys into their main key. The native reader (`parseConfigLayer`) does none of this rewriting.

| Lazygit migration | Native reader | Effect |
|---|---|---|
| `gui.skipUnstageLineWarning` → `skipDiscardChangeWarning` | Not applied | Harmless: both keys are ignored. |
| `keybinding.universal.executeCustomCommand` → `executeShellCommand` | Not applied | **Gap**: the old name is ignored; `executeShellCommand` is bound. |
| `keybinding.universal.cyclePagers`/`cyclePagersReverse` → `cycleDiffRenderers*` | Not applied | Harmless: not bound either way. |
| `gui.windowSize` → `screenMode` | Not applied | Harmless: ignored. |
| `gui.wrapLinesInStagingView` → `wrapLinesInDiffView`; `gui.useHunkModeInStagingView` → `useHunkModeInDiffView` | Not applied | Harmless: ignored. |
| `keybinding.files.openMergeTool` → `openMergeOptions` | Not applied | **Gap**: `openMergeOptions` is bound; the old name is ignored. |
| `gui.branchColors` → `gui.branchColorPatterns` (keys turned into regexes) | Not applied | Harmless: the theme is ignored. |
| Move `keybinding.worktrees.viewWorktreeOptions` → `keybinding.universal.newWorktree` | Not applied | **Gap**: `newWorktree` is bound; the old location is ignored. |
| Move `gui.authorColors`, `gui.branchColorPatterns` → `gui.theme.*` | Not applied | Harmless: the theme is ignored. |
| `null` keybinding → `<disabled>` | Equivalent | A null clears the key in the merge, and `normalizeKey(null)` returns `[]`, so the binding is disabled. |
| `git.commitPrefix` mapping → one-element sequence | Not applied | **Hazard**: `parseConfigLayer` throws `git.commitPrefix: expected a sequence`, so the whole config goes stale (verified by running the parser). |
| `git.commitPrefixes` map values: mapping → sequence | Not applied | **Hazard**: throws `git.commitPrefixes.<repo>: expected a sequence` (verified). |
| customCommands `subprocess: true` → `output: terminal`; `stream: true` → `output: log`; `showOutput: true` → `output: popup` | Not applied | **Gap**: the old keys are ignored, so the command runs with the default output `none`. |
| `git.allBranchesLogCmd` → prepended to `allBranchesLogCmds` | Not applied | Harmless: both are ignored. |
| `git.paging` → `git.pagers` → `git.diffRenderers` (`pager`→`command`, `externalDiffCommand`/`useExternalDiffGitConfig`→`type: extDiff`, otherwise `type: rawGit`) | Not applied | Harmless: diff renderers are ignored. A legacy `paging` mapping is an unknown key and parses untyped. |
| `MergeLegacyAltKeybindings` (union of `quit-alt1`, `prevItem-alt`, `nextItem-alt`, `gotoTop-alt`, `gotoBottom-alt`, `prevBlock-alt`/`-alt2`, `nextBlock-alt`/`-alt2`, `confirmInEditor-alt`, `scrollUpMain-alt1`/`-alt2`, `scrollDownMain-alt1`/`-alt2`, `diffingMenu-alt` into the main key) | Equivalent, except `confirmInEditor-alt` | Each alt name is its own native binding for the same action, so the keys add up the same way. `confirmInEditor-alt` is not bound. |

The `commitPrefix`/`commitPrefixes` rows are a real hazard, beyond silently ignoring a key. `TYPES` declares `commitPrefix` as `[]CommitPrefixConfig` and the values of `commitPrefixes` as `[]CommitPrefixConfig`, so `read()` calls `expect('a sequence')` on a legacy mapping. A user whose Lazygit config still has the old mapping form gets an `invalid-config` error. The native mod then keeps the last valid (or default) settings for every key, while Lazygit would have migrated the file and loaded it.
