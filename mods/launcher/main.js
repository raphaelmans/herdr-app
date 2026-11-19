// New tab, split or space launcher (prefix + c, C, v, -, N): pick a plain terminal or any installed agent, choose
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
// A new tab, split or space also offers its folder, prefilled with the focused
// pane's, to edit before it is made (f) or choose in the system's folder picker
// (p, this computer only): untouched, it starts where Herdr would put it anyway;
// an edited folder starts a split there through IN below. The worktree choice
// is offered for a new tab, split and space alike, for a plain terminal as for
// an agent.
// While editing the folder, arrows / Ctrl+J/K choose a directory and Tab
// completes it, keeping the field focused for the next path component.
// Fork uses this same picker with props { fork: { pane, terminal, key, name,
// canFork } }. Only agents are offered. Selection goes back to agent-fork:
// the same CLI forks natively; another receives a handover through hc send.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, ScrollHandle, Popup } from "gpui-base";
import { appHome, checking, closeOverlay, exec, focused, home, knownAgents, notify, openOverlay, panes, pickFolder, props, readTextFile, run, setShared, shared, spaces, theme, writeTextFile } from "herdr";
import * as fs from "fs/promises";

// Off is a folder in mods-disabled/, including on a fresh machine. Shared
// state updates open views, but every wt operation checks the folder itself.
async function worktrunkEnabled() {
  const on = await fs.exists(`${appHome()}/mods/worktrunk/mod.json`);
  if (shared("worktrunk.enabled") !== on) setShared("worktrunk.enabled", on);
  return on;
}
const WORKTRUNK_OFF = "Worktrunk is off. Turn it on in Config → Mods.";
import { folderSuggestions } from "./folders.js";

// A wait: one spinner, turned natively, and what is being waited for.
const waiting = (t, label) => h_flex().gap(8).items_center().child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)).child(label);

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
  // "writer": agent and model). This
  // command is used only until a choice exists: the prompt goes in on stdin,
  // the branch name comes out on stdout.
  title: { command: "MAX_THINKING_TOKENS=0 claude -p --model claude-haiku-5-5 --tools='' --disable-slash-commands --setting-sources='' --system-prompt='' --no-session-persistence" },
};
// How each agent is told its model: the flag that goes before the model's id.
// An agent with none here, and none in launcher.json, is started without one.
const MODEL_FLAG = { claude: "--model", codex: "-m", opencode: "-m", cursor: "--model", gemini: "-m", grok: "-m", copilot: "--model", pi: "--model" };
// The agent's own choice: the model each agent starts with when told none, as
// its own settings on that machine say. Prints "<agent key><tab><model>" lines;
// an agent whose settings name none prints nothing after the tab. A folder's
// own settings (a repo's .claude/settings.json) are not looked at.
const OWN = `j() { jq -r "$1 // empty" "$2" 2>/dev/null; }
printf 'claude\\t%s\\n' "\${ANTHROPIC_MODEL:-$(j '.env.ANTHROPIC_MODEL // .model' ~/.claude/settings.json)}"
printf 'codex\\t%s\\n' "$(awk -F'"' '/^\\[/{exit} /^model[[:space:]]*=/{print $2; exit}' ~/.codex/config.toml 2>/dev/null)"
printf 'opencode\\t%s\\n' "$(j '.model' ~/.config/opencode/opencode.json)"
printf 'gemini\\t%s\\n' "$(j '.model.name // (.model | strings)' ~/.gemini/settings.json)"
printf 'cursor\\t%s\\n' "$(j '.model.displayName // .model.modelId' ~/.cursor/cli-config.json)"
printf 'grok\\t%s\\n' "$(awk -F'"' '/^\\[models\\]/{f=1;next} /^\\[/{f=0} f&&/^default[[:space:]]*=/{print $2; exit}' ~/.grok/config.toml 2>/dev/null)"`;
// The skip-permissions flag of each agent that has one. One from here starts
// unticked; launcher.json's own `flag` (as DEFAULTS above) keeps its `on`.
const SKIP_FLAG = { claude: "--dangerously-skip-permissions", codex: "--dangerously-bypass-approvals-and-sandbox", grok: "--always-approve", opencode: "--auto", cursor: "--force" };
// CLI syntax is separate from model capabilities: the catalog supplies levels.
const REASONING_FLAG = { claude: ["--effort"], codex: ["-c", "model_reasoning_effort={value}"], grok: ["--reasoning-effort"] };
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
// A path that names its folder by itself, with no folder to start from.
const rooted = (p) => p.startsWith("/") || p === "~" || p.startsWith("~/");
// Herdr can't start a program in a folder that is gone, and blames the program ("cannot run sh").
const gone = (error) => /os error 2\b/.test(String(error?.message ?? error));
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

// The repository each folder given is in, once each: its main checkout (or the
// bare repository itself). Folders outside any repository print nothing.
const REPOS = `for d do
  c=$(CDPATH= cd "$d" 2>/dev/null && git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || continue
  case $c in */.git) c=\${c%/.git} ;; esac
  [ -n "$c" ] && printf '%s\\n' "$c"
done | awk '!seen[$0]++'`;
const NO_REPO = /not a git repository/i;
// `pane.split` takes no folder, so a split in a worktree or an edited folder is started through
// this: it goes there, then becomes the agent given, or the person's shell.
const IN = 'cd "$1" || exit 1; shift; [ "$#" -gt 0 ] && exec "$@"; exec "${SHELL:-/bin/sh}" -l';
// `wt list` reduced to what the combo box draws, before the mod reads it (ADR 0006):
// [[branch, checkout path or null, main, here], ...]. Older wt prints an array;
// current releases wrap it in schema 2 and keep checkout facts under worktree.
const LIST = `out=$(wt list --format json --branches) || exit 1
printf %s "$out" | jq -c '[(if type == "array" then . elif .schema == 2 then .items else error("wt list returned an unsupported JSON format.") end)[] | select(.branch) | [.branch, (.worktree.path // (if .kind == "worktree" then .path else null end)), (.worktree.main // .is_main // false), (.worktree.current // .is_current // false)]]'`;
// Kept reads (ADR 0009), by machine and folder: the least recently used is
// dropped past LISTS_KEPT. One younger than LIST_FRESH is used as it is; an
// older one is shown at once while a fresh read replaces it. No cheap mark
// says a repository's branches changed, so age decides.
const LISTS = new Map();
const LISTS_KEPT = 12;
const LIST_FRESH = 30_000;
const LIST_READS = new Map(); // key -> the read running for it: never two at once
const keep = (key, value) => {
  LISTS.delete(key);
  LISTS.set(key, value);
  while (LISTS.size > LISTS_KEPT) LISTS.delete(LISTS.keys().next().value);
};
const WORKTREES_SHOWN = 100; // options drawn at most: typing narrows the rest

// Escape is bound to an action of this mod's own: while a text field has the
// keyboard, Herdr closes the dialog on Escape before any key handler here sees it.
let escapeBound = false;

export default class Launcher extends View {
  init(_props, cx) {
    if (!escapeBound) {
      cx.bind_keys([
        { keystroke: "enter", action: "launcher-submit-text", context: "LauncherMessage > Input" },
        { keystroke: "secondary-enter", action: "launcher-submit-text", context: "LauncherMessage > Input" },
        { keystroke: "secondary-enter", action: "launcher-start", context: "Launcher" },
        { keystroke: "shift-enter", action: "launcher-newline", context: "LauncherMessage > Input" },
        { keystroke: "escape", action: "launcher-escape", context: "Launcher" },
        ...[["tab", "complete"], ["shift-tab", "previous"], ["up", "previous"], ["down", "next"], ["ctrl-k", "previous"], ["ctrl-j", "next"]]
          .map(([keystroke, action]) => ({ keystroke, action: `launcher-folder-${action}`, context: "LauncherFolder" })),
      ]);
      escapeBound = true;
    }
    this.fork = props()?.fork ?? null;
    const f = focused();
    const source = this.fork ? panes().find((p) => p.pane === this.fork.pane) : null;
    const space = this.fork ? spaces().find((s) => s.tabs?.some((tab) => tab.id === source?.tab))
      : spaces().find((s) => s.id === f?.space) ?? spaces().find((s) => s.active);
    this.space = space?.id;
    this.targetSpaceName = props()?.targetSpaceName;
    this.on = space?.machine ?? null;
    this.pane = this.fork?.pane ?? f?.pane ?? null;
    this.cwd = this.fork ? source?.cwd ?? null : f?.cwd ?? panes().find((p) => p.focused)?.cwd ?? null;
    this.folderBase = this.cwd; // Relative paths always start at the captured terminal, even after settling.
    this.picked = this.fork?.key;
    this.path = `${appHome()}/launcher.json`;
    this.cfg = null; // until launcher.json is read
    this.raw = null;
    this.agents = shared(KNOWN)?.[this.on ?? ""] ?? [];
    this.wt = false; // worktree mode
    this.worktrunkReady = false;
    this.search = null; // "/" filters the program list: null when off
    this.catalog = {}; // agent key -> [[model id, name, reasoning levels], ...]
    this.own = {}; // each agent's own choice of model, where its settings name one: agent key -> model
    this.models = null; // the model list, when open: { at, search } ("/" filters it: null when off)
    this.modelScroll = ScrollHandle.new();
    this.list = undefined; // undefined: not read, null: failed (see listError)
    this.reads = 0; // a read that was overtaken is dropped
    this.repos = undefined; // open repositories, offered when the folder is in none: undefined until read
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
    // The worktree combo box: the field narrows its options, drawn in a popup under it.
    this.opts = []; // the options drawn: rows(), a moment after the last key
    this.combo = false; // whether the popup is open
    this.narrowing = 0;
    this.chosen = null; // an option put in the field: that change does not reopen the popup
    this.input.on("change", (_e, cx) => {
      this.text = this.input.value(); this.at = 0; this.error = "";
      if (this.text !== this.chosen) { this.chosen = null; this.combo = true; }
      // An emptied field shows everything at once; typing waits for a pause (ADR 0010).
      if (this.text.trim()) this.narrow(cx);
      else { this.sync(); cx.notify(); }
    });
    this.input.on("submit", (_e, cx) => this.start(cx));
    this.inputFocused = false;
    this.input.on("focus", (_e, cx) => { this.inputFocused = true; this.combo = true; this.sync(); cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.inputFocused = false; this.combo = false; cx.notify(); });
    // A new tab's, split's or space's folder: where the focused pane is, until edited. Here, "~" stands for home.
    this.offered = this.cwd ? this.spelled(this.cwd) : "";
    this.folder = InputState.new({ value: props()?.startingFolder ?? this.offered, placeholder: "folder (empty: where Herdr starts it)" });
    this.folderFocused = false;
    this.folderScroll = ScrollHandle.new();
    this.folderGeneration = 0;
    this.folderMatches = []; this.folderAt = 0;
    this.folderOpen = false; this.folderLoading = false; this.folderError = ""; this.folderMore = false;
    this.folder.on("change", (_e, cx) => { this.error = ""; this.suggestFolders(cx); });
    this.folder.on("submit", (_e, cx) => this.start(cx));
    this.folder.on("focus", (_e, cx) => { this.folderFocused = true; this.suggestFolders(cx); });
    // Leaving the field settles it, so the worktree list is read from the folder typed.
    this.folder.on("blur", (_e, cx) => {
      this.folderFocused = false;
      this.dismissFolders();
      cx.notify();
      if (this.wt && !this.busy) cx.spawn(async (cx) => { try { await this.settle(cx); } catch (error) { this.error = String(error?.message ?? error); cx.notify(); } });
    });
    // An agent's first message: optional.
    this.message = TextareaState.new({ value: "", placeholder: "first message (optional): drop or ⌃V a file", rows: 1 });
    this.message.set_auto_grow(1, 6);
    this.files = []; // full paths, sent after the text
    this.messageFocused = false;
    this.message.on("focus", (_e, cx) => { this.messageFocused = true; cx.notify(); });
    this.message.on("blur", (_e, cx) => { this.messageFocused = false; cx.notify(); });
    if (checking()) return;
    cx.spawn(async (cx) => {
      await worktrunkEnabled();
      this.worktrunkReady = true;
      cx.notify();
    });
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
      return { key: a.key, name: a.name, icon: a.icon, tint: a.tint, run: a.run, installed: a.installed, flag: words(c?.flag ?? SKIP_FLAG[a.key]), on: c?.flag ? c.on !== false : c?.on === true, modelFlag: words(c?.modelFlag ?? MODEL_FLAG[a.key]), model: String(c?.model ?? "").trim(), reasoningFlag: words(c?.reasoningFlag ?? REASONING_FLAG[a.key]) };
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
  // { place: "space" }, a new space. A split stays in its tab's folder unless
  // its folder is edited or it takes a worktree (IN); a space's worktree always opens as that space.
  place() {
    if (this.fork) return "right";
    const place = props()?.place;
    return place === "right" || place === "down" || place === "space" ? place : "tab";
  }

  split() {
    return this.place() === "right" || this.place() === "down";
  }

  // A tab in another space can inherit a different folder, so resolve its nonempty field explicitly.
  untouched() {
    const typed = this.folder.value().trim();
    return !typed || (!this.targetSpaceName && typed === this.offered);
  }

  openTab(tab) {
    if (!this.targetSpaceName) return run("tab.new", { space: this.space, ...tab });

    // Look up the destination at launch, after folder validation and any worktree setup.
    const target = spaces().find(s => (s.machine ?? null) === this.on && s.named && s.name === this.targetSpaceName);
    if (target) return run("tab.new", { space: target.id, ...tab });

    const { name, ...args } = tab;
    run("space.new", { machine: this.on ?? "", name: this.targetSpaceName, ...(name ? { tab: name } : {}), ...args });
  }

  canChooseWorktreeDestination() {
    return this.place() === "tab" && !this.targetSpaceName;
  }

  // Split the pane with the agent's command (its task appended), started in
  // `folder` when one is given, else where the pane is.
  splitWith(folder, argv, task) {
    const cmd = argv ? (task.task ? [...argv, task.task] : argv) : null;
    const pane = this.pane ? { pane: this.pane } : {};
    if (folder) run("pane.split", { direction: this.place(), ...pane, argv: ["sh", "-c", IN, "sh", folder, ...(cmd ?? [])] });
    else run("pane.split", { direction: this.place(), ...pane, ...(cmd ? { argv: cmd } : {}) });
  }

  // null inherits the original folder. An edit during a lookup supersedes it
  // (undefined), so its path or error never applies to the new text.
  async settle(cx) {
    const typed = this.folder.value().trim();
    let path = null;
    if (!this.untouched()) {
      if (this.settled?.typed === typed) path = this.settled.path;
      else {
        let r;
        try {
          r = await exec("sh", ["-c", RESOLVE, "sh", typed], { cwd: rooted(typed) ? undefined : this.folderBase ?? undefined, on: this.on, timeout: 10_000 });
        } catch (error) {
          if (this.folder.value().trim() !== typed) return undefined;
          if (gone(error)) throw new Error(`No folder at ${typed}`);
          throw error;
        }
        if (this.folder.value().trim() !== typed) return undefined;
        path = r.code === 0 && r.stdout.trim();
        if (!path) throw new Error(`No folder at ${typed}`);
        this.settled = { typed, path };
      }
    }
    const cwd = path ?? this.folderBase;
    if (cwd !== this.cwd) {
      this.cwd = cwd;
      this.reads++;
      this.reading = false;
      this.list = undefined;
      this.defaultBranch = "";
      this.at = 0;
      this.sync();
      if (this.wt) this.load(cx);
    }
    return path;
  }

  editFolder(cx) {
    if (this.fork || this.busy) return;
    this.search = null;
    this.folder.focus();
    cx.notify();
  }

  dismissFolders() {
    this.folderGeneration++;
    this.folderOpen = false;
    this.folderLoading = false;
    this.folderMatches = [];
  }

  suggestFolders(cx) {
    const generation = ++this.folderGeneration, value = this.folder.value();
    this.folderMatches = []; this.folderAt = 0; this.folderError = ""; this.folderMore = false;
    this.folderOpen = this.folderFocused && !this.busy;
    this.folderLoading = this.folderOpen;
    cx.notify();
    if (!this.folderOpen || checking()) return;
    const current = () => generation === this.folderGeneration && this.folderFocused;
    cx.spawn(async cx => {
      await cx.sleep(80);
      if (!current()) return;
      try {
        const result = await folderSuggestions(value, exec, { cwd: rooted(value) ? undefined : this.folderBase ?? undefined, on: this.on });
        if (!current()) return;
        this.folderMatches = result.items; this.folderMore = result.more;
        this.folderScroll.scroll_to_item(0);
      } catch (error) {
        if (!current()) return;
        this.folderError = String(error?.message ?? error);
      }
      this.folderLoading = false;
      cx.notify();
    });
  }

  moveFolder(step, cx) {
    cx.stop_propagation();
    if (!this.folderOpen) return this.suggestFolders(cx);
    const count = this.folderMatches.length;
    if (!count) return;
    this.folderAt = (this.folderAt + step + count) % count;
    this.folderScroll.scroll_to_item(this.folderAt);
    cx.notify();
  }

  completeFolder(cx, item = this.folderMatches[this.folderAt]) {
    cx.stop_propagation();
    if (!this.folderOpen) return this.suggestFolders(cx);
    if (!item || this.busy) return;
    this.folder.set_value(item.value);
    this.folder.set_selected_range({ start: item.value.length, end: item.value.length });
    this.error = "";
    this.folder.focus();
    this.suggestFolders(cx);
  }

  // The system's folder picker fills the field. It only sees this computer.
  canBrowse() {
    return this.on === null && !this.fork;
  }

  browse(cx) {
    if (!this.canBrowse() || this.busy || this.browsing) return;
    this.browsing = true;
    cx.spawn(async (cx) => {
      try {
        const dir = await pickFolder({ prompt: "Start here" });
        if (dir) {
          this.folder.set_value(this.spelled(dir));
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

  canWorktree() { return this.worktrunkReady && shared("worktrunk.enabled") === true; }

  toggleWorktree(cx) {
    if (this.fork || this.busy || (!this.wt && !this.canWorktree())) return;
    this.wt = !this.wt;
    this.search = null;
    this.error = "";
    if (!this.wt) this.handle.focus();
    else {
      this.input.focus();
      cx.spawn(async (cx) => {
        try {
          const folder = await this.settle(cx);
          if (folder !== undefined && this.wt && this.list === undefined && !this.reading) this.load(cx);
        } catch (error) { this.error = String(error?.message ?? error); cx.notify(); }
      });
    }
    cx.notify();
  }

  // A folder as the folder field spells it: "~" for this computer's home.
  spelled(path) {
    return this.on === null && inside(path, home()) ? `~${path.slice(home().length)}` : path;
  }

  // The folder the launcher was opened in no longer exists.
  noFolder() {
    return `No folder at ${this.spelled(this.cwd)}. Set the folder above (⌃F).`;
  }

  noRepo() {
    return `No Git repository at ${this.cwd ? this.spelled(this.cwd) : "this folder"}.`;
  }

  // Worktrees and branches, as worktrunk lists them: read when the combo box is
  // first wanted, never before. What was read here last time is shown at once
  // and replaced when the fresh read lands. A folder in no repository gets the
  // open repositories to choose from instead.
  load(cx) {
    const read = ++this.reads, key = `${this.on ?? ""}\n${this.cwd ?? ""}`;
    const kept = LISTS.get(key);
    if (kept && this.list === undefined) {
      keep(key, kept);
      this.list = kept.list; this.defaultBranch = kept.defaultBranch; this.sync();
      if (Date.now() - kept.at < LIST_FRESH) { this.reading = false; return cx.notify(); }
    }
    this.reading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (!(await worktrunkEnabled()) || read !== this.reads) return;
        if (!this.cwd) throw new Error("No folder to look for a repository in.");
        const at = { cwd: this.cwd, on: this.on };
        const branch = exec("wt", ["config", "state", "default-branch"], at).catch(() => null);
        let running = LIST_READS.get(key);
        if (!running) {
          running = exec("sh", ["-c", LIST], { ...at, timeout: 60_000 });
          LIST_READS.set(key, running);
          const done = () => { if (LIST_READS.get(key) === running) LIST_READS.delete(key); };
          running.then(done, done);
        }
        const r = await running;
        if (read !== this.reads) return;
        if (r.code !== 0) {
          LISTS.delete(key);
          if (NO_REPO.test(r.stderr)) { this.list = null; this.listNoRepo = true; this.listError = this.noRepo(); this.sync(); return this.findRepos(cx); }
          throw new Error(clean(r.stderr) || "wt list failed.");
        }
        const chosen = this.opts[this.at];
        // The main checkout leads: from a worktree, wt lists the one you are in first,
        // which is the one place a new tab here would not need to go.
        const listed = JSON.parse(r.stdout).map(([branch, path, main, here]) => ({ branch, path, main, here }));
        this.list = [...listed.filter((w) => w.main), ...listed.filter((w) => !w.main)];
        this.sync();
        // The option highlighted stays highlighted when the fresh list moves it.
        const again = chosen && !chosen.typed ? this.opts.findIndex((w) => w.branch === chosen.branch) : -1;
        if (again >= 0) this.at = again;
        cx.notify();
        const d = await branch;
        if (read !== this.reads) return;
        if (d?.code === 0) this.defaultBranch = d.stdout.trim().split("\n").pop();
        keep(key, { list: this.list, defaultBranch: this.defaultBranch, at: Date.now() });
      } catch (error) {
        if (read !== this.reads) return;
        // A failed refresh leaves what was shown; a failed first read says why.
        if (!this.list) {
          this.list = null; this.listNoRepo = false;
          this.listError = gone(error) ? this.noFolder() : String(error?.message ?? error).split("\n").slice(-3).join("\n");
          this.sync();
        }
      } finally {
        if (read === this.reads) { this.reading = false; cx.notify(); }
      }
    });
  }

  // The repositories open in Herdr on this machine: where its spaces' terminals are.
  findRepos(cx) {
    if (this.repos !== undefined) return;
    cx.spawn(async (cx) => {
      let found = [];
      try {
        const mine = spaces().filter((s) => (s.machine ?? null) === this.on);
        const tabs = new Set(mine.flatMap((s) => (s.tabs ?? []).map((t) => t.id)));
        const dirs = [...new Set([...panes().filter((p) => tabs.has(p.tab)).map((p) => p.cwd), ...mine.map((s) => s.folder)].filter(Boolean))].slice(0, 60);
        if (dirs.length) {
          const r = await exec("sh", ["-c", REPOS, "sh", ...dirs], { on: this.on, timeout: 10_000 });
          found = r.stdout.split("\n").filter(Boolean).map((path) => ({ repo: true, path, branch: path.split("/").pop() }));
        }
      } catch {}
      this.repos = found;
      this.sync();
      cx.notify();
    });
  }

  // Moves the folder to a repository offered, keeping the branch typed.
  pickRepo(row, cx) {
    const typed = this.spelled(row.path);
    this.folder.set_value(typed);
    this.settled = { typed, path: row.path };
    this.cwd = row.path;
    this.list = undefined;
    this.at = 0;
    this.error = "";
    this.sync();
    this.input.focus();
    this.load(cx);
    cx.notify();
  }

  // What Enter can act on: the typed name first (unless it is a branch), then matches.
  // In no repository, the open repositories instead: the name typed waits for one.
  rows() {
    if (this.list === null && this.listNoRepo) return this.repos ?? [];
    const typed = this.text.trim();
    if (!typed) return [{ branch: this.generated, typed: true, create: true, generated: true }, ...(this.list ?? [])];
    if (/\s/.test(typed)) return [{ branch: typed, typed: true, create: true, sentence: true }];
    const f = typed.toLowerCase();
    const found = (this.list ?? []).filter((w) => w.branch.toLowerCase().includes(f));
    const exact = found.find((w) => w.branch === typed);
    if (exact) return [exact, ...found.filter((w) => w !== exact)];
    return [{ branch: typed, typed: true, create: !SHORTCUT.test(typed) }, ...found];
  }

  // The combo box's options, now. Every action on them calls this first, so a
  // key pressed inside the wait below never acts on options from before it.
  sync() {
    this.narrowing++;
    this.opts = this.rows();
    this.at = Math.max(0, Math.min(this.at, Math.min(this.opts.length, WORKTREES_SHOWN) - 1));
  }

  // The same, a moment after the last key typed: as the folder field's suggestions.
  narrow(cx) {
    const turn = ++this.narrowing;
    cx.notify();
    cx.spawn(async (cx) => {
      await cx.sleep(80);
      if (turn !== this.narrowing) return;
      this.sync();
      this.scroll.scroll_to_item(0);
      cx.notify();
    });
  }

  // A click on an option: a repository becomes the folder; a branch goes in the
  // field. Nothing starts until Enter.
  choose(i, cx) {
    cx.stop_propagation();
    this.sync();
    const row = this.opts[i];
    if (!row || this.busy) return;
    if (row.repo) return this.pickRepo(row, cx);
    if (!row.typed) {
      this.chosen = this.text = row.branch;
      this.input.set_value(row.branch);
      this.at = 0;
      this.sync();
    } else this.at = i;
    this.combo = false;
    this.error = "";
    cx.notify();
  }

  argv(p) {
    return p.terminal ? undefined : [...p.run, ...(p.on ? p.flag : []), ...(p.model && p.modelFlag.length ? [...p.modelFlag, p.model] : []), ...this.reasoningArgs(p)];
  }

  close() {
    this.dismissFolders();
    closeOverlay(props().overlay);
  }

  start(cx, program = this.current()) {
    if (!this.cfg || this.busy || !program) return;
    if (this.wt && !this.canWorktree()) { this.error = WORKTRUNK_OFF; return cx.notify(); }
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
    // A split or new tab in the folder offered: nothing to look up first.
    if (this.split() && !this.wt && this.untouched()) {
      this.busy = true;
      this.close();
      this.splitWith(null, argv, task);
      return;
    }
    if (!this.wt && this.place() === "tab" && this.untouched()) {
      this.busy = true;
      this.close();
      this.openTab(argv ? { name: program.name, argv, ...task } : {});
      return;
    }
    if (this.wt) this.sync();
    let row = this.wt ? this.opts[this.at] : null;
    const rowCwd = this.cwd;
    this.busy = true;
    this.status = "";
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (this.wt && !(await worktrunkEnabled())) throw new Error(WORKTRUNK_OFF);
        const folder = await this.settle(cx);
        if (folder === undefined) return;
        if (!this.wt) {
          if (this.split()) this.splitWith(folder, argv, task);
          else if (this.place() === "space") run("space.new", { machine: this.on ?? "", ...(folder ? { folder } : {}), ...(argv ? { tab: program.name, argv, ...task } : {}) });
          else this.openTab({ ...(folder ? { folder } : {}), ...(argv ? { name: program.name, argv, ...task } : {}) });
          return this.close();
        }
        // Let the user choose from the new folder before acting on a branch.
        if (this.cwd !== rowCwd || (row?.repo && this.folderFocused)) { this.input.focus(); return; }
        if (row?.repo) return this.pickRepo(row, cx);
        if (!row) throw new Error(this.list === null ? this.listError : "Type a branch name.");
        if (row.sentence) {
          this.status = "naming the branch…";
          cx.notify();
          row = { ...row, branch: await this.name(row.branch) };
        }
        this.status = `worktrunk is making ${row.branch}…`;
        cx.notify();
        this.error = await this.worktree(row, program, argv, task, rowCwd);
        if (!this.error) this.close();
      }
      catch (error) { this.error = gone(error) && this.cwd ? this.noFolder() : String(error?.message ?? error); }
      finally { this.busy = false; cx.notify(); }
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
  async worktree(row, program, argv, task, cwd = this.cwd) {
    if (!(await worktrunkEnabled())) return WORKTRUNK_OFF;
    const { base } = this.cfg.worktree;
    const open = this.place() === "space" ? "space" : this.cfg.worktree.open;
    const args = ["switch", ...(row.create ? ["--create", ...(base === "current" ? ["--base", "@"] : [])] : []), "--no-cd", "--format", "json", row.branch];
    const r = await exec("wt", args, { cwd, on: this.on, timeout: 600_000 });
    let made;
    // wt prints the JSON over several lines (or one, in older versions): parse from its opening brace on.
    try { made = JSON.parse(r.stdout.slice(r.stdout.search(/^\s*\{/m))); } catch {}
    if (r.code !== 0 && NO_REPO.test(r.stderr)) return this.noRepo();
    if (r.code !== 0 || !made?.path) return clean(r.stderr).split("\n").slice(-3).join("\n") || "wt switch failed.";
    for (const key of [...LISTS.keys()]) if (key.startsWith(`${this.on ?? ""}\n`)) LISTS.delete(key);
    if (this.split()) {
      this.splitWith(made.path, argv, task);
      return "";
    }
    const tab = argv ? { name: program.name, argv, ...task } : {};
    if (this.targetSpaceName || open === "tab") {
      this.openTab({ folder: made.path, name: made.branch ?? row.branch, ...tab });
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
    if (this.wt && !this.canWorktree()) {
      this.wt = this.inputFocused = false;
      this.handle.focus();
      cx.stop_propagation();
      cx.notify();
      return;
    }
    const m = e.modifiers;
    if (e.key === "escape") {
      if (this.folderFocused && this.folderOpen) {
        this.dismissFolders(); cx.stop_propagation(); return cx.notify();
      }
      // The combo box's popup closes first; what was typed stays.
      if (this.wt && this.combo && !this.folderFocused && !this.messageFocused && !this.models) {
        this.combo = false; cx.stop_propagation(); return cx.notify();
      }
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
    if (this.folderFocused && !m.alt && !m.platform) {
      if (e.key === "tab") return m.shift ? this.moveFolder(-1, cx) : this.completeFolder(cx);
      if (e.key === "up" || (m.control && e.key === "k")) return this.moveFolder(-1, cx);
      if (e.key === "down" || (m.control && e.key === "j")) return this.moveFolder(1, cx);
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
      const action = { r: () => this.cycleReasoning(cx), d: () => this.openModels(cx), f: () => this.editFolder(cx), m: () => this.editMessage(cx), v: () => this.pasteFile(cx), p: () => this.browse(cx), s: () => this.toggleFlag(cx), w: () => this.toggleWorktree(cx), b: () => this.option("base", ["default", "current"], cx), o: () => this.canChooseWorktreeDestination() && this.option("open", ["space", "tab"], cx) }[e.key];
      if (action) { done(); action(); }
      return;
    }
    // ⌘V with no text to paste: the clipboard's file or image, as ⌃V.
    if (m.platform && e.key === "v" && this.messageFocused && cx.read_from_clipboard() === undefined) { done(); return this.pasteFile(cx); }
    if (m.alt || m.platform) return;
    // A field has the keyboard: letters are typed, and Enter is its own.
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
        else if (char === "g" || char === "G") this.move(null, cx, char === "g" ? 0 : -1);
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

  // Moves the combo box's highlight, opening its popup. to: 0 first, -1 last.
  move(dir, cx, to) {
    cx.stop_propagation();
    this.sync();
    this.combo = true;
    const n = Math.min(this.opts.length, WORKTREES_SHOWN);
    if (n) {
      this.at = to === undefined ? (this.at + (dir === "down" ? 1 : n - 1)) % n : to < 0 ? n - 1 : to;
      this.scroll.scroll_to_item(this.at);
    }
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
    const rows = this.wt ? this.opts.slice(0, WORKTREES_SHOWN) : [];
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
      return h_flex().id(`m-${r.id}`).flex_none().h(ROW).px(9).gap(10).items_center().rounded(6).cursor_pointer()
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

    // Popup owns anchoring and window-edge clamping; the input keeps focus.
    // Reuse the launcher's compact ROW geometry (the shell scales it with zoom).
    const folderMenu = v_flex().w(360).p(4).gap(4).rounded(6).border(1).border_color(t.border).bg(t.popover).shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(v_flex().id("folder-options").role("list_box").accessibility_label("Folder suggestions")
        .max_h(ROW * 5).overflow_y_scrollbar().track_scroll(this.folderScroll)
        .children(this.folderMatches.map((item, i) => h_flex().id(`folder-${item.value}`).role("list_box_option")
          .accessibility_label(item.label).aria_selected(i === this.folderAt)
          .when(i === this.folderAt, el => el.aria_active_descendant())
          .flex_none().h(ROW).px(8).gap(8).rounded(4).items_center()
          .bg(i === this.folderAt ? t.selected : t.popover).hover(s => s.bg(i === this.folderAt ? t.selected : t.hover))
          .on_click((_e, cx) => this.completeFolder(cx, item))
          .child(svg("mods/files/folder.svg").size(13).flex_none().text_color(t.muted))
          .child(div().flex_1().min_w(0).truncate().font_family(mono).text_size(12).text_color(t.foreground).child(item.label))
          .when(i === this.folderAt, el => el.child(this.hint(t, "tab"))))))
      .when(!this.folderMatches.length, el => el.child(div().px(8).py(6).text_size(12).text_color(this.folderError ? t.blocked : t.muted)
        .child(this.folderLoading ? waiting(t, "Finding folders") : this.folderError || "No matching folders")))
      .when(this.folderMore, el => el.child(div().px(8).py(4).text_size(11).text_color(t.dim).child("More folders available · keep typing to narrow")));
    const folderInput = Input.new(this.folder).w_full().h(28).px(8).items_center().rounded(6).border(1)
      .border_color(this.folderFocused ? t.accent : t.input).bg(t.background)
      .accessibility_label("Starting folder").font_family(mono).text_size(12).text_color(t.foreground);
    const folder = h_flex().h(32).px(2).gap(9).items_center()
      .child(svg("mods/files/folder.svg").size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).key_context("LauncherFolder")
        .on_action("launcher-folder-complete", (_e, cx) => this.completeFolder(cx))
        .on_action("launcher-folder-next", (_e, cx) => this.moveFolder(1, cx))
        .on_action("launcher-folder-previous", (_e, cx) => this.moveFolder(-1, cx))
        .child(Popup.new("folder-completion", folderInput).w_full().anchor("top_left")
          .when(this.folderFocused && this.folderOpen && !this.busy, el => el.content(folderMenu))))
      .child(this.hint(t, this.folderFocused ? "esc" : this.wt ? "⌃F" : "f"))
      .when(this.canBrowse(), (el) => el
        .child(div().id("browse").flex_none().h(28).px(9).flex().items_center().rounded(6).border(1).border_color(t.input).cursor_pointer()
          .text_size(12).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.browse(cx)).child("Browse…"))
        .child(this.hint(t, this.wt || this.folderFocused ? "⌃P" : "p")));

    const message = h_flex().min_h(32).py(2).px(2).gap(9).items_start()
      .key_context("LauncherMessage")
      .on_action("launcher-submit-text", (_e, cx) => { cx.stop_propagation(); this.start(cx); })
      .on_action("launcher-newline", (_e, cx) => { cx.stop_propagation(); this.message.replace("\n"); })
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
    const noRepo = this.list === null && this.listNoRepo;
    const from = `new branch from ${this.cfg?.worktree.base === "current" ? (here || "here") : (this.defaultBranch || "the default branch")}`;
    // One option: in the popup it is highlighted and clicked; under the closed field it says what Enter acts on.
    const option = (w, i, listed) => {
      const on = listed && i === this.at;
      const row = h_flex().id(`${listed ? "o" : "now"}-${w.repo ? `r-${w.path}` : w.typed ? "typed" : w.branch}`).flex_none().h(ROW).px(8).gap(8).items_center().rounded(listed ? 4 : 6).cursor_pointer()
        .when(listed, (el) => el.role("list_box_option").accessibility_label(w.branch).aria_selected(on).when(on, (el) => el.aria_active_descendant())
          .bg(on ? t.selected : t.popover).hover((s) => s.bg(on ? t.selected : t.hover))
          .on_click((_e, cx) => this.choose(i, cx)))
        .when(!listed, (el) => el.bg(t.selected).on_click((_e, cx) => { this.combo = true; this.input.focus(); cx.notify(); }));
      if (w.repo) return row
        .child(svg("mods/files/folder.svg").size(13).flex_none().text_color(t.muted))
        .child(div().flex_none().max_w(200).truncate().text_color(t.foreground).child(w.branch))
        .child(div().flex_1().min_w(0).truncate().font_family(mono).text_size(11).text_color(t.dim).child(this.spelled(w.path)));
      const note = w.sentence ? `named for you · ${from}` : w.generated ? `generated name · ${from}` : w.typed ? (w.create ? from : w.branch === "^" ? "main checkout" : "worktrunk shortcut") : w.here ? (w.main ? "main checkout · you are here" : "you are here") : w.main ? "main checkout · ^" : w.path ? "worktree" : "branch";
      return row
        .child(div().flex_none().w(10).text_color(w.typed && w.create ? t.accent : t.dim).child(w.typed && w.create ? "+" : w.path ? "●" : "○"))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(w.branch))
        .child(this.hint(t, note));
    };
    const more = this.opts.length - rows.length;
    // What is still being read, said where its result will land.
    const reading = this.list === undefined ? "Reading worktrees" : noRepo && this.repos === undefined ? "Finding open repositories" : this.reading ? "Refreshing worktrees" : "";
    const comboMenu = v_flex().w(420).p(4).gap(4).rounded(6).border(1).border_color(t.border).bg(t.popover).shadow_lg()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .when(noRepo && rows.length > 0, (el) => el.child(div().px(8).pt(2).text_size(11).text_color(t.dim).child("Open repositories")))
      .child(v_flex().id("wt-options").role("list_box").accessibility_label(noRepo ? "Open repositories" : "Worktrees and branches")
        .max_h(ROW * 6).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(rows.map((w, i) => option(w, i, true))))
      .when(!rows.length && !reading, (el) => el.child(div().px(8).py(6).text_size(12).text_color(t.muted)
        .child(noRepo ? "No repository is open: set the folder above (⌃F) to one." : "Nothing matches.")))
      .when(Boolean(reading), (el) => el.child(div().px(8).py(4).text_size(11).text_color(t.dim).child(waiting(t, reading))))
      .when(more > 0, (el) => el.child(div().px(8).py(4).text_size(11).text_color(t.dim).child(`${more} more · keep typing to narrow`)));
    const comboOpen = this.combo && !this.busy;
    const comboInput = Input.new(this.input).w_full().h(32).px(10).items_center().rounded(6).border(1).border_color(this.inputFocused ? t.accent : t.input).bg(t.background).text_color(t.foreground)
      .accessibility_label("Worktree or branch");
    const now = rows[this.at];

    const wtBody = v_flex().gap(8).pl(26)
      .child(h_flex().gap(9).items_center()
        // Built as the folder field is: a Popup under the input, which keeps the keyboard.
        // Base's Combobox root would take Enter, Escape and the arrows for itself.
        .child(div().flex_1().min_w(0)
          .child(Popup.new("wt-popup", comboInput).w_full().anchor("top_left").when(comboOpen, (el) => el.content(comboMenu))))
        .child(div().id("wt-open").flex_none().size(28).flex().items_center().justify_center().rounded(6).border(1).border_color(t.input).cursor_pointer()
          .text_size(11).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.combo = !this.combo; if (this.combo) { this.sync(); this.input.focus(); } cx.notify(); })
          .child(comboOpen ? "▴" : "▾")))
      .child(h_flex().gap(16).flex_wrap()
        .child(this.segment(t, "base", "From", [["default", this.defaultBranch || "default branch"], ["current", here && here !== this.defaultBranch ? here : "current"]], this.cfg?.worktree.base, "⌃B", (v, cx) => this.option("base", v, cx)))
        .when(this.canChooseWorktreeDestination(), (el) => el.child(this.segment(t, "open", "Open as", [["space", "space"], ["tab", "tab"]], this.cfg?.worktree.open, "⌃O", (v, cx) => this.option("open", v, cx)))))
      .when(this.list === null, (el) => el.child(div().text_color(t.muted).child(this.listError || "Could not list worktrees.")))
      .when(!comboOpen && Boolean(reading), (el) => el.child(div().text_color(t.dim).child(waiting(t, reading))))
      .when(!comboOpen && Boolean(now), (el) => el.child(option(now, this.at, false)))
      .when(!comboOpen && noRepo && this.repos !== undefined && !now, (el) => el.child(div().text_size(11).text_color(t.dim).child("No repository is open: set the folder above (⌃F) to one.")));

    const split = this.split();
    const tabTitle = this.targetSpaceName ? `New tab in ${this.targetSpaceName}` : "New tab";
    const foot = this.busy ? this.status || "working…" : this.models ? (this.models.search !== null ? "type to narrow · ↑↓ or ⌃J ⌃K choose · ↵ use · esc back" : "j k g G choose · / search · s star · ↵ use · esc back") : this.folderFocused ? "↑↓ choose · tab complete · ↵ start · esc back" : this.messageFocused ? `type ${cur.name}'s first message · ⌃V file · ⇧↵ new line · ↵ start · esc back` : this.wt && noRepo ? (this.inputFocused ? "↑↓ or ⌃J ⌃K choose · ↵ use repository · esc back" : "j k g G choose · i branch name · ↵ use repository · esc") : this.wt ? (this.inputFocused ? "type to narrow · ↑↓ or ⌃J ⌃K choose · tab program · ↵ start · esc back" : "j k g G choose · i branch name · tab program · ↵ start · esc") : this.search !== null ? "↑↓ or ⌃J ⌃K choose · ↵ start · esc back" : `j k choose · / search · e edit list · 1–9 select · ↵ start · esc`;

    // The overlay has no frame and is taller than the card, so the card keeps its own height.
    return div().size_full().on_drop((e, cx) => this.attach(e.paths ?? [], cx)).child(
      v_flex().id("launcher").track_focus(this.handle).key_context("Launcher")
        .on_action("launcher-escape", (_e, cx) => this.key({ key: "escape", keystroke: "escape", modifiers: {} }, cx))
        .on_action("launcher-start", (_e, cx) => { cx.stop_propagation(); if (!this.models) this.start(cx); })
        .on_key_down((e, cx) => this.key(e, cx))
        .w_full().p(16).gap(10).rounded(10).border(1).border_color(t.border).bg(t.popover).shadow_lg()
        .text_size(13).text_color(t.foreground)
        .child(h_flex().items_center().child(div().flex_1().font_semibold().child(this.models ? `Model for ${cur.name}` : this.fork ? `Fork ${this.fork.name}` : split ? `Split ${this.place()}` : this.place() === "space" ? "New space" : tabTitle)).child(div().max_w(320).truncate().font_family(mono).text_size(11).text_color(t.dim).child(this.cfg && !this.fork ? command : "")))
        .when(Boolean(this.fork) && !this.models, (el) => el.child(div().text_size(12).text_color(t.muted)
          .child(cur.none ? "Choose an agent to continue with." : cur.key === this.fork.key
            ? this.fork.canFork ? `Fork this ${this.fork.name} session into a right split.` : "This CLI has no native fork recipe yet. Choose another for a handover."
            : `Hand over from ${this.fork.name} to ${cur.name} in a right split. The source sends its context and stays open.`)))
        .when(!this.cfg, (el) => el.child(div().text_color(t.dim).child(waiting(t, "Reading settings"))))
        .when(Boolean(this.cfg) && Boolean(this.models), (el) => el.child(modelBody))
        .when(Boolean(this.cfg) && !this.models, (el) => el.when(this.search !== null, (el) => el.child(searchBar)).child(chips).child(flag)
          .when(!cur.terminal && !cur.none, (el) => el.child(model)
            .when(Boolean(cur.reasoningFlag?.length), (el) => el.child(reasoning)))
          .when(!this.fork, (el) => el.child(folder))
          .when(this.takesMessage(), (el) => el.child(message).when(this.on === null && this.files.length > 0, (el) => el.child(files)))
          .when(!this.fork && this.canWorktree(), (el) => el.child(div().h(1).bg(t.border)).child(worktree)).when(!this.fork && this.canWorktree() && this.wt, (el) => el.child(wtBody)))
        .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
        .child(h_flex().justify_end().gap(6).text_size(11).text_color(t.dim)
          .when(this.busy, (el) => el.child(div().frames(SPINNER, 90)))
          .child(foot)));
  }
}
