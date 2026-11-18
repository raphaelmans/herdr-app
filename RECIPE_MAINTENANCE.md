# Recipe maintenance

Every own mod that works with an agent CLI has to know something about that one CLI: how to ask it for a single answer, how to fork its session, which flag takes a model. That knowledge is a **recipe** (`GLOSSARY.md`). Agent CLIs keep arriving and keep changing their flags, so recipes fall behind in two ways: an installed agent has no recipe for a flow, or an old recipe no longer works with the CLI's current version.

This file is how we catch up. It has three parts:

- **The recipe map**: every place a recipe lives, and what a recipe there has to do.
- **The coverage table**: which agent has a recipe for which flow, as of the last run.
- **The run**: how to fill the gaps and check the recipes that already exist.

## When to use this file

- **Adding or changing a recipe**, or adding a flow that needs per-agent knowledge: update the map and the coverage table in the same change. A table that leaves out a flow lets every later run miss it.
- **A recipe maintenance run**: only when the person asks for one by name. It touches many mods and runs every agent CLI, so it is not something to start in the middle of other work.

Recipes must stay agnostic of agent and provider (`CLAUDE.md`). A flow that can't work for an agent says so in the UI ("no recipe yet"); it doesn't hide the agent (ADR 0002).

## The recipe map

Recipes are keyed by **Herdr's agent key** (`knownAgents()`'s `key`, such as `claude`, `codex`, `opencode`, `cursor`, `grok`), never by the binary's name.

| Flow | Where | What a recipe must do | Feeds |
|---|---|---|---|
| **Writer** | `mods/config/writer.js`, `RECIPES` | A one-shot command: prompt on stdin, only the answer on stdout, well inside the Writer's 90 s limit. No tools, no slash commands, no saved session, no colour. `command(model)` adds the model flag only when a model is given; an empty model means the agent's default. `name`, a default `model`, suggested `models`, and a `hint` when the model id is shaped differently (`provider/model`). | Launcher branch names, `agents-titled` titles, worktrunk's commit writer (when it follows the Writer, `mods/config/worktrunk.js`), Health (it requires the Writer's program) |
| **Lific agent** | `mods/config/lific.js`, `RECIPES` (Grok uses `mods/lific/session/grok-agent.md`, OpenCode uses `mods/lific/session/opencode.sh` and `opencode-status.js`) | An interactive session that has only Lific's MCP server (`~/.local/bin/lific mcp`, stdio) and nothing else: no shell, no files, no other MCP. It starts with `mods/lific/session/` as its system prompt and skill. The MCP server is named in the command itself (ADR 0008, ADR 0014). Codex needs `default_tools_approval_mode="approve"` and a read-only sandbox. Grok takes MCP servers only from a file, and its tools are `search_tool,use_tool` with `--permission-mode dontAsk --allow 'MCPTool(lific__*)'`. | The Lific session |
| **Fork** | `mods/agent-fork/session.js`: `supportsFork()` and `nativePlan()` | Find the running session from the pane's process (its pid, the files it has open, the CLI's own session record), then start a copy of it in the right split, with the source's model and options. If the session id can't be found, fall back to the CLI's "continue the latest" and mark the result as guessed. | Fork; the Launcher's "native fork / no fork recipe" mark |
| **Model catalog** | `mods/config/models.js`, `CATALOGS` | Either `providers` (models.dev provider ids, plus `prefixed` and `families` when needed) or `list`, a command that prints the agent's own models for the signed-in account. | Config → Models, every model picker |
| **Model flag** | `mods/launcher/main.js`, `MODEL_FLAG` | The flag that comes before a model id when an agent is started. | Launcher, model picker |
| **Reasoning flag** | `mods/launcher/main.js`, `REASONING_FLAG` | The argv that sets a reasoning level (`{value}` is replaced by the level). The levels themselves come from the catalog, not from here. | Launcher `r` |
| **Agent's own model** | `mods/launcher/main.js`, `OWN` | A shell line that prints `<key><tab><model>` read from the agent's own settings file, or nothing after the tab. | Launcher's "default model" label |
| **Skip-permissions flag** | `mods/launcher/main.js`, `SKIP_FLAG` (a `flag` in `launcher.json` wins) | The flag that starts the agent without asking for approvals. One from `SKIP_FLAG` starts unticked. | Launcher `space` |
| **Pane model label** | `mods/pane-header/model.js`, `SAID` (and the generic `ID`) | A pattern that matches only the CLI's own UI lines: its banner, its `/model` switch, its status bar. Never conversation text. | The pane header's model label |

**Fallbacks, not recipes.** `DEFAULTS.title.command` in `mods/launcher/main.js` and `WRITER` in `mods/agents-titled/main.js` hard-code Claude Code. They run only until the Writer has a choice. Leave them as they are; don't copy them per agent.

## Coverage table

Last run 2026-11-17, against claude 2.1.326, codex 0.169.0, opencode 1.18.25, cursor-agent 2026.11.11 and grok 1.0.77 (the agents installed here). ✓ means there is a recipe, — means none yet, and ✗ means the CLI can't do it (the reason is in the notes).

| Flow | claude | codex | opencode | cursor | grok | gemini | copilot | pi |
|---|---|---|---|---|---|---|---|---|
| Writer | ✓ | ✓ | ✓ | ✓¹ | ✓² | — | — | — |
| Lific agent | ✓ | ✓ | ✓¹⁰ | ✗³ | ✓² | — | — | — |
| Fork | ✓ | ✓ | ✓⁴ | ✗⁵ | ✓ | — | — | — |
| Model catalog | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| Model flag | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Reasoning flag | ✓ | ✓ | ✗⁶ | ✗⁷ | ✓ | — | — | — |
| Agent's own model | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| Skip-permissions flag | ✓ | ✓ | ✓ | ✓ | ✓ | — | — | — |
| Pane model label | ✓ | ✓ | ✓⁸ | — | ✓ | ✓ | — | — |

Notes:

1. Cursor's tools can't be removed, so the Writer runs it in ask mode (read-only). Its `auto` model took up to 2½ minutes for a one-word reply, so the recipe names `composer-2.5` (11–47 s). Cursor saves the chat.
2. Grok also loads Claude Code's and Cursor's MCP servers, hooks, skills, rules and agents, and runs those hooks, even for a one-shot reply. `GROK_OWN` in `mods/config/writer.js` switches all of them off (this took the Writer from 60–140 s down to 22–45 s). Claude Code plugins still load; Grok has no switch for them. In the Lific session their tools are refused by `dontAsk`. Grok saves the session; it has no flag that skips that.
3. Cursor takes MCP servers only from `mcp.json` files, and every server set up in `~/.cursor/mcp.json` loads with them. Denying `Mcp(*:*)` also blocks Lific (deny beats allow), so the session can't be kept to Lific's tools (ADR 0008).
4. OpenCode keeps no pid per session: the fork takes the latest session in the pane's folder, by id, and is reported as guessed. Its task goes in `--prompt`, because its positional argument is a folder.
5. Cursor can resume a chat but has no way to copy one.
6. OpenCode's TUI has no reasoning flag; only `opencode run --variant` has one.
7. Cursor's effort is part of the model id (`model[effort=high]`), not a flag.
8. OpenCode shows `provider/model` ids, which the generic `ID` pattern catches. Cursor shows a display name ("Grok 4.7 Low Fast") with no pane open here to copy a line from.
9. gemini, copilot and pi are not installed here. Fill their columns when one is installed, or when the person asks.
10. Checked 2026-11-18 with OpenCode 1.18.25. Its Lific profile requires `jq`. It isolates personal settings, checks the effective MCP and tool permissions at startup, and loads one local hook to report readiness, blocked prompts and turn completion to Herdr. The Lific MCP keeps its usual configuration directory.

## The run

Do one flow at a time, and finish each flow before you start the next.

1. **Scope.** The agents in scope are the installed agents on the person's machines plus anything on the agent shortlist. Config → Agents shows them; in a shell, `zsh -lic 'command -v <bin>'` checks one binary. Record each CLI's `--version` in the coverage table's heading. If it is unclear whether an agent is wanted, ask once instead of guessing.
2. **Check the recipes that exist.** For each ✓, read the CLI's current `--help` (or its changelog since the version recorded above) for the flags the recipe uses. A renamed or removed flag is a broken recipe: fix it first.
3. **Fill the gaps.** For each — in scope, find in the CLI's own help and docs how it does what the map's "must do" column asks, and write the recipe next to the others, in the same shape. If the CLI really can't do it (for example, it has no non-interactive mode, or no way to name a session), mark it ✗ with the reason. A CLI that can do only part of it doesn't get a recipe that quietly does less: say what is missing and leave it —.
4. **Verify each recipe outside the window** (`CLAUDE.md`: no dialogs or keystrokes in the live window):
   - Writer: `printf '%s' "<the SAMPLE in writer.js>" | <command>` prints a single branch name, with nothing around it, and creates no session file.
   - Lific agent: start the command in a scratch terminal with `hc` (not in the person's tabs) and ask it to list projects. It must be able to use Lific's tools and nothing else. Then end it.
   - Fork: `node --experimental-vm-modules --test mods/agent-fork/session.test.js`, with a test for the new agent's plan. For a real fork, ask the person first, since it opens a split in their window.
   - Model catalog: run its `list` command, or check that models.dev has its providers. A sync is Config → Models `s`; ask before opening it.
   - Launcher flags: `node tests/launcher-reasoning.mjs`, and run the start argv by hand once (`<bin> <model flag> <model> --help` is enough to show that the flag parses).
   - Pane model label: paste a real banner or status line from the CLI into a quick `node -e` check against `SAID`.
5. **Finish.** Run `herdr-app check` on every mod you touched, and `herdr-app status | jq .errors` must print `[]`. Update the coverage table and its date. If a recipe adds a program, add it to `mods/config/requirements.json` and to the README's requirement table (ADR 0003). Report which recipes you added, fixed or marked ✗, and say which were verified only by script and which in the live window.
