# Vendored mods stay as their authors wrote them

A vendored mod (listed in `mods/config/vendored.json`: `auto-title`, `skillshare`) is kept byte-identical to its upstream release. We change how it behaves only from outside it: its own config files (`~/.config/herdr-auto-title/config.env`), keys, other mods, and Config's spec speaking for it. We considered taking `auto-title` over and decided against it: the mod is only an install popup around a Go service that does the real work, and owning it would mean maintaining that service and losing its fixes.

**Consequences:** changes to the behaviour itself go upstream as an issue or PR first. `tab-sequence` writes the service's private lock file (`manual-names.json.desktop`); if that format changes upstream, fix our side or ask upstream for a supported way, rather than forking.
