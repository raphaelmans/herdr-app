// Pending interactive-rebase instructions, separate from plans that start a
// rebase. A remaining first fixup/squash can target the already replayed HEAD.
// Keep every source line: labels, resets and comments are not commit rows.
const VERBS = Object.assign(Object.create(null), {
  p: "pick", pick: "pick", e: "edit", edit: "edit", r: "reword", reword: "reword",
  f: "fixup", fixup: "fixup", s: "squash", squash: "squash", d: "drop", drop: "drop",
  x: "exec", exec: "exec", b: "break", break: "break", l: "label", label: "label",
  t: "reset", reset: "reset", m: "merge", merge: "merge", u: "update-ref", "update-ref": "update-ref",
  noop: "noop", revert: "revert",
});
const STANDARD = new Set(["pick", "edit", "reword", "fixup", "squash", "drop"]);
const BARRIERS = new Set(["label", "reset", "merge", "break"]);
export const REBASE_EDIT_ACTIONS = Object.freeze(["pick", "edit", "fixup", "squash", "drop"]);

// lines include their original LF/CRLF terminators; entries are in execution
// order, rows in Lazygit's display order. line is a zero-based source identity.
export function parseRebaseTodo(raw, { commentChar = "#" } = {}) {
  if (typeof raw !== "string") throw new Error("Rebase todo must be text");
  if (typeof commentChar !== "string" || commentChar.length !== 1 || /[\r\n\0]/.test(commentChar)) {
    throw new Error("The rebase comment character must be one character");
  }
  const lines = raw.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const errors = [];
  const entries = lines.map((source, line) => {
    const eol = source.endsWith("\r\n") ? "\r\n" : source.endsWith("\n") ? "\n" : "";
    const text = eol ? source.slice(0, -eol.length) : source;
    const entry = { line, raw: source, text, eol, verb: "", action: "", hash: "", flag: "", flags: [],
      subject: "", ref: "", label: "", labels: [], command: "", visible: false, editable: false, movable: false };
    const invalid = (message) => { entry.error = `Line ${line + 1}: ${message}`; errors.push(entry.error); };
    if (text.includes("\0")) { invalid("A rebase instruction cannot contain NUL"); return entry; }
    const trimmed = text.trimStart();
    if (!trimmed) { entry.verb = "blank"; return entry; }
    if (trimmed.startsWith(commentChar)) { entry.verb = "comment"; return entry; }
    const words = [...text.matchAll(/\S+/g)];
    entry.verb = VERBS[words[0][0]] ?? "unknown";
    entry.action = entry.verb;
    entry.indent = text.slice(0, words[0].index);
    entry.gap = words[1] ? text.slice(words[0].index + words[0][0].length, words[1].index) : " ";
    if (entry.verb === "unknown") { invalid(`Unsupported rebase instruction ${words[0][0]}`); return entry; }
    const arg = (i) => words[i]?.[0] ?? "";
    const tail = (i) => words[i] ? text.slice(words[i].index).trimEnd() : "";
    const commit = (i) => {
      if (!arg(i) || arg(i).startsWith("-") || arg(i) === commentChar) { invalid(`${entry.verb} needs a commit`); return false; }
      entry.hash = arg(i); entry.commitOffset = words[i].index;
      entry.subject = tail(i + 1);
      if (entry.subject.startsWith(`${commentChar} `)) entry.subject = entry.subject.slice(2);
      return true;
    };
    if (entry.verb === "exec") {
      entry.command = tail(1); entry.subject = entry.command;
      if (!entry.command) invalid("exec needs a command");
    } else if (entry.verb === "update-ref") {
      entry.ref = arg(1); entry.subject = entry.ref;
      if (!entry.ref) invalid("update-ref needs a ref");
    } else if (entry.verb === "label" || entry.verb === "reset") {
      entry.label = entry.verb === "reset" && tail(1) === "[new root]" ? "[new root]" : arg(1);
      if (!entry.label) invalid(`${entry.verb} needs a label`);
    } else if (entry.verb === "merge") {
      let at = 1;
      if (arg(at) === "-C" || arg(at) === "-c") {
        entry.flag = arg(at++);
        if (!commit(at++)) return entry;
      }
      while (arg(at) && arg(at) !== "#") entry.labels.push(arg(at++));
      entry.label = entry.labels[0] ?? "";
      entry.subject = arg(at) === "#" ? tail(at + 1) : "";
      if (!entry.label || entry.label.startsWith("-")) invalid("merge needs a label");
    } else if (entry.verb !== "break" && entry.verb !== "noop") {
      let at = 1;
      if (entry.verb === "fixup" && (arg(at) === "-C" || arg(at) === "-c")) entry.flag = arg(at++);
      commit(at);
    }
    entry.flags = entry.flag ? [entry.flag] : [];
    entry.visible = !!entry.hash || entry.verb === "exec" || entry.verb === "update-ref";
    entry.editable = !entry.error && !!entry.hash && STANDARD.has(entry.verb);
    entry.movable = entry.editable || (!entry.error && entry.verb === "update-ref");
    return entry;
  });
  return { raw, commentChar, lines, entries, rows: entries.filter((entry) => entry.visible).reverse(), errors, valid: !errors.length };
}

function document(value) {
  // Reparse even a supplied document so callers can't mutate its parsed fields
  // into instructions that differ from the source they are about to replace.
  const doc = typeof value === "string" ? parseRebaseTodo(value) : parseRebaseTodo(value?.raw, { commentChar: value?.commentChar });
  if (!doc.valid) throw new Error(doc.errors.join("\n"));
  doc.requiresEditTodo = !!value?.requiresEditTodo;
  return doc;
}

function selection(doc, selected) {
  const values = Array.isArray(selected) ? selected : [selected];
  const ids = new Set();
  for (const value of values) {
    const line = typeof value === "number" ? value : value?.line;
    const entry = Number.isInteger(line) ? doc.entries[line] : null;
    if (!entry?.visible) throw new Error("Select a pending rebase row");
    if (typeof value === "object" && value.raw !== undefined && entry.raw !== value.raw) {
      throw new Error("The rebase todo changed; refresh it before editing");
    }
    ids.add(line);
  }
  if (!ids.size) throw new Error("Select a pending rebase row");
  return ids;
}

function changeAction(entry, action, flag) {
  if (!entry.editable) throw new Error(`Changing ${entry.verb} instructions is not supported`);
  if (entry.verb === action && entry.flag === flag) return entry;
  const text = entry.indent + action + entry.gap + (flag ? `${flag} ` : "") + entry.text.slice(entry.commitOffset);
  return { ...entry, text, raw: text + entry.eol };
}

function result(doc, entries, ids, requiresEditTodo = false) {
  const newline = doc.entries.find((entry) => entry.eol)?.eol ?? "\n";
  const terminated = doc.raw.endsWith("\n");
  const raw = entries.map((entry, index) => {
    // A last line without a terminator may have moved into the middle. Keep
    // the document's final-newline convention, without joining instructions.
    const eol = index === entries.length - 1 && !terminated ? "" : entry.eol || newline;
    return entry.text + eol;
  }).join("");
  const parsed = parseRebaseTodo(raw, { commentChar: doc.commentChar });
  if (!parsed.valid) throw new Error(parsed.errors.join("\n"));
  parsed.requiresEditTodo = doc.requiresEditTodo || requiresEditTodo;
  const selectedLines = new Set(entries.flatMap((entry, line) => ids.has(entry.line) ? [line] : []));
  parsed.selection = parsed.rows.filter((entry) => selectedLines.has(entry.line));
  return parsed;
}

// Pending reword needs an interactive Git editor, which Lazygit also disables.
// A pre-existing reword/-c can be displayed or moved without changing its bytes.
export function editRebaseTodo(value, selected, action, flag = "") {
  const doc = document(value), ids = selection(doc, selected);
  if (action === "reword" || action === "r") throw new Error("Rewording a pending rebase commit requires an external editor");
  action = VERBS[action] ?? action;
  if (!REBASE_EDIT_ACTIONS.includes(action)) throw new Error(`Unsupported rebase action ${action}`);
  if (flag !== "" && (action !== "fixup" || flag !== "-C")) {
    throw new Error("Only fixup with no flag or -C is supported");
  }
  const entries = doc.entries.map((entry) => ids.has(entry.line) ? changeAction(entry, action, flag) : entry);
  return result(doc, entries, ids);
}

// Drop keeps a commit row and sets its verb to drop. update-ref is removed and
// requires `git rebase --edit-todo` so Git reconciles its update-refs state.
export function dropRebaseTodo(value, selected) {
  const doc = document(value), ids = selection(doc, selected);
  let requiresEditTodo = false;
  const entries = doc.entries.flatMap((entry) => {
    if (!ids.has(entry.line)) return [entry];
    if (entry.verb === "update-ref") { requiresEditTodo = true; return []; }
    return [changeAction(entry, "drop", "")];
  });
  return result(doc, entries, ids, requiresEditTodo);
}

// offset follows the visible list: +1 moves down (earlier execution), -1 up.
// Move selected rows only, retaining hidden metadata in the file. Crossing a
// topology/break boundary is deliberately rejected until its semantics can be
// represented, rather than silently reparenting commits in a merge rebase.
export function moveRebaseTodo(value, selected, offset) {
  const doc = document(value), ids = selection(doc, selected);
  if (!Number.isSafeInteger(offset)) throw new Error("The rebase move offset must be an integer");
  for (const line of ids) {
    if (!doc.entries[line].movable) throw new Error(`Moving ${doc.entries[line].verb} instructions is not supported`);
  }
  let entries = doc.entries.slice(), requiresEditTodo = false;
  const initialRefs = new Map(entries.filter((entry) => entry.verb === "update-ref").map((entry) => [entry.line, entries.indexOf(entry)]));
  if (Math.abs(offset) >= doc.rows.length && offset !== 0) throw new Error("The pending rebase rows cannot move any further");
  for (let step = 0; step < Math.max(1, Math.abs(offset)); step++) {
    const visible = entries.filter((entry) => entry.visible).reverse();
    const positions = visible.flatMap((entry, index) => ids.has(entry.line) ? [index] : []);
    const start = positions[0], end = positions.at(-1);
    if (end - start + 1 !== ids.size) throw new Error("Select a contiguous range of pending rebase rows to move");
    if (offset === 0) break;
    const target = visible[offset > 0 ? end + 1 : start - 1];
    if (!target) throw new Error("The pending rebase rows cannot move any further");
    const source = entries.filter((entry) => ids.has(entry.line));
    const indexes = [...source, target].map((entry) => entries.indexOf(entry));
    const from = Math.min(...indexes), to = Math.max(...indexes);
    const barrier = entries.slice(from, to + 1).find((entry) => BARRIERS.has(entry.verb));
    if (barrier) throw new Error(`Moving across ${barrier.verb} instructions is not supported`);
    const rest = entries.filter((entry) => !ids.has(entry.line));
    const destination = rest.indexOf(target) + (offset > 0 ? 0 : 1);
    rest.splice(destination, 0, ...source);
    entries = rest;
  }
  for (const [line, index] of initialRefs) {
    if (entries.findIndex((entry) => entry.line === line) !== index) requiresEditTodo = true;
  }
  return result(doc, entries, ids, requiresEditTodo);
}
