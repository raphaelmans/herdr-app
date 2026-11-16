# A mod is off when its folder is in `mods-disabled/`

Turning a mod off moves `mods/<name>` to `mods-disabled/<name>`; on moves it back. Herdr has no switch for mods, and a list of names would need every mod to check it. Moving the folder makes Herdr simply not load it, deletes nothing, and lets git record which mods are off by default (`jira` is kept in `mods-disabled/`; `worktrunk` was too until 2026-11-16, when it became on by default).

Worktrunk's entry opens its Config page; its settings stay in Config (ADR 0001), and its worktree controls stay in the Launcher. Those hosts check for `mods/worktrunk/mod.json` before using `wt`. Shared `worktrunk.enabled` only updates open views after a switch: it is derived from the folder, never a second preference. Turning it off keeps its config and Writer choice, stops their use, and removes `wt` from Health's requirements.

**Consequences:** a tracked mod switched on shows in `git status` as moved; switch it back off before committing if its default is off. Keys bound to an off mod stay in `keys.json` and answer "no mod folder". Shipped mods cannot be turned off: Herdr restores them on every start. Whether on/off should become a tracked list is still open.
