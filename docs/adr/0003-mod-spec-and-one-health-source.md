# Each mod declares its requirements; one script checks them

Each mod's `mod.json` says under `spec` which requirements it needs and which are extras; `mods/config/requirements.json` describes each requirement once (where to look, its owner, the fix). `./health.sh` reads both and is the only checker: the Config Health page draws its result, and a fresh clone can run it before Herdr starts. Inspired by LazyVim's checkhealth. We rejected a central table of who-needs-what (it drifted) and a Health page with its own logic (two checkers can disagree).

**Consequences:** a new requirement is two edits, the catalog and the mod's spec. The README's requirement table is a hand-kept copy for when the page cannot open; change it with them. Each requirement has one owner (mise, the system, its own installer, or built here), following the toolchain standard in Notion.
