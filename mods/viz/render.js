// Drawing an artifact: build() turns its document into parts once; part() draws one.
// Prose goes to markdown; embeds (lines of their own) draw natively. Terms: CONTEXT.md.

import { div, image } from "gpui-kit";
import { h_flex, v_flex, TextView } from "gpui-base";
import { appHome, exec, theme } from "herdr";
import * as fs from "fs/promises";
import { palette, renderMermaid } from "./mermaid.js";
import { dirOf, readDoc, relOf } from "./store.js";

const CACHE = "mods/viz/.cache";
const EMBED_LINE = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;

// Diagrams already drawn this run: cache name -> {name, w, h} | {error}.
const drawn = new Map();

// FNV-1a: the cache name of a diagram.
function hashOf(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0") + s.length.toString(16);
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w-]*)/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+/;
const HEADING = /^\s{0,3}#{1,6}\s/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const TABLE = /^\s*\|/;
const QUOTE = /^\s*>/;
const isEmbed = (line) => { const m = EMBED_LINE.exec(line); return m && !/^[a-z]+:\/\//i.test(m[2]) ? m : null; };

// The document as blocks, each with its lines in the document (1-based, inclusive) and its source:
// {kind: "prose", type, text} | {kind: "diagram", source, text} | {kind: "embed", file, caption, text}.
// A prose block is one heading, paragraph, top-level list item, table, quote, code block or rule.
export function parse(doc) {
  const lines = doc.split("\n");
  const out = [];
  const blank = (i) => i >= lines.length || !lines[i].trim();
  const push = (kind, a, b, extra) => out.push({ kind, from: a + 1, to: b + 1, text: lines.slice(a, b + 1).join("\n"), ...extra });
  const starts = (i) => FENCE.test(lines[i]) || HEADING.test(lines[i]) || TABLE.test(lines[i]) || isEmbed(lines[i]);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (blank(i)) { i++; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      let j = i + 1;
      while (j < lines.length && !lines[j].trim().startsWith(fence[1])) j++;
      const end = Math.min(j, lines.length - 1);
      if (fence[2].toLowerCase() === "mermaid") push("diagram", i, end, { source: lines.slice(i + 1, j).join("\n") });
      else push("prose", i, end, { type: "code" });
      i = end + 1;
      continue;
    }
    const m = isEmbed(line);
    if (m) { push("embed", i, i, { file: m[2], caption: m[1] }); i++; continue; }
    if (HEADING.test(line)) { push("prose", i, i, { type: "heading" }); i++; continue; }
    if (RULE.test(line)) { push("prose", i, i, { type: "rule" }); i++; continue; }
    let j = i + 1;
    if (TABLE.test(line)) {
      while (!blank(j) && TABLE.test(lines[j])) j++;
      push("prose", i, j - 1, { type: "table" });
    } else if (QUOTE.test(line)) {
      while (!blank(j) && QUOTE.test(lines[j])) j++;
      push("prose", i, j - 1, { type: "quote" });
    } else if (LIST.test(line)) {
      // One top-level item, with what is nested under it.
      const base = LIST.exec(line)[1].length;
      let end = i;
      for (; j < lines.length; j++) {
        if (blank(j)) continue;
        const indent = /^\s*/.exec(lines[j])[0].length;
        const item = LIST.exec(lines[j]);
        if (item ? item[1].length <= base : indent <= base && (blank(j - 1) || starts(j))) break;
        end = j;
      }
      push("prose", i, end, { type: "item" });
      j = end + 1;
    } else {
      while (!blank(j) && !starts(j) && !(LIST.test(lines[j]) && LIST.exec(lines[j])[1].length < 2)) j++;
      push("prose", i, j - 1, { type: "text" });
    }
    i = j;
  }
  return out;
}

// A diagram drawn once per source and theme colors: this run's memory first, then the cache
// folder (the SVG, and its size beside it), and only then the renderer, which is the slow part.
async function diagram(source) {
  const key = hashOf(`${JSON.stringify(palette(theme()))}\n${source}`);
  if (drawn.has(key)) return drawn.get(key);
  const svgPath = `${appHome()}/${CACHE}/${key}.svg`, sizePath = `${appHome()}/${CACHE}/${key}.json`;
  let d = null;
  try {
    const size = JSON.parse(await fs.readFile(sizePath, "utf8"));
    if (size.w > 0 && size.h > 0 && (await fs.exists(svgPath))) d = { name: `${key}.svg`, w: size.w, h: size.h };
  } catch {}
  if (!d) {
    const r = renderMermaid(source, theme());
    if (r.error) d = { error: r.error };
    else {
      await fs.writeFile(svgPath, r.svg);
      await fs.writeFile(sizePath, JSON.stringify({ w: r.width, h: r.height }));
      d = { name: `${key}.svg`, w: r.width, h: r.height };
    }
  }
  drawn.set(key, d);
  return d;
}

// Blocks ready to draw: {kind: "prose", type, text} | {kind: "picture", src, w, h, caption, live?} | {kind: "error", note}.
// Each keeps its lines (from, to) and its source (text).
export async function build(a) {
  const parts = [];
  await fs.mkdir(`${appHome()}/${CACHE}`, { recursive: true }).catch(() => {});
  for (const seg of parse(await readDoc(a))) {
    const at = { from: seg.from, to: seg.to, text: seg.text };
    if (seg.kind === "prose") { parts.push(seg); continue; }
    if (seg.kind === "diagram") {
      const d = await diagram(seg.source);
      if (d.error) { parts.push({ ...at, kind: "error", note: `Diagram: ${d.error}` }); continue; }
      parts.push({ ...at, kind: "picture", type: "diagram", src: `${CACHE}/${d.name}`, w: d.w, h: d.h, caption: "" });
      continue;
    }
    const e = a.embeds?.[seg.file];
    if (!e) { parts.push({ ...at, kind: "error", note: `Missing embed ${seg.file}` }); continue; }
    if (e.kind === "page") {
      const live = `${dirOf(a.id)}/${seg.file}`;
      if (!e.preview) { parts.push({ ...at, kind: "error", note: `No preview of ${seg.file}`, live }); continue; }
      parts.push({ ...at, kind: "picture", type: "page preview", src: `${relOf(a.id)}/${e.preview}`, w: e.w, h: e.h, caption: seg.caption, live });
      continue;
    }
    parts.push({ ...at, kind: "picture", type: e.kind, src: `${relOf(a.id)}/${seg.file}`, w: e.w || 800, h: e.h || 600, caption: seg.caption });
  }
  return parts;
}

// The space under a block: list items sit close together.
export const pad = (p) => (p.type === "item" ? 1 : 8);

export function part(p, key, avail, t, selectable = true) {
  if (p.kind === "prose") return TextView.markdown(key, p.text).selectable(selectable);
  const openLive = (live) => div().id(`${key}-live`).px(6).py(1).rounded(4).text_size(11).text_color(t.accent)
    .hover((s) => s.bg(t.hover)).on_click(() => exec("open", [live]).catch(() => {})).child("Open live page ↗");
  if (p.kind === "picture") {
    const w = Math.max(40, Math.min(p.w, avail));
    const caption = p.caption || p.live
      ? h_flex().gap(8).justify_center().items_center()
          .when(Boolean(p.caption), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(p.caption)))
          .when(Boolean(p.live), (el) => el.child(openLive(p.live)))
      : null;
    return v_flex().w_full().items_center().gap(4).py(6)
      .child(div().rounded(6).overflow_hidden().border_1().border_color(t.border).child(image(p.src).w(w).h((w * p.h) / p.w)))
      .when(Boolean(caption), (el) => el.child(caption));
  }
  return h_flex().p(8).gap(8).rounded(4).border(1).border_color(t.blocked).text_size(12).text_color(t.muted)
    .child(p.note).when(Boolean(p.live), (el) => el.child(openLive(p.live)));
}

// The source of blocks from..to, as an annotation remembers it.
// Blocks on neighbouring lines (a tight list) stay on neighbouring lines.
export const sourceOf = (parts, from, to) => parts.slice(from, to + 1)
  .map((p, n, run) => p.text + (n === run.length - 1 ? "" : run[n + 1].from === p.to + 1 ? "\n" : "\n\n")).join("");

// Annotations made on an earlier publish, moved to the same blocks in this one. Those whose blocks
// changed are dropped: the comment was about text that is gone.
export function reanchor(notes, parts) {
  const out = [];
  for (const n of notes) {
    const len = n.to - n.from + 1;
    let best = -1;
    for (let s = 0; s + len <= parts.length; s++) {
      if (sourceOf(parts, s, s + len - 1) !== n.text) continue;
      if (best < 0 || Math.abs(s - n.from) < Math.abs(best - n.from)) best = s;
    }
    if (best >= 0) out.push({ ...n, from: best, to: best + len - 1 });
  }
  return out;
}

// What a run of blocks is called: "paragraph", "table", "3 blocks".
export function nameOf(parts, from, to) {
  if (from !== to) return `${to - from + 1} blocks`;
  const p = parts[from];
  if (!p) return "block";
  if (p.kind !== "prose") return p.type || "embed";
  return { text: "paragraph", item: "list item", code: "code block" }[p.type] ?? p.type;
}

export function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (!(s >= 0)) return "";
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toLocaleDateString();
}

export const tail = (p) => (p ? p.replace(/\/+$/, "").split("/").pop() || p : "");
export const tildify = (p, home) => (p && home && p.startsWith(home) ? "~" + p.slice(home.length) : p ?? "");
