import { filterItems } from "./search.js";
// Git's NUL-separated status is the authority for paths and ignore rules.
// A rename consumes two records; neither path is shell text or a quoted path.
export function parseStatus(text, stagedStats = {}, workStats = {}, limit = 2000) {
  const records = text.split("\0"), files = [];
  const branch = records[0]?.startsWith("## ") ? records.shift().slice(3) : "";
  let limited = false;
  for (let at = 0; at < records.length; at++) {
    const record = records[at];
    if (record.length < 4 || record[2] !== " ") continue;
    const x = record[0], y = record[1], code = x + y;
    if (code === "!!") continue;
    const directory = record.endsWith("/"), path = directory ? record.slice(3, -1) : record.slice(3);
    const previousPath = /[RC]/.test(code) ? records[++at] : null;
    if (/[RC]/.test(code) && !previousPath) break;
    if (files.length >= limit) { limited = true; break; }
    const s = stagedStats[path], w = workStats[path];
    files.push({path, previousPath, directory, x, y, fresh: code === "??", staged: ![" ", "U", "?"].includes(x), unstaged: y !== " ",
      conflict: ["UU", "AA", "DD", "AU", "UA", "UD", "DU"].includes(code), inlineConflict: ["UU", "AA"].includes(code),
      add: (s?.add ?? 0) + (w?.add ?? 0), del: (s?.del ?? 0) + (w?.del ?? 0), binary: s?.binary || w?.binary});
  }
  return {branch, files, limited};
}

export function filterFiles(files, status, term = "", conflictedPaths = new Set(), options = {}) {
  const visible=files.filter((f) => {
    const match = status === "staged" ? f.staged : status === "unstaged" ? f.unstaged
      : status === "tracked" ? !f.fresh : status === "untracked" ? f.fresh
      : status === "conflicted" ? f.conflict || conflictedPaths.has(f.path) : true;
    return match;
  });
  return filterItems(visible,term,f=>[f.path,f.previousPath??""],options);
}

export function filePaths(files) { return [...new Set(files.flatMap((f) => f.previousPath ? [f.path, f.previousPath] : [f.path]))]; }

// Run with sh -c in the worktree. --git-path also resolves linked worktrees,
// whose .git is a file. Only bounded metadata, never file contents, is returned.
export const OPERATION_STATE_SCRIPT = String.raw`
for name in rebase-merge rebase-apply rebase-apply/applying MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD SQUASH_MSG BISECT_LOG; do
  p=$(git rev-parse --git-path "$name") || exit
  if [ -e "$p" ]; then printf '%s\n' "$name"; fi
done
todo=$(git rev-parse --git-path sequencer/todo) || exit
if [ -f "$todo" ]; then
  LC_ALL=C head -c 8192 "$todo" | awk '
    NF && $1 !~ /^#/ { if ($1 == "pick" || $1 == "revert") print "sequence:" $1; exit }
  '
fi
cherry=$(git rev-parse --git-path CHERRY_PICK_HEAD) || exit
rebasing=$(git rev-parse --git-path rebase-merge) || exit
if [ -s "$cherry" ] && [ -d "$rebasing" ]; then
  cherry_hash=$(head -c 128 "$cherry" | tr -d '\r\n')
  stopped_hash=
  done_hash=
  if [ -f "$rebasing/stopped-sha" ]; then stopped_hash=$(head -c 128 "$rebasing/stopped-sha" | tr -d '\r\n'); fi
  if [ -f "$rebasing/done" ]; then
    done_hash=$(LC_ALL=C tail -c 8192 "$rebasing/done" | awk '
      $1 ~ /^(pick|p|reword|r|edit|e|squash|s|drop|d)$/ { hash=$2 }
      $1 == "fixup" || $1 == "f" { hash=($2 == "-C" || $2 == "-c") ? $3 : $2 }
      $1 == "merge" || $1 == "m" { hash=($2 == "-C" || $2 == "-c") ? $3 : "" }
      $1 ~ /^(exec|x|break|b|label|l|reset|t|update-ref|u)$/ { hash="" }
      END { print hash }
    ')
  fi
  for hash in "$stopped_hash" "$done_hash"; do
    case "$hash" in ''|*[!0-9a-fA-F]*) continue ;; esac
    case "$cherry_hash" in "$hash"*) printf '%s\n' rebase:pick; break ;; esac
  done
fi
`;

export function operationFromState(text) {
  const state = new Set(text.split("\n").map((line) => line.trim()));
  // A nested operation must finish before its enclosing rebase can continue.
  if (state.has("REVERT_HEAD") || state.has("sequence:revert")) return "revert";
  if ((state.has("CHERRY_PICK_HEAD") && !state.has("rebase:pick")) || state.has("sequence:pick")) return "cherry-pick";
  if (state.has("MERGE_HEAD")) return "merge";
  if (state.has("SQUASH_MSG")) return "squash-merge";
  if (state.has("rebase-apply/applying")) return "am";
  if (state.has("rebase-merge") || state.has("rebase-apply")) return "rebase";
  return null;
}

// Argument arrays, excluding "git". Squash merges write no MERGE_HEAD, so the
// usual merge --continue/--abort commands cannot finish them.
export function operationCommands(operation) {
  if (operation === "squash-merge") return {
    label: "squash merge", continue: ["commit", "--no-edit"], abort: ["reset", "--merge"], skip: null,
  };
  if (!["merge", "rebase", "cherry-pick", "revert", "am"].includes(operation)) return null;
  return {
    label: operation === "am" ? "apply patches" : operation,
    continue: [operation, "--continue"], abort: [operation, "--abort"],
    skip: operation === "merge" ? null : [operation, "--skip"],
  };
}
