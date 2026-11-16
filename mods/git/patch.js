// Pure patch operations. Keep the original bytes for applying; display text is
// allowed to expand tabs and clip long lines, but must never become the patch.
export function parsePatch(raw) {
  const lines = raw.replace(/\n$/, "").split("\n"), hunks = [];
  let hunk = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(lines[i]);
    if (m) {
      hunk = { index: hunks.length, row: i, old: +m[1], next: +m[3], suffix: m[5], lines: [] };
      hunks.push(hunk);
    } else if (hunk && /^[ +\\-]/.test(lines[i])) hunk.lines.push({ row: i, text: lines[i] });
    else hunk = null;
  }
  return { raw, lines, hunks, binary: /(^|\n)(Binary files |GIT binary patch)/.test(raw),
    changes: hunks.flatMap((h) => h.lines.filter((l) => /^[+-]/.test(l.text)).map((l) => l.row)) };
}

export function hunkAt(patch, row) {
  return patch?.hunks.find((h) => row >= h.row && row <= (h.lines.at(-1)?.row ?? h.row)) ?? null;
}

export function selectionRows(patch, cursor, lineMode, anchor = null) {
  if (!patch) return [];
  if (!lineMode) return hunkAt(patch, cursor)?.lines.filter((l) => /^[+-]/.test(l.text)).map((l) => l.row) ?? [];
  const from = Math.min(cursor, anchor ?? cursor), to = Math.max(cursor, anchor ?? cursor);
  return patch.changes.filter((n) => n >= from && n <= to);
}

// Turn the unselected changes into context (or remove them) against the side
// being changed. Reverse patches operate against the index/worktree's NEW side.
export function selectedPatch(patch, path, rows, reverse = false) {
  if (patch.binary) throw new Error("Binary changes must be staged as a whole file");
  const selected = new Set(rows);
  if (!patch.changes.some((n) => selected.has(n))) throw new Error("Select a changed hunk or line");
  const all = patch.changes.every((n) => selected.has(n));
  if (all) return patch.raw;
  const added = /^new file mode (\d+)$/m.exec(patch.raw), deleted = /^deleted file mode (\d+)$/m.exec(patch.raw);
  const create = added && !reverse, remove = deleted && reverse;
  const a = JSON.stringify(`a/${path}`), b = JSON.stringify(`b/${path}`);
  const out = [`diff --git ${a} ${b}`];
  if (create) out.push(`new file mode ${added[1]}`);
  if (remove) out.push(`deleted file mode ${deleted[1]}`);
  out.push(`--- ${create ? "/dev/null" : a}`, `+++ ${remove ? "/dev/null" : b}`);
  let delta = 0;
  for (const h of patch.hunks) {
    if (!h.lines.some((l) => selected.has(l.row))) continue;
    const body = [];
    let keptPrevious = false;
    for (const line of h.lines) {
      const kind = line.text[0];
      if (kind === "\\") { if (keptPrevious) body.push(line.text); continue; }
      keptPrevious = true;
      if (kind === " " || selected.has(line.row)) body.push(line.text);
      else if (kind === (reverse ? "+" : "-")) body.push(" " + line.text.slice(1));
      else keptPrevious = false;
    }
    const oldCount = body.filter((l) => /^[ -]/.test(l)).length;
    const newCount = body.filter((l) => /^[ +]/.test(l)).length;
    let oldStart, newStart;
    if (reverse) {
      newStart = h.next;
      oldStart = newStart + delta;
      if (!newCount) oldStart++;
      if (!oldCount) oldStart--;
      delta += oldCount - newCount;
    } else {
      oldStart = h.old;
      newStart = oldStart + delta;
      if (!oldCount) newStart++;
      if (!newCount) newStart--;
      delta += newCount - oldCount;
    }
    out.push(`@@ -${Math.max(0, oldStart)},${oldCount} +${Math.max(0, newStart)},${newCount} @@${h.suffix}`, ...body);
  }
  return out.join("\n") + "\n";
}

export function parseConflicts(text) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [], conflicts = [];
  let start = -1, base = -1, middle = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^<{7,} /.test(lines[i])) { start = i; base = -1; middle = -1; }
    else if (start >= 0 && /^\|{7,} /.test(lines[i])) base = i;
    else if (start >= 0 && /^={7,}\r?\n?$/.test(lines[i])) middle = i;
    else if (start >= 0 && middle >= 0 && /^>{7,} /.test(lines[i])) {
      conflicts.push({ start, end: i, ours: lines.slice(start + 1, base >= 0 ? base : middle).join(""), theirs: lines.slice(middle + 1, i).join("") });
      start = -1;
    }
  }
  return { text, lines, conflicts };
}

export function resolveConflict(parsed, index, side) {
  const c = parsed.conflicts[index];
  if (!c || !["ours", "theirs", "both"].includes(side)) throw new Error("Select a conflict and a resolution");
  return parsed.lines.slice(0, c.start).join("") + (side === "ours" ? c.ours : side === "theirs" ? c.theirs : c.ours + c.theirs) + parsed.lines.slice(c.end + 1).join("");
}

export const shellQuote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

export function rebaseTodo(plan) {
  const valid = new Set(["pick", "reword", "edit", "squash", "fixup", "drop"]);
  let hasParent = false;
  return plan.map((cm) => {
    if (!/^[a-f0-9]{40,64}$/.test(cm.hash) || !valid.has(cm.action)) throw new Error("Invalid rebase entry");
    if (["fixup", "squash"].includes(cm.action) && !hasParent) throw new Error("The first kept commit cannot be squashed or fixed up");
    if (cm.action !== "drop") hasParent = true;
    const label = cm.subject.replace(/[\r\n]/g, " ");
    if (cm.action === "reword") {
      if (!cm.message?.trim()) throw new Error("Give the reworded commit a message");
      if (/[\r\n]/.test(cm.message)) throw new Error("A reworded commit summary must be one line");
      return `pick ${cm.hash} ${label}\nexec git commit --amend -m ${shellQuote(cm.message)}`;
    }
    return `${cm.action} ${cm.hash} ${label}`;
  }).join("\n") + "\n";
}
