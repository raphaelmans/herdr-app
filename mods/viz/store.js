// The library and the artifact panes' pointers, on disk under mods/viz/ (hidden, so writes don't
// hot-reload the mod; inside the app home, so image() can draw embeds). Terms: CONTEXT.md.
//
//   .artifacts/<id>/meta.json     {id, title, project, cwd, created, updated, publishedBy, archived, embeds: {file: {kind, w, h, preview?}}}
//   .artifacts/<id>/artifact.md   the document: prose, with embeds as lines of their own
//   .artifacts/<id>/<embed files>
//   .artifacts/<id>/annotations.json  [{id, from, to, text, comment, sent}]: from/to are block indexes,
//                                 text the blocks' source. Publishing replaces the folder, so the file
//                                 goes with the content it was about.
//   .current/<terminal>.json      {terminal, id}: the artifact that agent's artifact pane shows

import { appHome, closeOverlay, focused, notify, openOverlay, panes, run, setShared, shared } from "herdr";
import * as fs from "fs/promises";

export const LIB_REL = "mods/viz/.artifacts";
export const CURRENT_REL = "mods/viz/.current";
export const OPEN = "viz.open";       // shared: {terminal: pane}
export const LIBRARY = "viz.library"; // shared: the open library window's overlay id

export const lib = () => `${appHome()}/${LIB_REL}`;
export const current = () => `${appHome()}/${CURRENT_REL}`;
export const safe = (t) => String(t).replace(/[^A-Za-z0-9_-]/g, "_");
export const dirOf = (id) => `${lib()}/${id}`;
export const relOf = (id) => `${LIB_REL}/${id}`;
export const docOf = (a) => `${dirOf(a.id)}/artifact.md`;

const name = (d) => (typeof d === "string" ? d : d.name);
const readJson = async (p, dflt) => { try { return JSON.parse(await fs.readFile(p, "utf8")); } catch { return dflt; } };

export async function ensureDirs() {
  await fs.mkdir(lib(), { recursive: true }).catch(() => {});
  await fs.mkdir(current(), { recursive: true }).catch(() => {});
}

export const readMeta = (id) => readJson(`${dirOf(id)}/meta.json`, null);
export const writeMeta = (a) => fs.writeFile(`${dirOf(a.id)}/meta.json`, JSON.stringify(a, null, 2));
export const readDoc = (a) => fs.readFile(docOf(a), "utf8").catch(() => "");

const notesOf = (id) => `${dirOf(id)}/annotations.json`;
export const readNotes = async (id) => { const n = await readJson(notesOf(id), []); return Array.isArray(n) ? n : []; };
export const writeNotes = (id, notes) => fs.writeFile(notesOf(id), JSON.stringify(notes, null, 2)).catch(() => {});

// Every artifact, most recently published first. One read at a time: parallel reads drop results here.
export async function listArtifacts() {
  const ids = (await fs.readdir(lib()).catch(() => [])).map(name).filter((n) => !n.startsWith("."));
  const all = [];
  for (const id of ids) { const m = await readMeta(id); if (m) all.push(m); }
  return all.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
}

const pointer = (term) => `${current()}/${safe(term)}.json`;
export const currentOf = async (term) => (await readJson(pointer(term), null))?.id ?? null;
export const setCurrent = (term, id) => fs.writeFile(pointer(term), JSON.stringify({ terminal: term, id }, null, 2));

export const setArchived = (a, archived) => writeMeta({ ...a, archived });

// Gone for good: its files, its folder, and any pane pointing at it.
export async function deleteArtifact(a) {
  const dir = dirOf(a.id);
  for (const f of (await fs.readdir(dir).catch(() => [])).map(name)) await fs.unlink(`${dir}/${f}`).catch(() => {});
  await fs.rmdir(dir).catch(() => {});
  for (const f of (await fs.readdir(current()).catch(() => [])).map(name)) {
    if (!f.endsWith(".json") || f.startsWith(".")) continue;
    const p = `${current()}/${f}`;
    if ((await readJson(p, null))?.id === a.id) await fs.unlink(p).catch(() => {});
  }
}

// The artifact pane for `term`: reuse the open one, else split one right of the agent's pane,
// then give the keyboard back to where it was. `cx`: the caller's, for the wait.
export function ensurePane(term, cx, done = () => {}) {
  const open = shared(OPEN) ?? {};
  if (open[term] && panes().some((x) => x.pane === open[term] && x.mod === "viz")) return done(open[term]);
  const agent = panes().find((x) => x.terminal === term);
  if (!agent) {
    notify({ title: "Artifacts", body: `No pane shows ${term} any more`, level: "error", timeout: 3000 });
    return done(null);
  }
  const before = new Set(panes().filter((x) => x.mod === "viz").map((x) => x.pane));
  const back = focused()?.pane ?? null;
  run("pane.split", { direction: "right", pane: agent.pane, mod: "viz", props: { terminal: term } });
  // run() returns nothing: find the new pane once the model has it.
  let tries = 0;
  const task = cx.timer.every(100, () => {
    const made = panes().find((x) => x.mod === "viz" && x.tab === agent.tab && !before.has(x.pane));
    if (!made && ++tries <= 30) return;
    task.cancel();
    if (made) {
      setShared(OPEN, { ...(shared(OPEN) ?? {}), [term]: made.pane });
      if (back && back !== made.pane) run("pane.focus", { pane: back });
    }
    done(made?.pane ?? null);
  });
}

// The library window, aimed at the terminal it was opened from. Again: closes it.
export function toggleLibrary() {
  const open = shared(LIBRARY);
  if (open) {
    closeOverlay(open);
    setShared(LIBRARY, null);
    return;
  }
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  openOverlay({
    kind: "window", mod: "viz", key: "viz-library", width: 1100, height: 680,
    props: { library: true, home: { terminal: f?.terminal ?? null, pane: f?.pane ?? null, cwd: pane?.cwd ?? f?.cwd ?? null } },
  });
}
