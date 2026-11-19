// The numbers behind an expanded picture: how big it is drawn and which part of it is in view.
// No Herdr or GPUI here, so it can be tested with plain node. Terms: CONTEXT.md.
//
// A view is {zoom, x, y}: zoom 1 is the picture fitted to the viewport; x, y are how far into
// the drawn picture the viewport's top left is (px). Each axis the picture doesn't fill is centered.

export const MAX_ZOOM = 8;
export const STEP = 1.5;        // + and -
export const CLICK_ZOOM = 2;    // a click or Enter, from fitted
export const PAN_PX = 80;       // h j k l and arrows
export const MIN_INLINE = 0.6;  // a diagram or chart in the document is never drawn smaller than this

// The scale that fits the picture in the viewport. A vector may grow past its own size; a raster
// (a screenshot) never does, since it would only blur.
export function fitScale(pic, vp) {
  if (!(pic.w > 0 && pic.h > 0 && vp.w > 0 && vp.h > 0)) return 1;
  return Math.min(pic.vector ? Infinity : 1, vp.w / pic.w, vp.h / pic.h);
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// Where the picture is drawn: {scale, w, h, left, top} with left/top inside the viewport.
export function placed(pic, vp, v) {
  const scale = fitScale(pic, vp) * v.zoom;
  const w = pic.w * scale, h = pic.h * scale;
  const left = w <= vp.w ? (vp.w - w) / 2 : -clamp(v.x, 0, w - vp.w);
  const top = h <= vp.h ? (vp.h - h) / 2 : -clamp(v.y, 0, h - vp.h);
  return { scale, w, h, left, top };
}

// The view with x, y kept inside the picture.
function settle(pic, vp, v) {
  const p = placed(pic, vp, v);
  return { zoom: v.zoom, x: -Math.min(0, p.left), y: -Math.min(0, p.top) };
}

export const fitted = () => ({ zoom: 1, x: 0, y: 0 });

// Zoom to `zoom`, keeping the point of the picture under `at` (viewport px; default: its middle) there.
export function zoomTo(pic, vp, v, zoom, at = { x: vp.w / 2, y: vp.h / 2 }) {
  const next = clamp(zoom, 1, MAX_ZOOM);
  if (next === v.zoom) return v;
  const p = placed(pic, vp, v);
  const q = placed(pic, vp, { zoom: next, x: 0, y: 0 });
  const k = q.scale / p.scale;
  // The picture point under `at` is (at - left) / scale; after the zoom it should still be under `at`.
  const x = (at.x - p.left) * k - at.x, y = (at.y - p.top) * k - at.y;
  return settle(pic, vp, { zoom: next, x, y });
}

export const pan = (pic, vp, v, dx, dy) => settle(pic, vp, { ...v, x: v.x + dx, y: v.y + dy });

// A click, or Enter: fitted goes to CLICK_ZOOM at the point; zoomed goes back to fitted.
export const toggle = (pic, vp, v, at) => (v.zoom > 1 ? fitted() : zoomTo(pic, vp, v, CLICK_ZOOM, at));

// The wheel: with Cmd or Ctrl held (a trackpad pinch arrives as Ctrl+wheel) it zooms at the
// pointer; otherwise it moves.
export function wheel(pic, vp, v, e) {
  const m = e.modifiers ?? {};
  if (m.platform || m.control) return zoomTo(pic, vp, v, v.zoom * Math.exp(-e.delta.y * 0.01), e.at);
  return pan(pic, vp, v, -e.delta.x, -e.delta.y);
}

// How large an SVG is written for this scale: the next power of two, so a few files cover every
// zoom, and never so large that its drawing gets heavy.
export function sharpness(pic, scale, maxSide = 4096) {
  if (!pic.vector) return 1;
  let b = 1;
  while (b < scale && Math.max(pic.w, pic.h) * b * 2 <= maxSide) b *= 2;
  return b;
}

// The SVG source drawn `b` times larger: only the outer element's width and height change.
export function enlarge(svg, b, pic) {
  if (b === 1) return svg;
  const open = /<svg\b[^>]*>/i.exec(svg);
  if (!open) return svg;
  let tag = open[0];
  const set = (name, value) => {
    const re = new RegExp(`(\\s${name}\\s*=\\s*)(["'])[^"']*\\2`, "i");
    tag = re.test(tag) ? tag.replace(re, `$1"${value}"`) : tag.replace(/^<svg\b/i, `<svg ${name}="${value}"`);
  };
  // Without a viewBox, a larger width would show more canvas, not a larger drawing.
  if (!/\sviewBox\s*=/i.test(tag)) tag = tag.replace(/^<svg\b/i, `<svg viewBox="0 0 ${pic.w} ${pic.h}"`);
  set("width", Math.round(pic.w * b));
  set("height", Math.round(pic.h * b));
  return svg.slice(0, open.index) + tag + svg.slice(open.index + open[0].length);
}

export const percent = (pic, vp, v) => `${Math.round(placed(pic, vp, v).scale * 100)}%`;
