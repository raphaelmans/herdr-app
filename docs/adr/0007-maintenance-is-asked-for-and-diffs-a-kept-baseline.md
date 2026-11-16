# Maintenance is asked for, and compares against a kept baseline

Own mods fall behind two things: Herdr (each release rewrites `AGENTS.md`, the type files and the shipped mods, and clones never follow) and this repo's own rules (a mod written before a rule doesn't pick it up). `MAINTENANCE.md` is the one procedure for catching up, and it runs only when the person asks for a maintenance run. Agents skip the file otherwise: a sweep of every mod in the middle of other work is slow, touches code nobody asked about, and competes with the person typing in the live window.

Herdr's files are untracked and overwritten in place, so nothing here could say what a release changed. `docs/baseline/` therefore keeps a copy of `AGENTS.md`, `herdr.d.ts` and `installed.json` (Herdr's hashes of every shipped file), a hash of `gpui-kit.d.ts` (800 KB, too large to keep) and the version, as they were at the end of the last run. We rejected re-cloning to catch up (it throws our changes away), bumping `cloned_from` by hand (that field is Herdr's), and a check on every start (it would nag about work that is only worth doing in one sitting).

**Consequences:** the baseline moves only at the end of a full run, or it hides what changed in between. The copies end in `.txt` so no agent or editor mistakes them for the live `AGENTS.md` or type files. `MAINTENANCE.md` holds the log of runs.
