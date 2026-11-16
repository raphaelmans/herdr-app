# Defaults

What this setup is when nothing has been changed on a machine, and how to put each part back. Written for an agent asked to "reset to defaults". Terms: `GLOSSARY.md`.

Reset only the part you were asked about. Nothing here deletes spaces, tabs, terminals or notes.

## 1. Files that git holds

`keys.json`, `settings.json`, `launcher.json`, `layouts/mine.json`, every tracked mod under `mods/`, `health.sh`.

Their default is the committed version:

```sh
cd ~/.config/herdr-app
git status --short            # what differs from the default
git diff -- keys.json         # look before discarding
git checkout -- keys.json     # one file back to its default
```

Never run `git checkout -- .` or `git clean`: most of this folder is Herdr's own and untracked on purpose.

The Launcher's reasoning choice lives in `launcher.json` under `programs.<agent>.reasoning.<model id>`. It defaults to absent (the agent's own effort). Set it with the Launcher's Reasoning buttons or `r` (`ctrl-r` while typing); choose Default to remove the launch override. Each agent and model remembers its own choice.

## 2. Mods on and off

Off means the folder is in `mods-disabled/<name>`; on means it is in `mods/<name>`.

| Default | Mods |
|---|---|
| Off | `jira` |
| On | every other own and vendored mod |

To put one back: `mv mods/jira mods-disabled/jira` (off), or the reverse (on). Config → Mods does the same with a switch. Shipped mods have no switch; Herdr restores them on every start.

## 3. Layout

Default: `mine` (my layout).

```sh
herdr-app do layout.switch --name mine
```

## 4. Choices

These live in `shared.json`, which git does not hold. "Absent" means the key is not set, which is what a new machine has. Default is what the reset below writes; where a mod treats an absent key differently, the row says so.

| Choice | Key | Default | Set on |
|---|---|---|---|
| Agent shortlist | `agents.shortlist` | `["claude","codex"]` (absent: every installed agent) | Config → Agents |
| Writer | `writer` | Claude Code with `claude-haiku-5-5`; Codex's model `gpt-6-luna` | Config → Writer |
| Starred models | `models.starred` | claude: `claude-opus-5-5`, `claude-fable-5-2`; codex: `gpt-6.1-sol`, `gpt-6-astra` | Config → Models |
| Worktrunk follows the Writer | `worktrunk.follows` | `true` (absent: not following) | Config → Worktrunk |
| Curtain | `curtain` | lifted (`on: false`) | Config → Curtain |
| Vaults | `vaults` | none | Config → Vaults |
| Connected vault | `vault` | none | Config → Vaults |
| Sections | `spaces.sections` | no named sections; an empty Hidden section per machine | the spaces sidebar |
| Space colors | `space.colors` | none (same reason) | the spaces sidebar |
| Files and Changes panels | `workspace.panels` | `[]` (both closed; absent: both offered) | the tab bar |
| Agents sidebar order | `agents.sort` | absent (`priority`) | the Agents sidebar's menu |

The Config page is the safe way to change one: it also updates what depends on it (the Writer's command, worktrunk's own file).

Hidden is available without saved state. Using it stores a section with `hidden: true`, its members and fold state in `spaces.sections`; other own mods read that membership directly. Ordinary sections have no `hidden` flag and keep their current behavior. Removing a space from Hidden restores it immediately; an empty Hidden section stays available. Resetting sections restores all their members to the other features.

To set them all at once, quit Herdr first. While it runs it writes `shared.json` itself and the edit is lost.

```sh
cd ~/.config/herdr-app && cp shared.json shared.json.before-reset && jq '
  .["agents.shortlist"] = ["claude","codex"]
  | .["models.starred"] = {"claude":["claude-opus-5-5","claude-fable-5-2"],"codex":["gpt-6.1-sol","gpt-6-astra"]}
  | .["worktrunk.follows"] = true
  | .["workspace.panels"] = []
  | del(.writer, .curtain, .vault, .vaults, .["spaces.sections"], .["space.colors"])
' shared.json.before-reset > shared.json
```

`writer` is deleted rather than written: on the next start Config settles it to Claude Code with `claude-haiku-5-5`, and builds the command for this machine. Check it on Config → Writer afterwards.

Not choices, so leave them alone: `layout`, `health`, `config.page`, `agents.order`, `models.synced`, `pane-geo`, and anything starting `viz.`, `send-box.`, `skillshare.`, `win98.` or `frame.`. The mods rewrite these as they run.

## 5. Each mod's own memory

`data/<mod>/store*.json` holds what one mod remembers (Lific's project per space, the Jira board's filter and scope). The default is no file:

```sh
rm -rf ~/.config/herdr-app/data/jira     # that mod starts fresh the next time it opens
```

## 6. Requirements

`./health.sh` lists every program the mods need, where each was found, and the command for one that is missing. It exits 1 when a needed one is missing. The list is in `mods/config/requirements.json`; which mod needs what is in each mod's `mod.json` under `spec`.

Which installer owns a program, and at which version, is decided in the toolchain standard (`git@github.com:raphaelmans/toolchain.git`, cloned to `~/toolchain`), not here. `./health.sh` reads its catalog when it is there. To change an owner or a pin, change it in that repo; `requirements.json` only keeps a copy for a machine without it, and `./health.sh` prints `drift` when the copy is behind.

## After a reset

```sh
./health.sh                         # requirements
herdr-app status | jq .errors       # must be []
```
