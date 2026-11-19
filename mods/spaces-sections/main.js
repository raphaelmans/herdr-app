// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, svg } from "gpui-kit";
//
// Sections: cmd-click or shift-click rows to pick them, right-click a picked row
// to put them in a section. A section is a named, foldable run of spaces on one machine,
// kept in shared "spaces.sections"; its spaces are moved next to each other
// for real, so space numbers follow what's shown. Drag a row onto a section's
// row or header to add it, onto a loose row or the machine header to take it
// out, and drag a section's header to move the whole section. Right-click a
// header to rename the section or dissolve it (its spaces stay where they are).
// Hidden is a permanent section per machine for deferred work. Its members
// stay in this sidebar; other own mods read its `hidden: true` membership to
// leave them out of discovery, navigation and attention summaries.

import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, machines, panes, run, openOverlay, closeOverlay, props, exec, hc, theme, shared, setShared, watchFolder, window, layout } from "herdr";

const MOD = "spaces-sections";
const SECTIONS = "spaces.sections";
const RANK = { blocked: 3, done: 2, working: 1, idle: 0 };

// { id, name, machine (null: this computer), folded, hidden?, members: [space id] }.
// Members are a set: their order is the spaces' own.
function sectionsOf() {
  const v = shared(SECTIONS);
  const sections = Array.isArray(v?.sections) ? [...v.sections] : [];
  // Empty Hidden sections need no saved state. Once used, they keep their
  // membership and fold state through the same save path as other sections.
  const names = new Set([null, ...spaces().map((s) => s.machine ?? null), ...machines().filter((m) => !m.temporary).map((m) => m.name ?? null)]);
  for (const machine of names) if (!sections.some((s) => s.hidden && onMachine(s, machine))) {
    sections.push({ id: `hidden:${machine ?? ""}`, name: "Hidden", machine, folded: true, hidden: true, members: [] });
  }
  return sections;
}

// Ordinary sections go when empty; Hidden stays available for the next space.
function saveSections(sections) {
  setShared(SECTIONS, { v: 1, sections: sections.filter((s) => s.hidden || s.members.length) });
}

const onMachine = (s, machine) => (s.machine ?? null) === (machine ?? null);

// The sections with these spaces taken out.
function without(ids) {
  const moving = new Set(ids);
  return sectionsOf().map((s) => ({ ...s, members: s.members.filter((id) => !moving.has(id)) }));
}

// Puts spaces in section `to` (null: none) and takes them out of the others.
function assign(ids, to) {
  saveSections(without(ids).map((s) => (s.id === to ? { ...s, members: [...s.members, ...ids] } : s)));
}

function createSection(name, ids, machine) {
  if (name.toLowerCase() === "hidden") return moveInto(ids, sectionsOf().find((s) => s.hidden && onMachine(s, machine)));
  saveSections([
    ...without(ids),
    { id: `s${Date.now().toString(36)}`, name, machine: machine ?? null, folded: false, members: ids },
  ]);
}

// Moves spaces, keeping their order, to just before or after `anchor`.
function placeAt(ids, anchor, after) {
  const order = spaces().map((s) => s.id);
  const moving = order.filter((id) => ids.includes(id) && id !== anchor);
  for (const id of moving.reverse()) {
    const from = order.indexOf(id);
    order.splice(from, 1);
    const to = order.indexOf(anchor) + (after ? 1 : 0);
    order.splice(to, 0, id);
    if (to !== from) run("space.move", { id, index: to + 1 });
  }
}

// A section's spaces as they are ordered now.
function membersOf(section) {
  return spaces().filter((s) => section.members.includes(s.id) && onMachine(s, section.machine)).map((s) => s.id);
}

// Adds spaces at the end of a section, so the section stays where it is.
function moveInto(ids, section) {
  const last = membersOf(section).filter((id) => !ids.includes(id)).pop();
  assign(ids, section.id);
  if (last) placeAt(ids, last, true);
}

const same = (a, b) => (a?.kind ?? null) === (b?.kind ?? null) && (a?.id ?? null) === (b?.id ?? null);

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// The curtain's rule (mods/curtain), the same in tab-bar: while it is drawn, a
// tab that is put away or holds only agents is left out, and so is a space
// with no other tab; no space shows an agent's status.
// An agent: a terminal that reports a status, or runs a program Herdr can start
// as an agent (its own list, as the + menu last saw it) and has not reported yet.
const agentKeys = () => new Set(Object.values(shared("new-menu.agents") ?? {}).flat().map((a) => a.key));
const isAgent = (p, keys) => Boolean(p.terminal && (p.program?.agent || p.status || keys.has(p.program?.key)));
const hiddenTab = (tab, ps, keys) => {
  if (tab.settled) return true;
  const mine = ps.filter((p) => p.tab === tab.id);
  return mine.length > 0 && mine.every((p) => isAgent(p, keys));
};
function unveiled(rows) {
  if (!shared("curtain")?.on) return rows;
  const ps = panes(), keys = agentKeys();
  return rows.filter((r) => (r.w.tabs ?? []).some((tab) => !hiddenTab(tab, ps, keys))).map((r) => ({ ...r, w: { ...r.w, status: null } }));
}

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const RAIL_CELL = 32;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

// Escape is bound to an action of this mod's own: while a text field has the
// keyboard, Herdr closes the dialog on Escape before any key handler here sees it.
let escapeBound = false;

export default class Spaces extends View {
  init(_props, cx) {
    if (!escapeBound) { cx.bind_keys([{ keystroke: "escape", action: "section-name-escape", context: "SectionName" }]); escapeBound = true; }
    // Opened by itself as the section menu or the name dialog: no list to keep.
    const p = props() ?? {};
    this.mode = p.sectionMenu ? "menu" : p.sectionName ? "name" : null;
    if (this.mode === "name") {
      const renamed = p.sectionName.rename ? sectionsOf().find((s) => s.id === p.sectionName.rename) : null;
      this.input = InputState.new({ value: renamed?.name ?? "" });
      this.input.on("submit", () => this.nameSubmit());
      // Whether the name field has the keyboard: Escape steps back out of it first.
      this.typing = false;
      this.left = false;
      this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
      this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
      this.handle = cx.focus_handle();
      this.input.focus();
      cx.timer.after(600, () => { if (!this.left) this.input.focus(); });
    }
    if (this.mode) return;
    this.picked = new Set(); // rows picked with cmd-click or shift-click
    this.anchor = null; // where a shift-click's range starts
    this.visible = []; // the rows drawn, in order
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
    for (const state of Object.values(this.reconnecting)) state.busy = false;
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // Refresh only when the refs could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        await Promise.all(keys.map((key) => this.check(key, cx)));
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // Ref-only reads avoid scanning the worktree or waking its index watch.
      // Two reads: a folder name may itself contain a newline.
      const [r, common] = await Promise.all([
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
      ]);
      if (r.code !== 0 || common.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.code !== 0 ? r.stderr : common.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = r.stdout.replace(/\n$/, ""), repo = common.stdout.replace(/\n$/, "");
      const [branch, counts] = await Promise.all([
        exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
        exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on }),
      ]);
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
      const info = { name, branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : "(detached)", ahead, behind, repo: JSON.stringify([on, repo]), linked: repo !== `${top}/.git` };
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const sectionOf = new Map();
    for (const s of sectionsOf()) for (const id of s.members) {
      if (sp.some((w) => w.id === id && onMachine(w, s.machine))) sectionOf.set(id, s);
    }
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    // A worktree only nests under a checkout in the same section. Hiding
    // either one must not silently hide (or restore) the other.
    const group = (r) => JSON.stringify([r.g?.repo, sectionOf.get(r.w.id)?.id ?? null]);
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map(group));
    const nested = (r) => r.g?.linked && mains.has(group(r));
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(group(r))) continue;
      placed.add(group(r));
      const kids = list.filter((k) => nested(k) && group(k) === group(r));
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Sections: a section's spaces (each with its worktrees) run together, from
    // where its first one is.
    const blocks = [];
    for (const r of out) r.tree && blocks.length ? blocks[blocks.length - 1].push(r) : blocks.push([r]);
    const owner = (b) => {
      const s = sectionOf.get(b[0].w.id);
      return s && onMachine(s, b[0].w.machine) ? s : null;
    };
    const done = new Set();
    out.length = 0;
    for (const b of blocks) {
      const s = owner(b);
      if (!s) out.push(...b.map((r) => ({ ...r, section: null })));
      else if (!done.has(s.id)) {
        done.add(s.id);
        for (const k of blocks) if (owner(k) === s) out.push(...k.map((r) => ({ ...r, section: s.id })));
      }
    }
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = unveiled(this.ordered());
    const hidden = new Set(sectionsOf().filter((s) => s.hidden).flatMap((s) => s.members));
    this.numbers = new Map(spaces().filter((s) => !hidden.has(s.id)).map((s, i) => [s.id, i + 1]));
    this.visible = [];
    this.dragFrom = this.dragIndex(); // once a render: every row and header draws its drop line by it
    const list = (rows, machine = null) => this.sectioned(rows, t, collapsed, machine);
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : list(rows);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const login = machine?.state === "needs_login" ? `hc machine login ${m}` : null;
      const folded = this.folded.has(m);
      const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none();
      const badge = div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.dim);
      const me = { kind: "machine", id: m ?? "local" };
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .when(collapsed, el => el.mt(4).w(RAIL_CELL).justify_center().rounded(6).tooltip(login ? `${m} needs a login: run ${login}. Click for Copy.` : m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "This computer"))
        .cursor_pointer().hover(s => s.bg(t.hover))
        // A row dropped here leaves its section.
        .when(same(this.over, me), el => el.bg(t.selected))
        .on_mouse_move((_e, cx) => this.hover(me, m, null, cx))
        .on_mouse_up("left", (_e, cx) => {
          const [from, over] = this.release();
          if (from?.kind === "row" && same(over, me)) assign(this.dragged(from, m), null);
          cx.notify();
        })
        .on_click((_e, cx) => {
          if (collapsed && login) { run("app.settings", { section: "machines" }); return; }
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .when(!collapsed, el => el.child(icon))
        .when(collapsed, el => el.child(div().relative().flex_none().child(icon).when(Boolean(m), el => el.child(badge))))
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt && !login, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", { machine: m ?? "" }); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", { machine: m ?? "" }))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(6).justify_center().tooltip(`New space on ${m ?? "this computer"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there"));
      if (!collapsed && rebuilt) return [head];
      const cell = collapsed ? railCell : (el) => el;
      const guidance = !collapsed && login ? [v_flex().px(8).pb(6).gap(3).flex_none()
        .child(div().text_size(11).text_color(t.blocked).child("needs a login: run"))
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(login).text_size(11).text_color(t.muted).child(login))
          .child(div().id(`machine-login-copy-${m}`).flex_none().px(5).py(2).rounded(4)
            .text_size(11).text_color(t.foreground).bg(t.raised).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(login); this.copiedLogin = login; cx.notify(); })
            .child(this.copiedLogin === login ? "Copied" : "Copy")))] : [];
      return [cell(head), ...guidance, ...(folded ? [] : mine.length ? list(mine, m) : [loading(m) ? loadingRow(m) : cell(empty), ...list([], m)])];
    });
  }

  // One machine's rows, each section under its header. Hidden is always last:
  // where its spaces sit in the space order, and any reordering, never moves it.
  sectioned(rows, t, collapsed, machine = null) {
    const sections = new Map(sectionsOf().map((s) => [s.id, s]));
    const isHidden = (r) => Boolean(r.section && sections.get(r.section)?.hidden);
    rows = [...rows.filter((r) => !isHidden(r)), ...rows.filter(isHidden)];
    const out = [];
    let last = null;
    for (const r of rows) {
      const s = r.section ? sections.get(r.section) ?? null : null;
      if (s && s.id !== last) out.push(this.sectionHead(s, rows.filter((k) => k.section === s.id), t, collapsed));
      last = s?.id ?? null;
      if (s?.folded) continue;
      this.visible.push(r.w);
      const row = s?.hidden ? { ...r, hidden: true, w: { ...r.w, status: null } } : r;
      out.push(collapsed ? this.compact(row, t) : this.row(row, t));
    }
    for (const s of sections.values()) if (s.hidden && onMachine(s, machine) && !rows.some((r) => r.section === s.id)) {
      out.push(this.sectionHead(s, [], t, collapsed));
    }
    return out;
  }

  // A section's header: click folds it, drag moves the section, a row dropped on it joins.
  sectionHead(s, members, t, collapsed) {
    const me = { kind: "section", id: s.id };
    const active = members.some((r) => r.w.active);
    const status = s.hidden ? null : members.map((r) => r.w.status).filter(Boolean).sort((a, b) => RANK[b] - RANK[a])[0] ?? null;
    const count = members.filter((r) => !r.tree).length;
    const toggle = () => saveSections(sectionsOf().map((k) => (k.id === s.id ? { ...k, folded: !k.folded } : k)));
    const menu = () => openOverlay({ mod: MOD, kind: "popup", width: 200, height: 72, props: { sectionMenu: { section: s.id } } });
    const chevron = svg(`mods/workspace-chrome/chevron-${s.folded ? "right" : "down"}.svg`).size(11).flex_none();
    if (collapsed) {
      return railCell(h_flex().id(`section-${s.id}`).w(RAIL_CELL).h(s.folded ? 22 : 12).mt(3).rounded(6).items_center().justify_center()
        .text_color(s.folded && active ? t.foreground : t.dim).cursor_pointer().hover((el) => el.bg(t.hover))
        .tooltip(`${s.name} · ${count}${s.hidden ? " · Sidebar only" : ""}`)
        .on_click(() => toggle())
        .on_mouse_down("right", menu)
        .when(s.hidden, (el) => el.child(svg("mods/spaces-sections/eye-off.svg").size(12)))
        .when(!s.hidden && s.folded, (el) => el.child(chevron))
        .when(!s.hidden && !s.folded, (el) => el.child(div().w(16).h(1).bg(t.border))));
    }
    const over = this.pressed !== null && same(this.over, me) && !same(this.pressed, me);
    const from = this.dragFrom;
    const at = members[0]?.i ?? 0;
    return h_flex().relative().id(`section-${s.id}`).h(24).mt(4).flex_none().px(8).gap(6).items_center().rounded(6)
      .text_size(11).text_color(t.dim).cursor_pointer().hover((el) => el.bg(t.hover))
      .when(!s.hidden && same(this.pressed, me) && this.over !== null && !same(this.over, me), (el) => el.opacity(0.5))
      .when(over && this.pressed.kind === "row", (el) => el.bg(t.selected))
      .when(over && this.pressed.kind === "section" && !s.hidden, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(from < at, (line) => line.bottom(0))
          .when(from > at, (line) => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = me;
        this.over = me;
      })
      .on_mouse_move((_e, cx) => this.hover(me, s.machine ?? null, s.id, cx))
      .on_mouse_up("left", (_e, cx) => {
        const [from, over] = this.release();
        if (same(from, me)) toggle();
        else if (from && same(over, me)) this.drop(from, { section: s });
        cx.notify();
      })
      .on_mouse_down("right", menu)
      .child(chevron)
      .when(s.hidden, (el) => el.tooltip("Deferred work · Sidebar only. Move spaces out when you are ready.").child(svg("mods/spaces-sections/eye-off.svg").size(12).flex_none()))
      .child(div().flex_1().min_w(0).truncate().font_medium().text_color(s.folded && active ? t.foreground : t.muted).child(s.name))
      .when(s.folded && (status === "blocked" || status === "done"), (el) => el.child(div().flex_none().text_color(tone(t, status)).child(glyph(status))))
      .child(div().flex_none().child(String(count)));
  }

  // Ends a drag: what was pressed and what it was over.
  release() {
    const drag = [this.pressed, this.over];
    this.pressed = this.over = null;
    return drag;
  }

  // The space index a drag started from: the row's, or its section's first.
  dragIndex() {
    if (!this.pressed) return -1;
    const all = spaces();
    if (this.pressed.kind === "row") return all.findIndex((s) => s.id === this.pressed.id);
    const section = sectionsOf().find((s) => s.id === this.pressed.id);
    return section ? all.findIndex((s) => s.id === membersOf(section)[0]) : -1;
  }

  // The machine a drag started on (null: this computer), undefined when gone.
  dragMachine() {
    if (this.pressed?.kind === "row") {
      const s = spaces().find((k) => k.id === this.pressed.id);
      return s ? s.machine ?? null : undefined;
    }
    const section = sectionsOf().find((s) => s.id === this.pressed?.id);
    return section ? section.machine ?? null : undefined;
  }

  // The pointer is on `target` mid-drag: it takes the drop if it's on the same
  // machine and isn't part of the section being dragged.
  hover(target, machine, section, cx) {
    if (this.pressed === null) return;
    const ok = this.dragMachine() === (machine ?? null)
      && !(this.pressed.kind === "section" && (target.kind === "machine" || section === this.pressed.id));
    const over = ok ? target : null;
    if (!same(this.over, over)) {
      this.over = over;
      cx.notify();
    }
  }

  // What a row drag carries: every picked row when it's one of them, on that machine.
  dragged(from, machine) {
    const ids = this.picked.has(from.id) && this.picked.size > 1 ? [...this.picked] : [from.id];
    const here = new Set(spaces().filter((s) => onMachine(s, machine)).map((s) => s.id));
    return ids.filter((id) => here.has(id));
  }

  // A drag let go on a row ({ row, section: its section's id }) or a header ({ section }).
  drop(from, target) {
    const all = spaces();
    const sections = sectionsOf();
    const index = (id) => all.findIndex((s) => s.id === id);
    if (from.kind === "row") {
      if (target.row) {
        const ids = this.dragged(from, target.row.machine);
        assign(ids, target.section ?? null);
        placeAt(ids, target.row.id, index(from.id) < index(target.row.id));
      } else if (!target.section.members.includes(from.id) || this.picked.size > 1) {
        moveInto(this.dragged(from, target.section.machine), target.section);
      }
      this.picked.clear();
      return;
    }
    // A section: all of it goes before or after the row, or the section, it was dropped on.
    // Hidden stays last: it isn't dragged, and nothing is placed around it.
    const moving = sections.find((s) => s.id === from.id);
    const onto = target.row ? sections.find((s) => s.id === target.section) : target.section;
    if (!moving || moving.hidden || onto?.hidden || onto?.id === moving.id) return;
    const ids = membersOf(moving);
    const ends = onto ? membersOf(onto) : [target.row.id];
    if (!ids.length || !ends.length) return;
    const after = index(ids[0]) < index(ends[0]);
    placeAt(ids, after ? ends[ends.length - 1] : ends[0], after);
  }

  // A row clicked: cmd toggles it, shift picks from the last one to it, plain goes there.
  click(w, e) {
    const mods = e?.modifiers ?? {};
    const machine = w.machine ?? null;
    const there = (id) => (spaces().find((s) => s.id === id)?.machine ?? null) === machine;
    this.clearOnChange = false;
    if (mods.platform || mods.control) {
      if (![...this.picked].every(there)) this.picked.clear();
      this.picked.has(w.id) ? this.picked.delete(w.id) : this.picked.add(w.id);
      this.anchor = w.id;
    } else if (mods.shift) {
      const rows = this.visible.filter((s) => onMachine(s, machine));
      const start = rows.find((s) => s.id === this.anchor) ?? rows.find((s) => s.active) ?? w;
      const a = rows.indexOf(start), b = rows.findIndex((s) => s.id === w.id);
      this.picked = new Set(rows.slice(Math.min(a, b), Math.max(a, b) + 1).map((s) => s.id));
      this.anchor = start.id;
    } else {
      this.picked.clear();
      this.anchor = w.id;
      run("space.select", { id: w.id });
    }
  }

  // Right-click on a picked row: what to do with the picked ones.
  pickedMenu(w) {
    this.clearOnChange = JSON.stringify(sectionsOf());
    openOverlay({ mod: MOD, kind: "popup", width: 220, height: 320, props: { sectionMenu: { ids: [...this.picked], machine: w.machine ?? null } } });
  }

  // The popup. For picked rows: a new section, an existing one, or none.
  // For a section's header: rename it or dissolve it.
  sectionMenu(t) {
    const p = props();
    const { ids = [], machine, section } = p.sectionMenu;
    const all = sectionsOf().filter((s) => onMachine(s, machine));
    // Not the one they are all in already.
    const sections = all.filter((s) => !ids.every((id) => s.members.includes(id)));
    const inOne = all.some((s) => s.members.some((id) => ids.includes(id)));
    const item = (id, icon, label, action) => h_flex().id(id).h(31).px(8).gap(9).rounded(7).items_center()
      .text_color(t.foreground).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click(() => { closeOverlay(p.overlay); action(); })
      .child(svg(`mods/workspace-chrome/${icon}.svg`).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(label));
    const rule = () => div().mx(7).my(4).h(1).bg(t.border);
    if (section) {
      const chosen = sectionsOf().find((s) => s.id === section);
      if (chosen?.hidden) return v_flex().id("section-menu").w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
        .child(div().px(8).py(4).text_size(11).text_color(t.dim).child("Deferred work · Sidebar only"))
        .child(item("sm-restore", "minus", "Restore all spaces", () => assign(chosen.members, null)));
      return v_flex().id("section-menu").w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
        .child(item("sm-rename", "square-pen", "Rename",
          () => openOverlay({ mod: MOD, kind: "dialog", width: 400, height: 190, props: { sectionName: { rename: section } } })))
        .child(item("sm-dissolve", "x", "Dissolve", () => saveSections(sectionsOf().filter((s) => s.id !== section))));
    }
    return v_flex().id("section-menu").w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .child(item("sm-new", "folder-plus", `New section from ${ids.length} ${ids.length === 1 ? "space" : "spaces"}`,
        () => openOverlay({ mod: MOD, kind: "dialog", width: 400, height: 190, props: { sectionName: { ids, machine } } })))
      .when(sections.length > 0, (el) => el.child(rule())
        .children(sections.map((s, i) => item(`sm-to-${i}`, "folder", `Move to ${s.name}`, () => moveInto(ids, s)))))
      .when(inOne, (el) => el.child(rule())
        .child(item("sm-out", "minus", "Remove from section", () => assign(ids, null))));
  }

  nameSubmit() {
    const p = props();
    closeOverlay(p.overlay);
    const name = this.input.value().trim();
    const { rename } = p.sectionName;
    // An empty name keeps the one it has.
    if (rename) {
      const section = sectionsOf().find((s) => s.id === rename);
      if (section?.hidden) return;
      if (section && name.toLowerCase() === "hidden") createSection("Hidden", section.members, section.machine);
      else if (name) saveSections(sectionsOf().map((s) => (s.id === rename ? { ...s, name } : s)));
    }
    else createSection(name || "Section", p.sectionName.ids, p.sectionName.machine);
  }

  // The dialog that names a new section or renames one. Enter saves; Esc steps back out of the
  // field, and a second Esc cancels.
  nameDialog(t) {
    const p = props();
    const { rename } = p.sectionName;
    const n = p.sectionName.ids?.length ?? 0;
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .hover((s) => s.opacity(0.88)).on_click(action).child(text);
    return v_flex().id("section-name").track_focus(this.handle)
      .key_context("SectionName")
      .on_action("section-name-escape", (_e, cx) => {
        if (this.typing) { this.typing = false; this.left = true; this.handle.focus(); cx.notify(); }
        else closeOverlay(p.overlay);
        cx.stop_propagation();
      })
      .on_key_down((e, cx) => {
        if (this.typing) return;
        else if (e.key === "enter") this.nameSubmit();
        else if (e.key === "tab" || e.key_char === "i") { this.input.focus(); cx.notify(); }
        else return;
        cx.stop_propagation();
      })
      .w_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground)
      .child(h_flex().items_center().child(div().flex_1().text_size(15).font_semibold().child(rename ? "Rename" : "New section"))
        .child(div().text_size(11).text_color(t.dim).child(this.typing ? "esc leave field" : "i type · esc close")))
      .child(div().pt(12).pb(7).text_size(11.5).text_color(t.dim).child(rename ? "Name" : `Name for ${n} ${n === 1 ? "space" : "spaces"}`))
      .child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(this.typing ? t.accent : t.input).bg(t.background).text_size(12.8).text_color(t.foreground))
      .child(h_flex().pt(16).gap(8).justify_end()
        .child(button("sn-cancel", "Cancel", false, () => closeOverlay(p.overlay)))
        .child(button("sn-save", rename ? "Rename" : "Create", true, () => this.nameSubmit())));
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, g, tree, section }, t) {
    const on = w.active;
    const me = { kind: "row", id: w.id };
    const picked = this.picked.has(w.id);
    const fromIndex = this.dragFrom;
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(Boolean(section), (el) => el.ml(10))
      .when(on && !picked, (el) => el.bg(t.selected))
      .when(picked, (el) => el.bg(t.accent + "33"))
      .when(!on && !picked, (el) => el.hover((s) => s.bg(t.hover)))
      .when(same(this.pressed, me) && !same(this.over, me), (el) => el.opacity(0.5))
      .when(this.pressed !== null && same(this.over, me) && !same(this.pressed, me), (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = me;
        this.over = me;
      })
      .on_mouse_move((_e, cx) => this.hover(me, w.machine ?? null, section, cx))
      .on_mouse_up("left", (e, cx) => {
        const [from, over] = this.release();
        if (same(from, me)) this.click(w, e);
        else if (from !== null && same(over, me)) this.drop(from, { row: w, section });
        cx.notify();
      })
      .on_mouse_down("right", () => (picked ? this.pickedMenu(w) : this.menu(w)))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(22).child(svg("mods/workspace-chrome/branch.svg").size(13).text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_shrink(0).max_w(150).truncate().text_color(t.foreground).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1()),
      );
  }

  compact({ w, hidden }, t) {
    return railCell(h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_CELL)
      .h(26)
      .rounded(6)
      .justify_center()
      .items_center()
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("space.select", { id: w.id }))
      .tooltip(`${w.name}${hidden ? " · Hidden · Sidebar only" : ""}`)
      .child(div().text_color(w.active ? t.foreground : t.muted).child(hidden ? svg("mods/spaces-sections/eye-off.svg").size(12) : String(this.numbers.get(w.id))))
      .child(div().absolute().right(5).text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  render() {
    const t = theme();
    if (this.mode === "menu") return this.sectionMenu(t);
    if (this.mode === "name") return this.nameDialog(t);
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    // Closed spaces leave their section, but only once their machine's spaces
    // are known: a machine still loading or away has none to show yet.
    const known = new Set(machines().filter((m) => m.layout === "ready").map((m) => m.name ?? null));
    const sections = sectionsOf();
    const live = sections.map((s) => (known.has(s.machine ?? null) ? { ...s, members: s.members.filter((id) => ids.has(id)) } : s));
    if (live.some((s, i) => s.members.length !== sections[i].members.length)) saveSections(live);
    for (const id of [...this.picked]) if (!ids.has(id)) this.picked.delete(id);
    // The section menu did something: its rows are no longer picked.
    if (this.clearOnChange && this.clearOnChange !== JSON.stringify(sectionsOf())) {
      this.picked.clear();
      this.clearOnChange = false;
    }
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13)
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child("Spaces"))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => run("space.new")).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.over = null; cx.notify(); })
        .children(this.grouped(t, collapsed)));
  }
}
