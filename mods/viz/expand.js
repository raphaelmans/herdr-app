// An expanded embed: one diagram, chart, image or page preview of an artifact in a window of its
// own, fitted to it, to zoom into and move around. The way T3 Code expands a visual reply's
// diagram. Terms: CONTEXT.md; the numbers: zoom.js.
//
// The window is the viz mod with props {expand: {src, w, h, vector, title, caption, live, back}}.
// Escape steps back: zoomed goes to fitted, fitted closes and gives the keyboard back to `back`.

import { div, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, closeOverlay, exec, focused, openOverlay, run, theme } from "herdr";
import * as fs from "fs/promises";
import { hashOf } from "./render.js";
import { MAX_ZOOM, PAN_PX, STEP, fitted, pan, percent, placed, sharpness, enlarge, toggle, wheel, zoomTo } from "./zoom.js";

const SHARP = "mods/viz/.cache/sharp";
const KEPT = 48;        // enlarged SVGs remembered this run
const DRAG_PX = 3;      // movement before a press becomes a drag
const stop = (_e, cx) => cx.stop_propagation();

// Enlarged SVGs: "src@b" -> path relative to the app home, or a promise while it is written.
const sharp = new Map();

// The SVG at `src` written `b` times larger, once per src and size: its path, or null if it can't be.
async function sharpened(pic, b) {
  const key = `${pic.src}@${b}`;
  if (sharp.has(key)) return sharp.get(key);
  const job = (async () => {
    try {
      const svg = await fs.readFile(`${appHome()}/${pic.src}`, "utf8");
      const rel = `${SHARP}/${hashOf(svg)}-x${b}.svg`;
      if (!(await fs.exists(`${appHome()}/${rel}`))) {
        await fs.mkdir(`${appHome()}/${SHARP}`, { recursive: true }).catch(() => {});
        await fs.writeFile(`${appHome()}/${rel}`, enlarge(svg, b, pic));
      }
      return rel;
    } catch { return null; }
  })();
  sharp.set(key, job);
  const rel = await job;
  sharp.set(key, rel);
  while (sharp.size > KEPT) sharp.delete(sharp.keys().next().value);
  return rel;
}

// Open `p` (a picture part from build()) of the artifact titled `title` expanded.
export function openExpand(p, title) {
  if (p?.kind !== "picture") return;
  openOverlay({
    kind: "window", mod: "viz", key: "viz-expand", width: 0.94, height: 0.92,
    props: { expand: {
      src: p.src, w: p.w, h: p.h, vector: Boolean(p.vector), type: p.type,
      title, caption: p.caption ?? "", live: p.live ?? null, back: focused()?.pane ?? null,
    } },
  });
}

export function initExpand(v, p, cx) {
  v.role = "expand";
  v.overlay = p.overlay;
  v.pic = p.expand;
  v.view = fitted();
  v.vp = { w: 0, h: 0 };       // the stage's size
  v.stage = null;              // the stage's box in the window, for the pointer
  v.drag = null;               // {x, y, vx, vy, moved}
  v.src = v.pic.src;           // what is drawn: the picture, or a sharper copy of it
  v.handle = cx.focus_handle();
  v.handle.focus();
  cx.timer.after(150, () => v.handle.focus());
}

function close(v) {
  closeOverlay(v.overlay);
  if (v.pic.back) run("pane.focus", { pane: v.pic.back });
}

// The view changed: redraw, and fetch a sharper copy when the zoom outgrew the one drawn.
function show(v, next, cx) {
  v.view = next;
  const b = sharpness(v.pic, placed(v.pic, v.vp, next).scale);
  const want = `${v.pic.src}@${b}`;
  v.wanted = want;
  if (b === 1) v.src = v.pic.src;
  else {
    const have = sharp.get(want);
    if (typeof have === "string") v.src = have;
    else cx.spawn(async (cx) => {
      // Only once the zoom has settled: a scroll through x2 and x4 to x8 makes only x8.
      await cx.sleep(180);
      if (v.wanted !== want) return;
      const rel = await sharpened(v.pic, b);
      // A later zoom asked for another size: this one is overtaken.
      if (rel && v.wanted === want) { v.src = rel; cx.notify(); }
    });
  }
  cx.notify();
}

const local = (v, e) => (v.stage ? { x: e.position.x - v.stage.x, y: e.position.y - v.stage.y } : { x: v.vp.w / 2, y: v.vp.h / 2 });

// Keys that do what another does.
const ALIAS = { "=": "+", enter: " ", space: " ", left: "h", right: "l", up: "k", down: "j" };

function keys(v, e, cx) {
  const m = e.modifiers ?? {};
  if (m.platform || m.control || m.alt) return;
  const { pic, vp, view } = v;
  const k = e.key_char ?? e.key;
  const map = {
    "+": () => zoomTo(pic, vp, view, view.zoom * STEP),
    "-": () => zoomTo(pic, vp, view, view.zoom / STEP), "0": () => fitted(),
    " ": () => toggle(pic, vp, view),
    h: () => pan(pic, vp, view, -PAN_PX, 0), l: () => pan(pic, vp, view, PAN_PX, 0),
    k: () => pan(pic, vp, view, 0, -PAN_PX), j: () => pan(pic, vp, view, 0, PAN_PX),
    g: () => ({ ...view, x: 0, y: 0 }),
    G: () => pan(pic, vp, view, Infinity, Infinity),
  };
  if (e.key === "escape" || k === "q") {
    // Escape can arrive twice, as the bound action and as the key: one step per press.
    const now = Date.now();
    if (now - (v.lastEscape ?? 0) < 80) return cx.stop_propagation();
    v.lastEscape = now;
    if (e.key === "escape" && view.zoom > 1) show(v, fitted(), cx);
    else close(v);
    return cx.stop_propagation();
  }
  const f = map[k] ?? map[e.key] ?? map[ALIAS[e.key] ?? ALIAS[k]];
  if (f) { show(v, f(), cx); cx.stop_propagation(); }
}

export function renderExpand(v) {
  const t = theme();
  const { pic, vp, view } = v;
  const p = placed(pic, vp, view);
  const zoomed = view.zoom > 1;
  const btn = (id, text, onClick, off = false) => div().id(id).flex_none().h(22).min_w(24).px(6).rounded(4)
    .flex().items_center().justify_center().text_size(12)
    .text_color(off ? t.dim : t.muted).when(!off, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
    .on_mouse_down("left", stop).on_click((e, cx) => { if (!off) onClick(e, cx); }).child(text);

  const header = h_flex().px(12).h(36).gap(6).items_center().border_b(1).border_color(t.border).bg(t.chrome)
    .child(v_flex().flex_1().min_w(0)
      .child(div().truncate().text_size(12.5).font_semibold().text_color(t.foreground).child(pic.caption || pic.title || "Embed"))
      .when(Boolean(pic.caption && pic.title), (el) => el.child(div().truncate().text_size(10.5).text_color(t.dim).child(`${pic.type ?? "embed"} in ${pic.title}`))))
    .when(Boolean(pic.live), (el) => el.child(btn("x-live", "Open live page ↗", () => exec("open", [pic.live]).catch(() => {}))))
    .child(btn("x-out", "−", (_e, cx) => show(v, zoomTo(pic, vp, view, view.zoom / STEP), cx), !zoomed))
    .child(btn("x-fit", zoomed ? percent(pic, vp, view) : `Fit · ${percent(pic, vp, view)}`, (_e, cx) => show(v, fitted(), cx), !zoomed))
    .child(btn("x-in", "+", (_e, cx) => show(v, zoomTo(pic, vp, view, view.zoom * STEP), cx), view.zoom >= MAX_ZOOM))
    .child(btn("x-close", "✕", () => close(v)));

  const stage = div().id("x-stage").relative().flex_1().min_h(0).overflow_hidden().bg(t.background)
    .on_size_change((size, cx) => {
      if (Math.abs(size.width - vp.w) > 1 || Math.abs(size.height - vp.h) > 1) {
        // A resized window fits the picture again.
        v.vp = { w: size.width, h: size.height };
        show(v, fitted(), cx);
      }
    })
    .when(zoomed, (el) => (v.drag?.moved ? el.cursor_grabbing() : el.cursor_grab()))
    .when(!zoomed, (el) => el.cursor_pointer())
    .on_mouse_down("left", (e, cx) => {
      cx.stop_propagation();
      if (e.bounds) v.stage = e.bounds;
      v.drag = { x: e.position.x, y: e.position.y, vx: view.x, vy: view.y, moved: false };
    })
    .on_mouse_move((e, cx) => {
      if (e.bounds) v.stage = e.bounds;
      const d = v.drag;
      if (!d) return;
      const dx = e.position.x - d.x, dy = e.position.y - d.y;
      if (!d.moved && Math.abs(dx) <= DRAG_PX && Math.abs(dy) <= DRAG_PX) return;
      d.moved = true;
      show(v, pan(pic, vp, { ...v.view, x: d.vx, y: d.vy }, -dx, -dy), cx);
    })
    .on_mouse_up("left", (e, cx) => {
      const d = v.drag;
      v.drag = null;
      if (d && !d.moved) show(v, toggle(pic, vp, v.view, local(v, e)), cx);
      else cx.notify();
    })
    .on_scroll_wheel((e, cx) => {
      if (e.bounds) v.stage = e.bounds;
      show(v, wheel(pic, vp, v.view, { delta: e.delta, modifiers: e.modifiers, at: local(v, e) }), cx);
    })
    .on_pinch((e, cx) => show(v, zoomTo(pic, vp, v.view, v.view.zoom * (1 + e.delta), local(v, e)), cx))
    .when(vp.w > 0, (el) => el.child(image(v.src).absolute().left(p.left).top(p.top).w(p.w).h(p.h)));

  const hint = zoomed
    ? "+ − zoom · 0 fit · drag or h j k l move · g G corners · ⌘ scroll zoom · esc fit"
    : "click or ↵ zoom in · + − zoom · ⌘ scroll or pinch zoom · esc close";
  return v_flex().id("x-root").size_full().bg(t.background).track_focus(v.handle)
    .key_context("VizExpand").on_action("viz-escape", (_e, cx) => keys(v, { key: "escape", keystroke: "escape", modifiers: {} }, cx))
    .on_key_down((e, cx) => keys(v, e, cx))
    .child(header)
    .child(stage)
    .child(div().flex_none().px(12).py(4).border_t(1).border_color(t.border).bg(t.chrome)
      .truncate().text_size(10.5).text_color(t.dim).child(hint));
}
