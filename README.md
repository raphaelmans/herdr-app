# herdr-app config

My config for the [Herdr](https://herdr.dev) desktop app. It lives at `~/.config/herdr-app`.
The Herdr TUI config is a separate repo: [raphaelmans/herdr](https://github.com/raphaelmans/herdr).

Herdr rewrites most of this folder on every start, so `.gitignore` is an allowlist:

| Path | What it is |
|---|---|
| `keys.json` | Key bindings (`ctrl-a` opens the tmux prefix) |
| `settings.json` | Zoom, sounds, fonts |
| `layouts/mine.json` | My layout, cloned from Herdr's `main`: the spaces sidebar with sections, the agents sidebar, my tab bar with its buttons (Stay awake, Config, Skillshare) and status bar. The only layout here that is mine; the others are Herdr's |
| `mods/tab-bar/`, `mods/status-bar/`, `mods/agents-titled/`, `mods/toasts/` | My layout's tab bar, status bar, agents sidebar and notifications: clones of Herdr's `tabs`, `workspace-status`, `agents` and `toast` that follow the curtain. Right-click an agent row → Snooze (Wake to undo): the agent drops to a Snoozed section with a moon, its tab shrinks to its icon and number, and it isn't counted as needing you, until it starts another turn or comes to need you. A tab's right-click menu has the same two actions (Regenerate title, Snooze / Wake) for the agent in it, the focused one on the shown tab, above Rename, New tab and Close |
| `mods/curtain/` | `cmd-shift-h`: takes every sign of agents off the window while the screen is shared |
| `mods/go-to/` | `cmd-p` / `ctrl-a w`: Go to, a search over spaces, tabs and agents (cloned from Herdr's `picker`), across every space (the one you're in never folds into "earlier"). Keys as in Find a file: opens in NORMAL (`j`/`k`, `g`/`G`, `l` or Enter to go, `/` or `i` to search, `?` for the keys, `q` to close); Escape leaves the search first, then closes; `ctrl-d` closes the selected tab |
| `mods/workspace-navigation/` | The top of the spaces sidebar (search, fold) and its footer (Settings, Add machine), cloned from Herdr's `workspace-chrome`; its search opens Go to |
| `mods/tab-sequence/` | `ctrl-a r`: renumbers the tabs of the shown space to match their places |
| `mods/pane-move/` | `ctrl-a t` / `ctrl-a !`: moves the focused pane to another tab or a new tab, in this space or another on the same machine, or into a tab of its own |
| `mods/file-picker/`, `mods/md-popup/` | `cmd-o`: find a file below the terminal's folder and open it in a viewer; the markdown preview popup it (and nvim's `<leader>mp`) opens fills the available height with the same 18px top and bottom margins as Go to |
| `mods/lazygit/` | lazygit in a popup for the focused pane's folder. No key opens it: the Git dialog's `L` starts lazygit itself |
| `mods/stayawake/` | The coffee-cup tab-bar button: keeps the Mac awake, right-click for lid-closed too |
| `mods/skillshare/` | The Skillshare panel and its tab-bar button (vendored) |
| `mods/tmux-prefix/` | `ctrl-a` prefix popup with keys that match the Herdr TUI |
| `mods/launcher/`, `launcher.json` | `ctrl-a c` / `v` / `-` / `N`: new tab, split or space with a shell or any installed agent, optional skip-permissions flag, a model from the model catalog (`d`), reasoning level (`r`, or `ctrl-r` while typing) for Claude Code and Codex, and worktrunk worktree, for a new tab, split or space and for a plain terminal as for an agent (a combo box: type a branch name or a sentence, or narrow the folder's existing worktrees and branches and choose one; they are read when the combo box is first opened and kept, so the next open shows them at once while they refresh; when the folder is in no repository, the repositories open in Herdr are offered instead and Enter moves the folder to one); choices saved in `launcher.json` |
| `mods/worktrunk/` | Worktrunk in the Launcher and Config, including following the Writer. On by default; turn it off in Config → Mods. No separate key; opening the mod goes to Config → Worktrunk. While off, its Launcher controls, config reads/writes and Writer sync stop, and Health does not require `wt`; saved settings are kept |
| `mods/copy-mode/` | tmux-style copy mode (`ctrl-a [`), vi keys over the terminal's scrollback |
| `mods/nvim-pane/` | Neovim in a pane beside the terminal: `cmd-e` / `ctrl-a e` shows or hides it, `cmd-shift-e` shows it and gives it the keyboard |
| `mods/pane-header/` | The layout's pane header; also records where each pane sits, for `send-box` |
| `mods/send-box/` | `ctrl-a i`: type a message and send it to another pane; opens with the cursor after any supplied text, including pulled output |
| `mods/agent-hub/` | `ctrl-a m`: every running agent in one window, with its recent screen; search the sidebar by title, program, space, tab or address (click the field or press `/`), with `a` to switch between this space and all spaces |
| `mods/agent-fork/` | `ctrl-a f`: choose an agent in the same Launcher palette. The current CLI forks natively (Claude Code and Codex); another opens in a right split and receives a context handover from the source through native `hc send`. The source stays open. The picker keeps the agent shortlist, model, reasoning, permission and optional message choices |
| `mods/spaces-sections/` | Spaces sidebar with named, foldable sections (cloned from Herdr's `spaces`), plus **Hidden** for work to pick up later |
| `mods/git/` | `cmd-g`: native Git with hunk/line staging, nested branch/remote/tag histories and commit files, ignored/status filters, worktrees/submodules, merge variants and editor continuation, rebase plans and active todos, custom patches, author/co-author edits, cherry-pick, bisect, conflicts, reflog and history undo. `v` or Shift-arrow selects ranges: files support staging/discard/editing; branches support deletion and fast-forward; tags support deletion/push; stashes support drop; commit ranges open a combined diff. CommitFiles Space builds whole-file patches and `d` removes selected changes from one local commit. Reads Lazygit settings, keybindings and configured command prompts. `e` uses its configured editor, including historical line mapping; Alt/Shift-click edits a diff line; `E` edits a hunk before staging/unstaging; `Ctrl-T` opens Git's diff tool; `Alt-Shift-C` edits configuration. Browser links use the configured launcher. Keeps Markdown/Mermaid previews. `i` in Local branches opens Git-flow start/finish; `m` opens actions; `[` / `]` change views; `L` opens upstream Lazygit in the same repo. [Coverage and keys](mods/git/PARITY.md) |
| `mods/viz/` | `cmd-shift-a` opens the artifacts, `cmd-alt-a` annotates the one shown. Artifacts that agents publish beside their terminal, with the `herdr-viz` script in this folder: link it once with `ln -sf ~/.config/herdr-app/mods/viz/herdr-viz ~/.local/bin/herdr-viz` |
| `mods/config/` | `cmd-shift-m` / `ctrl-a M` / the tab-bar button: one dialog for every choice my mods read. Pages: Agents (which installed agents are offered), Writer (who writes commit summaries and branch names), Models (the model catalog: the newest publicly available model of each family, synced from models.dev once a day, and the models you star to list first into `models.json`, offered by the Launcher and the Writer), Worktrunk (worktrunk's own `~/.config/worktrunk/config.toml`: its commit writer, which can follow the Writer, where worktrees go, what `wt merge`, `wt remove` and `wt list` do), Lific (the Lific agent: who carries out Lific requests, with which model; and whether `lific mcp` answers), Mods (what each is wired to, and a switch that turns one off by moving it to `mods-disabled/`), Curtain (what the curtain takes off the window while it is drawn), Vaults (the Obsidian vaults added here with `a`, and the connected vault; `ctrl-a o` opens it in Obsidian, `ctrl-a Y` copies its path, `ctrl-a O` opens this page), Health (every requirement: the programs my mods run, such as `hc`, `git`, `nvim`, `wt`, `jq` and `lific`, found or missing with the way to get each; for Lific requests also an MCP handshake with `lific mcp` and the Lific agent's program; it also runs as Herdr starts and marks the tab-bar button when a needed one is missing). Terms: `GLOSSARY.md` |
| `mods/lific/` | `ctrl-a L`: the [lific](https://github.com/raphaelmans/lific) issues and pages (`tab`) of every project, read and edited in place: scroll, search, edit text, comment, rename, set status and priority, add issues or pages, hand one to the pane you came from. Issues are listed under a heading per status. `:` (or `cmd-shift-i` / `ctrl-a I` from anywhere) steps into the request box along the bottom for a Lific request: say what should be done in your own words ("new issue: the export button does nothing on Safari", "mark RAISE-12 done and say it shipped"), `cmd-enter` runs it. The Lific agent (Config → Lific) carries it out through Lific's MCP tools, in the project shown unless you name another, and the list then shows the issue it touched. Needs `~/.local/bin/lific` (the fork's build); requests also need an installed agent |
| `mods/lific-request/` | `cmd-shift-i` / `ctrl-a I`: the opener that takes you straight into the Lific window's request box (opening it if needed) |
| `mods/pull-requests/` | `ctrl-a P`: pull requests for a repository in a selected organization, read with `gh` on this computer as the account it is signed in as. The organizations are along the top (`1-9`, `[` and `]` choose one), the repositories on the left, and `l` steps into that repository's pull requests, most recently updated first (`f`: open, all, closed; `/` searches the list with the keys). `enter` hands the one shown to the pane you came from, `y` copies its link, `o` opens it, `r` reads everything on screen again. What was read last is shown at once, then checked. Needs `gh` |
| `mods-disabled/jira/` | `ctrl-a B`: a Jira project's board, read only, through `acli`: issues as cards in the board's columns (one column per status), opening on the active sprint and the issues assigned to the signed-in account (`a` shows everyone's; `s` opens a combobox of the sprints (active, coming, closed), the backlog as the top of the rank, and the latest 150 issues, with `/` to filter it), the selected issue beside it, hand one to the pane you came from, or `b` for its branch `<KEY>-<title words>`: create it (`git switch -c` in the repo of the pane you came from) or copy the name. Off by default: turn it on in Config → Mods |
| `MAINTENANCE.md`, `docs/baseline/` | The maintenance run: how to bring my mods back in line with a new Herdr and with this repo's current rules, and Herdr's reference files as of the last run. Only on request; agents skip it otherwise |
| `mods/auto-title/` | Names tabs automatically ([kryptamine/herdr-auto-title](https://github.com/kryptamine/herdr-auto-title)) |

In the Git graph, click a commit for inline details and Ctrl/Cmd-click another to compare. Local and remote segments of a reference badge have separate menus. Commit checkout detaches at the selected hash; merge cherry-pick and revert offer a parent choice. The uncommitted row offers stash, reset and clean. Existing branch/tag names offer replacement or another name, and remote checkout offers checkout and pull when the local name already exists. The details file tree/list opens file patches, with Escape returning to the graph. [Parity status](mods/git/PARITY.md#rea-evidence-and-parity-status) lists the remaining work and distinguishes live checks from scripted tests.

**Hidden** stays in the spaces sidebar on each machine, including when empty. Drag a space onto it, or Cmd-click/Shift-click spaces and right-click a picked row → **Move to Hidden**. It folds like any section. Its spaces stay accessible by clicking them in the sidebar; opening one does not restore it. To resume work, drag it out, choose **Remove from section** or another section from the picked-row menu, or right-click Hidden → **Restore all spaces**. Terminals keep running, and membership survives restarts. Each worktree has its own membership.

In my layout, Hidden spaces are excluded from Go to (both scopes), the Agent hub, the Agents sidebar (including pinned agents and children), agent totals and “needs you” counts, pane-move destinations, space/agent navigation and numbered shortcuts, and targeted notification toasts. Hidden spaces do not take a space shortcut number. Normal folded sections keep their usual behavior. Explicitly opening a Hidden space still lets you use its tabs and panes. Herdr's native sounds are global, so they cannot be muted for just this section; raw Herdr commands, other layouts and external services still see the underlying spaces.

Hidden's behavior checks run without changing the live window: `node --experimental-vm-modules --test mods/spaces-sections/hidden.test.js`.

## Restore on a new machine

```sh
git clone git@github.com:raphaelmans/herdr-app.git ~/.config/herdr-app   # before the first start of Herdr
# or, if Herdr already created the folder:
cd ~/.config/herdr-app && git init && git remote add origin git@github.com:raphaelmans/herdr-app.git \
  && git fetch && git checkout -f -t origin/main
herdr-app do layout.switch --name mine
```

Clone the toolchain standard beside it (`git clone git@github.com:raphaelmans/toolchain.git ~/toolchain`): it decides which installer owns each program and at which version, and `./health.sh` follows it. Then run `./health.sh`: it lists the programs still to install, and works before Herdr has started. Config (`cmd-shift-m`) shows the same on its Health page (`8`). What this setup is by default, and how to put any part back, is in `DEFAULTS.md`.

What Health looks for, in case the page cannot open. Needed ones stop a mod's main job; extras stop one feature. Each comes from one owner, as the toolchain standard sets it.

| Requirement | Used for | Needed | Get it |
|---|---|---|---|
| herdr-core (`hc`) | every terminal | yes | `curl -fsSL https://releases.herdr.dev/app/install.sh \| sh` |
| Git | the Git dialog, branches, worktrees | yes | `xcode-select --install` |
| GitHub CLI (`gh`) | the Pull requests window, existing pull requests from the Git mod | yes | `mise use --global gh@2` |
| Git-flow (`git-flow`) | starting and finishing Git-flow branches from the Git dialog | extra | `brew install gittower/tap/git-flow-next` |
| Neovim | the editor pane | yes | `mise use --global neovim@0.12` |
| Vim | Lazygit's fallback file/hunk editor in the Git mod | extra; only when selected or inferred | `/usr/bin/vim` on macOS; `os.editPreset` can select another installed editor |
| lific | issues and pages | yes | clone `raphaelmans/lific`, then `cd web && bun install --frozen-lockfile --ignore-scripts && bun run build && cd .. && cargo build --release --locked && ln -sf "$PWD/target/release/lific" ~/.local/bin/lific` |
| Skillshare | the Skillshare panel | yes | `mise use --global github:runkids/skillshare@latest` |
| mise | installing the ones it owns | extra | `curl https://mise.run \| sh` |
| Worktrunk (`wt`) | worktrees, the Worktrunk page | yes while the Worktrunk mod is on (on by default) | `mise use --global worktrunk@latest` |
| jq | model sync, reading each agent's settings, the Jira board once that mod is on | extra | `mise use --global jq@1` |
| curl | model sync, Auto Title's install | extra | comes with macOS |
| herdr-viz | publishing artifacts | extra | `ln -sf ~/.config/herdr-app/mods/viz/herdr-viz ~/.local/bin/herdr-viz` |
| Node | herdr-viz runs on it | extra | `mise use --global node@26` |
| Google Chrome | page previews in artifacts | extra | `brew install --cask google-chrome` |
| Auto Title service | naming tabs | extra | open Auto Title (`cmd-alt-t`): it installs its own copy |
| lazygit | upstream workflows from the native Git dialog (`L`), with its own config and custom commands | extra | `mise use --global lazygit@latest` |
| POSIX shell (`sh`) | bounded Git reads, patch application and rebase plans | yes | system `sh` on macOS/Linux; Git for Windows' `sh` on PATH |
| fd | listing files for Find a file (`cmd-o`) | yes | `mise use --global fd@10` |
| ripgrep (`rg`) | listing files for Find a file when fd is not here | extra | `mise use --global ripgrep@15` |
| Atlassian CLI (`acli`) | the Jira board, read only, once the Jira mod is on | extra | `brew tap atlassian/homebrew-acli && brew install acli` |
| Obsidian | opening the connected vault | extra | install from obsidian.md |

`mods/config/requirements.json` is the list Health reads, and each mod's `mod.json` says under `spec` which ones it needs; change this table with them.

Herdr regenerates `AGENTS.md`, `*.d.ts`, shipped mods and layouts by itself.
