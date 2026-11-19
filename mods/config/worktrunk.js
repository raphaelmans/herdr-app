// Worktrunk page: the settings of worktrunk (`wt`), the tool the launcher makes
// worktrees with, read from and saved to its own file on this computer
// (~/.config/worktrunk/config.toml; `wt config show` says where).
//
//   Commit writer  [commit.generation] command, template-append
//   Worktrees      worktree-path, [commit] stage
//   Merge          [merge] squash, commit, rebase, ff, verify, remove
//   Remove, List   [remove] delete-branch, [list] full, summary, branches, remotes
// A setting put back to worktrunk's default is removed from the file. Hooks,
// aliases, prompt templates and per-project settings are not here: `e` opens
// the file.
//
// Worktrunk reads the file: `wt config show --format json`. A change is made
// to the text (./toml.js), read back by worktrunk from a copy, and written only
// when worktrunk reads the new value from it and the file hasn't changed since.
//
// The commit writer can follow the Writer page: shared "worktrunk.follows" true
// keeps `command` equal to shared "writer".command, here and whenever the
// Writer's choice changes (follow(), called from ./writer.js and ./main.js).

import { div } from "gpui-kit";
import { v_flex, h_flex, Button, InputState, Input, TextareaState, Textarea, ScrollHandle } from "gpui-base";
import { appHome, checking, closeOverlay, exec, home, notify, props, readTextFile, run, setShared, shared, settings } from "herdr";
import * as fs from "fs/promises";
import { toggle, tildify, waiting } from "./ui.js";
import { edit } from "./toml.js";

const FOLLOWS = "worktrunk.follows";
const ENABLED = "worktrunk.enabled";
const OFF = "Worktrunk is off. Turn it on in Config → Mods.";

// Folder placement is the choice (ADR 0004). Shared state only tells other
// open views about changes; it never authorizes wt without checking the folder.
export async function enabled() {
  const on = await fs.exists(`${appHome()}/mods/worktrunk/mod.json`);
  if (shared(ENABLED) !== on) setShared(ENABLED, on);
  return on;
}

async function requireEnabled() {
  if (!(await enabled())) throw new Error(OFF);
}

const COMMAND = ["commit", "generation", "command"];
const GUIDANCE = ["commit", "generation", "template-append"];
const PATH = ["worktree-path"];
const STAGE = ["commit", "stage"];
const BESIDE = "{{ repo_path }}/../{{ repo }}.{{ branch | sanitize }}";
const PATHS = [
  ["beside", "Beside the repo", BESIDE],
  ["inside", "Inside it", "{{ repo_path }}/.worktrees/{{ branch | sanitize }}"],
  ["central", "~/worktrees", "~/worktrees/{{ repo }}/{{ branch | sanitize }}"],
  ["herdr", "Herdr's folder", "~/.herdr/worktrees/{{ repo }}/{{ branch | sanitize }}"],
];
// [group, note, [[path, label, worktrunk's default, note]]]
const SWITCHES = [
  ["MERGE", "what wt merge does unless a flag says otherwise", [
    [["merge", "squash"], "Squash the commits into one", true],
    [["merge", "commit"], "Commit uncommitted changes first", true],
    [["merge", "rebase"], "Rebase onto the target first", true],
    [["merge", "ff"], "Fast-forward", true, "off: a merge commit"],
    [["merge", "verify"], "Run the project's hooks", true],
    [["merge", "remove"], "Remove the worktree afterwards", true],
  ]],
  ["REMOVE", "wt remove", [
    [["remove", "delete-branch"], "Delete the branch with its worktree", true],
  ]],
  ["LIST", "what wt list shows without flags", [
    [["list", "full"], "CI, diffstat against main and summaries", false, "slower"],
    [["list", "summary"], "A summary of each branch", false, "by the commit writer"],
    [["list", "branches"], "Branches without a worktree", false],
    [["list", "remotes"], "Remote-only branches", false],
  ]],
];
const LABEL = 118;

const clean = (s) => (s ?? "").replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").trim();
const at = (config, path) => path.reduce((o, k) => o?.[k], config) ?? null;
const same = (a, b) => (typeof a === "string" && typeof b === "string" ? a.trim() === b.trim() : a === b);

// What worktrunk reads: { path, config, exists } of the user config.
async function report() {
  await requireEnabled();
  let r;
  try { r = await exec("wt", ["config", "show", "--format", "json"], { cwd: home() }); }
  catch { throw new Error("worktrunk (wt) was not found on this computer."); }
  try { return JSON.parse(r.stdout).user; }
  catch { throw new Error(clean(r.stderr).split("\n").slice(0, 3).join("\n") || "wt config show failed."); }
}

const CHECK = 'tmp=$(mktemp) && printf %s "$1" > "$tmp" && wt --config "$tmp" config show --format json; s=$?; rm -f "$tmp"; exit $s';
// Exit 3: the file is no longer what was read.
const WRITE = 'if [ "$3" = new ]; then [ ! -e "$1" ] || exit 3; mkdir -p "$(dirname "$1")" || exit 1; else printf %s "$4" | cmp -s - "$1" || exit 3; fi; printf %s "$2" > "$1"';

// Sets one key (null removes it) and resolves with the new report(). `value`
// may be a function, asked again on each try.
async function apply(path, value) {
  const key = path.at(-1), section = path.slice(0, -1).join(".");
  for (let tries = 0; tries < 3; tries++) {
    const want = typeof value === "function" ? value() : value;
    const state = await report();
    const old = await readTextFile(state.path);
    const next = edit(old ?? "", section, key, want);
    if (next === (old ?? "")) return state;
    await requireEnabled();
    const check = await exec("sh", ["-c", CHECK, "sh", next], { cwd: home() });
    let config = null;
    try { config = JSON.parse(check.stdout).user.config; } catch {}
    if (!config || /failed to parse|Invalid config/.test(check.stderr)) {
      throw new Error(`worktrunk could not read the change, so nothing was saved.\n${clean(check.stderr).split("\n").slice(1, 6).join("\n")}`);
    }
    if (!same(at(config, path), want)) throw new Error(`${state.path} sets ${path.join(".")} in a way this page can't change. Press e to edit the file.`);
    await requireEnabled();
    const w = await exec("sh", ["-c", WRITE, "sh", state.path, next, old === null ? "new" : "old", old ?? ""]);
    if (w.code === 0) return { ...state, config, exists: true };
    if (w.code !== 3) throw new Error(clean(w.stderr) || `Could not write ${state.path}.`);
  }
  throw new Error("The file kept changing while it was being saved. Try again.");
}

// Keeps worktrunk's commit writer equal to the Writer's choice, when it follows it.
async function sync() {
  if (!(await enabled())) return null;
  const command = () => shared("writer")?.command?.trim() || null;
  if (shared(FOLLOWS) !== true || !command()) return null;
  return apply(COMMAND, command);
}
export function follow(cx) {
  if (checking()) return;
  cx.spawn(async () => {
    try { await sync(); }
    catch (e) { notify({ title: "Worktrunk's commit writer", body: String(e?.message ?? e), level: "error" }); }
  });
}

export default class Worktrunk {
  constructor(host) {
    this.host = host;
    this.scroll = ScrollHandle.new();
    this.state = null; // report()
    this.enabled = null; // until the mod's folder is checked
    this.at = 0;
    this.error = "";
    this.typing = false;
    this.queue = []; // [path, value] still to save
    this.saving = false;
    this.own = false; // "Its own command" picked with no command yet
    this.custom = false; // "Custom" picked while the path is still a preset
    this.kept = ""; // the own command, while Nobody writes
    this.command = this.field(InputState.new({ placeholder: "reads the prompt on stdin, prints the message" }), COMMAND);
    this.path = this.field(InputState.new({ placeholder: BESIDE }), PATH);
    this.guidance = this.field(TextareaState.new({ placeholder: "- Use conventional commits (feat:, fix:, docs:, …)", rows: 2 }), GUIDANCE, true);
    this.guidance.input.set_auto_grow(2, 6);
  }

  // A text setting: what was typed is saved when the keyboard leaves it.
  // Only a change made while it had the keyboard counts, so a field that is
  // filled, or let go as the dialog closes, never writes.
  field(input, path, multi = false) {
    const field = { input, path };
    input.on("change", () => { if (field.focused) field.typed = input.value(); });
    if (!multi) input.on("submit", (_e, cx) => {
      this.host.handle.focus(); cx.notify();
    });
    input.on("focus", (_e, cx) => { this.typing = true; field.focused = true; field.typed = undefined; cx.notify(); });
    input.on("blur", (_e, cx) => {
      const typed = field.focused ? field.typed?.trim() : undefined;
      this.typing = false; field.focused = false; field.typed = undefined;
      if (typed !== undefined && this.state && !same(typed, this.get(path) ?? "")) {
        // An emptied command or path is put back: Nobody and the presets clear those.
        if (typed || path === GUIDANCE) this.save(path, typed && !(path === PATH && typed === BESIDE) ? typed : null, cx);
        else this.fill();
      }
      cx.notify();
    });
    return field;
  }

  get hints() {
    if (this.guidance.focused) return "⇧↵ new line · ↵ save";
    return this.enabled === false ? "m open Mods · r reread"
      : "j k g G move · space switch, or the next choice · ↵ type · e edit the file · r reread · saved as you change it";
  }

  start(cx) { if (!checking()) this.reload(cx); }

  reload(cx) {
    cx.spawn(async (cx) => {
      try {
        this.enabled = await enabled();
        if (!this.enabled) {
          this.state = null;
          this.error = "";
          this.queue = [];
          cx.notify();
          return;
        }
        this.state = (await sync()) ?? (await report());
        this.error = "";
      } catch (e) {
        this.error = String(e?.message ?? e);
        try { this.state ??= await report(); } catch {}
      }
      this.fill();
      cx.notify();
    });
  }

  get(path) { return at(this.state?.config, path); }

  fill() {
    for (const field of [this.command, this.path, this.guidance]) {
      if (field.focused) continue;
      const value = String(this.get(field.path) ?? (field === this.command ? this.kept : "")).trim();
      if (field.input.value() !== value) field.input.set_value(value);
    }
  }

  // One write at a time, in the order asked.
  save(path, value, cx) {
    if (!this.enabled || shared(ENABLED) !== true) return;
    this.queue.push([path, value]);
    if (this.saving) return;
    this.saving = true;
    cx.notify();
    cx.spawn(async (cx) => {
      while (this.queue.length) {
        const [p, v] = this.queue.shift();
        try { this.state = await apply(p, v); this.error = ""; }
        catch (e) { this.error = String(e?.message ?? e); }
        this.fill();
        cx.notify();
      }
      this.saving = false;
      cx.notify();
    });
  }

  writer() { return shared(FOLLOWS) === true ? "writer" : this.get(COMMAND) || this.own ? "own" : "none"; }

  pickWriter(mode, cx) {
    if (mode === this.writer()) return;
    const command = this.get(COMMAND);
    if (mode === "writer") {
      const theirs = shared("writer")?.command?.trim();
      if (!theirs) { this.error = "The Writer has no command yet: choose one on the Writer page."; return cx.notify(); }
      setShared(FOLLOWS, true);
      this.save(COMMAND, theirs, cx);
    } else {
      if (shared(FOLLOWS) != null) setShared(FOLLOWS, null);
      this.own = mode === "own";
      if (mode === "none") { this.kept = command ?? this.kept; if (command) this.save(COMMAND, null, cx); }
      else if (!command && this.kept) this.save(COMMAND, this.kept, cx);
      else if (!command) this.command.input.focus();
    }
    this.error = "";
    this.fill();
    cx.notify();
  }

  place() {
    const now = this.get(PATH) ?? BESIDE;
    return this.custom ? "custom" : PATHS.find(([, , template]) => same(template, now))?.[0] ?? "custom";
  }

  pickPlace(key, cx) {
    if (key === this.place()) return;
    this.custom = key === "custom";
    if (this.custom) { this.fill(); if (!this.path.input.value()) this.path.input.set_value(BESIDE); return cx.notify(); }
    const template = PATHS.find(([k]) => k === key)[2];
    this.save(PATH, template === BESIDE ? null : template, cx);
  }

  // The page as drawn: headings ({ group }) and the settings under them.
  rows() {
    const mode = this.writer(), place = this.place(), rows = [];
    rows.push({ group: "COMMIT WRITER", note: "writes the messages of wt merge, wt step commit and wt step squash" });
    rows.push({
      id: "writer", kind: "choice", label: "Written by", value: mode, pick: (v, cx) => this.pickWriter(v, cx),
      options: [["writer", "The Writer"], ["own", "Its own command"], ["none", "Nobody"]],
      detail: mode === "writer" ? `${shared("writer")?.label ?? "the Writer page's choice"} · follows the Writer page`
        : mode === "none" ? "worktrunk asks you for each message" : "",
    });
    if (mode === "own") rows.push({ id: "command", kind: "text", label: "Command", field: this.command });
    if (mode !== "none") rows.push({ id: "guidance", kind: "text", area: true, label: "Guidance", field: this.guidance, detail: "added to worktrunk's prompt, in your own words" });

    rows.push({ group: "WORKTREES", note: "where wt switch puts a new one" });
    rows.push({
      id: "place", kind: "choice", label: "Where they go", value: place, pick: (v, cx) => this.pickPlace(v, cx),
      options: [...PATHS.map(([key, label]) => [key, label]), ["custom", "Custom"]],
      detail: place === "custom" ? "" : PATHS.find(([key]) => key === place)[2], mono: true,
    });
    if (place === "custom") rows.push({ id: "path", kind: "text", label: "Path", field: this.path, detail: "{{ repo_path }}  {{ repo }}  {{ owner }}  {{ branch }}  {{ branch | sanitize }}", mono: true });
    rows.push({
      id: "stage", kind: "choice", label: "A commit takes", value: this.get(STAGE) ?? "all", pick: (v, cx) => this.save(STAGE, v === "all" ? null : v, cx),
      options: [["all", "Every change"], ["tracked", "Tracked files"], ["none", "What is staged"]],
    });

    for (const [group, note, switches] of SWITCHES) {
      rows.push({ group, note });
      for (const [path, label, normal, detail] of switches) {
        const on = this.get(path) ?? normal;
        rows.push({ id: path.join("-"), kind: "switch", label, on, note: detail, flip: (cx) => this.save(path, !on === normal ? null : !on, cx) });
      }
    }
    return rows;
  }

  move(to, cx) {
    const rows = this.rows(), n = rows.filter((r) => !r.group).length;
    if (!n) return;
    this.at = (to + n) % n;
    let seen = -1;
    this.scroll.scroll_to_item(rows.findIndex((r) => !r.group && ++seen === this.at));
    cx.notify();
  }

  act(row, cx) {
    if (!row) return;
    if (row.kind === "switch") row.flip(cx);
    else if (row.kind === "choice") row.pick(row.options[(row.options.findIndex(([v]) => v === row.value) + 1) % row.options.length][0], cx);
    else row.field.input.focus();
  }

  openFile() {
    if (!this.state?.path) return;
    const overlay = props()?.overlay;
    run("pane.split", { direction: "right", argv: ["nvim", this.state.path] });
    if (overlay) closeOverlay(overlay);
  }

  key(e, cx) {
    if (this.typing) { if (e.key === "escape") { this.host.handle.focus(); cx.stop_propagation(); cx.notify(); } return true; }
    const char = e.key_char ?? e.key;
    if (char === "r") { this.reload(cx); return true; }
    if (this.enabled === false) {
      if (char === "m" || e.key === "enter") { this.host.show("mods", cx); return true; }
      return false;
    }
    if (!this.state) return false;
    const rows = this.rows().filter((r) => !r.group);
    if (e.key === "down" || char === "j") this.move(this.at + 1, cx);
    else if (e.key === "up" || char === "k") this.move(this.at - 1, cx);
    else if (char === "g") this.move(0, cx);
    else if (char === "G") this.move(rows.length - 1, cx);
    else if (e.key === "enter" || e.key === "space" || char === " ") this.act(rows[Math.min(this.at, rows.length - 1)], cx);
    else if (char === "e") this.openFile();
    else return false;
    return true;
  }

  row(t, row, i) {
    const selected = i === this.at, mono = settings().font_family ?? "JetBrains Mono";
    const label = div().flex_none().w(LABEL).truncate().text_color(t.foreground).child(row.label);
    const detail = (el) => el.when(Boolean(row.detail), (e) => e.child(div().pl(LABEL + 10).truncate().text_size(11).text_color(t.dim)
      .when(Boolean(row.mono), (d) => d.font_family(mono)).child(row.detail ?? "")));
    const shell = (inner) => detail(v_flex().id(`wt-${row.id}`).flex_none().px(10).py(6).gap(5).rounded(8)
      .when(selected, (el) => el.bg(t.selected)).when(!selected, (el) => el.hover((s) => s.bg(t.hover)))
      .child(inner));

    if (row.kind === "switch") {
      return shell(h_flex().h(22).gap(10).items_center()
        .child(div().flex_shrink(1).min_w(0).truncate().child(row.label))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(row.note ?? ""))
        .child(div().flex_none().w(22).text_size(11).text_color(t.dim).child(row.on ? "on" : "off"))
        .child(toggle(t, row.on)))
        .cursor_pointer().on_click((_e, cx) => { this.at = i; this.host.handle.focus(); row.flip(cx); });
    }
    if (row.kind === "choice") {
      return shell(h_flex().gap(10).items_center().child(label)
        .child(h_flex().flex_1().min_w(0).gap(5).flex_wrap().children(row.options.map(([value, text]) => {
          const on = value === row.value;
          return div().id(`wt-${row.id}-${value}`).flex_none().h(24).px(9).flex().items_center().rounded(6).border_1().text_size(12).cursor_pointer()
            .border_color(on ? t.accent : t.border).text_color(on ? t.foreground : t.muted).when(on, (el) => el.bg(t.raised))
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.at = i; this.host.handle.focus(); row.pick(value, cx); })
            .child(text);
        }))))
        .on_click((_e, cx) => { this.at = i; cx.notify(); });
    }
    const focused = Boolean(row.field.focused);
    const input = row.area ? Textarea.new(row.field.input) : Input.new(row.field.input);
    return shell(h_flex().gap(10).when(!row.area, (el) => el.items_center()).when(Boolean(row.area), (el) => el.items_start())
      .child(row.area ? label.pt(6) : label)
      .child(div().id(`wt-${row.id}-box`)
        .when(Boolean(row.area), (el) => el.key_context("WorktrunkGuidance")
          .on_action("config-submit-text", (_e, cx) => { cx.stop_propagation(); this.host.handle.focus(); cx.notify(); })
          .on_action("config-newline", (_e, cx) => { cx.stop_propagation(); row.field.input.replace("\n"); }))
        .flex_1().min_w(0).px(10).rounded(8).border_1().border_color(focused ? t.accent : t.border).bg(t.surface).cursor_text()
        .when(!row.area, (el) => el.h(30).flex().items_center()).when(Boolean(row.area), (el) => el.py(6))
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .child(input.w_full().text_size(12).text_color(t.foreground).when(!row.area, (el) => el.h_full()))))
      .on_click((_e, cx) => { this.at = i; cx.notify(); });
  }

  render(t) {
    if (this.enabled === false) return v_flex().gap(8).px(4)
      .child(div().font_semibold().child("Worktrunk is off"))
      .child(div().text_color(t.muted).child("Turn it on in Mods to use worktrees in the Launcher and edit Worktrunk's settings."))
      .child(h_flex().child(Button.new("worktrunk-open-mods").accessibility_label("Open Mods").px(10).py(6).rounded(6).bg(t.surface).text_color(t.foreground).cursor_pointer()
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.host.show("mods", cx)).child("Open Mods  ·  m")));
    const rows = this.state ? this.rows() : [];
    const count = rows.filter((r) => !r.group).length;
    if (count) this.at = Math.min(this.at, count - 1);
    let i = -1;
    const head = (r) => h_flex().flex_none().h(30).px(10).gap(8).items_end().pb(4).text_size(11)
      .child(div().flex_none().font_semibold().text_color(t.muted).child(r.group))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(r.note ?? ""));
    return v_flex().size_full().min_h(0).gap(6)
      .child(h_flex().flex_none().px(4).gap(8).text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(this.state ? `${tildify(this.state.path)}${this.state.exists ? "" : " · not made yet, your first change makes it"}` : this.error ? "" : waiting(t, "Reading worktrunk's config")))
        .child(div().flex_none().child(this.saving ? waiting(t, "Saving") : "")))
      .when(Boolean(this.error), (el) => el.child(div().flex_none().mx(4).p(8).rounded(8).border_1().border_color(t.blocked).text_size(12).text_color(t.blocked).child(this.error)))
      .child(v_flex().id("wt-rows").flex_1().min_h(0).gap(2).pr(12).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(rows.map((r) => (r.group ? head(r) : this.row(t, r, ++i)))));
  }
}
