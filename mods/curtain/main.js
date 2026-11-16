// Curtain: one switch that takes every sign of agents off the window, for
// sharing the screen. Terms: GLOSSARY.md.
//
// Drawn (on), nothing running is ended:
//   - a tab with only agents in it is put away (tab.settle) and left out of
//     the tab bar and the spaces sidebar; a space with no other tab is left out
//   - an agent beside a shell is taken out of its tab (terminal.park) and keeps
//     running; lifting the curtain puts it back to the right of the pane it
//     sat next to, so its place in the split can differ
//   - the agents list, the Skillshare button and panel go, the attention
//     sounds go quiet (settings.json), and the mods that read the state below
//     drop their agent parts
// An agent started while it is drawn goes the same way at once.
//
// State, read by every mod that shows agents:
//   shared "curtain": { on, parked: [{ terminal, tab, beside, first }], settled: [tab],
//                       nodes: [layout id], agents, sounds }
// A mod asks `shared("curtain")?.on`, and hides a tab that is settled or has
// only agents in it (see hiddenTab below, the same rule in tab-bar and
// spaces-sections).
//
// It lives in my layout as a floating block that draws nothing. Keys reach it
// as commands (keys.json):
//   curtain.toggle | on | off
//   curtain.agent-next | agent-prev     agent.next / agent.prev, nothing while drawn
//   curtain.space-1..9 | space-next | space-prev   as space.select / next / prev,
//                                       passing over spaces that are left out
//   curtain.open-<mod>                  mod.open <mod>, nothing while drawn: for
//                                       the keys of mods that show agents

import { View, div } from "gpui-kit";
import { agents, appHome, exec, focused, knownAgents, layout, nextCommand, notify, panes, readTextFile, run, setShared, shared, spaces, terminals, writeTextFile } from "herdr";

const KEY = "curtain";
// Layout blocks that only make sense with agents. The agents list is handled
// apart: on the rail it holds the button that unfolds the sidebar.
const NODES = ["skillshare-toggle", "skillshare-panel"];

const state = () => shared(KEY) ?? {};
// Hidden sections remain reachable only from the spaces sidebar. Read their
// membership directly, so a move takes effect before the next sidebar render.
const hiddenSpaces = () => new Set((shared("spaces.sections")?.sections ?? []).filter((s) => s.hidden).flatMap((s) => s.members));
// An agent: a terminal that reports a status, or runs a program Herdr can start
// as an agent (its own list, as the + menu last saw it) and has not reported yet.
const agentKeys = () => new Set(Object.values(shared("new-menu.agents") ?? {}).flat().map((a) => a.key));
const isAgent = (p, keys) => Boolean(p.terminal && (p.program?.agent || p.status || keys.has(p.program?.key)));
const hiddenTab = (tab, ps, keys) => {
  if (tab.settled) return true;
  const mine = ps.filter((p) => p.tab === tab.id);
  return mine.length > 0 && mine.every((p) => isAgent(p, keys));
};
const visible = (space, ps, keys) => (space.tabs ?? []).some((tab) => !hiddenTab(tab, ps, keys));

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;
const pause = (ms) => exec("sleep", [String(ms / 1000)]);
// The item after (or before) index `at`, wrapping; from nowhere, the first (or last).
const step = (list, at, forward) => list[at < 0 ? (forward ? 0 : list.length - 1) : (at + (forward ? 1 : list.length - 1)) % list.length];

export default class Curtain extends View {
  init(_props, cx) {
    this.last = {};
    // The record is kept here and only copied to shared state: a value set
    // there is not read back until later, so reading it to add to it loses
    // what an earlier render in the same moment recorded.
    const st = state();
    this.on = Boolean(st.on);
    this.parked = [...(st.parked ?? [])];
    this.settled = [...(st.settled ?? [])];
    this.nodes = [...(st.nodes ?? [])];
    this.agents = Boolean(st.agents);
    this.sounds = st.sounds ?? null;
    // Herdr's list of agents, for the ones that have not reported a status yet.
    cx.spawn(async (cx) => {
      try {
        const known = await knownAgents();
        setShared("new-menu.agents", { ...shared("new-menu.agents"), "": known });
      } catch {}
      cx.notify();
    });
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        this.command(command, cx);
      }
    });
  }

  // True at most once per `ms` for a key: commands land a moment after they
  // are run, and the same render must not send them twice.
  once(key, ms) {
    const now = Date.now();
    if (now - (this.last[key] ?? 0) < ms) return false;
    this.last[key] = now;
    return true;
  }

  save() {
    setShared(KEY, { on: this.on, parked: this.parked, settled: this.settled, nodes: this.nodes, agents: this.agents, sounds: this.sounds });
  }

  command(command, cx) {
    const on = this.on;
    if (command === "toggle") return this.set(!on, cx);
    if (command === "on" || command === "off") return this.set(command === "on", cx);
    if (command === "agent-next" || command === "agent-prev") {
      if (on) return;
      const hidden = hiddenSpaces();
      if (!hidden.size) return run(command.replace("-", "."));
      // setAgentOrder orders the model; it appends omitted agents. Navigation
      // must select from the filtered list instead of calling agent.next/prev.
      const order = new Map((shared("agents.order") ?? []).map((id, i) => [id, i]));
      const list = agents().filter((a) => !hidden.has(a.space));
      list.sort((a, b) => (order.get(a.address) ?? Infinity) - (order.get(b.address) ?? Infinity));
      const f = focused();
      const at = list.findIndex((a) => a.address === (f?.agent ?? f?.terminal));
      const forward = command === "agent-next";
      const next = step(list, at, forward);
      if (next) run("agent.focus", { terminal: next.address });
      return;
    }
    if (command.startsWith("open-")) { if (!on) run("mod.open", { name: command.slice(5) }); return; }
    const sp = spaces(), ps = panes(), keys = agentKeys(), hidden = hiddenSpaces();
    const nth = /^space-([1-9])$/.exec(command);
    if (nth) {
      const target = sp.filter((s) => !hidden.has(s.id))[Number(nth[1]) - 1];
      if (target && (!on || visible(target, ps, keys))) run("space.select", { id: target.id });
      return;
    }
    if (command === "space-next" || command === "space-prev") {
      if (!on && !hidden.size) return run(command.replace("-", "."));
      const open = sp.filter((s) => s.active || (!hidden.has(s.id) && (!on || visible(s, ps, keys))));
      const at = open.findIndex((s) => s.active);
      const forward = command === "space-next";
      const next = step(open, at, forward);
      if (next && !next.active) run("space.select", { id: next.id });
    }
  }

  set(on, cx) {
    if (this.switching || this.on === on) return;
    this.switching = true;
    cx.spawn(async (cx) => {
      try { await (on ? this.draw() : this.lift()); }
      catch (e) { notify({ title: "Curtain", body: String(e?.message ?? e), level: "error" }); }
      this.switching = false;
      cx.notify();
    });
  }

  // settings.json's sounds.enabled, changed in place. Returns what it was, or
  // null when the file could not be read.
  async sounds_(want) {
    const path = `${appHome()}/settings.json`;
    try {
      const text = await readTextFile(path);
      const settings = JSON.parse(text);
      const was = settings.sounds?.enabled !== false;
      if (was === want) return was;
      const field = /("sounds"\s*:\s*\{[^}]*"enabled"\s*:\s*)(true|false)/;
      const next = field.test(text)
        ? text.replace(field, `$1${want}`)
        : JSON.stringify({ ...settings, sounds: { ...settings.sounds, enabled: want } }, null, 2) + "\n";
      await writeTextFile(path, next, text);
      return was;
    } catch { return null; }
  }

  async draw() {
    const root = layout();
    const shown = (id) => { const node = find(root, id); return Boolean(node) && !node.hidden; };
    this.nodes = NODES.filter(shown);
    this.nodes.forEach((id) => run("layout.hide", { id }));
    this.agents = shown("agents");
    // Where the window was: lifting the curtain goes back there.
    this.from = focused();
    this.sounds = await this.sounds_(false);
    this.parked = [];
    this.settled = [];
    this.on = true;
    // The rest happens in enforce(), which every change to the window runs.
    this.save();
  }

  async lift() {
    this.on = false;
    this.save();
    // Nothing else puts tabs away here, so every settled one comes back.
    for (const tab of spaces().flatMap((s) => s.tabs ?? [])) if (tab.settled) run("tab.unsettle", { id: tab.id });
    this.nodes.forEach((id) => run("layout.show", { id }));
    if (this.agents) run("layout.show", { id: "agents" });
    if (this.sounds) await this.sounds_(true);

    // Parked agents go back beside the pane they sat next to. terminal.keep
    // places by the focused pane, so each one is visited, then focus returns.
    const live = new Set(terminals().filter((t) => t.state !== "finished").map((t) => t.address));
    const tabs = spaces().flatMap((s) => s.tabs ?? []);
    const back = tabs.some((tab) => tab.id === this.from?.tab) ? this.from : focused();
    let moved = back === this.from;
    for (const p of this.parked) {
      const ps = panes();
      if (!live.has(p.terminal) || ps.some((x) => x.terminal === p.terminal)) continue;
      const anchor = ps.find((x) => x.pane === p.beside) ?? ps.find((x) => x.tab === p.tab);
      moved = true;
      if (!anchor) { run("terminal.keep", { terminal: p.terminal }); await pause(300); continue; }
      run("tab.select", { id: anchor.tab });
      await pause(150);
      run("pane.focus", { pane: anchor.pane });
      await pause(150);
      run("terminal.keep", { terminal: p.terminal, place: "right" });
      await pause(350);
      const kept = p.first ? panes().find((x) => x.terminal === p.terminal) : null;
      if (kept) { run("pane.swap", { pane: kept.pane, target: anchor.pane }); await pause(150); }
    }
    if (moved && back) {
      run("tab.select", { id: back.tab });
      await pause(150);
      if (back.pane && panes().some((x) => x.pane === back.pane)) run("pane.focus", { pane: back.pane });
    }
    this.from = null;
    this.parked = [];
    this.settled = [];
    this.nodes = [];
    this.save();
  }

  // While drawn: every agent that has shown up since goes, and the window
  // never rests on a tab that is left out.
  enforce() {
    const sp = spaces(), ps = panes(), keys = agentKeys();
    const agent = (p) => isAgent(p, keys);
    const parked = this.parked, settled = this.settled;
    let changed = false;
    for (const s of sp) for (const tab of s.tabs ?? []) {
      const mine = ps.filter((p) => p.tab === tab.id);
      const ai = mine.filter(agent);
      if (mine.length > 0 && ai.length === mine.length) {
        if (!tab.settled && this.once(`settle:${tab.id}`, 1500)) {
          run("tab.settle", { id: tab.id });
          if (!settled.includes(tab.id)) { settled.push(tab.id); changed = true; }
        }
      } else if (tab.settled && settled.includes(tab.id) && mine.length > 0 && this.once(`unsettle:${tab.id}`, 1500)) {
        // Its agent ended or got company: an ordinary tab again.
        run("tab.unsettle", { id: tab.id });
        settled.splice(settled.indexOf(tab.id), 1);
        changed = true;
      } else for (const p of ai) {
        // Parking takes a moment and fails if asked twice meanwhile.
        if (!this.once(`park:${p.terminal}`, 15000)) continue;
        const at = mine.indexOf(p);
        const before = mine.slice(0, at).reverse().find((x) => !agent(x));
        const beside = (before ?? mine.find((x) => !agent(x)))?.pane ?? null;
        run("terminal.park", { terminal: p.terminal });
        // `first`: it came before that pane, so it is swapped back in front of it.
        if (!parked.some((x) => x.terminal === p.terminal)) { parked.push({ terminal: p.terminal, tab: tab.id, beside, first: !before }); changed = true; }
      }
    }

    const active = sp.find((s) => s.active);
    const tab = active?.tabs?.find((x) => x.active);
    if (tab && hiddenTab(tab, ps, keys) && this.once("leave", 700)) {
      const here = active.tabs.find((x) => !hiddenTab(x, ps, keys));
      const hidden = hiddenSpaces();
      const there = sp.find((s) => !hidden.has(s.id) && visible(s, ps, keys));
      if (here) run("tab.select", { id: here.id });
      else if (there) run("space.select", { id: there.id });
      else run("tab.new", { space: active.id });
    }

    // The agents list goes, except on the rail, where it holds the unfold button.
    const list = find(layout(), "agents");
    if (this.agents && list && Boolean(list.hidden) === narrow() && this.once("agents", 700)) {
      run(narrow() ? "layout.show" : "layout.hide", { id: "agents" });
    }
    if (changed) this.save();
  }

  render() {
    if (this.on && !this.switching) this.enforce();
    return div();
  }
}
