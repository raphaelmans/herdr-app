# A mod is off when its folder is in `mods-disabled/`

Turning a mod off moves `mods/<name>` to `mods-disabled/<name>`; on moves it back. Herdr has no switch for mods, and a list of names would need every mod to check it. Moving the folder makes Herdr simply not load it, deletes nothing, and lets git record which mods are off by default (`jira` is committed in `mods-disabled/`).

**Consequences:** a tracked mod switched on shows in `git status` as moved; switch it back off before committing if its default is off. Keys bound to an off mod stay in `keys.json` and answer "no mod folder". Shipped mods cannot be turned off: Herdr restores them on every start. Whether on/off should become a tracked list is still open.
