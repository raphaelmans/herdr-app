# Maintenance

> **Agents: skip this file unless the person asks for a maintenance run by name** ("run maintenance", "do a maintenance run", "follow MAINTENANCE.md"). Don't read it for other work, don't start one of its passes on your own, and don't offer one because a check here would be handy. A new Herdr version, a failing check or a stale clone is something to mention, not a reason to begin.

A maintenance run brings the own mods back in line with two things that move without them:

- **Herdr itself.** Each release rewrites `AGENTS.md`, the type files and the shipped mods. Clones don't follow, and an own mod can keep calling something Herdr changed.
- **This repo's current approach.** `CLAUDE.md`, the ADRs and `GLOSSARY.md` gain rules over time. Mods written before a rule don't pick it up by themselves.

Terms: `GLOSSARY.md` (maintenance run, Herdr baseline, own mod, clone, shipped mod, vendored mod, mod spec).

## Rules for the run

- Run every command from `~/.config/herdr-app`.
- The live-window rules in `CLAUDE.md` still hold: no dialogs, no keystrokes, no restart without asking.
- Passes 1 to 4 only read. Finish them and report before changing a mod, then change what the person agrees to. One mod per change, checked before the next.
- Never edit a shipped or vendored mod to make a finding go away (ADR 0005).
- Don't commit unless asked. `jira` goes back to `mods-disabled/` before a commit if it is on.

## 1. Where things stand

```sh
herdr-app --version          # the Herdr that is running
cat docs/baseline/version    # the Herdr the last run was made against
git status --short           # work in progress that the run must not mix with
```

Same version and a clean log below: Herdr has not moved, so passes 2 and 3 have nothing to find. Go to pass 4.

## 2. What Herdr changed

`docs/baseline/` holds Herdr's reference files as they were at the last run (ADR 0007).

```sh
# Release notes newer than the baseline
awk -v v="$(cut -d' ' -f2 docs/baseline/version)" 'index($0, "## [" v "]") == 1 {exit} {print}' update-notes-cache.md

# What Herdr now tells agents, and what mods can call
git diff --no-index docs/baseline/AGENTS.md.txt AGENTS.md
git diff --no-index docs/baseline/herdr.d.ts.txt herdr.d.ts

# gpui-kit's types are too large to keep; only whether they changed
[ "$(shasum -a 256 gpui-kit.d.ts | cut -d' ' -f1)" = "$(cat docs/baseline/gpui-kit.d.ts.sha256)" ] && echo "gpui-kit: same" || echo "gpui-kit: changed"

# Shipped mods and layouts whose files changed, appeared or went
jq -nc --slurpfile was docs/baseline/installed.json --slurpfile now installed.json '{
  changed: [$now[0] | to_entries[] | select($was[0][.key] != null and $was[0][.key] != .value) | .key],
  added: ($now[0] | keys - ($was[0] | keys)),
  gone:  ($was[0] | keys - ($now[0] | keys)) }'
```

From these, write down:

- anything removed, renamed or changed in `herdr.d.ts` that an own mod uses (`grep -rn "<name>" mods/*/*.js`);
- new guidance in `AGENTS.md` that contradicts or replaces a rule in `CLAUDE.md`, an ADR or a mod's workaround. The Escape binding and the heavy-data rule (ADR 0006) exist because of Herdr's limits; if Herdr lifts one, say so rather than keeping the workaround quietly;
- anything Herdr now does itself that an own mod was written to do.

## 3. Clones

A clone stopped following Herdr the day it was made. List them with the shipped mod each came from:

```sh
{ find mods mods-disabled -maxdepth 2 -name mod.json; echo layouts/mine.json; } | sort | while read -r f; do
  jq -r --arg f "$f" 'select(.cloned_from) | "\($f)\t\(.cloned_from.name)\t\(.cloned_from.version)"' "$f"
done
```

For each clone whose shipped mod is under `changed` in pass 2 (on the first run, every clone: see the log):

```sh
git diff --no-index mods/<shipped> mods/<clone>      # e.g. mods/tabs mods/tab-bar
git diff --no-index layouts/main.json layouts/mine.json
```

The diff holds both our changes and Herdr's. Read it with the release notes and sort each of Herdr's changes into: take it (a fix, or a feature the layout should have), leave it (we replaced that part on purpose), or ask. Port by hand into the clone; never re-clone over it. Leave `cloned_from` as Herdr wrote it; the log records what a clone was last compared against.

A shipped mod under `gone` that a clone, `keys.json` or `layouts/mine.json` still refers to is a finding of its own.

## 4. Everything still loads

```sh
# Every own and vendored mod, wherever it sits
sed -n 's|^!mods/\([a-z0-9-]*\)/$|\1|p' .gitignore | while read -r m; do
  d=mods/$m; [ -d "$d" ] || d=mods-disabled/$m
  herdr-app check "$d" >/dev/null 2>&1 </dev/null && echo "ok    $d" || echo "FAIL  $d"
done

herdr-app status | jq .errors      # must be []
ls *.error 2>/dev/null             # must be nothing
./health.sh                        # requirements; "drift" rows mean requirements.json fell behind the toolchain standard
for t in tests/*.mjs; do node "$t"; done
```

`herdr-app check` proves a mod loads and draws its first view, no more. Say which mods were only checked and which were seen working in the window.

## 5. The current approach

Read `CLAUDE.md`, `docs/adr/` and `GLOSSARY.md` first, then go through the own mods (the list from pass 4, minus the vendored ones in `mods/config/vendored.json`). For each, compare against:

| Rule | Where it is written |
|---|---|
| Vim motions, shown in the footer hints | `CLAUDE.md` → How every own mod behaves |
| Escape steps back, bound with `cx.bind_keys`, never drops a draft | same |
| Text boxes submit with Cmd+Enter, built on `TextareaState` | same |
| Explicit start: Cmd+Enter to create, never a single digit | same |
| Agent pickers from `knownAgents()` and the agent shortlist | ADR 0002 |
| Model pickers from the model catalog | `CLAUDE.md` |
| Works for any agent CLI and provider | `CLAUDE.md` |
| Choices live on a page of Config | ADR 0001 |
| Short generated text comes from the Writer | `CLAUDE.md` |
| Closes when its job is done, keyboard back to the pane, a toast | `CLAUDE.md` |
| Heavy data reduced with `exec` before the mod reads it | ADR 0006 |
| Labels, identifiers and comments use glossary terms, no _Avoid_ words | `GLOSSARY.md` |

Then the bookkeeping, for every own mod:

- **Mod spec:** the programs the mod runs (`exec`, `run`, `hc`) match `spec.needs` and `spec.extras`, each is described in `mods/config/requirements.json`, and the README's requirement table agrees (ADR 0003).
- **Tracked:** `.gitignore` allowlists the folder and any non-`.js` file it ships; `git status --short --ignored mods/<name>` shows nothing of ours ignored.
- **Wiring:** its keys are in `keys.json` and the README row; a prefix key is also in `mods/tmux-prefix/main.js`; `layouts/mine.json` still shows it if it should.
- **Words and defaults:** its terms are in `GLOSSARY.md`; each choice it reads is in `DEFAULTS.md`'s choices table.
- **Vendored mods:** still byte-identical to the release at the URL in `mods/config/vendored.json` (ADR 0005). A newer release is offered to the person, not taken.

A rule that most mods break is more likely a rule that changed than thirty bugs. Raise it before fixing.

## 6. Report, then close the run

Report first, grouped as: broken now, behind Herdr, behind the approach, bookkeeping. For each: the mod, what is wrong, the fix proposed, and whether it was seen in the live window or only by `herdr-app check`.

After the agreed fixes are in and pass 4 is clean again, move the baseline to today's Herdr and add a row to the log:

```sh
cp AGENTS.md docs/baseline/AGENTS.md.txt
cp herdr.d.ts docs/baseline/herdr.d.ts.txt
cp installed.json docs/baseline/installed.json
shasum -a 256 gpui-kit.d.ts | cut -d' ' -f1 > docs/baseline/gpui-kit.d.ts.sha256
herdr-app --version > docs/baseline/version
```

Move the baseline only at the end of a full run. A baseline moved early hides every change Herdr made in between.

## Log

Newest first. One row per run: what was compared, what was fixed, what was left and why.

| Date | Herdr | What happened |
|---|---|---|
| 2026-11-16 | 0.1.16 | Baseline taken; no run made. The clones date from 0.1.12 to 0.1.16 and have never been compared with their shipped mods, so the first run does pass 3 for every clone, whatever pass 2 says. |
