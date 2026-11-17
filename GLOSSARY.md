# Herdr app config

One person's setup of the Herdr desktop app: the mods, layout and keys added on top of what Herdr ships. Herdr's own words (space, tab, pane, terminal, agent, layout, overlay) keep the meanings in `AGENTS.md`; artifacts have their own glossary in `mods/viz/CONTEXT.md`.

## Language

### Mods and where they come from

**Mod**:
A small program that draws part of the Herdr app's window or acts on it.
_Avoid_: plugin, extension, panel (for the program itself)

**Plugin**:
An extension of the Herdr TUI, the separate terminal program. Nothing in this folder is a plugin, though a mod can be the app's version of one.
_Avoid_: mod (for a TUI extension)

**Shipped mod**:
A mod that comes with Herdr, which Herdr puts back as it was on every start.
_Avoid_: default mod, built-in, core mod

**Vendored mod**:
A mod written by someone else and copied in as it is. Changes to it belong with its author, not here.
_Avoid_: upstream, third-party, ours

**Own mod**:
A mod written here, or a clone. Own and vendored mods can be turned off; shipped mods cannot.
_Avoid_: custom mod, personal mod, local mod

**Clone**:
A copy of a shipped mod or layout that is ours to change and no longer follows Herdr's updates. A cloned mod is an own mod.
_Avoid_: fork (that is for sessions), copy, override

**Off**:
The state of a mod that is set aside so Herdr does not load it, with nothing deleted.
_Avoid_: disabled, uninstalled, removed

**Wiring**:
Everything that reaches a mod: the keys bound to it, the layouts that show it and the mods that open it.
_Avoid_: usage, references, dependencies

### Keeping up with Herdr

**Maintenance run**:
One sitting, asked for by the person, in which every own mod is compared with the Herdr now installed and with this setup's current rules, and what fell behind is reported and fixed. `MAINTENANCE.md` is its procedure.
_Avoid_: sync, audit, upgrade, health check (Health is about requirements)

**Herdr baseline**:
Herdr's own reference files as they were at the end of the last maintenance run, kept so the next run can see what Herdr changed since.
_Avoid_: snapshot, core, upstream copy, cache

### Changing how things work

**Config**:
The one dialog where every choice this setup's mods read is made. No mod has a dialog of its own for its choices.
_Avoid_: settings (Herdr's own screen), preferences, Writer dialog, Mods dialog

**Page**:
One subject inside Config, such as Agents, Writer, Models or Mods.
_Avoid_: tab, section, panel

**Requirement**:
A program or app outside this folder that a mod runs. A needed one stops its mod's main job when it is missing; an extra one stops a single feature.
_Avoid_: dependency, plugin, toolchain, prerequisite

**Mod spec**:
What a mod states about itself in its `mod.json`: the requirements it needs and the ones that are extras for it. Health reads every spec; nothing lists a mod's needs for it.
_Avoid_: plugin spec, manifest, dependencies

**Default**:
What a part of this setup is on a machine where nothing has been changed, as `DEFAULTS.md` records it.
_Avoid_: factory setting, preset, starred or shortlisted (those are choices)

**Owner**:
The one installer a requirement comes from, as the toolchain standard sets it: mise, the system, the program's own installer, or built here. The standard is the `raphaelmans/toolchain` repo's catalog; Health reads it when it is on this computer. A program that works but was not installed by its owner is off its route.
_Avoid_: source, provider (that is for models), package manager, backend

**Health**:
The page of Config that looks for every requirement on this computer, lists what is missing and gives the way to get it. It also runs as Herdr starts, and from a shell as `./health.sh`.
_Avoid_: checker, doctor, checkhealth, diagnostics

**Vim motions**:
The keys every mod takes for moving without the mouse: j and k down and up, h and l across, g and G to the first and last, and / to search where a list is long.
_Avoid_: vim keys, vi mode, keyboard shortcuts

**Focused component**:
The part of a mod you have stepped into, which takes the keys until you step back out of it: a text field, a search, a panel's main view, an opened commit.
_Avoid_: typing, insert mode, focus (alone: that is Herdr's word for the pane that has the keyboard)

**Step back**:
What Escape does in every mod: it leaves the focused component you stepped into last, and nothing more. What was typed there stays. Only with no focused component left does Escape close the mod's window.
_Avoid_: cancel, dismiss, close (for Escape in general)

**Text box**:
A field for writing text that is sent or saved, longer than a name or a search: a first message, a message in the send box, a comment, an annotation. Enter and Shift+Enter start a new line in it; only Cmd+Enter sends or saves. A short field (a name, a branch, a search) keeps Enter.
_Avoid_: textarea, input, prompt (Herdr's naming dialog), editor

### Waiting and reading

**Waiting indicator**:
The turning spinner and the words for what is being waited for ("Reading worktrees"), drawn where the result will land.
_Avoid_: loading, busy text, progress bar

**Typing pause**:
How long a search or suggestion list waits after the last key before it runs. What was on screen stays meanwhile.
_Avoid_: debounce (in labels and docs), delay, lag

**Settle**:
A selection coming to rest long enough for its detail to be read. A selection passed over on the way is never read.
_Avoid_: hover, debounce, idle

**Kept read**:
What a mod read from a program and holds on to, so showing it again needs no new read until it is old or `r` is pressed.
_Avoid_: cache (in labels), snapshot, memo

**Overtaken read**:
A read whose answer is no longer wanted because the selection, folder or window moved on before it came back. It is dropped without a trace.
_Avoid_: stale read, cancelled read, race

**Combo box**:
A field that filters a popup of choices under it, for a list too long to show inline, such as worktrees or sprints.
_Avoid_: dropdown, select, picker (Herdr's space picker), autocomplete

### Starting things

**Prefix**:
The key pressed before a second key to run one of the tmux-style actions.
_Avoid_: leader, tmux prefix, ctrl-a (as a name)

**Launcher**:
The dialog that starts a new tab, split or space with a chosen program.
_Avoid_: new menu (Herdr's + menu), picker (Herdr's space picker)

**Go to**:
The search popup that jumps to a space, tab or agent.
_Avoid_: picker (Herdr's space picker, which it is cloned from), switcher

**Opener**:
The unseen first step of a mod that a key opens, which puts the mod's real window or pane in place and then goes away.
_Avoid_: launcher, trampoline, toggle

**Skip-permissions flag**:
The option that starts an agent without it asking before each action.
_Avoid_: yolo, bypass, dangerous mode

**First message**:
What the person gives an agent as it starts from the Launcher, so it begins working at once: text, attached files, or both. It is optional, and a plain terminal takes none.
_Avoid_: message (alone: that is between agents), task, prompt, initial prompt

**Attached file**:
A file on this computer that goes with the first message, so the agent can open it. An image copied to the clipboard becomes a file when attached.
_Avoid_: attachment, upload, file input, pasted image

**Worktree**:
A second checkout of a repo on its own branch, opened as a tab or a space.
_Avoid_: checkout (for the concept), worktrunk (that is the tool that makes one)

**Worktrunk**:
The tool (`wt`) that makes worktrees and merges them. Its settings live in its own file, which the Worktrunk page of Config changes.
_Avoid_: worktree (for the tool), wt config

**Tab-bar button**:
A small control in the tab bar that opens Config or shows a mod's panel.
_Avoid_: toggle, action row, icon

### Notes

**Vault**:
A folder of Obsidian notes that was added on the Vaults page of Config. This setup keeps the list; a folder Obsidian has opened is not a vault here until it is added.
_Avoid_: notebook, notes folder, workspace

**Connected vault**:
The one vault this setup's mods act on, chosen on the Vaults page of Config. With none connected, a vault key opens that page.
_Avoid_: active vault, default vault, linked vault, current vault

### Choosing an agent

**Installed agent**:
An agent Herdr knows how to start and has found on a machine. Herdr decides this list and its order; no mod keeps its own.
_Avoid_: supported agent, available agent, known agent

**Agent shortlist**:
The installed agents one machine chooses to be offered, wherever an agent is picked. With none chosen, every installed agent is offered.
_Avoid_: filter, favourites, enabled agents, defaults

**Provider**:
The company whose models an agent runs, such as Anthropic, OpenAI or Google. Most agents take one provider's models; OpenCode takes any.
_Avoid_: vendor, AI provider, backend, API

**Model**:
The language model an agent sends its work to, offered by one provider. A model is chosen per agent, so the same model can run under different agents.
_Avoid_: LLM, engine, AI

**Reasoning level**:
How much reasoning effort a model uses. Available levels belong to the model; Default leaves the choice to the agent.

**Recipe**:
What one flow knows about one agent, such as how to ask it for a single answer or how to fork its session. An installed agent with no recipe for a flow is still listed there, marked as not usable yet.
_Avoid_: preset, support, integration

**Model catalog**:
The models each agent can be started with, the newest of each family that anyone can use, taken from models.dev and kept in `models.json`. Wherever a model is picked, the choices are the catalog's; a model it does not have can still be typed.
_Avoid_: model list (that is the Launcher's list of them), registry, models.dev (for our copy)

**Starred model**:
A model marked to be listed first wherever a model is picked for its agent. Any model can be starred, in the catalog or not.
_Avoid_: favourite (too close to the agent shortlist), pinned (Herdr's word for an agent kept at the top), default

**Model sync**:
Bringing the model catalog up to date from models.dev. It runs by itself once a day, and from the Models page of Config.
_Avoid_: refresh, update, fetch

### Listing agents

**Agents sidebar**:
The list of running agents in the window's sidebar, under the spaces.
_Avoid_: agent list, app sidebar, agents panel, Agent hub

**Agent order**:
The one order agents are listed in, wherever they are listed: pinned agents first, then by the Agents sidebar's chosen sort, each sub-agent under its parent. The Agents sidebar decides it; the Agent hub and next/previous agent follow it.
_Avoid_: sort (that is the choice behind the order), ranking, priority

**Agent row**:
One agent in a list of agents: its title on the first line, and under it, quieter, its space mark, its tab badge and its space.
_Avoid_: entry, item, card

**Snoozed**:
An agent set aside on purpose: it asks for no attention, in the Agents sidebar, the tab bar or the status bar, until it starts another turn or comes to need you, or is woken.
_Avoid_: muted, hidden (that is a section of spaces), dismissed, seen (Herdr's word for a done agent you looked at)

**Space mark**:
A space's first letter on the space's own color, in a small rounded square, so a space can be told apart at a glance wherever it is listed.
_Avoid_: favicon, avatar, space icon, logo

**Tab badge**:
A tab's number in its space, drawn as a small box so it can be matched to the tab bar at a glance.
_Avoid_: tab index, tab number (as text), press number

### Agents working together

**Session**:
The conversation an agent holds, with its own history. An agent is the running terminal; a session is what it is talking about.
_Avoid_: agent session (for the agent), chat, thread

**Fork**:
A second session that starts from the same history as a running one and then goes its own way.
_Avoid_: clone (that is for mods and layouts), duplicate, branch

**Handover**:
Passing a session on to a different agent CLI: the source writes a summary of where things stand and sends it to the new agent as a message.
_Avoid_: transfer, migrate, fork (that keeps the same CLI)

**Agent hub**:
The window that lists the running agents with each one's recent screen.
_Avoid_: Agents sidebar, switcher, dashboard

**Send box**:
The floating text area whose contents go to one chosen pane.
_Avoid_: prompt (Herdr's naming dialog), message box, input

**Message**:
Text sent from one agent to another agent that says who sent it, so the receiver can answer.
_Avoid_: send (for the concept), note, context

**Pull**:
Bringing another agent's recent output to the agent you are working with.
_Avoid_: fetch, import, context (as a verb)

**Hand**:
Giving one item from a mod, such as an issue, to the pane you came from as the start of a message.
_Avoid_: send, assign, pull

**Lific request**:
What the person asks to be done in Lific, in their own words: a new issue, a status, a comment. It is typed in the Lific window's request box and works in the project shown there, unless the words name another.
_Avoid_: message (that is between agents), command, prompt, chat

**Lific agent**:
The agent and model chosen to carry out Lific requests. It is started once per request and can reach nothing but Lific's own tools. It is a separate choice from the Writer, which only writes.
_Avoid_: Writer (that one has no tools), bot, assistant, MCP (that is how it reaches Lific)

### Text written for you

**Writer**:
The agent and model chosen to write the short texts that mods ask for.
_Avoid_: generator, title command, AI

**Commit message**:
The whole text of a commit: the one line that names it and, for a larger change, a paragraph under it. Worktrunk has its own commit writer for these, which can follow the Writer.
_Avoid_: commit summary, commit subject (for the whole text)

### GitHub

**Organization**:
A GitHub organization the account signed in on this computer belongs to. The Pull requests window lists the repositories of the one selected.
_Avoid_: org, team, account (the account is who is signed in on this computer)

**Pull request**:
A proposed change GitHub has in one repository of the selected organization.
_Avoid_: pull (that is bringing another agent's output), PR

**Pull requests**:
The window that lists an organization's repositories and the pull requests of the repository selected.
_Avoid_: GitHub panel, pulls, prs

### The window

**Curtain**:
The switch that takes every sign of agents off the window while the screen is shared, with nothing ended. It is drawn or lifted.
_Avoid_: AI switch, hide mode, privacy mode, stealth

**My layout**:
`mine`, the layout this setup is built around, cloned from Herdr's `main`. It is the only layout here that is ours, and the only one with this setup's tab-bar buttons.
_Avoid_: main-copy, herdr-skillshare (its old names), main (Herdr's), default layout

**Section**:
A named, foldable run of spaces on one machine in the spaces sidebar.
_Avoid_: group, folder, category

**Hidden**:
The section on each machine for work to pick up later. Its spaces remain accessible in the spaces sidebar, while the setup's discovery, navigation and attention summaries leave them out. Moving a space out restores it to those features. Its terminals keep running.
_Avoid_: archived, closed, off, curtain (those mean different things)
