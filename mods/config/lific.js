// Lific page: the Lific agent, and whether Lific's MCP answers.
// Terms: GLOSSARY.md (Lific session, Lific agent, Lific request). Decision: docs/adr/0014.
//
// The Lific agent is the agent and model a Lific session runs: the standing,
// interactive agent the Lific window (mods/lific) hands requests to, in a tab
// of its own. It is chosen like the Writer (./writer.js, whose picker this page
// is) but kept apart from it: this one converses and acts through tools, so it
// may want a stronger model. The choice is kept in shared state under "lific.agent":
//   { agent, models: { <agent>: <model> }, custom, command, label }
// `command` is a shell command that starts the session interactively. The
// Lific window runs it in a login shell inside a herdr-core terminal
// (mods/lific/session.js) and talks to it with hc send.
// Each recipe gives the agent Lific's MCP server (`lific mcp`, over stdio) as
// its only tools (Codex keeps a read-only sandbox), plus the session's focus:
// mods/lific/session/system-prompt.md and the lific skill
// (mods/lific/session/plugin). Claude Code loads the plugin, OpenCode uses
// its build prompt, and Codex and Grok get an initial message. Nothing depends on what `lific connect` set up
// for the agent's everyday sessions. A custom command has to bring the MCP itself.
//
// handshake() is the MCP health check: it starts `lific mcp`, greets it the way
// a client would and counts the tools it lists. Health (./health.js) draws the
// same check. "Try it" on this page runs that check: it starts no session.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, exec, home, setShared, shared } from "herdr";
import Writer, { GROK_OWN, pick, quote, settle as settleKind } from "./writer.js";
import { chip, waiting } from "./ui.js";

export const LIFIC_AGENT = "lific.agent";
const bin = () => `${home()}/.local/bin/lific`;

const focus = () => `${appHome()}/mods/lific/session`;
// The system prompt, then the skill: the first message of an agent without plugins.
const brief = () => `"$(cat ${quote(`${focus()}/system-prompt.md`)} ${quote(`${focus()}/plugin/skills/lific/SKILL.md`)})"`;

const RECIPES = {
  claude: {
    name: "Claude Code", model: "claude-sonnet-5-5", models: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
    command: (m) => `claude${pick("--model", m)} --mcp-config ${quote(JSON.stringify({ mcpServers: { lific: { command: bin(), args: ["mcp"] } } }))} --strict-mcp-config --tools Skill --allowedTools 'mcp__lific Skill' --plugin-dir ${quote(`${focus()}/plugin`)} --append-system-prompt-file ${quote(`${focus()}/system-prompt.md`)} --name Lific`,
  },
  codex: {
    name: "Codex", model: "", models: [],
    command: (m) => `codex --no-daemon --sandbox read-only${pick("-m", m)} -c ${quote(`mcp_servers.lific.command=${JSON.stringify(bin())}`)} -c 'mcp_servers.lific.args=["mcp"]' -c 'mcp_servers.lific.default_tools_approval_mode="approve"' ${brief()}`,
  },
  opencode: {
    name: "OpenCode", model: "", models: [], hint: "provider/model",
    command: (m) => `sh ${quote(`${focus()}/opencode.sh`)} ${quote(bin())}${pick("-m", m)}`,
  },
  // Grok takes an MCP server only from a file: the agent file names Lific's and
  // removes the built-in tools; dontAsk then refuses any tool but Lific's.
  grok: {
    name: "Grok", model: "grok-4.7", models: ["grok-4.7", "grok-4.7-build-fast"],
    command: (m) => `${GROK_OWN} grok --agent ${quote(`${focus()}/grok-agent.md`)}${pick("-m", m)} --tools search_tool,use_tool --permission-mode dontAsk --allow 'MCPTool(lific__*)' --no-subagents --disable-web-search ${brief()}`,
  },
};

// Trying it greets Lific's MCP; it starts no session (a session is interactive).
const KIND = { key: LIFIC_AGENT, page: "lific", name: "Lific agent", does: "the Lific session", recipes: RECIPES, fallback: "claude",
  trying: "Greeting lific mcp", tryLabel: "Check the MCP", follows: false,
  hints: "j k g G choose · t or r check the MCP · the next new Lific session starts with this · saved as you change it" };

// Rebuild saved built-in commands when their recipe changes. Keep the chosen
// agent and model, including custom commands which have no built-in recipe.
export function settle(agents) {
  const saved = shared(LIFIC_AGENT), recipe = RECIPES[saved?.agent];
  if (recipe) {
    const model = String(saved.models?.[saved.agent] ?? recipe.model).trim();
    const command = recipe.command(model);
    if (saved.command !== command) setShared(LIFIC_AGENT, { ...saved, command, label: `${recipe.name} · ${model || "default model"}` });
  }
  settleKind(agents, KIND);
}

const HELLO = [
  { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "herdr-health", version: "1" } } },
  { jsonrpc: "2.0", method: "notifications/initialized" },
  { jsonrpc: "2.0", id: 2, method: "tools/list" },
].map((m) => JSON.stringify(m));
// The answers are tens of kilobytes of tool descriptions: jq keeps two facts (ADR 0006).
const SCRIPT = `[ -x "$1" ] || exit 3
printf '%s\\n' "$2" "$3" "$4" | "$1" mcp 2>/dev/null | jq -sc '{version: ((map(select(.id == 1))[0].result.serverInfo.version) // null), tools: (((map(select(.id == 2))[0].result.tools) // []) | length)}'`;

// One MCP handshake with `lific mcp`:
//   { ok: true, version, tools }   it answered and lists tools
//   { ok: false, absent: true }    lific itself is not here (Health's lific row says so)
//   { ok: false, text }            it is here but did not answer
export async function handshake() {
  let r;
  try { r = await exec("sh", ["-c", SCRIPT, "sh", bin(), ...HELLO], { cwd: home(), timeout: 15_000 }); }
  catch (e) { return { ok: false, text: String(e?.message ?? e) }; }
  if (r.code === 3) return { ok: false, absent: true, text: `${bin()} is not there` };
  let got = null;
  try { got = JSON.parse(r.stdout.trim()); } catch {}
  if (!got) return { ok: false, text: /jq/.test(r.stderr) ? "jq is not here to read the answer" : (r.stderr.trim().split("\n").pop() || "no answer that could be read") };
  if (!got.version) return { ok: false, text: "lific mcp started but did not answer the handshake" };
  if (!got.tools) return { ok: false, text: `lific ${got.version} answered but lists no tools` };
  return { ok: true, version: got.version, tools: got.tools };
}

export default class Lific extends Writer {
  constructor(host) {
    super(host, KIND);
    this.mcp = null; // the last handshake
    this.checkingMcp = false;
  }

  start(cx) { super.start(cx); this.check(cx); }

  check(cx) {
    if (this.checkingMcp) return;
    this.checkingMcp = true;
    cx.notify();
    cx.spawn(async (cx) => {
      this.mcp = await handshake();
      this.checkingMcp = false;
      cx.notify();
    });
  }

  // The Writer's "Try it" pipes a prompt through a one-shot command; a session
  // is interactive, so here it is the MCP check.
  test(cx) { this.check(cx); }
  busy() { return this.checkingMcp; }

  key(e, cx) {
    if (!this.typing && (e.key_char ?? e.key) === "r") { this.check(cx); return true; }
    return super.key(e, cx);
  }

  render(t) {
    const m = this.mcp, ok = Boolean(m?.ok);
    const mcp = h_flex().id("lific-mcp").flex_none().h(40).px(10).gap(10).items_center().rounded(8).bg(t.raised).cursor_pointer()
      .on_click((_e, cx) => { this.host.handle.focus(); this.check(cx); })
      .child(div().flex_none().w(16).text_size(13).font_semibold().text_color(!m ? t.dim : ok ? t.ansi2 : t.blocked).child(!m ? "·" : ok ? "✓" : "✕"))
      .child(div().flex_none().font_semibold().child("Lific MCP"))
      .when(ok, (el) => el.child(chip(t, `${m.tools} tools · ${m.version}`, t.muted)))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(m && !ok ? t.blocked : t.muted)
        .child(this.checkingMcp || !m ? waiting(t, "Greeting lific mcp") : ok ? "answers over stdio: the Lific session's only tools" : `${m.text}. Run: lific doctor`))
      .child(div().flex_none().text_size(11).text_color(t.dim).child("r check again"));
    return v_flex().size_full().min_h(0).gap(12)
      .child(mcp)
      .child(v_flex().flex_1().min_h(0).child(super.render(t)));
  }
}
