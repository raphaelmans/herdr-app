// What the Pull requests window asks gh, and how it reads the answers.
// Nothing here runs a program: ./main.js does, so this file is tested with
//   node --test mods/pull-requests/github.test.js
//
// Every read is reduced by gh's own --jq before the mod sees it (ADR 0006).

export const ORGANIZATION_CAP = 100;
export const REPOSITORY_CAP = 30;
export const PULL_REQUEST_CAP = 20;
export const BODY_CAP = 3000;
export const FILTERS = ["open", "all", "closed"];

// gh as a login shell would find it: mise's shims first when they are here,
// then the PATH Herdr runs programs with. The same order health.sh uses.
export const GH = 'd="${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims"; [ -d "$d" ] && PATH="$d:$PATH"; export PATH; exec gh "$@"';

const STATES = { open: "[OPEN]", closed: "[CLOSED, MERGED]", all: "[OPEN, CLOSED, MERGED]" };

// `more` is counted before archived repositories are dropped: the cap is on
// what GitHub sent, not on what is listed.
const REPOSITORIES_JQ = `{more: (length >= ${REPOSITORY_CAP}), items: [.[] | select(.archived | not) | {name, private, description: ((.description // "") | .[0:140]), pushed: .pushed_at}]}`;
const PULL_REQUESTS_JQ = `.data.repository.pullRequests | {total: .totalCount, items: [.nodes[] | {number, title, author: (.author.login // ""), updated: .updatedAt, url, draft: .isDraft, review: (.reviewDecision // ""), state, head: .headRefName, base: .baseRefName, add: (.additions // 0), del: (.deletions // 0), files: (.changedFiles // 0), body: ((.body // "") | .[0:${BODY_CAP}]), cut: ((.body // "") | length > ${BODY_CAP})}]}`;

const query = (filter) => `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { pullRequests(first: ${PULL_REQUEST_CAP}, states: ${STATES[filter] ?? STATES.open}, orderBy: {field: UPDATED_AT, direction: DESC}) { totalCount nodes { number title url state isDraft reviewDecision updatedAt headRefName baseRefName additions deletions changedFiles author { login } body } } } }`;

export const accountArgs = () => ["api", "user", "--jq", "{login}"];
export const organizationsArgs = () => ["api", `user/orgs?per_page=${ORGANIZATION_CAP}`, "--jq", "[.[] | .login]"];
export const repositoriesArgs = (organization) => ["api", `orgs/${encodeURIComponent(organization)}/repos?sort=pushed&per_page=${REPOSITORY_CAP}&type=all`, "--jq", REPOSITORIES_JQ];
// One call brings the list and every description in it, most recently updated
// first, so moving through the pull requests never waits on gh.
export const pullRequestsArgs = (organization, repository, filter) => ["api", "graphql", "-f", `query=${query(filter)}`, "-f", `owner=${organization}`, "-f", `name=${repository}`, "--jq", PULL_REQUESTS_JQ];

// What gh printed, as a value. A failed run throws what gh said last.
export function parse(result) {
  const said = (text) => String(text ?? "").trim().split("\n").pop();
  if (result.code !== 0) throw new Error(said(result.stderr) || said(result.stdout) || `gh exited ${result.code}`);
  const out = String(result.stdout ?? "").trim();
  if (!out) return null;
  try { return JSON.parse(out); } catch { throw new Error(said(out)); }
}

export function explain(error) {
  const message = String(error?.message ?? error);
  if (/gh: (command )?not found|no such file|cannot start|os error 2/i.test(message)) return "gh isn't on this computer. Install it with: mise use --global gh@2";
  if (/gh auth login|HTTP 401|authentication required|to authenticate/i.test(message)) return "gh isn't signed in on this computer. Run: gh auth login";
  return message;
}

export function mark(pullRequest) {
  if (!pullRequest) return "";
  if (pullRequest.state === "MERGED") return "merged";
  if (pullRequest.state === "CLOSED") return "closed";
  if (pullRequest.draft) return "draft";
  if (pullRequest.review === "APPROVED") return "approved";
  if (pullRequest.review === "CHANGES_REQUESTED") return "changes";
  if (pullRequest.review === "REVIEW_REQUIRED") return "review";
  return "open";
}

export function matches(search, text) {
  const hay = text.toLowerCase();
  return search.trim().toLowerCase().split(/\s+/).filter(Boolean).every((word) => hay.includes(word));
}

// Markdown as blocks (blank lines split, code fences kept whole) so the
// keyboard can scroll to one.
export function blocks(text) {
  const out = [];
  let current = [], fence = false;
  const flush = () => { if (current.join("").trim()) out.push(current.join("\n")); current = []; };
  for (const line of (text ?? "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) { fence = !fence; current.push(line); if (!fence) flush(); continue; }
    if (!fence && !line.trim()) { flush(); continue; }
    current.push(line);
  }
  flush();
  return out;
}

// What is remembered between opens, belonging to one account. Lists are
// dropped oldest first: descriptions make a list the largest thing kept.
export const REPOSITORY_LISTS = 12;
export const PULL_REQUEST_LISTS = 6;

export const emptyMemory = () => ({ account: "", accountAt: 0, organizations: null, repositories: {}, pullRequests: {} });

export function readMemory(text) {
  try {
    const memory = JSON.parse(text || "");
    if (memory && typeof memory.account === "string" && memory.repositories && memory.pullRequests) return { ...emptyMemory(), ...memory };
  } catch {}
  return emptyMemory();
}

export function trimMemory(memory) {
  const trim = (lists, max) => {
    const keys = Object.keys(lists).sort((a, b) => (lists[a].at ?? 0) - (lists[b].at ?? 0));
    for (const key of keys.slice(0, Math.max(0, keys.length - max))) delete lists[key];
  };
  trim(memory.repositories, REPOSITORY_LISTS);
  trim(memory.pullRequests, PULL_REQUEST_LISTS);
  return memory;
}

// Another account signed in: nothing read as the last one is shown or kept.
export function forAccount(memory, login, now) {
  const next = memory.account && memory.account !== login ? emptyMemory() : memory;
  next.account = login;
  next.accountAt = now;
  return next;
}
