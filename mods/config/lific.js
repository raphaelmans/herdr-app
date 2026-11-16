// Lific page: the Lific agent, and whether Lific's MCP answers.
// Terms: GLOSSARY.md (Lific request, Lific agent).
//
// The Lific agent is the agent and model that carry out a Lific request
// (made in the Lific window, mods/lific). It is chosen like the Writer (./writer.js, whose picker
// this page is) but kept apart from it: this one acts through tools, so it may
// want a different model. The choice is kept in shared state under "lific.agent":
//   { agent, models: { <agent>: <model> }, custom, command, label }
// `command` is all a mod needs: a shell command that reads the request on
// stdin, carries it out through Lific's MCP tools, and prints what it did.
//   printf %s "$prompt" | <command>
// Each recipe starts its agent once, with Lific's MCP server (`lific mcp`, over
// stdio) as its only tools: no shell, no files. The server is named in the
// command itself, so nothing depends on what `lific connect` set up for the
// agent's everyday sessions. A custom command has to bring the MCP itself.
//
// handshake() is the MCP health check: it starts `lific mcp`, greets it the way
// a client would and counts the tools it lists. Health (./health.js) draws the
// same check.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, home } from "herdr";
import Writer, { pick, quote, settle as settleKind } from "./writer.js";
import { chip, waiting } from "./ui.js";

export const LIFIC_AGENT = "lific.agent";
const bin = () => `${home()}/.local/bin/lific`;

const RECIPES = {
  claude: {
    name: "Claude Code", model: "claude-haiku-5-5", models: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
    command: (m) => `MAX_THINKING_TOKENS=0 claude -p${pick("--model", m)} --mcp-config ${quote(JSON.stringify({ mcpServers: { lific: { command: bin(), args: ["mcp"] } } }))} --strict-mcp-config --tools='' --allowedTools mcp__lific --disable-slash-commands --setting-sources='' --no-session-persistence`,
  },
  codex: {
    name: "Codex", model: "", models: [],
    command: (m) => `codex exec --skip-git-repo-check --sandbox read-only --ephemeral --color never${pick("-m", m)} -c ${quote(`mcp_servers.lific.command=${JSON.stringify(bin())}`)} -c 'mcp_servers.lific.args=["mcp"]' -c 'mcp_servers.lific.default_tools_approval_mode="approve"' -`,
  },
  opencode: {
    name: "OpenCode", model: "", models: [], hint: "provider/model",
    command: (m) => `OPENCODE_CONFIG_CONTENT=${quote(JSON.stringify({ mcp: { lific: { type: "local", command: [bin(), "mcp"], enabled: true } } }))} opencode run --pure${pick("-m", m)} "$(cat)"`,
  },
};

// Trying it changes nothing in Lific: it only reads.
const KIND = { key: LIFIC_AGENT, page: "lific", name: "Lific agent", does: "Lific requests", recipes: RECIPES, fallback: "claude",
  sample: "Use the Lific tools to list the projects. Reply with only their identifiers on one line. Change nothing.",
  trying: "Asking Lific", timeout: 300_000, follows: false,
  hints: "j k g G choose · t try it (reads only) · r check the MCP again · saved as you change it" };

export const settle = (agents) => settleKind(agents, KIND);

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
        .child(this.checkingMcp || !m ? waiting(t, "Greeting lific mcp") : ok ? "answers over stdio: what the Lific agent is given, and nothing else" : `${m.text}. Run: lific doctor`))
      .child(div().flex_none().text_size(11).text_color(t.dim).child("r check again"));
    return v_flex().size_full().min_h(0).gap(12)
      .child(mcp)
      .child(v_flex().flex_1().min_h(0).child(super.render(t)));
  }
}
