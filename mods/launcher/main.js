// New tab, split or space launcher (prefix + c, v, -, N): pick a plain terminal or any installed agent, choose
// whether the agent gets its "skip the prompts" flag, and optionally start it
// in a worktrunk (`wt`) worktree. Choices are kept in ~/.config/herdr-app/launcher.json.
// An agent can carry its first message (m): optional, empty starts the agent
// with nothing said. `pane.split` has no `task`, so a split gets the message as
// the agent's last argument, which is what Herdr's `task` does for a tab.
// The message also takes files: dropped on the dialog, or pasted from the
// clipboard with ⌃V (a copied file, or an image, which is saved first). Their
// paths go after the text, so files alone are a message too. This computer only.
// An agent can be started with a model (d): chosen from the model catalog
// (models.json, synced from models.dev by the Config dialog's Models page), or
// typed. It is kept per agent in launcher.json; none is the agent's own choice,
// shown beside it when the agent's own settings name one (OWN below). A starred
// model (s in the model list; shared "models.starred", also the Models page)
// is listed first. Reasoning (r) offers that model's effort levels from the same
// catalog. Choices are kept per agent and resolved model in `reasoning`;
// Default passes no override. Only agents with a known reasoning flag offer it.
// A new tab or space also offers its folder, to edit before it is made (f) or
// choose in the system's folder picker (p, this computer only): untouched, it
// starts where Herdr would put it anyway. A split stays in its tab's folder.
// Fork uses this same picker with props { fork: { pane, terminal, key, name,
// canFork } }. Only agents are offered. Selection goes back to agent-fork:
// the same CLI forks natively; another receives a handover through hc send.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, ScrollHandle } from "gpui-base";
import { appHome, checking, closeOverlay, exec, focused, home, knownAgents, notify, openOverlay, panes, pickFolder, props, readTextFile, run, setShared, shared, spaces, theme, writeTextFile } from "herdr";

const KNOWN = "new-menu.agents"; // the + menu's last look, shown while we check again
// The agent shortlist (the Config dialog's Agents page): the agent keys this machine offers. None,
// or none of them installed on the machine being listed: Herdr's whole list.
const SHORTLIST = "agents.shortlist";
function shortlisted(agents) {
  const keys = shared(SHORTLIST);
  if (!Array.isArray(keys) || !keys.length) return null;
  const kept = agents.filter((a) => a.installed && keys.includes(a.key));
  return kept.length ? kept : null;
}
// Written to launcher.json on first use. The list is Herdr's own: a terminal,
// then every agent it finds installed (as the + menu), narrowed to the agent
// shortlist when this machine has one (e edits it). `program` is the one
// selected when the dialog opens. `programs` gives an agent its checkbox:
// `flag` is what it adds to the command, `on` is whether it is ticked. It also
// keeps the agent's `model` ("" or absent: its own choice) and can give
// `modelFlag`, for an agent MODEL_FLAG below doesn't know. `reasoning` maps
// model ids to effort levels (empty: Default). An optional `reasoningFlag`
// overrides REASONING_FLAG: an argv array, followed by the level, or with
// {value} in a config assignment (replaced with the JSON-quoted level).
const DEFAULTS = {
  program: "terminal",
  programs: {
    claude: { flag: "--dangerously-skip-permissions", on: true },
    codex: { flag: "--dangerously-bypass-approvals-and-sandbox", on: true },
  },
  // base: "default" (the repo's default branch) or "current" (where you are).
  // open: "space" (a space on the checkout, as Herdr's own worktrees) or "tab".
  worktree: { base: "default", open: "tab" },
  // A sentence typed as the branch is named by the Config dialog's Writer page choice (shared
  // "writer": agent and model, also the Git dialog's commit summaries). This
  // command is used only until a choice exists: the prompt goes in on stdin,
  // the branch name comes out on stdout.
  title: { command: "MAX_THINKING_TOKENS=0 claude -p --model claude-haiku-5-5 --tools='' --disable-slash-commands --setting-sources='' --system-prompt='' --no-session-persistence" },
};
// How each agent is told its model: the flag that goes before the model's id.
// An agent with none here, and none in launcher.json, is started without one.
const MODEL_FLAG = { claude: "--model", codex: "-m", opencode: "-m", cursor: "--model", gemini: "-m", copilot: "--model", pi: "--model" };
// The agent's own choice: the model each agent starts with when told none, as
// its own settings on that machine say. Prints "<agent key><tab><model>" lines;
// an agent whose settings name none prints nothing after the tab. A folder's
// own settings (a repo's .claude/settings.json) are not looked at.
const OWN = `j() { jq -r "$1 // empty" "$2" 2>/dev/null; }
printf 'claude\\t%s\\n' "\${ANTHROPIC_MODEL:-$(j '.env.ANTHROPIC_MODEL // .model' ~/.claude/settings.json)}"
printf 'codex\\t%s\\n' "$(awk -F'"' '/^\\[/{exit} /^model[[:space:]]*=/{print $2; exit}' ~/.codex/config.toml 2>/dev/null)"
printf 'opencode\\t%s\\n' "$(j '.model' ~/.config/opencode/opencode.json)"
printf 'gemini\\t%s\\n' "$(j '.model.name // (.model | strings)' ~/.gemini/settings.json)"
printf 'cursor\\t%s\\n' "$(j '.model.displayName // .model.modelId' ~/.cursor/cli-config.json)"`;
// CLI syntax is separate from model capabilities: the catalog supplies levels.
const REASONING_FLAG = { claude: ["--effort"], codex: ["-c", "model_reasoning_effort={value}"] };
const LEVEL_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const STARRED = "models.starred"; // { <agent key>: [model id, ...] }: listed first, in the order starred
const MODELS_SHOWN = 120; // rows drawn at most: search narrows the rest
const PROMPT = "Reply with only a git branch name for the task below: lowercase kebab-case, 2 to 5 words, no prefix, no quotes, no explanation.\n\nTask: ";
// The name offered when nothing is typed.
const A = ["quiet", "brisk", "amber", "lucid", "mellow", "nimble", "rustic", "silver", "tidal", "vivid", "wry", "bold", "calm", "deft", "keen"];
const B = ["otter", "heron", "maple", "comet", "ember", "fjord", "lotus", "raven", "willow", "quartz", "badger", "cedar", "finch", "harbor", "pebble"];
const any = (l) => l[Math.floor(Math.random() * l.length)];
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9/._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-/.]+|[-/.]+$/g, "");
const TERMINAL = { key: "terminal", name: "Terminal", terminal: true, installed: true };
// Worktrunk shortcuts that name something to switch to, never a new branch.
const SHORTCUT = /^(?:(?:pr|mr):\d+|[\^@-])$/;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const ROW = 28;

const clean = (s) => (s ?? "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").trim();
const words = (flag) => (Array.isArray(flag) ? flag : String(flag ?? "").split(/\s+/)).filter(Boolean);
const inside = (p, dir) => p === dir || p.startsWith(dir + "/");
// Prints the folder's full path, or fails: "~" is the home of the machine it runs on.
// Prints the path of the clipboard's file, or of its image saved as a PNG; fails when it holds neither.
const CLIP = `d="\${TMPDIR:-/tmp}/herdr-launcher"; mkdir -p "$d" || exit 1
f=$(osascript -e 'POSIX path of (the clipboard as «class furl»)' 2>/dev/null)
case $f in /*) [ -e "$f" ] && { printf %s "$f"; exit 0; } ;; esac
f="$d/image-$(date +%Y%m%d-%H%M%S).png"
osascript -e 'on run argv' -e 'set d to the clipboard as «class PNGf»' -e 'set fp to open for access (POSIX file (item 1 of argv)) with write permission' -e 'set eof fp to 0' -e 'write d to fp' -e 'close access fp' -e 'end run' "$f" >/dev/null 2>&1
[ -s "$f" ] && { printf %s "$f"; exit 0; }
rm -f "$f"; exit 1`;
const RESOLVE = 'p=$1; case $p in "~") p=$HOME ;; "~/"*) p=$HOME/${p#"~/"} ;; esac; cd "$p" 2>/dev/null && pwd';

// Escape is bound to an action of this mod's own: while a text field has the
// keyboard, Herdr closes the dialog on Escape before any key handler here sees it.
let escapeBound = false;

export default class Launcher extends View {
  init(_props, cx) {
    if (!escapeBound) { cx.bind_keys([{ keystroke: "escape", action: "launcher-escape", context: "Launcher" }]); escapeBound = true; }
    this.fork = props()?.fork ?? null;
    const f = focused();
    const source = this.fork ? panes().find((p) => p.pane === this.fork.pane) : null;
    const space = this.fork ? spaces().find((s) => s.tabs?.some((tab) => tab.id === source?.tab))
      : spaces().find((s) => s.id === f?.space) ?? spaces().find((s) => s.active);
    this.space = space?.id;
    this.on = space?.machine ?? null;
    this.pane = this.fork?.pane ?? f?.pane ?? null;
    this.cwd = this.fork ? source?.cwd ?? null : f?.cwd ?? panes().find((p) => p.focused)?.cwd ?? null;
    this.picked = this.fork?.key;
    this.path = `${appHome()}/launcher.json`;
    this.cfg = null; // until launcher.json is read
    this.raw = null;
    this.agents = shared(KNOWN)?.[this.on ?? ""] ?? [];
    this.wt = false; // worktree mode
    this.search = null; // "/" filters the program list: null when off
    this.catalog = {}; // agent key -> [[model id, name, reasoning levels], ...]
    this.own = {}; // each agent's own choice of model, where its settings name one: agent key -> model
    this.models = null; // the model list, when open: { at, search } ("/" filters it: null when off)
    this.modelScroll = ScrollHandle.new();
    this.list = undefined; // undefined: not read, null: failed (see listError)
    this.text = "";
    this.generated = `${any(A)}-${any(B)}`;
    this.defaultBranch = "";
    this.status = "";
    this.at = 0;
    this.busy = false;
    this.error = "";
    this.scroll = ScrollHandle.new();
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.input = InputState.new({ value: "", placeholder: "branch name, or a sentence to name it from" });
    this.input.on("change", (_e, cx) => { this.text = this.input.value(); this.at = 0; this.error = ""; cx.notify(); });
    this.input.on("submit", (_e, cx) => this.start(cx));
    this.inputFocused = false;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; cx.notify(); });
    // A new tab's or space's folder: where the focused pane is, until edited. Here, "~" stands for home.
    const mine = this.on === null && this.cwd && inside(this.cwd, home());
    this.offered = mine ? `~${this.cwd.slice(home().length)}` : this.cwd ?? "";
    this.folder = InputState.new({ value: this.offered, placeholder: "folder (empty: where Herdr starts it)" });
    this.folderFocused = false;
    this.folder.on("change", (_e, cx) => { this.error = ""; cx.notify(); });
    this.folder.on("submit", (_e, cx) => this.start(cx));
    this.folder.on("focus", (_e, cx) => { this.folderFocused = true; cx.notify(); });
    // Leaving the field settles it, so the worktree list is read from the folder typed.
    this.folder.on("blur", (_e, cx) => {
      this.folderFocused = false;
      cx.notify();
      if (this.wt && !this.busy) cx.spawn(async (cx) => { try { await this.settle(cx); } catch (error) { this.error = String(error?.message ?? error); cx.notify(); } });
    });
    // An agent's first message: optional.
    // A text box: Enter and Shift+Enter add a new line, Cmd+Enter starts.
    this.message = TextareaState.new({ value: "", placeholder: "first message (optional): drop or ⌃V a file", rows: 1 });
    this.message.set_auto_grow(1, 6);
    this.files = []; // full paths, sent after the text
    this.messageFocused = false;
    this.message.on("submit", (e, cx) => {
      if (e?.secondary) this.start(cx);
      else if (e?.shift) this.message.replace("\n");
    });
    this.message.on("focus", (_e, cx) => { this.messageFocused = true; cx.notify(); });
    this.message.on("blur", (_e, cx) => { this.messageFocused = false; cx.notify(); });
    if (checking()) return;
    cx.spawn(async (cx) => {
      let parsed = {};
      try {
        this.raw = await readTextFile(this.path);
        if (this.raw !== null) parsed = JSON.parse(this.raw);
      } catch (error) {
        // A broken file is the person's to fix: use the defaults, leave it alone.
        this.readonly = true;
        notify({ title: "launcher.json is invalid", body: String(error), level: "warning" });
      }
      this.cfg = { ...DEFAULTS, ...parsed, programs: parsed.programs ?? DEFAULTS.programs, worktree: { ...DEFAULTS.worktree, ...parsed.worktree }, title: { ...DEFAULTS.title, ...parsed.title } };
      if (this.raw === null) this.save(cx);
      cx.notify();
    });
    cx.spawn(async (cx) => {
      try { this.agents = await knownAgents({ on: this.on }); } catch { this.failed = true; }
      cx.notify();
    });
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", OWN], { on: this.on, timeout: 10_000 });
        for (const line of r.stdout.split("\n")) {
          const [key, model] = line.split("\t");
          if (key && model?.trim()) this.own[key] = model.trim();
        }
      } catch {}
      cx.notify();
    });
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(`${appHome()}/models.json`);
        const read = text ? JSON.parse(text) : null;
        if (read?.agents) { this.catalog = read.agents; this.synced = true; }
      } catch {}
      cx.notify();
    });
  }

  // launcher.json, one write at a time. The first starts at the call, so it
  // still lands when the dialog closes right after; a change made while one is
  // in flight is written when that one ends.
  save(cx) {
    if (this.readonly) return;
    this.dirty = true;
    if (this.writing) return;
    this.writing = true;
    const write = () => {
      this.dirty = false;
      const text = JSON.stringify(this.cfg, null, 2) + "\n";
      return [writeTextFile(this.path, text, this.raw), text];
    };
    let [pending, text] = write();
    let retried = false;
    cx.spawn(async () => {
      for (;;) {
        try { await pending; this.raw = text; }
        catch (error) {
          // Edited meanwhile: our choices win, once.
          try { this.raw = await readTextFile(this.path); } catch {}
          if (retried) console.log(`launcher: ${error}`);
          else { retried = true; this.dirty = true; }
        }
        if (!this.dirty) break;
        [pending, text] = write();
      }
      this.writing = false;
    });
  }

  programs() {
    // The shortlist when there is one. Else as the + menu: the installed ones,
    // then two it could not find.
    // The curtain (mods/curtain) is drawn: a plain terminal is all there is.
    if (shared("curtain")?.on) return this.fork ? [] : [TERMINAL];
    const installed = this.agents.filter((a) => a.installed);
    const shown = shortlisted(this.agents) ?? (this.failed ? installed : [...installed, ...this.agents.filter((a) => !a.installed).slice(0, 2)]);
    return [...(this.fork ? [] : [TERMINAL]), ...shown.map((a) => {
      const c = this.cfg?.programs?.[a.key];
      return { key: a.key, name: a.name, icon: a.icon, tint: a.tint, run: a.run, installed: a.installed, flag: words(c?.flag), on: c?.on !== false, modelFlag: words(c?.modelFlag ?? MODEL_FLAG[a.key]), model: String(c?.model ?? "").trim(), reasoningFlag: words(c?.reasoningFlag ?? REASONING_FLAG[a.key]) };
    })];
  }

  // The list as shown: all of it, or what "/" matches.
  shown() {
    const f = (this.search ?? "").trim().toLowerCase();
    return this.programs().filter((p) => !f || `${p.name} ${p.key}`.toLowerCase().includes(f));
  }

  current() {
    const all = this.shown();
    if (this.search !== null) return all.find((p) => p.installed && p.key === this.picked) ?? all.find((p) => p.installed) ?? null;
    return all.find((p) => p.key === (this.picked ?? this.cfg?.program)) ?? all[0];
  }

  pick(key, cx) {
    this.picked = key;
    this.error = "";
    // A plain shell takes no message: its field goes, so the keyboard goes back.
    if (this.messageFocused && key === TERMINAL.key) this.wt ? this.input.focus() : this.handle.focus();
    cx.notify();
  }

  cycle(step, cx) {
    const all = this.shown().filter((p) => p.installed);
    if (!all.length) return;
    const i = Math.max(0, all.findIndex((p) => p.key === this.current()?.key));
    this.pick(all[(i + step + all.length) % all.length].key, cx);
  }

  toggleFlag(cx) {
    const p = this.current();
    if (!p || p.terminal || !p.flag.length) return;
    this.cfg.programs[p.key] = { ...this.cfg.programs[p.key], on: !p.on };
    this.save(cx);
    cx.notify();
  }

  // Whether the agent can be told a model: a plain shell can't, nor an agent with no flag for it.
  takesModel(p = this.current()) {
    return Boolean(p) && !p.terminal && (p.modelFlag ?? []).length > 0;
  }

  // Resolve Default through the agent's own settings when they name a catalog model.
  reasoningModel(p = this.current()) {
    return p?.model || this.own[p?.key] || "";
  }

  reasoningLevels(p = this.current()) {
    if (!p || p.terminal || !p.reasoningFlag?.length) return [];
    const row = (this.catalog[p.key] ?? []).find(([id]) => id === this.reasoningModel(p));
    if (!Array.isArray(row?.[2])) return [];
    const levels = [...new Set(row[2].filter((v) => typeof v === "string" && v.length > 0))];
    const rank = (v) => { const i = LEVEL_ORDER.indexOf(v); return i < 0 ? LEVEL_ORDER.length : i; };
    return levels.sort((a, b) => rank(a) - rank(b));
  }

  reasoningLevel(p = this.current()) {
    const saved = this.cfg?.programs?.[p?.key]?.reasoning?.[this.reasoningModel(p)];
    return this.reasoningLevels(p).includes(saved) ? saved : "";
  }

  chooseReasoning(value, cx) {
    const p = this.current(), levels = this.reasoningLevels(p);
    if (!this.cfg || this.busy || !levels.length || (value && !levels.includes(value))) return;
    const current = this.cfg.programs[p.key] ?? {};
    this.cfg.programs[p.key] = { ...current, reasoning: { ...current.reasoning, [this.reasoningModel(p)]: value } };
    this.save(cx);
    cx.notify();
  }

  cycleReasoning(cx) {
    const levels = ["", ...this.reasoningLevels()];
    this.chooseReasoning(levels[(levels.indexOf(this.reasoningLevel()) + 1) % levels.length], cx);
  }

  reasoningArgs(p) {
    const value = this.reasoningLevel(p);
    if (!value) return [];
    const flag = p.reasoningFlag;
    // A config assignment needs a quoted string; ordinary flags take a separate argument.
    return flag.some((arg) => arg.includes("{value}"))
      ? flag.map((arg) => arg.replace(/\{value\}/g, JSON.stringify(value))) : [...flag, value];
  }

  starred(p = this.current()) {
    const ids = shared(STARRED)?.[p?.key];
    return Array.isArray(ids) ? ids : [];
  }

  // The model list's rows: the agent's own choice, the kept model when it is
  // neither starred nor in the catalog, the starred ones, then the catalog's
  // others. Searching: what matches, then the text itself, so a model the
  // catalog doesn't know can still be used.
  modelRows(p = this.current()) {
    const known = this.catalog[p?.key] ?? [], stars = this.starred(p), typed = (this.models?.search ?? "").trim(), f = typed.toLowerCase();
    const all = [...stars.map((id) => [id, known.find((m) => m[0] === id)?.[1] ?? ""]), ...known.filter(([id]) => !stars.includes(id))];
    const row = ([id, name]) => ({ id, name: name ?? "", starred: stars.includes(id) });
    if (f) {
      const found = all.filter(([id, name]) => `${id} ${name ?? ""}`.toLowerCase().includes(f)).map(row);
      return found.some((r) => r.id.toLowerCase() === f) ? found : [...found, { id: typed, name: "as typed", typed: true }];
    }
    const kept = p?.model && !all.some(([id]) => id === p.model) ? [{ id: p.model, name: "not in the catalog" }] : [];
    return [{ id: "", name: `${p?.name ?? "the agent"}'s own choice`, own: this.own[p?.key] ?? "" }, ...kept, ...all.map(row)];
  }

  openModels(cx) {
    const p = this.current();
    if (!this.takesModel(p) || this.busy) return;
    this.search = null;
    this.error = "";
    this.models = { at: Math.max(0, this.modelRows(p).findIndex((r) => r.id === p.model)), search: null };
    this.handle.focus();
    this.modelScroll.scroll_to_item(this.models.at);
    cx.notify();
  }

  // Steps back out of the model list, to where the keyboard was.
  closeModels(cx) {
    this.models = null;
    this.wt ? this.input.focus() : this.handle.focus();
    cx.notify();
  }

  moveModel(step, cx, to) {
    const n = Math.min(this.modelRows().length, MODELS_SHOWN);
    if (!n) return;
    this.models.at = to === undefined ? (Math.min(this.models.at, n - 1) + step + n) % n : to < 0 ? n - 1 : to;
    this.modelScroll.scroll_to_item(this.models.at);
    cx.notify();
  }

  // Stars the model chosen in the list, or takes its star off; the selection stays on it.
  starModel(cx) {
    const p = this.current(), row = this.modelRows(p)[this.models.at];
    if (!p || !row?.id) return;
    const now = this.starred(p), next = now.includes(row.id) ? now.filter((id) => id !== row.id) : [...now, row.id];
    const all = { ...shared(STARRED) };
    if (next.length) all[p.key] = next; else delete all[p.key];
    setShared(STARRED, Object.keys(all).length ? all : null);
    this.models.at = Math.max(0, this.modelRows(p).findIndex((r) => r.id === row.id));
    this.modelScroll.scroll_to_item(this.models.at);
    cx.notify();
  }

  chooseModel(cx, row = this.modelRows()[this.models.at]) {
    const p = this.current();
    if (!row || !p) return;
    this.cfg.programs[p.key] = { ...this.cfg.programs[p.key], model: row.id };
    this.save(cx);
    this.closeModels(cx);
  }

  // Sets a worktree option, or with two values flips between them.
  option(name, value, cx) {
    this.cfg.worktree[name] = Array.isArray(value) ? value.find((v) => v !== this.cfg.worktree[name]) : value;
    this.save(cx);
    cx.notify();
  }

  // How it was opened: prefix + c is a new tab; prefix + v or - passes
  // { place: "right" | "down" }, a split of the focused pane; prefix + N passes
  // { place: "space" }, a new space. A split stays in its tab's folder, so it
  // never takes a worktree; a space's worktree always opens as that space.
  place() {
    if (this.fork) return "right";
    const place = props()?.place;
    return place === "right" || place === "down" || place === "space" ? place : "tab";
  }

  split() {
    return this.place() === "right" || this.place() === "down";
  }

  // The folder typed for a new tab or space, as a full path: null when the field was
  // left as offered or emptied. Throws when there is no such folder. In
  // worktree mode it is also where the repository is looked for.
  async settle(cx) {
    const typed = this.folder.value().trim();
    if (this.split() || !typed || typed === this.offered) return null;
    if (typed === this.settled?.typed) return this.settled.path;
    const r = await exec("sh", ["-c", RESOLVE, "sh", typed], { on: this.on, timeout: 10_000 });
    const path = r.code === 0 ? r.stdout.trim() : "";
    if (!path) throw new Error(`No folder at ${typed}`);
    this.settled = { typed, path };
    if (path !== this.cwd) {
      this.cwd = path;
      this.list = undefined;
      this.at = 0;
      if (this.wt) this.load(cx);
    }
    return path;
  }

  editFolder(cx) {
    if (this.split() || this.busy) return;
    this.search = null;
    this.folder.focus();
    cx.notify();
  }

  // The system's folder picker fills the field. It only sees this computer.
  canBrowse() {
    return this.on === null && !this.split();
  }

  browse(cx) {
    if (!this.canBrowse() || this.busy || this.browsing) return;
    this.browsing = true;
    cx.spawn(async (cx) => {
      try {
        const dir = await pickFolder({ prompt: "Start here" });
        if (dir) {
          this.folder.set_value(inside(dir, home()) ? `~${dir.slice(home().length)}` : dir);
          this.error = "";
        }
        this.wt ? this.input.focus() : this.handle.focus();
        if (dir && this.wt) await this.settle(cx);
      } catch (error) { this.error = String(error?.message ?? error); }
      this.browsing = false;
      cx.notify();
    });
  }

  // Whether the first message applies: an agent, not a plain shell.
  takesMessage(p = this.current()) {
    return Boolean(p) && !p.terminal;
  }

  editMessage(cx) {
    if (!this.takesMessage() || this.busy) return;
    this.search = null;
    this.message.focus();
    cx.notify();
  }

  // Files for the first message: dropped, or from the clipboard.
  attach(paths, cx) {
    if (this.busy) return;
    if (!this.takesMessage()) this.error = "A plain shell takes no message: choose an agent first.";
    else if (this.on !== null) this.error = `Files here are not on ${this.on}: only this computer's agents can take them.`;
    else {
      this.error = "";
      for (const p of paths) if (p && !this.files.includes(p)) this.files.push(p);
    }
    cx.notify();
  }

  // ⌃V: the clipboard's file, or its image saved as a PNG.
  pasteFile(cx) {
    if (this.pasting || this.busy) return;
    if (!this.takesMessage() || this.on !== null) return this.attach([], cx);
    this.pasting = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", CLIP], { timeout: 10_000 });
        if (r.code === 0 && r.stdout.trim()) this.attach([r.stdout.trim()], cx);
        else this.error = "No file or image in the clipboard.";
      } catch (error) { this.error = String(error?.message ?? error); }
      this.pasting = false;
      cx.notify();
    });
  }

  detach(i, cx) {
    this.files.splice(i, 1);
    cx.notify();
  }

  // The first message as command arguments: the text, then the files' paths. Nothing when there is neither.
  task(p) {
    if (!this.takesMessage(p)) return {};
    const files = this.on === null ? this.files.map((f) => (/\s/.test(f) ? `"${f}"` : f)) : [];
    const text = [this.message.value().trim(), ...files].filter(Boolean).join(" ");
    return text ? { task: text } : {};
  }

  toggleWorktree(cx) {
    if (this.split()) return;
    this.wt = !this.wt;
    this.search = null;
    this.error = "";
    if (!this.wt) this.handle.focus();
    else {
      this.input.focus();
      if (this.list === undefined) this.load(cx);
    }
    cx.notify();
  }

  // Worktrees and branches, as worktrunk lists them.
  load(cx) {
    cx.spawn(async (cx) => {
      try {
        if (!this.cwd) throw new Error("No folder to look for a repository in.");
        const at = { cwd: this.cwd, on: this.on };
        const branch = exec("wt", ["config", "state", "default-branch"], at).catch(() => null);
        const r = await exec("wt", ["list", "--format", "json", "--branches"], at);
        if (r.code !== 0) throw new Error(clean(r.stderr) || "wt list failed.");
        this.list = JSON.parse(r.stdout).filter((w) => w.branch).map((w) => ({ branch: w.branch, path: w.kind === "worktree" ? w.path : null, main: Boolean(w.is_main), here: Boolean(w.is_current) }));
        cx.notify();
        const d = await branch;
        if (d?.code === 0) this.defaultBranch = d.stdout.trim().split("\n").pop();
      } catch (error) {
        if (this.list) return;
        this.list = null;
        this.listError = String(error?.message ?? error).split("\n").slice(-3).join("\n");
      }
      cx.notify();
    });
  }

  // What Enter can act on: the typed name first (unless it is a branch), then matches.
  rows() {
    const typed = this.text.trim();
    if (!typed) return [{ branch: this.generated, typed: true, create: true, generated: true }, ...(this.list ?? [])];
    if (/\s/.test(typed)) return [{ branch: typed, typed: true, create: true, sentence: true }];
    const f = typed.toLowerCase();
    const found = (this.list ?? []).filter((w) => w.branch.toLowerCase().includes(f));
    if (found.some((w) => w.branch === typed)) return found;
    return [{ branch: typed, typed: true, create: !SHORTCUT.test(typed) }, ...found];
  }

  argv(p) {
    return p.terminal ? undefined : [...p.run, ...(p.on ? p.flag : []), ...(p.model && p.modelFlag.length ? [...p.modelFlag, p.model] : []), ...this.reasoningArgs(p)];
  }

  close() {
    closeOverlay(props().overlay);
  }

  start(cx, program = this.current()) {
    if (!this.cfg || this.busy || !program) return;
    if (!program.installed) { this.error = `${program.name} is not installed here.`; return cx.notify(); }
    const argv = this.argv(program);
    const task = this.task(program);
    if (this.fork) {
      if (program.terminal || !argv) return;
      if (program.key === this.fork.key && !this.fork.canFork) {
        this.error = "No native fork recipe for " + program.name + " yet. Choose another CLI to hand over.";
        return cx.notify();
      }
      this.busy = true;
      this.close();
      openOverlay({ mod: "agent-fork", kind: "dialog", width: 440, height: 120, frame: "none",
        props: { source: this.fork, target: { key: program.key, name: program.name, run: program.run, argv, ...task } } });
      return;
    }
    if (this.split()) {
      this.close();
      run("pane.split", { direction: this.place(), ...(this.pane ? { pane: this.pane } : {}), ...(argv ? { argv: task.task ? [...argv, task.task] : argv } : {}) });
      return;
    }
    // A new tab in the folder offered: nothing to look up first.
    const typed = this.folder.value().trim();
    if (!this.wt && this.place() === "tab" && (!typed || typed === this.offered)) {
      this.close();
      run("tab.new", { space: this.space, ...(argv ? { name: program.name, argv, ...task } : {}) });
      return;
    }
    let row = this.wt ? this.rows()[this.at] : null;
    if (this.wt && !row) { this.error = "Type a branch name."; return cx.notify(); }
    this.busy = true;
    this.status = "";
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const folder = await this.settle(cx);
        if (!this.wt) {
          if (this.place() === "space") run("space.new", { machine: this.on ?? "", ...(folder ? { folder } : {}), ...(argv ? { tab: program.name, argv, ...task } : {}) });
          else run("tab.new", { space: this.space, ...(folder ? { folder } : {}), ...(argv ? { name: program.name, argv, ...task } : {}) });
          return this.close();
        }
        if (row.sentence) {
          this.status = "naming the branch…";
          cx.notify();
          row = { ...row, branch: await this.name(row.branch) };
        }
        this.status = `worktrunk is making ${row.branch}…`;
        cx.notify();
        this.error = await this.worktree(row, program, argv, task);
      }
      catch (error) { this.error = String(error?.message ?? error); }
      this.busy = false;
      if (!this.error) this.close();
      cx.notify();
    });
  }

  // A branch name for a sentence, from the title command; the sentence's own
  // first words if that fails. Never an existing branch's name.
  async name(sentence) {
    let name = "";
    try {
      const r = await exec("sh", ["-c", `printf %s "$1" | ${shared("writer")?.command || this.cfg.title.command}`, "sh", PROMPT + sentence], { on: this.on, timeout: 60_000 });
      if (r.code === 0) name = slug(clean(r.stdout).split("\n").filter(Boolean).pop() ?? "").slice(0, 60);
    } catch {}
    name = name.replace(/-+$/, "") || slug(sentence.split(/\s+/).slice(0, 5).join(" ")) || this.generated;
    const taken = new Set((this.list ?? []).map((w) => w.branch));
    let out = name;
    for (let i = 2; taken.has(out); i++) out = `${name}-${i}`;
    return out;
  }

  // `wt switch` makes or finds the checkout and runs worktrunk's hooks; --no-cd
  // because the new tab starts there itself.
  async worktree(row, program, argv, task) {
    const { base } = this.cfg.worktree;
    const open = this.place() === "space" ? "space" : this.cfg.worktree.open;
    const args = ["switch", ...(row.create ? ["--create", ...(base === "current" ? ["--base", "@"] : [])] : []), "--no-cd", "--format", "json", row.branch];
    const r = await exec("wt", args, { cwd: this.cwd, on: this.on, timeout: 600_000 });
    let made;
    try { made = JSON.parse(r.stdout.split("\n").find((l) => l.trim().startsWith("{"))); } catch {}
    if (r.code !== 0 || !made?.path) return clean(r.stderr).split("\n").slice(-3).join("\n") || "wt switch failed.";
    const tab = argv ? { name: program.name, argv, ...task } : {};
    if (open === "tab") {
      run("tab.new", { space: this.space, folder: made.path, name: made.branch ?? row.branch, ...tab });
      return "";
    }
    // A space already on this checkout gets the tab; else a new space, unnamed
    // so it follows the folder and nests under its repo.
    const all = panes();
    const there = spaces().find((s) => {
      if ((s.machine ?? null) !== this.on) return false;
      const tabs = new Set(s.tabs.map((t) => t.id));
      const at = all.find((p) => tabs.has(p.tab) && p.cwd)?.cwd;
      return at && inside(at, made.path) && !(this.list ?? []).some((w) => w.path && w.path.length > made.path.length && inside(at, w.path));
    });
    if (there) {
      run("space.select", { id: there.id });
      run("tab.new", { space: there.id, folder: made.path, ...tab });
    } else run("space.new", { folder: made.path, machine: this.on ?? "", ...(argv ? { tab: program.name, argv, ...task } : {}) });
    return "";
  }

  key(e, cx) {
    const m = e.modifiers;
    if (e.key === "escape") {
      // Escape steps back out of whichever field has the keyboard, not out of the Launcher.
      if (this.folderFocused || this.messageFocused || this.inputFocused) {
        cx.stop_propagation();
        this.folderFocused = this.messageFocused = this.inputFocused = false;
        this.handle.focus();
        return cx.notify();
      }
      // Then out of the model list's search, then out of the model list.
      if (this.models) {
        cx.stop_propagation();
        if (this.models.search === null) return this.closeModels(cx);
        this.models.search = null;
        this.models.at = 0;
        return cx.notify();
      }
      if (this.search === null) return this.close();
      cx.stop_propagation();
      this.search = null;
      return cx.notify();
    }
    if (!this.cfg || this.busy) return;
    const done = () => cx.stop_propagation();
    if (this.models) {
      // The model list has the keyboard: j k g G choose, / searches, Enter uses the one chosen.
      done();
      if (m.alt || m.platform) return;
      const char = e.key_char ?? e.key, searching = this.models.search !== null;
      if (m.control) {
        if (e.key === "j" || e.key === "k") this.moveModel(e.key === "j" ? 1 : -1, cx);
        else if (e.key === "d") this.closeModels(cx);
        return;
      }
      if (e.key === "enter") return this.chooseModel(cx);
      if (e.key === "up" || e.key === "down") return this.moveModel(e.key === "down" ? 1 : -1, cx);
      if (searching) {
        if (e.key === "backspace") this.models.search = this.models.search ? this.models.search.slice(0, -1) : null;
        else if (e.key_char && e.key_char.length === 1 && e.key_char >= " ") this.models.search += e.key_char;
        else return;
        this.models.at = 0;
        this.modelScroll.scroll_to_item(0);
        return cx.notify();
      }
      if (char === "j" || char === "k") return this.moveModel(char === "j" ? 1 : -1, cx);
      if (char === "g" || char === "G") return this.moveModel(0, cx, char === "g" ? 0 : -1);
      if (char === "/") { this.models.search = ""; this.models.at = 0; return cx.notify(); }
      if (char === "s") return this.starModel(cx);
      if (char === "d") return this.closeModels(cx);
      return;
    }
    if (e.key === "tab") { done(); return this.cycle(m.shift ? -1 : 1, cx); }
    // Vim keys: plain hjkl in the program list; ctrl-j/k in the branch list,
    // where plain letters are typed into the field.
    const vim = { j: "down", k: "up", l: "down", h: "up" }[e.key];
    if (m.control && !m.alt && !m.platform) {
      if (e.key === "j" || e.key === "k") {
        if (this.wt) return this.move(vim, cx);
        if (this.search !== null) { done(); return this.cycle(e.key === "k" ? -1 : 1, cx); }
      }
      const action = { r: () => this.cycleReasoning(cx), d: () => this.openModels(cx), f: () => this.editFolder(cx), m: () => this.editMessage(cx), v: () => this.pasteFile(cx), p: () => this.browse(cx), s: () => this.toggleFlag(cx), w: () => this.toggleWorktree(cx), b: () => this.option("base", ["default", "current"], cx), o: () => this.place() === "space" || this.option("open", ["space", "tab"], cx) }[e.key];
      if (action) { done(); action(); }
      return;
    }
    // ⌘V with no text to paste: the clipboard's file or image, as ⌃V.
    if (m.platform && e.key === "v" && this.messageFocused && cx.read_from_clipboard() === undefined) { done(); return this.pasteFile(cx); }
    if (m.alt || m.platform) return;
    // A field has the keyboard: letters are typed, and Enter is its own (the first message takes ⌘↵ to start).
    if (this.folderFocused || this.messageFocused) return;
    if (this.wt) {
      // The input has the keyboard: only list keys are ours.
      if (e.key === "down" || e.key === "up") this.move(e.key, cx);
      else if (e.key === "enter") { done(); this.start(cx); }
      else if (!this.inputFocused) {
        // Stepped back out of the branch field: j k choose, i or / goes back in.
        done();
        const char = e.key_char ?? e.key;
        if (char === "j" || char === "k") this.move(vim, cx);
        else if (char === "i" || char === "/") { this.input.focus(); cx.notify(); }
        else if (char === "w") this.toggleWorktree(cx);
        else if (char === "d") this.openModels(cx);
        else if (char === "r") this.cycleReasoning(cx);
      }
      return;
    }
    done();
    const all = this.programs();
    const char = e.key_char ?? e.key;
    if (e.key === "enter") return this.start(cx);
    if (this.search !== null) {
      // Searching: keys are typed; arrows (or ctrl-j/k) move, backspace on nothing leaves.
      if (e.key === "up" || e.key === "down") return this.cycle(e.key === "up" ? -1 : 1, cx);
      if (e.key === "backspace") this.search = this.search ? this.search.slice(0, -1) : null;
      else if (e.key_char && e.key_char.length === 1 && e.key_char >= " ") this.search += e.key_char;
      else return;
      return cx.notify();
    }
    if (char === "/") { this.search = ""; return cx.notify(); }
    const dir = e.key === "up" || e.key === "down" ? e.key : !m.shift ? vim : null;
    if (dir) return this.cycle(dir === "up" ? -1 : 1, cx);
    if (/^[1-9]$/.test(char) && all[Number(char) - 1]) {
      // A digit selects that one; only Enter starts it.
      const p = all[Number(char) - 1];
      if (p.installed) return this.pick(p.key, cx);
      this.error = `${p.name} is not installed here.`;
      return cx.notify();
    }
    if (char === " " || e.key === "space" || char === "s") return this.toggleFlag(cx);
    if (char === "w") return this.toggleWorktree(cx);
    if (char === "d") return this.openModels(cx);
    if (char === "r") return this.cycleReasoning(cx);
    if (char === "f") return this.editFolder(cx);
    if (char === "m") return this.editMessage(cx);
    if (char === "x" && this.files.length) return this.detach(this.files.length - 1, cx);
    if (char === "p") return this.browse(cx);
    if (char === "e") { setShared("config.page", "agents"); return run("mod.open", { name: "config" }); }
  }

  // Moves the branch list's selection.
  move(dir, cx) {
    cx.stop_propagation();
    const n = this.rows().length;
    if (!n) return;
    this.at = (this.at + (dir === "down" ? 1 : n - 1)) % n;
    this.scroll.scroll_to_item(this.at);
    cx.notify();
  }

  box(t, on, enabled = true) {
    return div().flex_none().size(15).rounded(4).border(1).border_color(on && enabled ? t.accent : t.input)
      .when(on && enabled, (el) => el.bg(t.accent))
      .flex().items_center().justify_center().text_size(10).text_color(t.accent_foreground).child(on ? "✓" : "");
  }

  hint(t, text) {
    return div().flex_none().text_size(11).text_color(t.dim).child(text);
  }

  segment(t, id, label, values, now, hint, set) {
    return h_flex().items_center().gap(6).child(div().text_color(t.muted).child(label))
      .child(h_flex().rounded(6).border(1).border_color(t.border).overflow_hidden().children(values.map(([value, name]) =>
        div().id(`${id}-${value}`).px(8).h(22).flex().items_center().cursor_pointer()
          .text_color(value === now ? t.foreground : t.dim).when(value === now, (el) => el.bg(t.selected))
          .on_click((_e, cx) => set(value, cx)).child(name))))
      .child(this.hint(t, hint));
  }

  render(cx) {
    const t = theme();
    const all = this.shown();
    const numbered = this.search === null;
    const cur = this.current() ?? { key: "", name: "", flag: [], none: true };
    const rows = this.wt ? this.rows() : [];
    const mono = "JetBrains Mono";
    const command = cur.none ? "" : cur.terminal ? "your shell" : this.argv(cur).join(" ");

    const chips = v_flex().id("programs").max_h(ROW * 8).overflow_y_scroll().children(all.map((p, i) => {
      const on = p.key === cur.key;
      const icon = p.terminal ? svg("icons/shell.svg").size(14).text_color(t.foreground) : p.tint ? svg(p.icon).size(14).text_color(t.foreground) : image(p.icon).size(14);
      return h_flex().id(`p-${p.key}`).flex_none().h(ROW + 2).px(9).gap(10).items_center().rounded(7)
        .when(p.installed, (el) => el.cursor_pointer().on_click((_e, cx) => this.pick(p.key, cx)))
        .when(on, (el) => el.bg(t.selected)).when(!on && p.installed, (el) => el.hover((s) => s.bg(t.hover)))
        .child(icon)
        .child(div().flex_1().min_w(0).truncate().text_color(p.installed ? t.foreground : t.dim).child(p.name))
        .child(this.hint(t, !p.installed ? "not installed" : [
          ...(this.fork ? [p.key === this.fork.key ? (this.fork.canFork ? "native fork" : "no fork recipe") : "handover"] : []),
          numbered && i < 9 ? String(i + 1) : ""
        ].filter(Boolean).join(" · ")));
    })).when(this.agents.length > 0 && all.length === 0, (el) => el.child(div().px(9).py(6).text_color(t.dim).child("Nothing matches."))).when(this.agents.length === 0, (el) => el.child(div().px(9).py(6).text_color(t.dim).child(this.failed ? "Could not check installed agents" : "Checking installed agents…")));

    const searchBar = h_flex().h(30).px(9).gap(8).items_center().rounded(6).border(1).border_color(t.accent).bg(t.background)
      .child(div().text_color(t.accent).child("/"))
      .child(h_flex().flex_1().min_w(0).items_center().child(div().truncate().child(this.search ?? "")).child(div().w(1).h(15).bg(t.foreground).loop("opacity", { from: 0.2, to: 1, period: 1000 })))
      .child(this.hint(t, "esc"));

    const flag = cur.terminal || !cur.flag.length
      ? h_flex().h(ROW).px(2).gap(9).items_center().child(this.box(t, false, false)).child(div().flex_1().text_color(t.dim).child(cur.none ? "" : cur.terminal ? "A plain shell takes no flags" : `No flag for ${cur.name} in launcher.json`))
      : h_flex().id("flag").h(ROW).px(2).gap(9).items_center().cursor_pointer().on_click((_e, cx) => this.toggleFlag(cx))
        .child(this.box(t, cur.on))
        .child(div().flex_1().min_w(0).truncate().font_family(mono).text_size(12).text_color(cur.on ? t.foreground : t.muted).child(cur.flag.join(" ")))
        .child(this.hint(t, this.wt ? "⌃S" : "space"));

    // The agent's model: opens the model list.
    const typing = this.folderFocused || this.messageFocused || (this.wt && this.inputFocused);
    const model = !this.takesModel(cur)
      ? h_flex().h(ROW).px(2).gap(9).items_center().child(svg("mods/launcher/cpu.svg").size(14).flex_none().text_color(t.dim)).child(div().flex_1().text_color(t.dim).child(`No model flag for ${cur.name} in launcher.json`))
      : h_flex().id("model").h(ROW).px(2).gap(9).items_center().cursor_pointer().on_click((_e, cx) => this.openModels(cx))
        .child(svg("mods/launcher/cpu.svg").size(14).flex_none().text_color(t.muted))
        .child(div().flex_none().text_color(t.muted).child("Model"))
        .when(Boolean(cur.model), (el) => el.child(div().flex_1().min_w(0).truncate().font_family(mono).text_size(12).text_color(t.foreground).child(cur.model)))
        .when(!cur.model, (el) => el.child(h_flex().flex_1().min_w(0).gap(8).items_center()
          .child(div().flex_none().text_color(t.dim).child(`${cur.name}'s own choice`))
          .when(Boolean(this.own[cur.key]), (el) => el.child(div().min_w(0).truncate().font_family(mono).text_size(12).text_color(t.muted).child(this.own[cur.key])))))
        .child(this.hint(t, typing ? "⌃D" : "d"));

    const levels = this.reasoningLevels(cur), effort = this.reasoningLevel(cur);
    const reasoning = h_flex().id("reasoning").min_h(ROW).px(2).gap(9).items_start()
      .child(div().w(14).flex_none())
      .child(div().h(24).flex_none().flex().items_center().text_color(t.muted).child("Reasoning"))
      .child(h_flex().flex_1().min_w(0).gap(4).flex_wrap()
        .children((levels.length ? ["", ...levels] : []).map((value) =>
          div().id(`reasoning-${value || "default"}`).h(24).px(7).flex().items_center().rounded(5).border(1)
            .border_color(value === effort ? t.accent : t.border).bg(value === effort ? t.selected : t.popover)
            .text_size(11).text_color(value === effort ? t.foreground : t.muted).cursor_pointer()
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.chooseReasoning(value, cx))
            .child(value || "Default")))
        .when(!levels.length, (el) => el.child(div().py(4).text_size(11).text_color(t.dim)
          .child(!this.reasoningModel(cur) ? "Choose a model to see levels" : "No levels listed for this model"))))
      .when(levels.length > 0, (el) => el.child(this.hint(t, typing ? "⌃R" : "r")));

    const modelRows = this.models ? this.modelRows(cur) : [];
    const modelAt = Math.min(this.models?.at ?? 0, Math.max(0, Math.min(modelRows.length, MODELS_SHOWN) - 1));
    const modelSearch = h_flex().h(30).px(9).gap(8).items_center().rounded(6).border(1).border_color(t.accent).bg(t.background)
      .child(div().text_color(t.accent).child("/"))
      .child(h_flex().flex_1().min_w(0).items_center().child(div().truncate().child(this.models?.search ?? "")).child(div().w(1).h(15).bg(t.foreground).loop("opacity", { from: 0.2, to: 1, period: 1000 })))
      .child(this.hint(t, "esc"));
    const modelList = v_flex().id("models").max_h(ROW * 12).overflow_y_scroll().track_scroll(this.modelScroll).children(modelRows.slice(0, MODELS_SHOWN).map((r, i) => {
      const on = i === modelAt, now = r.id === (cur.model ?? "");
      return h_flex().id(`m-${i}`).flex_none().h(ROW).px(9).gap(10).items_center().rounded(6).cursor_pointer()
        .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => this.chooseModel(cx, r))
        .child(div().flex_none().w(12).text_color(now || r.starred ? t.accent : t.dim).child(now ? "●" : r.starred ? "★" : r.typed ? "+" : ""))
        .child(div().flex_none().max_w(260).truncate().when(Boolean(r.id), (el) => el.font_family(mono).text_size(12)).text_color(t.foreground).child(r.id || "Default"))
        .child(div().flex_1().min_w(0).truncate().font_family(mono).text_size(12).text_color(t.muted).child(r.own ?? ""))
        .child(div().flex_none().max_w(190).truncate().text_size(11).text_color(t.dim).child(r.name));
    }));
    const modelNote = modelRows.length > MODELS_SHOWN ? `${modelRows.length - MODELS_SHOWN} more: / narrows them`
      : (this.catalog[cur.key] ?? []).length ? "" : this.synced ? `The model catalog has none for ${cur.name}: / types one` : "No model catalog yet (Config, Models page syncs it): / types one";
    const modelBody = v_flex().gap(8)
      .when(this.models?.search != null, (el) => el.child(modelSearch))
      .child(modelList)
      .when(Boolean(modelNote), (el) => el.child(div().px(9).text_size(11).text_color(t.dim).child(modelNote)));

    const worktree = h_flex().id("wt").h(ROW).px(2).gap(9).items_center().cursor_pointer().on_click((_e, cx) => this.toggleWorktree(cx))
      .child(this.box(t, this.wt))
      .child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.muted))
      .child(div().flex_1().text_color(this.wt ? t.foreground : t.muted).child("In a worktree (worktrunk)"))
      .child(this.hint(t, this.wt ? "⌃W" : "w"));

    const folder = h_flex().h(32).px(2).gap(9).items_center()
      .child(svg("mods/files/folder.svg").size(14).flex_none().text_color(t.muted))
      .child(Input.new(this.folder).flex_1().h(28).px(8).items_center().rounded(6).border(1).border_color(this.folderFocused ? t.accent : t.input).bg(t.background)
        .font_family(mono).text_size(12).text_color(t.foreground))
      .child(this.hint(t, this.folderFocused ? "esc" : this.wt ? "⌃F" : "f"))
      .when(this.canBrowse(), (el) => el
        .child(div().id("browse").flex_none().h(28).px(9).flex().items_center().rounded(6).border(1).border_color(t.input).cursor_pointer()
          .text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.browse(cx)).child("Browse…"))
        .child(this.hint(t, this.wt || this.folderFocused ? "⌃P" : "p")));

    const message = h_flex().min_h(32).py(2).px(2).gap(9).items_start()
      .child(div().h(28).flex_none().flex().items_center().child(svg("mods/workspace-chrome/square-pen.svg").size(14).text_color(t.muted)))
      .child(Textarea.new(this.message).flex_1().min_h(28).px(8).py(5).rounded(6).border(1).border_color(this.messageFocused ? t.accent : t.input).bg(t.background)
        .text_size(12).text_color(t.foreground))
      .child(this.hint(t, this.messageFocused ? "esc" : this.wt ? "⌃M" : "m"));

    // The message's files: click one to take it off (x takes the last).
    const files = h_flex().pl(25).gap(6).flex_wrap().items_center().children(this.files.map((f, i) =>
      h_flex().id(`file-${i}`).flex_none().max_w(220).h(22).px(7).gap(5).items_center().rounded(5).border(1).border_color(t.border).bg(t.raised).cursor_pointer()
        .text_size(11).text_color(t.muted).hover((s) => s.text_color(t.foreground).border_color(t.input))
        .on_click((_e, cx) => this.detach(i, cx))
        .child(svg("mods/files/file.svg").size(11).flex_none())
        .child(div().min_w(0).truncate().child(f.split("/").pop()))
        .child(div().flex_none().text_color(t.dim).child("×"))))
      .when(!this.wt && !this.messageFocused && !this.folderFocused, (el) => el.child(this.hint(t, "x")));

    const here = (this.list ?? []).find((w) => w.here)?.branch ?? "";
    const list = v_flex().id("wt-list").max_h(ROW * 5).overflow_y_scroll().track_scroll(this.scroll).children(rows.map((w, i) => {
      const on = i === this.at;
      const from = `new branch from ${this.cfg.worktree.base === "current" ? (here || "here") : (this.defaultBranch || "the default branch")}`;
      const note = w.sentence ? `named for you · ${from}` : w.generated ? `generated name · ${from}` : w.typed ? (w.create ? from : "worktrunk shortcut") : w.here ? "you are here" : w.main ? "main checkout" : w.path ? "worktree" : "branch";
      return h_flex().id(`w-${i}`).flex_none().h(ROW).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
        .on_click((_e, cx) => { this.at = i; this.start(cx); })
        .child(div().flex_none().w(10).text_color(w.typed && w.create ? t.accent : t.dim).child(w.typed && w.create ? "+" : w.path ? "●" : "○"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(w.branch))
        .child(this.hint(t, note));
    }));

    const wtBody = v_flex().gap(8).pl(26)
      .child(Input.new(this.input).h(32).px(10).items_center().rounded(6).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground))
      .child(h_flex().gap(16).flex_wrap()
        .child(this.segment(t, "base", "From", [["default", this.defaultBranch || "default branch"], ["current", here && here !== this.defaultBranch ? here : "current"]], this.cfg?.worktree.base, "⌃B", (v, cx) => this.option("base", v, cx)))
        .when(this.place() !== "space", (el) => el.child(this.segment(t, "open", "Open as", [["space", "space"], ["tab", "tab"]], this.cfg?.worktree.open, "⌃O", (v, cx) => this.option("open", v, cx)))))
      .when(this.list === undefined, (el) => el.child(div().text_color(t.dim).child("Reading worktrees…")))
      .when(this.list === null, (el) => el.child(div().text_color(t.muted).child(this.listError || "Could not list worktrees.")))
      .when(Boolean(this.list) && rows.length > 0, (el) => el.child(list))
      .when(Boolean(this.list) && rows.length === 0, (el) => el.child(div().text_color(t.dim).child("No worktrees yet: type a branch name.")));

    const split = this.split();
    const foot = this.busy ? this.status || "working…" : this.models ? (this.models.search !== null ? "type to narrow · ↑↓ or ⌃J ⌃K choose · ↵ use · esc back" : "j k g G choose · / search · s star · ↵ use · esc back") : this.folderFocused ? "type a folder · ↵ start · esc back" : this.messageFocused ? `type ${cur.name}'s first message · ⌃V file · ⇧↵ new line · ⌘↵ start · esc back` : this.wt ? (this.inputFocused ? "↑↓ or ⌃J ⌃K choose · tab program · ↵ start · esc back" : "j k choose · i branch name · tab program · ↵ start · esc") : this.search !== null ? "↑↓ or ⌃J ⌃K choose · ↵ start · esc back" : `j k choose · / search · e edit list · 1–9 select · ↵ start · esc`;

    // The overlay has no frame and is taller than the card, so the card keeps its own height.
    return div().size_full().on_drop((e, cx) => this.attach(e.paths ?? [], cx)).child(
      v_flex().id("launcher").track_focus(this.handle).key_context("Launcher").on_action("launcher-escape", (_e, cx) => this.key({ key: "escape", keystroke: "escape", modifiers: {} }, cx)).on_key_down((e, cx) => this.key(e, cx))
        .w_full().p(16).gap(10).rounded(10).border(1).border_color(t.border).bg(t.popover).shadow_lg()
        .text_size(13).text_color(t.foreground)
        .child(h_flex().items_center().child(div().flex_1().font_semibold().child(this.models ? `Model for ${cur.name}` : this.fork ? `Fork ${this.fork.name}` : split ? `Split ${this.place()}` : this.place() === "space" ? "New space" : "New tab")).child(div().max_w(320).truncate().font_family(mono).text_size(11).text_color(t.dim).child(this.cfg && !this.fork ? command : "")))
        .when(Boolean(this.fork) && !this.models, (el) => el.child(div().text_size(12).text_color(t.muted)
          .child(cur.none ? "Choose an agent to continue with." : cur.key === this.fork.key
            ? this.fork.canFork ? `Fork this ${this.fork.name} session into a right split.` : "This CLI has no native fork recipe yet. Choose another for a handover."
            : `Hand over from ${this.fork.name} to ${cur.name} in a right split. The source sends its context and stays open.`)))
        .when(!this.cfg, (el) => el.child(div().text_color(t.dim).child("…")))
        .when(Boolean(this.cfg) && Boolean(this.models), (el) => el.child(modelBody))
        .when(Boolean(this.cfg) && !this.models, (el) => el.when(this.search !== null, (el) => el.child(searchBar)).child(chips).child(flag)
          .when(!cur.terminal && !cur.none, (el) => el.child(model)
            .when(Boolean(cur.reasoningFlag?.length), (el) => el.child(reasoning)))
          .when(!split, (el) => el.child(folder))
          .when(this.takesMessage(), (el) => el.child(message).when(this.on === null && this.files.length > 0, (el) => el.child(files)))
          .when(!split, (el) => el.child(div().h(1).bg(t.border)).child(worktree)).when(!split && this.wt, (el) => el.child(wtBody)))
        .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
        .child(h_flex().justify_end().gap(6).text_size(11).text_color(t.dim)
          .when(this.busy, (el) => el.child(div().frames(SPINNER, 90)))
          .child(foot)));
  }
}
