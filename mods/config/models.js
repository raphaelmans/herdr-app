// Models page, and the model sync: the model catalog is the models each agent
// can be started with, taken from models.dev or the agent's own list, kept in
//   ~/.config/herdr-app/models.json
//   { synced: <ISO time>, source, agents: { <agent key>: [[model id, name, reasoning levels], ...] } }
// newest first. A mod that offers models reads that file (the Launcher) or,
// in this mod, catalog() (the Writer page). Shared "models.synced" is the time
// of the last sync: it changes when the file does.
//
// The page lists Herdr's offered agents (knownAgents() narrowed by the agent
// shortlist, ADR 0002), never a list of its own. Where an agent's models come
// from is CATALOGS below, its recipe: its providers on models.dev, or the
// command that makes the agent list them itself (the models of the signed-in
// account; models.dev still gives their reasoning levels). From models.dev,
// kept is the newest model of each family (models.dev's `family`: claude-opus,
// gpt-mini) among those anyone can use (AVAILABLE below).
// An older one can still be typed where a model is picked.
// An agent without a recipe is still listed, with no catalog: its model is typed.
//
// A starred model is listed first wherever a model is picked. Shared
// "models.starred": { <agent key>: [model id, ...] }, in the order starred. Any
// model can be starred, in the catalog or not. Here: Enter steps into an
// agent's models, space stars the one chosen.
//
// The sync runs by itself when the catalog is absent or a day old (the
// tab-bar button's copy checks at start and every few hours, this page when it
// opens), and from this page with s.

import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { appHome, exec, knownAgents, readTextFile, setShared, shared } from "herdr";
import { heading, offeredAgents, waiting } from "./ui.js";

const SOURCE = "https://models.dev/api.json";
const STAMP = "models.synced";
const DAY = 24 * 3600_000;
const SHOWN = 150; // rows drawn at most: search narrows the rest
const STARRED = "models.starred";
// Recipes, by Herdr's agent key. providers: models.dev provider ids, in the
// order listed (one it doesn't have adds nothing). prefixed: the id is
// "provider/model". OpenCode takes any provider; only these are listed, to keep
// its list short. families: of the provider's models, only those whose family
// starts with one of these. Copilot resells many makers' models; only Claude's
// and OpenAI's are listed. list: a command printing the agent's own models, one
// per line as "id", "* id (default)" or "id - Name" (run in a login shell, as
// Herdr starts agents); its providers then only give reasoning levels. When it
// prints nothing (not signed in, not installed), the last catalog is kept.
const CATALOGS = {
  claude: { providers: ["anthropic"] },
  codex: { providers: ["openai"] },
  gemini: { providers: ["google"] },
  grok: { list: "grok models", providers: ["xai"] },
  cursor: { list: "cursor-agent models" },
  copilot: { providers: ["github-copilot"], families: ["claude", "gpt", "o1", "o3", "o4", "codex", "cursor"] },
  opencode: { providers: ["anthropic", "openai"], prefixed: true },
};

// The catalog as last read or synced, and the sync in flight: one of each for
// every copy of this mod, so the dialog sees what the tab-bar button synced.
let cache = null;
let running = null;

const path = () => `${appHome()}/models.json`;
export const catalog = (agent) => cache?.agents?.[agent] ?? [];
export const synced = () => cache?.synced ?? null;
// The agent's starred models, and its models as offered: the starred first, then the catalog's others.
export const starred = (agent) => { const ids = shared(STARRED)?.[agent]; return Array.isArray(ids) ? ids : []; };
export function offered(agent) {
  const all = catalog(agent), stars = starred(agent);
  return [...stars.map((id) => [id, all.find((m) => m[0] === id)?.[1] ?? ""]), ...all.filter(([id]) => !stars.includes(id))];
}
export function star(agent, id) {
  const now = starred(agent), next = now.includes(id) ? now.filter((m) => m !== id) : [...now, id];
  const all = { ...shared(STARRED) };
  if (next.length) all[agent] = next; else delete all[agent];
  setShared(STARRED, Object.keys(all).length ? all : null);
}
const stale = () => cache?.version !== 2 || !cache?.synced || !(Date.now() - Date.parse(cache.synced) < DAY);

export function ago(iso) {
  const min = Math.floor((Date.now() - Date.parse(iso)) / 60_000);
  if (!(min >= 1)) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} days ago`;
}

// Reads models.json, unless a newer catalog is already here.
export async function load() {
  try {
    const text = await readTextFile(path());
    const read = text ? JSON.parse(text) : null;
    if (read?.agents && !(cache?.synced > read.synced)) cache = read;
  } catch {}
  return cache;
}

// The sync runs outside the app: curl fetches the catalog and jq keeps what is
// offered. The whole of it is several megabytes, more than a mod's script has
// room for, so it is never read in here.
// A model anyone can use: it calls tools and answers in text only, models.dev
// gives it no status (alpha, beta, deprecated), it isn't named a preview or an
// experiment, and its description doesn't say access is limited. models.dev
// has no field for this, so it is read from those.
const AVAILABLE = `.tool_call and .status == null and (.modalities.output // ["text"]) == ["text"]
  and ((.id + " " + (.name // "")) | test("preview|experimental|alpha|beta|internal|[-_ ]exp([-_ ]|$)"; "i") | not)
  and ((.description // "") | test("authorized|limited access|early access|trusted access|waitlist|research preview"; "i") | not)`;
const list = (rule) => `[${JSON.stringify(rule.providers)}[] as $p | (.[$p].models // {}) | [.[] | select(${AVAILABLE}${rule.families ? ` and ((.family // .id) | test("^(${rule.families.join("|")})"))` : ""})] | group_by(.family // .id) | map(max_by(.release_date // "")) | sort_by(.release_date // "") | reverse | .[] | [${rule.prefixed ? '"\\($p)/\\(.id)"' : ".id"}, (.name // .id), ([.reasoning_options[]? | select(.type == "effort") | .values[]? | select(type == "string" and length > 0)] | unique)]]`;
// An agent's own list: its printed lines read as models, in its order, each
// with the reasoning levels models.dev gives the same id. "auto" is no model.
// Regexes as jq string literals (JSON.stringify writes valid ones): colors and
// zero-width spaces are dropped, then a line is "id", "* id (default)" or "id - Name".
const ANSI = JSON.stringify(String.raw`\u001b\[[0-9;?]*[A-Za-z]`.replace("\\u001b", "\u001b"));
const INVISIBLE = JSON.stringify("[​‌‍﻿]");
const LINE = JSON.stringify(String.raw`^\s*(?:[*-]\s+)?(?<id>[A-Za-z0-9][A-Za-z0-9._:/\[\]-]*)(?:\s+\(default\))?(?:\s+-\s+(?<name>.*?))?\s*$`);
const own = (key, rule) => `(($own[0][${JSON.stringify(key)}] // "") | gsub(${ANSI}; "") | gsub(${INVISIBLE}; "")
  | [split("\n")[] | capture(${LINE})? | select(.id != "auto")]
  | reduce .[] as $m ([]; if any(.[]; .[0] == $m.id) then . else . + [[$m.id, ($m.name // $m.id)]] end)
  | map(. as [$id, $name] | [${JSON.stringify(rule.providers ?? [])}[] as $p | $api[$p].models[$id]? // empty] as $dev
    | [$id, (if $name == $id then ($dev[0].name // $id) else $name end), ([$dev[] | .reasoning_options[]? | select(.type == "effort") | .values[]? | select(type == "string" and length > 0)] | unique)])
  | if length == 0 then ($old[0].agents[${JSON.stringify(key)}] // []) else . end)`;
const FILTER = `. as $api | {${Object.entries(CATALOGS).map(([key, rule]) => `${JSON.stringify(key)}: ${rule.list ? own(key, rule) : list(rule)}`).join(", ")}} as $agents
| if ([$agents[] | length] | add) == 0 then error("models.dev listed no models") else
  { version: 2, synced: (now | todate), source: $source, agents: $agents } end`;
// $1 models.json, $2 the source, $3 the jq filter. The file is replaced only by a whole new one.
// $4: "<agent key><tab><command>" lines, the agents that list their own models:
// each runs in a login shell, and what it prints goes to the filter as $own;
// the catalog as it was, as $old.
const PULL = `command -v jq >/dev/null || { echo "jq is not installed" >&2; exit 1; }
t="$1.tmp.$$"; d="$1.own.$$"; trap 'rm -rf "$t" "$d"' EXIT; mkdir -p "$d"
printf '%s\\n' "$4" | while IFS='	' read -r key cmd; do
  [ -n "$key" ] && "\${SHELL:-/bin/sh}" -lic "$cmd" </dev/null 2>/dev/null | jq -Rs --arg k "$key" '{($k): .}' > "$d/$key.json"
done
cat "$d"/*.json 2>/dev/null | jq -s 'add // {}' > "$d/all" || echo '{}' > "$d/all"
{ [ -s "$1" ] && cat "$1"; } > "$d/old" || echo '{}' > "$d/old"
curl -fsSL --compressed --max-time 120 "$2" | jq -r --arg source "$2" --slurpfile own "$d/all" --slurpfile old "$d/old" "$3" > "$t" || exit 1
[ -s "$t" ] || { echo "models.dev sent nothing" >&2; exit 1; }
mv "$t" "$1"`;
const LISTS = Object.entries(CATALOGS).filter(([, rule]) => rule.list).map(([key, rule]) => `${key}\t${rule.list}`).join("\n");

async function pull() {
  const r = await exec("sh", ["-c", PULL, "sh", path(), SOURCE, FILTER, LISTS], { timeout: 240_000 });
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `exit ${r.code}`);
  cache = null;
  await load();
  if (!cache) throw new Error("models.json could not be read back");
  setShared(STAMP, cache.synced);
  return cache;
}

// The model sync. Asked for twice at once, it runs once.
export function sync() {
  if (!running) running = pull().finally(() => { running = null; });
  return running;
}

// Syncs when there is no catalog or it is a day old. Quiet: a failure is tried again later.
export async function refresh() {
  await load();
  if (!stale()) return;
  try { await sync(); } catch (e) { console.log(`config: model sync: ${e?.message ?? e}`); }
}

// An agent's logo (Herdr's icon and tint) as the Agents page draws it: a one-color glyph takes the text color.
const logo = (t, l, on) => !l?.icon ? div().flex_none().w(16) : l.tint ? svg(l.icon).size(16).flex_none().text_color(on ? t.foreground : t.dim) : image(l.icon).w(16).h(16).flex_none();

const HINTS = "j k g G agent · ↵ its models · / search them · s sync now";

export default class Models {
  constructor(host) {
    this.host = host;
    this.at = 0; // which agent's models are listed
    this.inside = false; // stepped into the models: keys move there
    this.row = 0;
    this.search = null; // "/" narrows the models: null when off
    this.searching = false; // the search has the keyboard
    this.error = "";
    this.hints = HINTS;
    this.scroll = ScrollHandle.new();
    this.agents = null; // Herdr's offered agents, in its order: null until it answers
  }

  // While stepped into the models or their search, every key is this page's.
  get typing() { return this.inside || this.searching; }

  start(cx) {
    // The agents listed, read once for the dialog: Herdr's, narrowed by the shortlist.
    cx.spawn(async (cx) => {
      try { this.agents = offeredAgents(await knownAgents()); } catch { this.agents = []; this.error = "Could not check installed agents."; }
      cx.notify();
    });
    cx.spawn(async (cx) => {
      await load();
      cx.notify();
      if (stale()) this.sync(cx);
    });
  }

  sync(cx) {
    if (this.syncing) return;
    this.syncing = true; this.error = "";
    cx.spawn(async (cx) => {
      try { await sync(); } catch (e) { this.error = `Could not sync: ${e?.message ?? e}`; }
      this.syncing = false; cx.notify();
    });
    cx.notify();
  }

  agent() { return this.agents?.[this.at]?.key; }

  // The agent's models as listed: the starred first, narrowed by the search.
  rows() {
    const f = (this.search ?? "").trim().toLowerCase(), all = offered(this.agent());
    return (f ? all.filter(([id, name]) => `${id} ${name ?? ""}`.toLowerCase().includes(f)) : all).slice(0, SHOWN);
  }

  enter(cx, row = 0) {
    this.inside = true; this.row = row;
    this.hints = "j k g G model · space star · / search · esc back";
    this.scroll.scroll_to_item(this.row);
    cx.notify();
  }

  // Steps back: out of the search, then out of the models.
  back(cx) {
    cx.stop_propagation();
    if (this.searching || this.search !== null) { this.searching = false; this.search = null; this.row = 0; }
    else { this.inside = false; this.hints = HINTS; }
    cx.notify();
  }

  move(step, cx, to) {
    const n = this.rows().length;
    if (!n) return;
    this.row = to === undefined ? (Math.min(this.row, n - 1) + step + n) % n : to < 0 ? n - 1 : to;
    this.scroll.scroll_to_item(this.row);
    cx.notify();
  }

  // Stars the model, or takes its star off; the selection stays on it.
  star(id, cx) {
    if (!id) return;
    star(this.agent(), id);
    this.row = Math.max(0, this.rows().findIndex((r) => r[0] === id));
    this.scroll.scroll_to_item(this.row);
    cx.notify();
  }

  key(e, cx) {
    const keys = (this.agents ?? []).map((a) => a.key), ch = e.key_char ?? e.key, m = e.modifiers ?? {};
    if (e.key === "escape") { if (!this.typing && this.search === null) return false; return this.back(cx), true; }
    if (m.control || m.platform || m.alt) return this.typing;
    if (this.searching) {
      // The search has the keyboard: keys are typed, Enter keeps what was typed.
      if (e.key === "enter") this.searching = false;
      else if (e.key === "up" || e.key === "down") return this.move(e.key === "down" ? 1 : -1, cx), true;
      else if (e.key === "backspace") { if (!this.search) return this.back(cx), true; this.search = this.search.slice(0, -1); this.row = 0; }
      else if (e.key_char && e.key_char.length === 1 && e.key_char >= " ") { this.search += e.key_char; this.row = 0; }
      else return true;
      cx.notify();
      return true;
    }
    const step = ch === "j" || e.key === "down" ? 1 : ch === "k" || e.key === "up" ? -1 : 0;
    if (this.inside) {
      if (step) this.move(step, cx);
      else if (ch === "g" || ch === "G") this.move(0, cx, ch === "g" ? 0 : -1);
      else if (ch === " " || e.key === "space" || e.key === "enter") this.star(this.rows()[this.row]?.[0], cx);
      else if (ch === "/") { this.search = this.search ?? ""; this.searching = true; cx.notify(); }
      return true;
    }
    if (step && !keys.length) return true;
    if (step) this.at = (this.at + step + keys.length) % keys.length;
    else if (ch === "g" || ch === "G") this.at = ch === "g" ? 0 : keys.length - 1;
    else if (e.key === "enter") return keys.length && this.enter(cx), true;
    else if (ch === "/") { this.search = ""; this.searching = true; this.enter(cx); }
    else if (ch === "s") return this.sync(cx), true;
    else return false;
    this.row = 0; this.search = ch === "/" ? this.search : null;
    cx.notify();
    return true;
  }

  render(t) {
    const agents = this.agents ?? [], now = agents[this.at], key = now?.key, all = key ? offered(key) : [], rows = key ? this.rows() : [], stars = key ? starred(key) : [];
    const recipe = CATALOGS[key], source = !recipe ? "no catalog: its model is typed where it is started" : recipe.list ? "as it lists them for the signed-in account" : "the newest of each family";
    const at = Math.min(this.row, Math.max(0, rows.length - 1));
    const when = synced();
    return v_flex().size_full().min_h(0).gap(10)
      .child(heading(t, "CATALOG", when ? `from models.dev · synced ${ago(when)}` : this.syncing ? "syncing from models.dev…" : "not synced yet"))
      .when(!this.agents, (el) => el.child(div().px(10).py(6).text_color(t.dim).child(waiting(t, "Checking what is installed"))))
      .child(v_flex().flex_none().gap(2).children(agents.map((a, i) => {
        const k = a.key, on = i === this.at, list = catalog(k), n = starred(k).length;
        return h_flex().id(`models-${k}`).flex_none().h(30).px(10).gap(10).items_center().rounded(8).cursor_pointer()
          .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => { this.at = i; this.inside = false; this.searching = false; this.search = null; this.row = 0; this.hints = HINTS; this.host.handle.focus(); cx.notify(); })
          .child(logo(t, a, on))
          .child(div().flex_none().w(110).truncate().text_color(on ? t.foreground : t.muted).child(a.name))
          .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(list.length ? `newest: ${list[0][0]}` : ""))
          .child(div().flex_none().text_size(11).text_color(t.dim).child([n ? `${n} starred` : "", list.length ? `${list.length} models` : CATALOGS[k] ? "none" : "no catalog"].filter(Boolean).join(" · ")));
      })))
      .child(heading(t, "MODELS", this.search !== null ? `/${this.search}${this.searching ? "▏" : ""} · ${rows.length} of ${all.length}` : now ? `${now.name} can be started with these · ${source} · starred first` : ""))
      .child(v_flex().id("models-list").flex_1().min_h(0).overflow_y_scroll().track_scroll(this.scroll).children(rows.map(([id, name], i) => {
        const on = this.inside && i === at, has = stars.includes(id);
        return h_flex().id(`model-${id}`).flex_none().h(26).px(10).gap(10).items_center().rounded(6).cursor_pointer()
          .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => { this.host.handle.focus(); this.enter(cx, i); })
          .child(div().id(`star-${id}`).flex_none().w(14).text_color(has ? t.accent : t.dim).hover((s) => s.text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); this.host.handle.focus(); this.inside = true; this.star(id, cx); }).child(has ? "★" : "☆"))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.foreground).child(id))
          .child(div().flex_none().max_w(260).truncate().text_size(11).text_color(t.dim).child(name || (has ? "not in the catalog" : "")));
      }))
        .when(!rows.length, (el) => el.child(div().px(10).py(6).text_color(t.dim).child(all.length ? "Nothing matches." : !this.agents ? "" : !recipe ? "No catalog for this agent: type its model where it is started." : recipe.list ? "It listed none: sign in to it, then s syncs." : when ? "models.dev lists none for this agent." : "Nothing yet: s syncs the catalog."))))
      .when(Boolean(this.error), (el) => el.child(div().flex_none().px(4).text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().flex_none().px(4).justify_end()
        .child(h_flex().id("models-sync").flex_none().h(30).px(14).gap(7).items_center().rounded(8).bg(t.solid).text_color(t.solid_foreground).text_size(12)
          .when(!this.syncing, (b) => b.cursor_pointer().hover((s) => s.opacity(0.88))).on_click((_e, cx) => this.sync(cx))
          .when(Boolean(this.syncing), (b) => b.child(svg("mods/workspace-chrome/spinner.svg").size(12).spin(900)))
          .child(this.syncing ? "Syncing…" : "Sync now")));
  }
}
