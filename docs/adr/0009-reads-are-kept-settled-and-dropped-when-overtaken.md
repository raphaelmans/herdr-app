# Reads are kept, settled, and dropped when overtaken

Every mod that reads from a program (git, gh, acli, wt, lific) follows one approach, first worked out in the Git mod during the Lazygit parity work and then carried to Pull requests and Jira. ADR 0006 keeps large data out of the shared script heap; this one keeps the number and cost of reads down, because each read is a process spawn and the window is shared with the person typing.

- **Read lazily.** A list is read when it is first shown, not when the window opens (the Launcher's worktree list is read on the branch field's first open, per folder).
- **Keep what was read, bounded.** Results are kept per key (repository, folder, project and scope) in a map that drops the least recently used entry past a fixed size (Pull requests: 12 repository lists, 6 pull request lists). A kept result outlives the window, so reopening shows it at once.
- **Know when it is old.** A kept result is reused until something says it changed: a cheap mark (the Git mod's hash over refs and upstreams), or an age when no mark exists (history after 5 minutes, a Jira issue detail after an hour). What never changes, such as a commit's patch, is read once. `r` reads again on purpose.
- **Settle before reading.** A selection that moves quickly (j held down) reads only the row it rests on, 150–200 ms after it stops. Holding j through a 30-card Jira column used to start 30 `acli` processes.
- **One read per key.** A read already running for a key is never started twice.
- **Drop what was overtaken.** Each read carries a generation; when the selection, folder or window has moved on, its result is discarded and its waiting indicator cleared.
- **Bound what comes back.** Lists are paged or capped before the mod parses them (Git Graph pages of 100, a Jira sprint cut at 500 with the count saying so, a cache file over 2 MB started over), long lists are virtual, and anything derived from a list (columns, search text, markdown blocks) is worked out once per list, not on every redraw.

We rejected a shared cache module (a mod can't import another mod's files, and each source invalidates differently) and timers that redraw on a schedule (the Waiting rule forbids them, and they spend reads on views nobody is looking at).

**Consequences:** stale-by-design is accepted: a kept list can be up to its age old until `r`. Conditional requests (gh's ETag / 304, free of rate limit) would replace ages for GitHub and are still to do. None of the gains were timed in the live window; they come from fewer spawns and less parsing by construction.
