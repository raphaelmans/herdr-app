// Writer page: which agent and model write the short texts other mods ask
// for, such as the launcher's worktree branch names and agent titles.
//
// The choice is kept in shared state under "writer":
//   { agent, models: { <agent>: <model> }, custom, command, label }
// `command` is all a mod needs: a shell command that reads the prompt on stdin
// and prints the text on stdout.
//   printf %s "$prompt" | <command>
// The agents listed are Herdr's installed ones, narrowed to the agent shortlist
// when this machine has one. One without a recipe below is listed but can't be
// chosen: add a recipe, or pick Custom command.
// Worktrunk's commit writer can follow this choice (./worktrunk.js).
// The models offered for an agent are the model catalog's (./models.js), the
// starred ones first; typing in the field narrows them. Without a catalog or a
// starred model for the agent they are its recipe's.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, home, knownAgents, notify, setShared, shared, settings } from "herdr";
import { heading, SHORTLIST, waiting } from "./ui.js";
import { follow } from "./worktrunk.js";
import { ago, catalog, load, offered as models, starred, synced } from "./models.js";

const KEY = "writer";
export const quote = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
export const pick = (flag, m) => (m ? ` ${flag} ${quote(m)}` : "");
// One-shot, no tools, prompt on stdin, only the answer on stdout. `models` are
// the suggestions until the catalog has the agent's: any model the agent
// accepts can be typed; none is its default.
const RECIPES = {
  claude: {
    name: "Claude Code", model: "claude-haiku-5-5", models: ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"],
    command: (m) => `MAX_THINKING_TOKENS=0 claude -p${pick("--model", m)} --tools='' --disable-slash-commands --setting-sources='' --system-prompt='' --no-session-persistence`,
  },
  codex: {
    name: "Codex", model: "", models: [],
    command: (m) => `codex exec --skip-git-repo-check --sandbox read-only --ephemeral --color never${pick("-m", m)} -`,
  },
  opencode: {
    name: "OpenCode", model: "", models: [], hint: "provider/model",
    command: (m) => `opencode run --pure${pick("-m", m)} "$(cat)"`,
  },
};
const CUSTOM = "custom";
const SAMPLE = "Reply with only a git branch name, lowercase words joined by hyphens, for this work: add a settings page that picks which agent writes branch names.";
// A kind of one-shot command chosen this way: where it is kept, its recipes,
// and what its page says. The Writer is one; the Lific agent (./lific.js) another.
const WRITER = { key: KEY, page: "writer", name: "Writer", does: "worktree branch names and agent titles", recipes: RECIPES, fallback: "claude",
  sample: SAMPLE, trying: "Writing…", timeout: 90_000, follows: true, hints: "j k g G choose · t try it · saved as you change it" };

// Herdr's installed agents, narrowed to the shortlist when it names one of them.
function offered(agents) {
  const installed = agents.filter((a) => a.installed), keys = shared(SHORTLIST);
  if (!Array.isArray(keys) || !keys.length) return installed;
  const kept = installed.filter((a) => keys.includes(a.key));
  return kept.length ? kept : installed;
}
const read = (kind) => {
  const saved = shared(kind.key) ?? {};
  return { agent: saved.agent ?? kind.fallback, models: { ...saved.models }, custom: saved.custom ?? "" };
};
const OFFERED = 40; // chips drawn at most
// The models offered as chips: the agent's starred ones, then the catalog's,
// narrowed by what is typed unless that is one of them; the recipe's own when
// it has neither.
function suggestions(kind, agent, typed) {
  const all = models(agent), f = typed.trim().toLowerCase();
  if (!all.length) return kind.recipes[agent]?.models ?? [];
  const ids = all.map(([id]) => id);
  if (!f || ids.some((id) => id.toLowerCase() === f)) return ids.slice(0, OFFERED);
  return all.filter(([id, name]) => `${id} ${name ?? ""}`.toLowerCase().includes(f)).map(([id]) => id).slice(0, OFFERED);
}
const modelOf = (kind, cfg, agent = cfg.agent) => cfg.models[agent] ?? kind.recipes[agent]?.model ?? "";
function publish(kind, cfg, cx) {
  const recipe = kind.recipes[cfg.agent], model = modelOf(kind, cfg);
  const command = recipe ? recipe.command(model.trim()) : cfg.custom.trim();
  const label = recipe ? `${recipe.name} · ${model.trim() || "default model"}` : "custom command";
  setShared(kind.key, { ...cfg, command, label });
  if (cx && kind.follows) follow(cx);
}

// A choice that can run on this machine, always: with none yet, or one whose
// agent isn't installed here, the first offered agent that has a recipe.
export function settle(agents, kind = WRITER) {
  const saved = shared(kind.key), installed = (key) => agents.some((a) => a.key === key && a.installed);
  if (saved?.command && (saved.agent === CUSTOM || installed(saved.agent))) return;
  const first = offered(agents).map((a) => a.key).find((key) => kind.recipes[key]) ?? Object.keys(kind.recipes).find(installed);
  if (!first) return;
  publish(kind, { ...read(kind), agent: first });
  if (saved?.agent) {
    setShared("config.page", kind.page);
    notify({ title: kind.name, body: `${kind.recipes[saved.agent]?.name ?? saved.agent} isn't installed here: ${kind.does} now use ${kind.recipes[first].name}.`, action: { name: "mod.open", args: { name: "config" } } });
  }
}

export default class Writer {
  constructor(host, kind = WRITER) {
    this.host = host;
    this.kind = kind;
    this.agents = null;
    this.result = null;
    this.typing = false;
    this.hints = kind.hints;
    this.input = InputState.new({ placeholder: "" });
    this.fill();
    this.input.on("change", (_e, cx) => {
      const cfg = read(this.kind), value = this.input.value();
      if (cfg.agent === CUSTOM) { if (value === cfg.custom) return; cfg.custom = value; }
      else { if (value === modelOf(this.kind, cfg)) return; cfg.models[cfg.agent] = value; }
      this.result = null; publish(this.kind, cfg, cx); cx.notify();
    });
    this.input.on("submit", (_e, cx) => { this.host.handle.focus(); cx.notify(); });
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
  }

  start(cx) {
    cx.spawn(async (cx) => {
      try { this.agents = await knownAgents(); } catch { this.agents = []; }
      cx.notify();
    });
    cx.spawn(async (cx) => { await load(); cx.notify(); });
  }

  fill() { const cfg = read(this.kind); this.input.set_value(cfg.agent === CUSTOM ? cfg.custom : modelOf(this.kind, cfg)); }

  // Herdr's offered agents in its order, then the chosen one if it isn't among
  // them, then Custom command. Until Herdr answers: the agents with a recipe.
  rows() {
    const custom = { key: CUSTOM, name: "Custom command", installed: true, usable: true };
    if (!this.agents) return [...Object.entries(this.kind.recipes).map(([key, p]) => ({ key, name: p.name, installed: null, usable: true })), custom];
    const row = (a) => ({ key: a.key, name: a.name, icon: a.icon, tint: a.tint, installed: a.installed, usable: Boolean(this.kind.recipes[a.key]) });
    const rows = offered(this.agents).map(row), now = read(this.kind).agent;
    if (this.kind.recipes[now] && !rows.some((r) => r.key === now)) {
      const known = this.agents.find((a) => a.key === now);
      rows.push(known ? row(known) : { key: now, name: this.kind.recipes[now].name, installed: false, usable: true });
    }
    return [...rows, custom];
  }

  choose(key, cx) {
    const cfg = read(this.kind);
    if (cfg.agent === key || (key !== CUSTOM && !this.kind.recipes[key])) return;
    publish(this.kind, { ...cfg, agent: key }, cx);
    this.result = null; this.fill(); cx.notify();
  }

  setModel(model, cx) {
    const cfg = read(this.kind); cfg.models[cfg.agent] = model;
    publish(this.kind, cfg, cx); this.result = null; this.fill(); cx.notify();
  }

  test(cx) {
    const command = shared(this.kind.key)?.command;
    if (this.testing || !command) return;
    this.testing = true; this.result = null;
    const started = Date.now();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", `printf %s "$1" | ${command}`, "sh", this.kind.sample], { cwd: home(), timeout: this.kind.timeout });
        const out = r.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
        if (shared(this.kind.key)?.command !== command) return;
        this.result = r.code === 0 && out ? { ok: true, text: out, ms: Date.now() - started }
          : { ok: false, text: (r.stderr || r.stdout).trim().split("\n").slice(-2).join("  ") || `exit ${r.code}, no output` };
      } catch (e) { this.result = { ok: false, text: String(e?.message ?? e) }; }
      finally { this.testing = false; cx.notify(); }
    });
    cx.notify();
  }

  key(e, cx) {
    if (this.typing) { if (e.key === "escape") { this.host.handle.focus(); cx.stop_propagation(); cx.notify(); } return true; }
    const rows = this.rows().filter((r) => r.usable), at = Math.max(0, rows.findIndex((r) => r.key === read(this.kind).agent)), ch = e.key_char ?? e.key;
    const step = ch === "j" || e.key === "down" ? 1 : ch === "k" || e.key === "up" ? -1 : 0;
    if (step) this.choose(rows[(at + step + rows.length) % rows.length].key, cx);
    else if (ch === "g" || ch === "G") this.choose(rows[ch === "g" ? 0 : rows.length - 1].key, cx);
    else if (ch === "t" || e.key === "enter") this.test(cx);
    else return false;
    return true;
  }

  render(t) {
    const kind = this.kind, cfg = read(kind), recipe = kind.recipes[cfg.agent], model = modelOf(kind, cfg), command = shared(kind.key)?.command ?? "";
    const mono = settings().font_family ?? "JetBrains Mono";
    const chip = (id, label, on, click) => div().id(id).flex_none().h(24).px(9).flex().items_center().rounded(6).border_1().text_size(12).cursor_pointer()
      .border_color(on ? t.accent : t.border).text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => click(cx)).child(label);
    const r = this.result;
    return v_flex().size_full().min_h(0).gap(12)
      .child(heading(t, "AGENT", this.agents ? "the agents page decides which are offered" : waiting(t, "Checking what is installed")))
      .child(v_flex().id("writer-agents").flex_none().max_h(36 * 5 + 8).overflow_y_scroll().gap(2).children(this.rows().map((row) => {
        const on = row.key === cfg.agent;
        return h_flex().id(`agent-${row.key}`).flex_none().h(36).px(10).gap(10).items_center().rounded(8)
          .when(row.usable, (el) => el.cursor_pointer())
          .when(on, (el) => el.bg(t.selected)).when(!on && row.usable, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => { this.host.handle.focus(); this.choose(row.key, cx); })
          .child(div().flex_none().size(14).rounded_full().border_1().border_color(on ? t.accent : t.input).flex().items_center().justify_center()
            .when(on, (el) => el.child(div().size(6).rounded_full().bg(t.accent))))
          .child(row.icon ? (row.tint ? svg(row.icon).size(16).flex_none().text_color(t.foreground) : image(row.icon).w(16).h(16).flex_none())
            : svg("mods/config/sparkles.svg").size(14).mx(1).flex_none().text_color(t.dim))
          .child(div().flex_1().min_w(0).truncate().text_color(row.installed === false || !row.usable ? t.dim : t.foreground).child(row.name))
          .child(div().flex_none().text_size(11).text_color(row.installed === false ? t.blocked : t.dim)
            .child(row.installed === false ? "not installed" : !row.usable ? "no recipe yet · use Custom command" : row.key === CUSTOM ? "any program" : modelOf(kind, cfg, row.key) || "default model"));
      })))
      .child(heading(t, recipe ? "MODEL" : "COMMAND", recipe ? [catalog(cfg.agent).length ? `from models.dev, synced ${ago(synced())} · type to narrow` : recipe.hint, "empty for the agent's default"].filter(Boolean).join(" · ") : "reads the prompt on stdin, prints the text"))
      .when(Boolean(recipe), (el) => el.child(h_flex().id("writer-models").flex_none().max_h(84).overflow_y_scroll().px(4).gap(6).flex_wrap()
        .child(chip("model-default", "Default", !model.trim(), (cx) => this.setModel("", cx)))
        .children(suggestions(kind, cfg.agent, model).map((m) => chip(`model-${m}`, starred(cfg.agent).includes(m) ? `★ ${m}` : m, model.trim() === m, (cx) => this.setModel(m, cx))))))
      .child(div().id("writer-input").flex_none().mx(4).h(32).px(10).flex().items_center().rounded(8).border_1().border_color(this.typing ? t.accent : t.border).bg(t.surface).cursor_text()
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(Input.new(this.input).w_full().h_full().text_size(12).text_color(t.foreground)))
      .when(Boolean(recipe), (el) => el.child(v_flex().flex_none().px(4).gap(4)
        .child(div().text_size(11).text_color(t.dim).child("Runs"))
        .child(div().p(8).rounded(8).bg(t.raised).font_family(mono).text_size(11).text_color(t.muted).child(command))))
      .child(div().flex_1().min_h(0))
      .when(Boolean(r), (el) => el.child(div().flex_none().mx(4).p(8).rounded(8).border_1().border_color(r.ok ? t.border : t.blocked).text_size(12)
        .text_color(r.ok ? t.foreground : t.blocked).child(r.ok ? `${r.text}  ·  ${(r.ms / 1000).toFixed(1)}s` : r.text)))
      .child(h_flex().flex_none().px(4).justify_end()
        .child(h_flex().id("writer-test").flex_none().h(30).px(14).gap(7).items_center().rounded(8).bg(t.solid).text_color(t.solid_foreground).text_size(12)
          .when(!this.testing, (b) => b.cursor_pointer().hover((s) => s.opacity(0.88))).on_click((_e, cx) => this.test(cx))
          .when(Boolean(this.testing), (b) => b.child(svg("mods/workspace-chrome/spinner.svg").size(12).spin(900)))
          .child(this.testing ? kind.trying : "Try it")));
  }
}
