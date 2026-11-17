# Git is the lazygit program, not an own mod

On `main`, Git is lazygit itself, shown in a popup by `mods/lazygit` (Cmd-G, `ctrl-a g`) for the focused pane's folder on its machine, and lazygit is a needed requirement. The native Git mod, which redrew Lazygit 1:1 in Herdr and added a Git Graph, is kept only on the `lazygit-mod` branch with its parity notes (`PARITY.md`) and research (`docs/research/`). We chose the program over the port because the port was the largest and fastest-growing part of this repo (about 16,000 lines, an eight-minute test suite, a pinned upstream to follow), while lazygit already does the same work, follows its own config and updates through mise.

**Given up:** the Git Graph, Markdown and Mermaid previews of changed files, and drawing Git in Herdr's own theme and keys. Bring the mod back only when the person asks, and from that branch, not by rewriting it.

**Consequences:** ADRs 0006, 0009 and 0010 cite the Git mod as an example; those examples now live on `lazygit-mod`, and their rules still hold for every mod on `main`. The Writer no longer writes commit summaries: lazygit has its own commit flow, and Worktrunk's commit writer can still follow the Writer.
