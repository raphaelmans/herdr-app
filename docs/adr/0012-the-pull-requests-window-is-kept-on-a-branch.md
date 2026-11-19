# The Pull requests window is kept on a branch

The Pull requests window (`mods/pull-requests`, `ctrl-a P`), which read an organization's repositories and pull requests through `gh`, is removed from `main` and kept on the `pull-requests-mod` branch, as the native Git mod is on `lazygit-mod` (ADR 0011). The person wants every request a board makes to be one they asked for, and is focusing on the Jira board first; a second board reading GitHub on its own schedule (account and lists re-checked after a minute) was requests and audit-log entries for little use. `gh` is no longer a requirement on `main`.

**Consequences:** bring it back only when asked, from that branch, and with longer ages or conditional requests (ETag / 304) before it reads anything. ADRs 0009 and 0010 note that their Pull requests examples now live there.
