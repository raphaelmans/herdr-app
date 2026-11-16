# Agent pickers follow Herdr's installed agents

Wherever an agent is picked (Launcher, Writer, forks, anything new), the choices are Herdr's own `knownAgents()` in Herdr's order, narrowed by the per-machine agent shortlist (shared `agents.shortlist`, Config → Agents). No mod keeps a hard-coded list of agents. Hard-coded lists (the Writer's three presets, Claude-and-Codex-only forks) broke on another machine with different agents installed, and the person had to repeat this rule several times.

**Consequences:** an installed agent a flow has no recipe for is still listed, marked as not usable yet. A shortlist that matches nothing installed is ignored, so a list is never empty.
