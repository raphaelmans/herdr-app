# herdr-app config

My config for the [Herdr](https://herdr.dev) desktop app. It lives at `~/.config/herdr-app`.
The Herdr TUI config is a separate repo: [raphaelmans/herdr](https://github.com/raphaelmans/herdr).

Herdr rewrites most of this folder on every start, so `.gitignore` is an allowlist:

| Path | What it is |
|---|---|
| `keys.json` | Key bindings (`ctrl-a` opens the tmux prefix) |
| `settings.json` | Zoom, sounds, fonts |
| `layouts/main-copy.json` | My layout, cloned from Herdr's `main` |
| `mods/tmux-prefix/` | `ctrl-a` prefix popup with keys that match the Herdr TUI |
| `mods/copy-mode/` | tmux-style copy mode (`ctrl-a [`), vi keys over the terminal's scrollback |
| `mods/herdr-nvim/`, `mods/herdr-nvim-header/` | Neovim pane and file tree |

## Restore on a new machine

```sh
git clone git@github.com:raphaelmans/herdr-app.git ~/.config/herdr-app   # before the first start of Herdr
# or, if Herdr already created the folder:
cd ~/.config/herdr-app && git init && git remote add origin git@github.com:raphaelmans/herdr-app.git \
  && git fetch && git checkout -f -t origin/main
herdr-app do layout.switch --name main-copy
```

Herdr regenerates `AGENTS.md`, `*.d.ts`, shipped mods and layouts by itself.
