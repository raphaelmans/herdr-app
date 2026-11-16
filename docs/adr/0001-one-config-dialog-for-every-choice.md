# One Config dialog for every choice

Every choice this setup's mods read (agent shortlist, Writer, model catalog and stars, Worktrunk, vaults, curtain, mods on and off) is made on a page of one Config dialog (`mods/config/`, one file per page), opened from one tab-bar button, `cmd-shift-m` or `ctrl-a M`. We had started with a Writer dialog, a Mod manager and an Agent shortlist mod, each with its own button; they were merged so there is one place to look and one place to maintain. A new choice is a new page, never a dialog or tab-bar button of its own.

**Consequences:** other mods jump to a page instead of drawing their own settings (the Launcher's `e` opens Agents, the Git commit prompt opens Writer). The Launcher's own toggles (skip-permissions flag, worktree base, open as) still live in the Launcher and `launcher.json`; moving them to a page is open.
