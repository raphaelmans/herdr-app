// Git Graph's history query and page boundary, independent of the native UI.
export const GRAPH_INITIAL_LIMIT = 300;
export const GRAPH_PAGE_SIZE = 100;

function pageLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit >= Number.MAX_SAFE_INTEGER)
    throw new RangeError("Graph history limit must be a positive safe integer");
  return limit;
}

// refs:null is the all-branches view. An explicit array stays filtered, even
// when a stash has a base outside those refs. format is the caller's git-log
// format; date is an optional complete --date=... argument.
export function graphHistoryQuery({ refs = null, limit = GRAPH_INITIAL_LIMIT, format = "%H", date, stashBases = [] } = {}) {
  limit = pageLimit(limit);
  const revisions = refs === null
    ? ["--branches", "--remotes", "--tags", ...new Set(stashBases.filter(Boolean)), "HEAD"]
    : [...refs];
  // Ordering must happen during Git's walk, before limiting. Sorting an
  // already limited default walk cannot recover commits omitted from it.
  const args = ["-c", "log.showSignature=false", "log", "--no-color", "--date-order", "--decorate=full",
    `--max-count=${limit + 1}`, `--format=${format}`, ...(date ? [date] : []), ...revisions, "--"];
  return { args, limit, key: JSON.stringify(args) };
}

// Consume the extra commit before inserting synthetic WIP or stash rows.
// A bounded command's truncated output cannot establish the end of history;
// preserve that fact so the caller can show an incomplete-result message.
export function graphHistoryPage(commits, limit = GRAPH_INITIAL_LIMIT, { truncated = false } = {}) {
  limit = pageLimit(limit);
  return { commits: commits.slice(0, limit), limit, hasMore: commits.length > limit || truncated, truncated };
}
