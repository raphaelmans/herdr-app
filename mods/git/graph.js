// The commit graph, as VS Code's Git Graph draws it: one row per commit,
// each branch in its own colored lane, rounded turns where lanes fork and
// merge. layout() gives every row its lanes; graphCell() draws one row's
// piece natively (paths), so rows can live in a virtual list.

import { div } from "gpui-kit";
import { PathBuilder } from "gpui-kit";

export const ROW = 26, LANE = 16, PAD = 14;
export const UNCOMMITTED = "*";
// With --decorate=full, so a branch, a remote branch and a tag can be told apart.
// %ct last: the commit time.
export const GRAPH_FORMAT = "%H%x1f%P%x1f%D%x1f%s%x1f%an%x1f%cd%x1f%ct";
// Every lane emitted by layout() must fit, including wide merge histories.
export const graphWidth = (lanes) => Math.max(56, PAD * 2 + (lanes - 1) * LANE);

// A commit's labels. A remote branch on the same commit as its local one
// joins that label ("main | origin"), as in Git Graph.
export function refsOf(text,remoteNames=null) {
  const heads = [], remotes = [], tags = [];
  let current = null, detached = false;
  for (let r of text.split(", ").filter(Boolean)) {
    if (r === "HEAD") { detached = true; continue; }
    if (r.startsWith("HEAD -> ")) { r = r.slice(8); current = r; }
    if (r.startsWith("tag: ")) tags.push(r.slice(5).replace(/^refs\/tags\//, ""));
    else if (r.startsWith("refs/heads/")) heads.push({ kind: "head", name: r.slice(11), current: r === current, remotes: [] });
    else if (r.startsWith("refs/remotes/") && !r.endsWith("/HEAD")) remotes.push(r.slice(13));
  }
  const out = [...heads];
  for (const r of remotes) {
    const remote=remoteNames?.filter(name=>r.startsWith(`${name}/`)).sort((a,b)=>b.length-a.length)[0]??(remoteNames?null:r.slice(0,r.indexOf("/")));
    const local=remote&&heads.find(h=>h.name===r.slice(remote.length+1));
    if (local) local.remotes.push(remote); else out.push({ kind: "remote", name: r, remotes: [] });
  }
  if (detached) out.unshift({ kind: "head", name: "HEAD", current: true, remotes: [] });
  return [...out, ...tags.map((name) => ({ kind: "tag", name, remotes: [] }))];
}

export function parseLog(text) {
  return text.split("\n").filter(Boolean).map((line) => {
    const [hash, parents, refs, subject, who, when, time] = line.split("\x1f");
    return { hash, parents: parents ? parents.split(" ") : [], refs: refsOf(refs ?? ""), rawRefs:refs??"", subject: subject ?? "", who: who ?? "", when: when ?? "", time: Number(time) || 0 };
  });
}

// Commits come children first. A lane waits for one commit (its hash); a
// commit sits in the first lane waiting for it, and the other lanes waiting
// for it end there. Its first parent keeps the lane; another parent joins the
// lane already waiting for it, or gets a new one. A lane
// keeps its column until it ends; a free column is used again.
// Colors are numbers (the caller's palette); -1 is the uncommitted row's grey.
export function layout(commits) {
  const lanes = [], rows = [];
  let next = 0, widest = 1;
  const free = () => { const i = lanes.indexOf(null); return i < 0 ? lanes.length : i; };
  for (const commit of commits) {
    const wip = commit.hash === UNCOMMITTED;
    const waiting = lanes.flatMap((l, i) => (l?.hash === commit.hash ? [i] : []));
    const col = waiting.length ? waiting[0] : free();
    const color = wip ? -1 : waiting.length ? lanes[col].color : next++;
    const ins = waiting.map((i) => ({ from: i, color: lanes[i].ink }));
    for (const i of waiting) lanes[i] = null;
    const through = lanes.flatMap((l, i) => (l ? [{ col: i, color: l.ink }] : []));
    const outs = [];
    commit.parents.forEach((parent, k) => {
      // The first parent always keeps this lane, so a branch runs straight down.
      const joined = k === 0 ? -1 : lanes.findIndex((l) => l?.hash === parent);
      if (joined >= 0) return outs.push({ to: joined, color: lanes[joined].ink });
      const at = k === 0 ? col : free();
      // Under the uncommitted row the line is grey; the commit below takes a color of its own.
      lanes[at] = wip ? { hash: parent, color: next++, ink: -1 } : k === 0 ? { hash: parent, color, ink: color } : { hash: parent, color: next, ink: next++ };
      outs.push({ to: at, color: lanes[at].ink });
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    widest = Math.max(widest, col + 1, lanes.length, ...waiting.map((i) => i + 1));
    rows.push({ commit, col, color, ins, through, outs });
  }
  return { rows, lanes: widest };
}

// One row's piece of the graph. ink(n) is the color of lane color n; `bg` is
// the row's background (the middle of a hollow dot); `head` is the checked
// out commit; it, a stash and the uncommitted row are drawn hollow.
export function graphCell(row, width, ink, bg, head) {
  const x = (i) => PAD + i * LANE, mid = ROW / 2, xc = x(row.col);
  const stroke = (color, draw) => window.paint_path(draw(PathBuilder.stroke(2)).build(), ink(color)).absolute().top(0).left(0).size_full();
  const turn = (xl) => Math.min(8, Math.abs(xc - xl));
  const parts = [];
  for (const t of row.through) parts.push(stroke(t.color, (p) => p.move_to(x(t.col), 0).line_to(x(t.col), ROW)));
  for (const l of row.ins) {
    const xl = x(l.from), s = Math.sign(xc - xl), r = turn(xl);
    parts.push(stroke(l.color, (p) => s === 0 ? p.move_to(xl, 0).line_to(xl, mid)
      : p.move_to(xl, 0).line_to(xl, mid - r).curve_to(xl + s * r, mid, xl, mid).line_to(xc, mid)));
  }
  for (const l of row.outs) {
    const xl = x(l.to), s = Math.sign(xl - xc), r = turn(xl);
    parts.push(stroke(l.color, (p) => s === 0 ? p.move_to(xl, mid).line_to(xl, ROW)
      : p.move_to(xc, mid).line_to(xl - s * r, mid).curve_to(xl, mid + r, xl, mid).line_to(xl, ROW)));
  }
  const hollow = head || row.color < 0 || Boolean(row.commit.stash);
  parts.push(div().absolute().left(xc - 5).top(mid - 5).w(10).h(10).rounded(5)
    .bg(hollow ? bg : ink(row.color)).when(hollow, (e) => e.border(2).border_color(ink(row.color))));
  return div().relative().flex_none().w(width).h(ROW).overflow_hidden().children(parts);
}

// The edges leaving the primary row continue through its inline details gap.
export function graphGapLanes(row) {
  return [...new Map([...row.through.map(edge=>[edge.col,edge.color]),...row.outs.map(edge=>[edge.to,edge.color])]).entries()];
}
export function graphGap(row,width,height,ink) {
  return div().relative().flex_none().w(width).h(height).overflow_hidden().children(graphGapLanes(row).map(([col,color])=>
    window.paint_path(PathBuilder.stroke(2).move_to(PAD+col*LANE,0).line_to(PAD+col*LANE,height).build(),ink(color)).absolute().inset_0()));
}
