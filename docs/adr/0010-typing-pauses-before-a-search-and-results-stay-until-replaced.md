# Typing pauses before a search, and results stay until replaced

A search or suggestion list does not run on every keystroke. It runs once typing pauses, and what is on screen stays until the new result replaces it. Find a file used to empty its list and show a spinner on each letter (a 40 ms wait nobody could feel), which made the list blink; the person asked for a pause and chose **1000 ms** for Find a file over the usual 100–250 ms, because a large index makes each search costly and a jumping list is worse than a short wait.

The pause depends on what each keystroke costs:

| Kind | Pause | Where |
|---|---|---|
| Suggestions read from a small, local source | 80 ms | Launcher folder field, worktree combo box |
| A selection whose detail costs a process | 150–200 ms settle (ADR 0009) | Pull requests, Jira |
| Search over a large index | 1000 ms, the person's choice | The former Find a file picker |

Whatever the pause:

- **Old results stay.** While a search waits, the previous rows stay and the footer shows the waiting indicator; the list shows a spinner only when it has nothing yet.
- **Enter doesn't wait.** Enter during a pause runs the search at once and acts on the top result for what was typed, never a row left from the previous query.
- **Empty is immediate.** Clearing the field, and the first fill after a list loads, show results without a pause.
- **A long list of choices is a combo box**: a field that filters, a popup of capped rows read lazily and kept per source (ADR 0009), Vim motions inside it. It scales to many worktrees or sprints where an inline list would not. The Launcher's branch field and Jira's scope use it.

**Consequences:** a new search picks its row from the table and names its constant; a pause above 250 ms needs the Enter shortcut, or it reads as lag. The main view's spinner in the Git mod appears only after 180 ms, so quick reads don't flash one.

**Note (ADR 0011):** the Git mod's 180 ms main-view spinner now lives on the `lazygit-mod` branch.

**Note (ADR 0012):** the Pull requests window in the table now lives on the `pull-requests-mod` branch; Jira still settles this way.
