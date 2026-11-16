// Health page: whether this computer has what the mods need, so a fresh
// machine says what is missing instead of a mod quietly doing nothing.
// Terms: GLOSSARY.md (requirement).
//
// Four groups of rows:
//   Programs  each requirement: found or not, where, its version, and whether
//             its owner (mise, the system, its own installer) put it there
//   Agents    Herdr's installed agents, and the program the Writer runs
//   Herdr     what `herdr-app status` reports from files and mods
//   Wiring    keys and the layout on screen that name a mod that is not there
// A requirement is needed (its mods' main job stops without it) or extra (one
// feature does). One whose mods are all off is passed over.
//
// The Programs rows come from ../../health.sh --json, the same check a shell
// runs without Herdr. What a requirement is lives in ./requirements.json; which
// mod needs it lives in that mod's mod.json "spec" (see health.sh). Owners and
// install commands follow the toolchain standard (~/toolchain) when it is here. To add a
// requirement: describe it in requirements.json and name it in the mod's spec.
//
// The tab-bar button's copy runs survey() as Herdr starts: it keeps
//   shared "health": { missing: [names], extra: [names], route: [names] }
// for the button's mark, and says so once when something needed goes missing.

import { div } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { appHome, commands, exec, home, keys, knownAgents, notify, readTextFile, setShared, shared } from "herdr";
import { chip, tildify } from "./ui.js";
import { dirs, layoutMods } from "./mods.js";

export const HEALTH = "health";
const TOLD = "health.told";

// The program a shell command starts: its first word that is not VAR=value.
const program = (command) => String(command ?? "").trim().split(/\s+/).find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? "";

// A row: { group, state: "ok" | "extra" | "missing" | "route" | "off", name, tag, text, fix }.
// "missing" is a needed thing that is not there; "extra" a thing one feature wants;
// "route" a program that works but was not installed by its owner.
// The requirement rows are health.sh's, one for one: the page only words them.
async function programs() {
  const writer = program(shared("writer")?.command) || "claude";
  let found, where = "";
  try {
    const [check, w] = await Promise.all([
      exec("sh", [`${appHome()}/health.sh`, "--json"], { cwd: home(), timeout: 30_000 }),
      exec("sh", ["-c", 'command -v "$1"', "sh", writer], { cwd: home(), timeout: 5000 }).catch(() => null),
    ]);
    if (check.code > 1) throw new Error(check.stderr.trim() || `health.sh exited ${check.code}`);
    found = JSON.parse(check.stdout);
    where = w?.stdout.trim() ?? "";
  } catch (e) {
    return { rows: [{ group: "programs", state: "missing", name: "Could not look for programs", tag: "", text: String(e?.message ?? e), fix: null }], writer: null };
  }
  const rows = found.rows.map((r) => {
    const by = r.mods.length ? `${r.mods.join(", ")}: ${r.why}` : r.why;
    if (r.state === "off") return { group: "programs", state: "off", name: r.name, tag: "", text: "Not asked for: no mod that is on needs it", fix: null };
    if (r.state === "route") return { group: "programs", state: "route", name: r.name, tag: "off its route", text: `Works, but it is at ${tildify(r.path)} and the toolchain standard gives it to mise: install it there, so mise's copy is the one found.`, fix: r.fix };
    if (r.state === "ok") return { group: "programs", state: "ok", name: r.name, tag: [r.version, r.owner].filter(Boolean).join(" · "), text: `${tildify(r.path)}  —  ${by}`, fix: null };
    return { group: "programs", state: r.state, name: r.name, tag: r.needed ? "needed" : "extra", text: `Not found. Without it, no ${r.why}${r.mods.length ? ` (${r.mods.join(", ")})` : ""}.`, fix: r.fix };
  });
  for (const id of found.unknown ?? []) rows.push({ group: "programs", state: "extra", name: id, tag: "not described", text: "A mod spec names it, but mods/config/requirements.json does not describe it.", fix: null });
  for (const r of found.rows.filter((r) => r.drift)) rows.push({ group: "programs", state: "extra", name: `${r.name}: drift`, tag: "drift", text: "requirements.json no longer matches the toolchain standard. The standard is what is shown; update the copy.", fix: null });
  rows.push(found.standard
    ? { group: "programs", state: "ok", name: "Toolchain standard", tag: "", text: `${tildify(found.standard)}  —  owners and fixes follow it`, fix: null }
    : { group: "programs", state: "extra", name: "Toolchain standard", tag: "extra", text: "Not on this computer, so owners and fixes are this repo's copy and may be behind.", fix: "git clone git@github.com:raphaelmans/toolchain.git ~/toolchain" });
  return { rows, writer: { program: writer, path: where } };
}

async function agentRows(writer) {
  const rows = [];
  try {
    const installed = (await knownAgents()).filter((a) => a.installed);
    rows.push(installed.length
      ? { group: "agents", state: "ok", name: "Installed agents", tag: String(installed.length), text: installed.map((a) => a.name).join(", "), fix: null }
      : { group: "agents", state: "missing", name: "Installed agents", tag: "needed", text: "Herdr found no agent on this computer, so the Launcher offers only a terminal.", fix: "npm install -g @anthropic-ai/claude-code" });
  } catch (e) {
    rows.push({ group: "agents", state: "extra", name: "Installed agents", tag: "", text: `Could not ask Herdr: ${String(e?.message ?? e)}`, fix: null });
  }
  if (writer) {
    const label = shared("writer")?.label;
    rows.push(writer.path
      ? { group: "agents", state: "ok", name: "Writer", tag: writer.program, text: `${label ? `${label}  —  ` : ""}commit summaries, branch names and agent titles`, fix: null }
      : { group: "agents", state: "extra", name: "Writer", tag: "extra", text: `It runs ${writer.program}, which is not found: no commit summaries, branch names or agent titles are written.`, fix: "Choose another on the Writer page" });
  }
  return rows;
}

async function herdrRows() {
  let r;
  try { r = await exec("herdr-app", ["status"], { timeout: 10_000 }); }
  catch { return [{ group: "herdr", state: "extra", name: "herdr-app", tag: "extra", text: "Not found on PATH: agents and scripts cannot drive this window.", fix: "Start Herdr from Applications: it links ~/.local/bin/herdr-app itself" }]; }
  let errors = null;
  try { errors = JSON.parse(r.stdout).errors ?? []; } catch {}
  if (!errors) return [{ group: "herdr", state: "extra", name: "herdr-app status", tag: "", text: (r.stderr || r.stdout).trim().split("\n")[0] || `exit ${r.code}`, fix: null }];
  if (!errors.length) return [{ group: "herdr", state: "ok", name: "Files and mods", tag: "", text: "Herdr reports no error from a layout, keys, settings or a mod.", fix: null }];
  return errors.map((e) => {
    const text = typeof e === "string" ? e : (e.error ?? e.message ?? JSON.stringify(e));
    const name = typeof e === "string" ? "Error" : (e.mod ?? e.file ?? e.source ?? e.name ?? "Error");
    return { group: "herdr", state: "missing", name: String(name), tag: "error", text: String(text).replace(/\s+/g, " "), fix: String(text) };
  });
}

async function wiringRows(on, off) {
  const spaces = new Set(commands().map((c) => c.name.split(".")[0]));
  const lost = {}; // mod: [what names it]
  const add = (mod, what) => { if (mod && !on.includes(mod) && !(lost[mod] ??= []).includes(what)) lost[mod].push(what); };
  for (const k of keys()) {
    const action = String(k.action ?? "");
    const opened = /^mod\.open:(.+)$/.exec(action)?.[1], head = /^([a-z0-9-]+)\./.exec(action)?.[1];
    if (opened) add(opened, k.keys);
    else if (head && !spaces.has(head)) add(head, k.keys);
    if (k.section?.startsWith("mod:")) add(k.section.slice(4), k.keys);
  }
  const shown = shared("layout");
  try {
    for (const mod of layoutMods(JSON.parse((await readTextFile(`${appHome()}/layouts/${shown}.json`)) ?? "{}"))) add(mod, `layout ${shown}`);
  } catch {}
  const names = Object.keys(lost).sort();
  if (!names.length) return [{ group: "wiring", state: "ok", name: "Keys and the layout", tag: "", text: `Every mod that a key or ${shown ?? "the layout"} names is here.`, fix: null }];
  return names.map((mod) => {
    const isOff = off.includes(mod), uses = lost[mod];
    const inLayout = uses.some((u) => u.startsWith("layout "));
    return { group: "wiring", state: inLayout && !isOff ? "missing" : "extra", name: mod, tag: isOff ? "off" : "not here",
      text: `${isOff ? "Off" : "No such mod"}, but named by ${uses.slice(0, 6).join(", ")}${uses.length > 6 ? ` and ${uses.length - 6} more` : ""}.`,
      fix: isOff ? "Turn it on from the Mods page" : null };
  });
}

// Every row, in the order drawn.
async function check() {
  const root = appHome();
  const [on, off] = await Promise.all([dirs(`${root}/mods`), dirs(`${root}/mods-disabled`)]);
  const [prog, herdr, wiring] = await Promise.all([programs(), herdrRows(), wiringRows(on, off)]);
  const agents = shared("curtain")?.on ? [] : await agentRows(prog.writer);
  return [...prog.rows, ...agents, ...herdr, ...wiring];
}

const names = (rows, state) => rows.filter((r) => r.state === state).map((r) => r.name);

// Keeps shared "health" equal to what a check found.
function record(rows) {
  const next = { missing: names(rows, "missing"), extra: names(rows, "extra"), route: names(rows, "route") };
  if (JSON.stringify(shared(HEALTH) ?? null) !== JSON.stringify(next)) setShared(HEALTH, next);
  return next;
}

// The check as Herdr starts: says what is missing once, until that changes.
export async function survey() {
  let found;
  try { found = record(await check()); } catch { return; }
  const key = found.missing.join(", ");
  if (key === (shared(TOLD) ?? "")) return;
  setShared(TOLD, key);
  if (!key) return;
  setShared("config.page", HEALTH);
  notify({ title: found.missing.length === 1 ? "A requirement is missing" : `${found.missing.length} requirements are missing`,
    body: `${key}. Click for what each one stops, and how to get it.`, level: "warning", timeout: 12_000, action: { name: "mod.open", args: { name: "config" } } });
}

const GROUPS = [
  ["programs", "PROGRAMS", "what the mods run on this computer"],
  ["agents", "AGENTS", "the ones Herdr found, and who writes for you"],
  ["herdr", "HERDR", "what the app reports from its files and mods"],
  ["wiring", "WIRING", "keys and the layout on screen"],
];
const ROW = 46;

export default class Health {
  constructor(host) {
    this.host = host;
    this.scroll = ScrollHandle.new();
    this.rows = null;
    this.at = 0;
    this.only = false; // list only what is missing
    this.busy = false;
    this.note = "";
    this.hints = "j k g G move · r check again · y copy the fix · p only what is missing";
  }

  start(cx) { this.run(cx); }

  run(cx) {
    if (this.busy) return;
    this.busy = true; this.note = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try { this.rows = await check(); record(this.rows); }
      catch (e) { this.rows ??= []; this.note = String(e?.message ?? e); }
      this.busy = false;
      this.at = Math.min(this.at, Math.max(0, this.listed().length - 1));
      cx.notify();
    });
  }

  listed() {
    const rows = this.rows ?? [];
    return this.only ? rows.filter((r) => ["missing", "extra", "route"].includes(r.state)) : rows;
  }

  // The list as drawn: a heading before each group's first row.
  entries() {
    const rows = this.listed(), out = [];
    rows.forEach((row, i) => {
      if (row.group !== rows[i - 1]?.group) out.push({ group: row.group });
      out.push({ row, i });
    });
    return out;
  }

  move(delta, cx) {
    const n = this.listed().length;
    if (!n) return;
    this.at = (this.at + delta + n) % n;
    this.note = "";
    this.scroll.scroll_to_item(this.entries().findIndex((e) => e.i === this.at));
    cx.notify();
  }

  copy(row, cx) {
    if (!row) return;
    if (!row.fix) this.note = row.state === "ok" ? `${row.name} is fine.` : "Nothing to copy for this one.";
    else { cx.write_to_clipboard(row.fix); this.note = `Copied: ${row.fix}`; }
    cx.notify();
  }

  key(e, cx) {
    const char = e.key_char ?? e.key, n = this.listed().length;
    if (e.key === "down" || char === "j") this.move(1, cx);
    else if (e.key === "up" || char === "k") this.move(-1, cx);
    else if (char === "g") this.move(-this.at, cx);
    else if (char === "G") this.move(n - 1 - this.at, cx);
    else if (char === "r") this.run(cx);
    else if (char === "y" || e.key === "enter") this.copy(this.listed()[this.at], cx);
    else if (char === "p") { this.only = !this.only; this.at = 0; this.note = ""; cx.notify(); }
    else return false;
    return true;
  }

  mark(t, state) {
    const [text, color] = { ok: ["✓", t.ansi2], extra: ["!", t.ansi3], missing: ["✕", t.blocked], route: ["↷", t.ansi3], off: ["–", t.dim] }[state];
    return div().flex_none().w(16).text_size(13).font_semibold().text_color(color).child(text);
  }

  row(t, row, i) {
    const selected = i === this.at, bad = ["missing", "extra", "route"].includes(row.state), off = row.state === "off";
    const second = bad && selected && row.fix ? `${row.text}  →  ${row.fix}` : row.text;
    return h_flex().id(`health-${i}`).flex_none().h(ROW).px(10).gap(10).items_center().rounded(8).cursor_pointer()
      .when(selected, (el) => el.bg(t.selected)).when(!selected, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => { this.at = i; this.host.handle.focus(); this.copy(row, cx); })
      .child(this.mark(t, row.state))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(h_flex().gap(6).items_center()
          .child(div().flex_shrink(1).min_w(0).truncate().font_semibold().text_color(off ? t.dim : t.foreground).child(row.name))
          .when(Boolean(row.tag), (el) => el.child(chip(t, row.tag, row.state === "missing" ? t.blocked : bad ? t.ansi3 : t.muted))))
        .child(div().truncate().text_size(12).text_color(off ? t.dim : t.muted).child(second)))
      .when(bad && Boolean(row.fix), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("y copy fix")));
  }

  render(t) {
    const rows = this.rows ?? [];
    const missing = names(rows, "missing").length, extra = names(rows, "extra").length, fine = names(rows, "ok").length, route = names(rows, "route").length;
    const routed = route ? ` · ${route} off ${route === 1 ? "its" : "their"} route` : "";
    const summary = !this.rows ? "Looking for what the mods need…"
      : missing ? `${missing} needed ${missing === 1 ? "thing is" : "things are"} missing${extra ? `, ${extra} extra` : ""}${routed} · ${fine} fine`
      : extra ? `Everything needed is here · ${extra} extra missing${routed} · ${fine} fine`
      : `Everything is here${routed} · ${fine} fine`;
    const heading = (group) => {
      const [, label, about] = GROUPS.find(([key]) => key === group);
      return h_flex().flex_none().h(28).px(10).gap(8).items_end().pb(4).text_size(11)
        .child(div().font_semibold().text_color(t.muted).child(label)).child(div().text_color(t.dim).child(about));
    };
    return v_flex().size_full().min_h(0).gap(6)
      .child(h_flex().flex_none().px(4).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_color(missing ? t.blocked : extra || route ? t.ansi3 : this.rows ? t.ansi2 : t.dim).child(summary))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(this.busy ? "checking…" : this.only ? "only what is missing" : "")))
      .child(v_flex().id("health-list").flex_1().min_h(0).gap(2).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(this.entries().map((e) => (e.row ? this.row(t, e.row, e.i) : heading(e.group))))
        .when(Boolean(this.rows) && !this.listed().length, (el) => el.child(div().px(10).py(8).text_color(t.dim).child("Nothing is missing."))))
      .when(Boolean(this.note), (el) => el.child(div().flex_none().px(4).truncate().text_size(12).text_color(t.muted).child(this.note)));
  }
}
