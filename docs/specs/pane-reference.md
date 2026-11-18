# Spec: Copy reference

Status: built (`mods/pane-reference/`).

## Why

From one agent I often want to point at another live agent: "look at what t63 is doing", "ask t63 whether the migration ran". The Agent hub (`cmd-j`) can already message or pull, but both are heavier than needed when I only want the other agent's name in the box I'm typing in. Today the only way to get a terminal's address is `hc ls` or reading it off the hub.

**Copy reference** puts a short, self-explaining **reference** to a pane on the clipboard in one key, so I can paste it into any session, of any agent CLI, and that agent can read or message the pane itself with `hc`.

## Words

- **Address**: herdr-core's name for a terminal, e.g. `t63` (a terminal on another machine carries that machine's name, as `hc ls` prints it). It lives as long as the terminal does. _Avoid_: session ID, terminal ID, pane ID. A session is the conversation (GLOSSARY), not the terminal, and a session's own ID (Claude Code's, Codex's) is not what `hc` takes.
- **Reference**: text that points an agent at another terminal by its address, and says how to read and message it. Pasted, not sent. _Avoid_: link, handle, mention, pull (a pull brings output; a reference brings only the address).

## What gets copied

One block, the same for every agent CLI, built like the Agent hub's pull line so receivers learn one shape:

```
<herdr-ref to="t63" name="Fix login redirect" agent="claude-code" where="herdr-updates / 5" machine="Raphaels-MacBook-Pro-2" core="aef038bc82ce4d34bd94219945af04ef"/>
Another agent in Herdr on Raphaels-MacBook-Pro-2. Act only when asked. If hc server status --json shows core.id aef038bc82ce4d34bd94219945af04ef, set target=t63. Otherwise find that id in hc machine ls --json and set target=NAME/t63 using its name on your machine. If the core is unreachable, ask how to reach it. Read its screen with hc read "$target" --lines 400 · ask it with hc send "$target" '<herdr-message from="YOUR_ADDRESS">your question</herdr-message>' (your local address is $HC_TERMINAL_ID)
```

- `name`: the pane title with the same noise stripped as Copy pane title; omitted when empty.
- `agent`: `app` for an agent; for a shell or another program, its name (`zsh`), and the "ask it" part is dropped (there is nobody to answer), leaving only `hc read`.
- `where`: space name / tab badge, as the agent row's second line shows them.
- `machine` names the host, and `core` identifies its permanent herdr-core instance. Each recipient uses that ID to choose the address or machine alias valid on their own computer.
- Attribute values are escaped as in `mods/agent-hub/main.js` (`attr`).

The reference never contains screen output: that is a pull.

## Keys

| Where | Key | Copies |
|---|---|---|
| Anywhere (global, `keys.json`) | `cmd-shift-c` | reference to the focused pane |
| Prefix (`mods/tmux-prefix/main.js`) | `ctrl-a R` | reference to the focused pane |
| Prefix | `ctrl-a @` | the focused pane's bare address (`t63`), for typing into `hc` myself |
| Agent hub | `c` / `C` | reference / bare address of the selected agent; the hub stays open. Hinted in the sidebar's key line, not as a footer button: the footer has no room left |

`cmd-shift-c` and `ctrl-a R` / `@` are free today. Copy pane title stays on `ctrl-a y`.

The hub row is the "a pane I selected" case from the request: open the hub, move to the agent, `c`, close, paste. The global key covers "the pane I'm in": copy it here, switch to the other agent, paste.

## Behaviour

- No dialog, no window, no focus change: the keyboard stays where it was. A success toast confirms: title "Copied reference", body `t63 · Fix login redirect` (1.5 s, as Copy pane title).
- While the curtain is drawn, the toast body is the address only: no title, no agent name.
- A mod pane (no terminal, `PaneInfo.terminal === null`): nothing is copied; warning toast "This pane has no terminal".
- A full reference looks up the source core ID with `hc server status --json` for a local pane or `hc machine ls --json` for a remote pane. If the lookup fails, a warning explains why the reference could not be copied. Copy address uses the address already shown in Herdr.
- Hidden spaces: copying is explicit, so it works on a pane in a Hidden space like any other.

## Where it lives

A small own mod, `mods/pane-reference/` (`place: "none"`), sitting in my layout as a floating block of no size, like `tab-sequence`. `reference.js` builds the text (tested by `reference.test.js`); `main.js` takes three commands:

- `pane-reference.copy`: the focused pane's reference
- `pane-reference.copy-address`: its bare address
- `pane-reference.ask`: the pane named in shared `"pane-reference.ask"` `{ terminal, bare, n }`, honoured for 2 s after `n`. The Agent hub sets it and runs the command, since mods can't import each other's files and `nextCommand()` carries no arguments.

`tmux-prefix` and `keys.json` run the first two. Because the mod lives in my layout, the keys do nothing in Herdr's other layouts.

## Done when (CLAUDE.md's list)

1. `herdr-app check mods/pane-reference` passes; `herdr-app status | jq .errors` is `[]`.
2. `mod.json` spec: `{"needs": []}`.
3. `.gitignore` allowlists `!mods/pane-reference/`.
4. README row with its keys; prefix keys in `mods/tmux-prefix/main.js`; hub header comment lists `c` / `C`.
5. **Address** and **Reference** in `GLOSSARY.md`. No new choice, so `DEFAULTS.md` is untouched.
6. A node test for the builder: agent vs shell, empty title, quotes in a title, a remote address.

## Left out on purpose

- A **Copy reference** item in the pane's right-click menu: that menu is Herdr's shipped `menu` mod, which is never edited; it would need a clone set as the layout's `terminal_menu`.
- Sending the reference straight into another pane: that is the send box's job (`ctrl-a i`); paste it there if wanted.
- The agent CLI's own session ID (Claude Code's UUID): agent-specific, and `hc` can't use it. The address is agnostic of agent and provider.
- A picker of panes for the global key: the hub already is one.
