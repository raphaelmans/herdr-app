// Run: node --test mods/viz/zoom.test.js
// The expanded picture's numbers: fitting, zooming at a point, moving, and sharper SVGs.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_ZOOM, fitScale, placed, zoomTo, pan, toggle, wheel, sharpness, enlarge, fitted,
} from "./zoom.js";

const wide = { w: 2000, h: 400, vector: true };
const shot = { w: 800, h: 600, vector: false };
const vp = { w: 1000, h: 800 };

test("a vector fits the viewport, growing past its size; a raster never grows", () => {
  assert.equal(fitScale(wide, vp), 0.5);
  assert.equal(fitScale({ w: 100, h: 100, vector: true }, vp), 8);
  assert.equal(fitScale(shot, vp), 1);
});

test("fitted, an axis the picture doesn't fill is centered", () => {
  const p = placed(wide, vp, fitted());
  assert.deepEqual([p.w, p.h, p.left, p.top], [1000, 200, 0, 300]);
});

test("zooming keeps the picture point under the pointer in place", () => {
  const at = { x: 250, y: 400 };
  const before = placed(wide, vp, fitted());
  const pointBefore = (at.x - before.left) / before.scale;
  const v = zoomTo(wide, vp, fitted(), 4, at);
  const after = placed(wide, vp, v);
  assert.equal(v.zoom, 4);
  assert.ok(Math.abs((at.x - after.left) / after.scale - pointBefore) < 1e-9);
});

test("zoom stays between fitted and the most", () => {
  assert.equal(zoomTo(wide, vp, fitted(), 99).zoom, MAX_ZOOM);
  assert.equal(zoomTo(wide, vp, { zoom: 2, x: 0, y: 0 }, 0.1).zoom, 1);
});

test("moving stops at the picture's edges", () => {
  const v = zoomTo(wide, vp, fitted(), 8, { x: 0, y: 0 });
  const far = pan(wide, vp, v, 1e9, 1e9);
  const p = placed(wide, vp, far);
  assert.equal(p.left, vp.w - p.w);
  assert.equal(p.top, vp.h - p.h);
  assert.deepEqual(pan(wide, vp, far, -1e9, -1e9), { zoom: 8, x: 0, y: 0 });
});

test("a click zooms in, and a second goes back to fitted", () => {
  const v = toggle(wide, vp, fitted(), { x: 500, y: 400 });
  assert.equal(v.zoom, 2);
  assert.deepEqual(toggle(wide, vp, v), fitted());
});

test("the wheel moves; with Cmd or Ctrl it zooms", () => {
  const z = { zoom: 2, x: 0, y: 0 };
  assert.equal(wheel(wide, vp, z, { delta: { x: -50, y: 0 }, modifiers: {} }).x, 50);
  assert.ok(wheel(wide, vp, z, { delta: { x: 0, y: -50 }, modifiers: { control: true }, at: { x: 0, y: 0 } }).zoom > 2);
});

test("a sharper SVG is a power of two, bounded, and only for vectors", () => {
  assert.equal(sharpness(wide, 0.5), 1);
  assert.equal(sharpness({ w: 500, h: 300, vector: true }, 3), 4);
  assert.equal(sharpness(wide, 8), 2); // 2000 * 4 would pass the bound
  assert.equal(sharpness({ w: 3000, h: 400, vector: true }, 8), 1);
  assert.equal(sharpness(shot, 8), 1);
});

test("enlarging changes only the outer size, and adds a viewBox when there is none", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 5" width="10" height="5"><rect width="10" height="5"/></svg>';
  assert.equal(enlarge(svg, 4, { w: 10, h: 5 }),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 5" width="40" height="20"><rect width="10" height="5"/></svg>');
  const bare = enlarge('<svg width="10" height="5"></svg>', 2, { w: 10, h: 5 });
  assert.match(bare, /viewBox="0 0 10 5"/);
  assert.match(bare, /width="20" height="10"/);
});
