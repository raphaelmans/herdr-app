# herdr-app config

My config for the [Herdr](https://herdr.dev) desktop app. It lives at `~/.config/herdr-app`.
The Herdr TUI config is a separate repo: [raphaelmans/herdr](https://github.com/raphaelmans/herdr).

Herdr rewrites most of this folder on every start, so `.gitignore` is an allowlist:

| Path | What it is |
|---|---|
| `keys.json` | Key bindings (`ctrl-a` opens the tmux prefix) |
| `settings.json` | Zoom, sounds, fonts |
| `layouts/mine.json` | My layout, cloned from Herdr's `main`: the spaces sidebar with sections, the agents sidebar, my tab bar with its buttons (Stay awake, Config, Skillshare) and status bar. The only layout here that is mine; the others are Herdr's |
| `mods/tab-bar/`, `mods/status-bar/`, `mods/agents-titled/`, `mods/toasts/` | My layout's tab bar, status bar, agents sidebar and notifications: clones of Herdr's `tabs`, `workspace-status`, `agents` and `toast` that follow the curtain |
| `mods/curtain/` | `cmd-shift-h`: takes every sign of agents off the window while the screen is shared |
| `mods/go-to/` | `cmd-p` / `ctrl-a w`: Go to, a search over spaces, tabs and agents (cloned from Herdr's `picker`); `cmd-shift-a` inside it switches between this space and all spaces |
| `mods/workspace-navigation/` | The top of the spaces sidebar (search, fold) and its footer (Settings, Add machine), cloned from Herdr's `workspace-chrome`; its search opens Go to |
| `mods/tab-sequence/` | `ctrl-a r`: renumbers the tabs of the shown space to match their places |
| `mods/pane-move/` | `ctrl-a t` / `ctrl-a !`: moves the focused pane to another tab, or into a tab of its own |
| `mods/file-picker/`, `mods/md-popup/` | `cmd-o`: find a file below the terminal's folder and open it in a viewer; the markdown preview popup it (and nvim's `<leader>mp`) opens fills the available height with the same 18px top and bottom margins as Go to |
| `mods/lazygit/` | lazygit in a popup for the focused pane's folder. No key opens it: the Git dialog's `L` starts lazygit itself |
| `mods/stayawake/` | The coffee-cup tab-bar button: keeps the Mac awake, right-click for lid-closed too |
| `mods/skillshare/` | The Skillshare panel and its tab-bar button (vendored) |
| `mods/tmux-prefix/` | `ctrl-a` prefix popup with keys that match the Herdr TUI |
| `mods/launcher/`, `launcher.json` | `ctrl-a c` / `v` / `-` / `N`: new tab, split or space with a shell or any installed agent, optional skip-permissions flag, a model from the model catalog (`d`), reasoning level (`r`, or `ctrl-r` while typing) for Claude Code and Codex, a first message (`m`), and worktrunk worktree; choices saved in `launcher.json`. Copilot's first message follows `-i`, because a bare argument is a subcommand |
| `mods/copy-mode/` | tmux-style copy mode (`ctrl-a [`), vi keys over the terminal's scrollback |
| `mods/nvim-pane/` | Neovim in a pane beside the terminal: `cmd-e` / `ctrl-a e` shows or hides it, `cmd-shift-e` shows it and gives it the keyboard |
| `mods/pane-header/` | The layout's pane header; also records where each pane sits, for `send-box` |
| `mods/send-box/` | `ctrl-a i`: type a message and send it to another pane; opens with the cursor after any supplied text, including pulled output |
| `mods/agent-hub/` | `ctrl-a m`: every running agent in one window, with its recent screen; search the sidebar by title, program, space, tab or address (click the field or press `/`), with `a` to switch between this space and all spaces |
| `mods/agent-fork/` | `ctrl-a f`: choose an agent in the same Launcher palette. The current CLI forks natively (Claude Code and Codex); another opens in a right split and receives a context handover from the source through native `hc send`. The source stays open. The picker keeps the agent shortlist, model, reasoning, permission and optional message choices |
| `mods/spaces-sections/` | Spaces sidebar with named, foldable sections (cloned from Herdr's `spaces`), plus **Hidden** for work to pick up later |
| `mods/git/` | `cmd-g`: native Git with hunk/line staging, branch/remote/tag/worktree/submodule views, editable rebase plans, custom patches and commit splitting, cherry-pick, bisect, conflicts, reflog and history undo. Keeps Markdown/Mermaid previews. `m` opens actions; `[` / `]` change views; `L` opens upstream Lazygit in the same repo. [Coverage and keys](mods/git/PARITY.md) |
| `mods/viz/` | `cmd-shift-a` opens the artifacts, `cmd-alt-a` annotates the one shown. Artifacts that agents publish beside their terminal, with the `herdr-viz` script in this folder: link it once with `ln -sf ~/.config/herdr-app/mods/viz/herdr-viz ~/.local/bin/herdr-viz` |
| `mods/config/` | `cmd-shift-m` / `ctrl-a M` / the tab-bar button: one dialog for every choice my mods read. Pages: Agents (which installed agents are offered), Writer (who writes commit summaries and branch names), Models (the model catalog: the newest publicly available model of each family, synced from models.dev once a day, and the models you star to list first into `models.json`, offered by the Launcher and the Writer), Worktrunk (worktrunk's own `~/.config/worktrunk/config.toml`: its commit writer, which can follow the Writer, where worktrees go, what `wt merge`, `wt remove` and `wt list` do), Mods (what each is wired to, and a switch that turns one off by moving it to `mods-disabled/`), Curtain (what the curtain takes off the window while it is drawn), Vaults (the Obsidian vaults added here with `a`, and the connected vault; `ctrl-a o` opens it in Obsidian, `ctrl-a Y` copies its path, `ctrl-a O` opens this page), Health (every requirement: the programs my mods run, such as `hc`, `git`, `nvim`, `wt`, `jq` and `lific`, found or missing with the way to get each; it also runs as Herdr starts and marks the tab-bar button when a needed one is missing). Terms: `GLOSSARY.md` |
| `mods/lific/` | `ctrl-a L`: the [lific](https://github.com/raphaelmans/lific) issues and pages (`tab`) of every project, read and edited in place: scroll, search, edit text, comment, rename, set status and priority, add issues or pages, hand one to the pane you came from. Needs `~/.local/bin/lific` (the fork's build) |
| `mods/prs/` | `ctrl-a P`: pull requests for a repository in a selected organization, read with `gh` on this computer. The account's organizations are along the top; `1-9`, `[` and `]` choose one; the repositories are on the left and `l` steps into that repository's pull requests. Its own spec needs `gh`. The Git dialog and lazygit do not |
| `mods-disabled/jira/` | `ctrl-a B`: a Jira project's board, read only, through `acli`: issues as cards in the board's columns (one column per status), opening on the active sprint and the issues assigned to the signed-in account (`a` shows everyone's; `s` opens a combobox of the sprints (active, coming, closed), the backlog as the top of the rank, and the latest 150 issues, with `/` to filter it), the selected issue beside it, hand one to the pane you came from, or `b` for its branch `<KEY>-<title words>`: create it (`git switch -c` in the repo of the pane you came from) or copy the name. Off by default: turn it on in Config → Mods |
| `MAINTENANCE.md`, `docs/baseline/` | The maintenance run: how to bring my mods back in line with a new Herdr and with this repo's current rules, and Herdr's reference files as of the last run. Only on request; agents skip it otherwise |
| `mods/auto-title/` | Names tabs automatically ([kryptamine/herdr-auto-title](https://github.com/kryptamine/herdr-auto-title)) |

**Hidden** stays in the spaces sidebar on each machine, including when empty. Drag a space onto it, or Cmd-click/Shift-click spaces and right-click a picked row → **Move to Hidden**. It folds like any section. Its spaces stay accessible by clicking them in the sidebar; opening one does not restore it. To resume work, drag it out, choose **Remove from section** or another section from the picked-row menu, or right-click Hidden → **Restore all spaces**. Terminals keep running, and membership survives restarts. Each worktree has its own membership.

In my layout, Hidden spaces are excluded from Go to (both scopes), the Agent hub, the Agents sidebar (including pinned agents and children), agent totals and “needs you” counts, pane-move destinations, space/agent navigation and numbered shortcuts, and targeted notification toasts. Hidden spaces do not take a space shortcut number. Normal folded sections keep their usual behavior. Explicitly opening a Hidden space still lets you use its tabs and panes. Herdr's native sounds are global, so they cannot be muted for just this section; raw Herdr commands, other layouts and external services still see the underlying spaces.

Hidden's behavior checks run without changing the live window: `node --experimental-vm-modules --test mods/spaces-sections/hidden.test.js`.

## Cursor in the Agents list

Herdr adds a terminal to the Agents list only after that program reports its own status. Claude Code and Codex do this themselves. Cursor's `agent` CLI, and `cursor` when it starts the agent, runs as Node and never reports one, so a session that is plainly Cursor stays out of the Agents sidebar and the status bar keeps saying "0 agents".

The Herdr TUI's Cursor integration (`herdr integration install cursor`) reports to the TUI. This desktop app only sets `HC_TERMINAL_ID` on the pane, so that integration never reaches it.

`hooks/herdr-app-status.sh` is the bridge, installed as a Cursor user hook. It writes the status onto the Herdr pane: idle when a session starts, working when a message is sent, idle when the turn ends, and cleared when the session ends. Outside a Herdr pane it does nothing, so the same hook stays quiet in an ordinary terminal.

## Restore on a new machine

```sh
git clone git@github.com:raphaelmans/herdr-app.git ~/.config/herdr-app   # before the first start of Herdr
# or, if Herdr already created the folder:
cd ~/.config/herdr-app && git init && git remote add origin git@github.com:raphaelmans/herdr-app.git \
  && git fetch && git checkout -f -t origin/main
herdr-app do layout.switch --name mine
mkdir -p ~/.cursor/hooks
ln -sf ~/.config/herdr-app/hooks/herdr-app-status.sh ~/.cursor/hooks/herdr-app-status.sh
```

`~/.cursor/hooks.json` holds the four commands. On a machine that already has that file, add them under `hooks` and leave the rest. A new file is:

```json
{
  "version": 1,
  "hooks": {
    "sessionStart": [{ "command": "./hooks/herdr-app-status.sh idle" }],
    "beforeSubmitPrompt": [{ "command": "./hooks/herdr-app-status.sh working continue" }],
    "stop": [{ "command": "./hooks/herdr-app-status.sh idle" }],
    "sessionEnd": [{ "command": "./hooks/herdr-app-status.sh clear" }]
  }
}
```

A Cursor session that is already open keeps the status it last reported. Cursor reads the hook when it starts a session.

Clone the toolchain standard beside it (`git clone git@github.com:raphaelmans/toolchain.git ~/toolchain`): it decides which installer owns each program and at which version, and `./health.sh` follows it. Then run `./health.sh`: it lists the programs still to install, and works before Herdr has started. Config (`cmd-shift-m`) shows the same on its Health page (`8`). What this setup is by default, and how to put any part back, is in `DEFAULTS.md`.

What Health looks for, in case the page cannot open. Needed ones stop a mod's main job; extras stop one feature. Each comes from one owner, as the toolchain standard sets it.

| Requirement | Used for | Needed | Get it |
|---|---|---|---|
| herdr-core (`hc`) | every terminal | yes | `curl -fsSL https://releases.herdr.dev/app/install.sh \| sh` |
| Git | the Git dialog, branches, worktrees | yes | `xcode-select --install` |
| Neovim | the editor pane | yes | `mise use --global neovim@0.12` |
| lific | issues and pages | yes | clone `raphaelmans/lific`, then `cd web && bun install --frozen-lockfile --ignore-scripts && bun run build && cd .. && cargo build --release --locked && ln -sf "$PWD/target/release/lific" ~/.local/bin/lific` |
| Skillshare | the Skillshare panel | yes | `mise use --global github:runkids/skillshare@latest` |
| mise | installing the ones it owns | extra | `curl https://mise.run \| sh` |
| Worktrunk (`wt`) | worktrees, the Worktrunk page | extra | `mise use --global worktrunk@latest` |
| jq | model sync, reading each agent's settings, the Jira board | yes | `mise use --global jq@1` |
| curl | model sync, Auto Title's install | extra | comes with macOS |
| herdr-viz | publishing artifacts | extra | `ln -sf ~/.config/herdr-app/mods/viz/herdr-viz ~/.local/bin/herdr-viz` |
| Node | herdr-viz runs on it | extra | `mise use --global node@26` |
| Google Chrome | page previews in artifacts | extra | `brew install --cask google-chrome` |
| Auto Title service | naming tabs | extra | open Auto Title (`cmd-alt-t`): it installs its own copy |
| lazygit | upstream workflows from the native Git dialog (`L`), with its own config and custom commands | extra | `mise use --global lazygit@latest` |
| GitHub CLI (`gh`) | organizations, repositories and pull requests on this computer | yes | `mise use --global gh@2` |
| POSIX shell (`sh`) | bounded Git reads, patch application and rebase plans | yes | system `sh` on macOS/Linux; Git for Windows' `sh` on PATH |
| fd | listing files for Find a file (`cmd-o`) | yes | `mise use --global fd@10` |
| ripgrep (`rg`) | listing files for Find a file when fd is not here | extra | `mise use --global ripgrep@15` |
| Atlassian CLI (`acli`) | the Jira board, read only | yes | `brew tap atlassian/homebrew-acli && brew install acli` |
| Obsidian | opening the connected vault | extra | install from obsidian.md |

`mods/config/requirements.json` is the list Health reads, and each mod's `mod.json` says under `spec` which ones it needs; change this table with them.

Herdr regenerates `AGENTS.md`, `*.d.ts`, shipped mods and layouts by itself.
