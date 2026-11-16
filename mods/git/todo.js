import { exec } from "herdr";
import { GitContexts } from "./contexts.js";
import { parseRebaseTodo, editRebaseTodo, moveRebaseTodo, dropRebaseTodo } from "./rebase.js";

// Resolve through Git: linked worktrees have their own rebase state. The
// sentinel preserves paths ending in a newline when the shell captures Git.
const PATH = 'path=$(git rev-parse --path-format=absolute --git-path rebase-merge/git-rebase-todo; printf "."); path=${path%.}; path=${path%?};';
export const READ_TODO = PATH + ' test -f "$path" || exit 0; test "$(wc -c < "$path")" -le 524288 || { printf "Rebase todo exceeds 512 KiB" >&2; exit 1; }; printf "%s\\0%s\\0" "$path" "$(git config --get core.commentChar)"; cat "$path"';
const MAKE_STAGE = `set -eu
test -f "$1" || { printf 'The rebase ended or changed; refresh first' >&2; exit 1; }
umask 077
stage=$(mktemp -d "\${1%/*}/.herdr-git-todo.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
: > "$stage/before"; : > "$stage/after"
printf '%s\\n' "$stage"
trap - EXIT HUP INT TERM`;
const APPEND_STAGE = 'set -eu; printf "%s" "$2" >> "$1/before"; printf "%s" "$3" >> "$1/after"';
const WRITE_TODO = 'set -eu; ' + PATH + `
test "$path" = "$1" && test -f "$path" || { printf 'The rebase ended or changed; refresh first' >&2; exit 1; }
stage=$2
test "$(wc -c < "$stage/after")" -le 524288 || { printf 'Updated rebase todo exceeds 512 KiB' >&2; exit 1; }
lock=$path.lock
(set -C; umask 077; : > "$lock") 2>/dev/null || { printf 'The rebase todo is locked by another process' >&2; exit 1; }
owned=$stage/owned-lock
ln "$lock" "$owned" || { rm -f -- "$lock"; exit 1; }
# Keep a private hardlink to the inode until ownership is released. A successor
# lock cannot be mistaken for ours, even if rename succeeds just before failure.
# Unlike /dev/fd, this also compares device IDs correctly on macOS.
cleanup() { if test "$lock" -ef "$owned"; then rm -f -- "$lock"; fi; }
trap cleanup EXIT
trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
cmp -s "$stage/before" "$path" || { printf 'The rebase todo changed; refresh before editing' >&2; exit 1; }
cat "$stage/after" > "$owned"
mv -f "$lock" "$path"
trap - EXIT HUP INT TERM
if test "$3" = true; then GIT_SEQUENCE_EDITOR=true git rebase --edit-todo; fi`;
const checked = r => { if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `Git exited ${r.code}`); return r.stdout; };

function chunks(text) {
  const result = [];
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + 4096, text.length);
    // A supplementary code point is two UTF-16 units but one argv character.
    // Never hand the subprocess half of its surrogate pair.
    if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff &&
        text.charCodeAt(end) >= 0xdc00 && text.charCodeAt(end) <= 0xdfff) end--;
    result.push(text.slice(start, end)); start = end;
  }
  return result;
}

async function writeTodo(state, next, context) {
  const target = { ...context }; // All staged writes and cleanup use this target.
  const stage = checked(await exec("sh", ["-c", MAKE_STAGE, "sh", state.path], target)).replace(/\n$/, "");
  let failure;
  try {
    const before = chunks(state.doc.raw), after = chunks(next.raw);
    // Each payload argument is <=4 Ki UTF-16 units; at most two chunks cross
    // exec at once, safely below both per-argument and total OS argv limits.
    for (let i = 0; i < Math.max(before.length, after.length); i++) {
      checked(await exec("sh", ["-c", APPEND_STAGE, "sh", stage, before[i] ?? "", after[i] ?? ""], target));
    }
    checked(await exec("sh", ["-c", WRITE_TODO, "sh", state.path, stage, String(next.requiresEditTodo)], target));
  } catch (error) { failure = error; throw error; }
  finally {
    try { checked(await exec("sh", ["-c", 'rm -rf -- "$1"', "sh", stage], target)); }
    catch (error) { if (!failure) throw error; }
  }
}

export class GitTodo extends GitContexts {
  async readPendingRebase(context) {
    const r = await exec("sh", ["-c", READ_TODO], context), raw = checked(r);
    if (!raw) return null;
    const first = raw.indexOf("\0"), next = raw.indexOf("\0", first + 1);
    const path = raw.slice(0, first), configured = raw.slice(first + 1, next);
    const doc = parseRebaseTodo(raw.slice(next + 1), {commentChar: configured && configured !== "auto" ? configured : "#"});
    return {path, doc, context};
  }
  pendingRebaseItems() {
    return (this.pendingRebase?.doc.rows ?? []).map(row => ({hash:row.hash, subject:row.subject, when:row.action, todo:row}));
  }
  pendingRebaseActions(cm, cx) {
    if (!cm?.todo) return [];
    const row = cm.todo, reason = this.pendingRebase?.doc.valid ? null : this.pendingRebase?.doc.errors.join("\n");
    const mutate = (action,flag="") => cx => this.editPendingRebase(action,cx,flag);
    const disabled = reason || (!row.editable ? `This ${row.action} instruction does not accept commit actions` : null);
    return [
      row.hash && ["View commit files", "enter", cx => this.openChangedFiles(cm,cx)],
      ["Pick", "p", mutate("pick"), false, "p", disabled],
      ["Edit", "e", mutate("edit"), false, "e", disabled],
      ["Squash", "s", mutate("squash"), false, "s", disabled],
      ["Fixup", "f", mutate("fixup"), false, "f", disabled],
      ["Fixup options", "c", cx => this.menuItems("Fixup", [
        ["Discard this commit message", "f", mutate("fixup")],
        ["Use this commit message", "c", mutate("fixup","-C")],
      ],cx), false,"c",disabled],
      [row.action === "update-ref" ? "Remove branch update" : "Drop", "d", mutate("drop"), false, "d", reason || (row.action === "update-ref" ? null : disabled)],
      ["Move up", "Ctrl-K", cx => this.movePendingRebase(-1,cx), false, null, reason || (!row.movable ? `Cannot move ${row.action}` : null)],
      ["Move down", "Ctrl-J", cx => this.movePendingRebase(1,cx), false, null, reason || (!row.movable ? `Cannot move ${row.action}` : null)],
      ["Continue / abort", "m", cx => this.operationMenu(cx)],
    ].filter(Boolean);
  }
  changePendingRebase(change, cx) {
    if (this.busy || this.loading) return this.say("Wait for the current operation to finish",cx);
    const state = this.pendingRebase;
    if (!state || this.operation !== "rebase") return this.say("No interactive rebase todo is active",cx);
    const selection = this.selectedItems();
    if (!selection.length || selection.some(it => !it.todo)) return this.say("Select only pending rebase instructions",cx);
    let next;
    try { next = change(state.doc, selection.map(it => it.todo)); }
    catch (e) { return this.say(e.message,cx); }
    if (next.raw === state.doc.raw) return;
    this.perform("Update rebase todo", async (_git,context) => {
      if (context.cwd !== state.context.cwd || context.on !== state.context.on) throw new Error("The repository changed; refresh the rebase todo");
      await writeTodo(state,next,context);
      if (!this.closed && this.root === context.cwd && this.on === context.on) {
        this.rangeAnchors[this.viewKey()] = null;
        this.pendingRebaseSelection = next.selection[0] ?? null;
      }
    },cx);
  }
  editPendingRebase(action,cx,flag="") {
    this.changePendingRebase((doc,selection)=>action === "drop" ? dropRebaseTodo(doc,selection) : editRebaseTodo(doc,selection,action,flag),cx);
  }
  movePendingRebase(offset,cx) { this.changePendingRebase((doc,selection)=>moveRebaseTodo(doc,selection,offset),cx); }
  pendingRebaseKeys(e,cx) {
    if (this.main || this.context() || this.panel !== "commits" || this.commitView !== "commits" || !this.item()?.todo) return false;
    const m = e.modifiers ?? {}, k=e.key;
    if ((m.control && ["j","k"].includes(k)) || (m.alt && ["up","down"].includes(k))) {
      this.movePendingRebase(k === "j" || k === "down" ? 1 : -1,cx); return true;
    }
    return false;
  }
}
