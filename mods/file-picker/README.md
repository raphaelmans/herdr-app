# Native file picker

Cmd+O lists files below the focused terminal's working directory in navigation mode.
Enter or `l` opens Markdown in a new preview pane; press `e` in that pane to
replace it with Neovim editing the same file. Other files open in Neovim.
`p` offers a quick preview without leaving the picker (a popup for Markdown).
Markdown previews use `md-popup`. Clicking a row selects it.

- Hidden files **on**, ignored files **off**, matching this user's Snacks settings.
- Hidden searches recurse into hidden directories. Hidden and ignored are independent
  toggles. `.git` internals are always excluded; directory symlinks are not followed.
- Uses `fd`, `fdfind`, then `rg`. These honor `.gitignore`, `.ignore`, and their normal
  tool-specific ignore rules. Refresh rescans; typing never starts a directory walk.
- Fuzzy matching with smart case, space-separated AND terms, `'exact`, `!exclude`,
  `^prefix`, and `suffix$`. This is not Snacks' full query language or exact ranking.
- Matching, indexing, and sorting yield in small batches; new input cancels stale
  matching. Rapid toggle changes serialize scans and discard outdated results.
- All results are accessible through a virtual list; only visible rows are rendered.
  Content loads on demand.
- Opens in navigation (NORMAL) mode. `/` or `i` enters search (INSERT) mode.
  Escape leaves the search field and keeps the query.
  NORMAL mode: `j/k` move, `g`/`gg` and `G` jump first/last, `Ctrl+D/U` move half
  a page, `l`/Enter opens the file, `p` previews, `h` returns to files.
  Enter uses the same behavior while searching; plain `p` is typed into the search field.
  `H` toggles hidden, `I` toggles ignored, `R` refreshes, `e` opens Neovim, and
  `y` copies the relative path; `Y` (Shift+Y) copies the absolute path using the
  directory captured when the picker opened. `?` shows help; `q` closes. Escape steps out of
  help or a text preview before closing. The preview's motions move its caret.
  Ctrl+N/P, Ctrl+J/K and arrows navigate while the search input has focus.
  Bindings are scoped to this mod; terminal keys and text insertion stay separate.
- Herdr's `exec` returns buffered output, capped at 8 MiB. Enumeration is therefore
  not streamed like Snacks. A scan times out after 15 seconds. Output-limit errors
  or detected truncation are shown; use a narrower cwd for very large trees.
- No background daemon or persistent index. Closing cancels search publication;
  an already-started finder can run until it exits or reaches its timeout.
