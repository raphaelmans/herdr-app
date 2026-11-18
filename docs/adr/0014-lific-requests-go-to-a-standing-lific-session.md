# Lific requests go to a standing Lific session

A **Lific session** is an interactive agent with Lific’s MCP tools and access to every Lific project. It remembers the conversation across requests. This replaces ADR 0008’s one-shot agent and keeps its tool restrictions. We considered longer one-shot prompts, a session per project, and a background-only agent. The person wanted to follow up across projects and see or join the conversation directly.

The first request starts a session in `~/.local/state/lific-session`. Herdr gives it a dedicated tab in a local space. In the board, `t` opens the terminal, including during first-run trust. `T` selects a live session or chooses to start a fresh one on the next request. Closing the board leaves the session and its answers available.

The board records the launch PID and command, verifies the agent report and turns off core shell recovery before delivery. It calls `hc send --wait` once. A timeout continues the wait for the same turn. A blocked prompt directs the person to the terminal, and an exit or an unconfirmed turn is reported to the board. A changed issue opens only when the reply includes the request’s marker and the changed issue ID.

Config → Lific saves an agent and model. The default is Sonnet for conversation and planning. Built-in commands are rebuilt when their recipe changes. “Check the MCP” tests the handshake. The system prompt and Lific skill live in `mods/lific/session/`. Claude Code loads the skill as a plugin. Codex and Grok receive an initial message, and Codex keeps a read-only sandbox. OpenCode loads the brief as its build prompt, checks its effective tool permissions and MCP servers at launch, and uses one local status hook to report turns to Herdr.
