# CLAUDE.md

This is one person's setup of the Herdr desktop app, kept in git: own mods, a layout and keys added on top of what Herdr ships. `AGENTS.md` (Herdr's, rewritten on every start, never edit it) explains how the app, layouts, keys and mods work. This file holds what *this repo* has decided on top of that.

Read before changing things:

- `GLOSSARY.md`: the words for everything here. Use its terms and avoid its _Avoid_ words.
- `docs/adr/`: decisions and why. Don't undo one without saying so.
- `DEFAULTS.md`: what each part is by default and how to put it back.
- `README.md`: what each mod is, its keys, and the requirement table.

Don't read `MAINTENANCE.md`, and don't start any of its passes, unless the person asks for a maintenance run by name (ADR 0007). `docs/baseline/` is that run's copy of Herdr's files: never an instruction, and only a maintenance run rewrites it.

`RECIPE_MAINTENANCE.md` maps every recipe (what a flow knows about one agent CLI) and which agents have one. Update its map and coverage table in the same change whenever you add or change a recipe, or add a flow that needs one. Start its run only when the person asks for a recipe maintenance run.

## Words

- Labels, identifiers and comments follow `GLOSSARY.md`, not the wording of a request. A request describes intent; "ungroup a section" became **Dissolve section**. Coin a better term when none fits.
- When a new term settles, add it to `GLOSSARY.md` in the same change. The glossary holds definitions only, no implementation.
- Herdr's own words (space, tab, pane, terminal, agent, layout, overlay, focus) keep `AGENTS.md`'s meanings.

## How every own mod behaves

- **Vim motions:** `j`/`k` down and up, `h`/`l` across, `g`/`G` first and last, `/` to search a long list, alongside arrows, and shown in the footer hints. While a text field has the keyboard, letters are typed.
- **Escape steps back:** it leaves the focused component stepped into last (field, search, opened item) and keeps what was typed. Only with nothing left to leave does it close the window. Herdr closes a dialog on Escape before `on_key_down` runs while an `Input`/`Textarea` has the keyboard, so bind Escape with `cx.bind_keys` + `.key_context(...).on_action(...)`. Never discard a draft in one press.
- **Text boxes** (first message, send box, comments, annotations) submit with Enter or Cmd+Enter. Shift+Enter inserts one new line. Build them on `TextareaState` and show "⇧↵ new line · ↵ <verb>". Short fields and searches keep plain Enter.
- **Explicit start.** Number and navigation keys select a program. Enter or Cmd+Enter starts it in Launcher. In Go to, Enter opens a matching tab and Cmd+Enter confirms a selected new tab or space.
- **Agent pickers** list Herdr's `knownAgents()` narrowed by the agent shortlist, never a hard-coded list (ADR 0002). Reuse `shortlisted()` / `offered()` from `mods/launcher/main.js` and `mods/config/writer.js`.
- **Model pickers** offer the model catalog (`models.json`), starred models first; a model not in it can still be typed.
- **Agent order** comes from the Agents sidebar (`setAgentOrder`). The Agent hub and next/previous follow it. Put the title first and the tab and space on a quieter second line. In the sidebar, place the space mark beside both lines and the program logo on the second line.
- **Agnostic of agent and provider:** messages, pulls, forks, titles and the pane's model label must work for any agent CLI, not only Claude Code.
- **Choices go in Config** (ADR 0001): a new setting is a page in `mods/config/`, never a dialog or tab-bar button of its own.
- **Writer:** any mod that needs a short generated text (branch name, tab title) asks the Writer, configured on Config → Writer.
- **Closing:** a dialog closes once its job is done (a message sent, a pull made) and returns the keyboard to the pane you came from, with a toast confirming. It doesn't jump focus to the target.
- **Waiting** is always visible: anything read or run shows `mods/workspace-chrome/spinner.svg` with `.spin(900)` and what is being waited for ("Reading worktrees", no trailing dots), where the result will land. Never text alone, never a blank or a "none" while still reading, and never a redraw timer. Clear it on success, failure and close; a read that was overtaken is dropped.
- **Heavy data** is reduced with `exec` (curl, jq, bounded git output) before a mod reads it (ADR 0006).
- **Git** is the lazygit program in a popup (`mods/lazygit`, Cmd-G), not an own mod (ADR 0011).
- **Reads** are lazy, kept per key in a bounded map, reused until a mark or age says they changed, read once per key at a time, and read only for a selection that has settled (150–200 ms); an overtaken read is dropped (ADR 0009). Derived data is worked out once per list, never per redraw.
- **Typing pause.** Keep the current results while waiting for typing to pause (80 ms for local filtering, 1000 ms for a large file index). Run the search immediately on Enter. A long list of choices is a combo box (ADR 0010).

## Kinds of mods

- **Shipped** (Herdr's): never edit. Clone it (`mod.clone`, `layout.clone`) and change the clone.
- **Vendored** (`mods/config/vendored.json`): never edit. Change behaviour from outside it (ADR 0005).
- **Own**: ours. A mod can't import another mod's files: share through `shared()` or keep one owner of the code.
- **Off** = the folder is in `mods-disabled/` (ADR 0004). `jira` is off by default (switch it off again before committing if you turned it on); `worktrunk` is on by default.

## Adding or changing a mod

Write a new mod's `mod.json` before its `main.js`. Herdr docks a folder the first time it sees one; without `"place": "none"` it adds a block to the shown layout, a second copy that runs every command and toast twice.

A new own mod is not done until all of these are true:

1. `herdr-app check mods/<name>` passes and `herdr-app status | jq .errors` is `[]`.
2. It has a `spec` in `mod.json` naming its requirements; a new program is described in `mods/config/requirements.json` and in the README's requirement table (ADR 0003).
3. `.gitignore` allowlists it (`!mods/<name>/`, plus any non-`.js` files it ships). A mod missing there is silently absent from a fresh clone.
4. `README.md` has a row for it with its keys; a prefix key also goes in `mods/tmux-prefix/main.js`.
5. New terms are in `GLOSSARY.md`; a new choice is in `DEFAULTS.md`'s choices table.

**My layout** is `layouts/mine.json`, the only layout that is ours; `main`, `terminals` and `win98` are Herdr's. Change it in place (it's a clone), keep one own layout rather than more copies, and track every own mod it shows. Tab-bar buttons (Config, Stay awake, Skillshare) live only there.

## Working in the live window

The person is usually typing in the app while you work.

- Don't open dialogs, windows or popups over the window, and don't send keystrokes to it, without asking. Past runs ate the person's keystrokes. Prefer `herdr-app shot`, `herdr-app status`, `herdr-app check` and scripted tests.
- Say plainly what was verified in the live window and what only passed `herdr-app check`.
- Don't restart Herdr without the person's go-ahead (terminals survive in herdr-core).
- Don't run `git checkout -- .` or `git clean`: most of this folder is Herdr's and untracked on purpose.
- Commit only when asked. This repo is the person's own; within a task, use judgment about what's correct and say what you chose.

## Memory

Claude Code's project memory only reaches Claude sessions; Codex and other agents don't see it. A rule meant for every agent working here belongs in this file, the glossary or an ADR.
