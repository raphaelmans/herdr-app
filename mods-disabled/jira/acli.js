// Jira, read through the Atlassian CLI. READ access only.
//
// Allowed: auth status, project list, board search, board list-sprints,
// workitem search, workitem view. Nothing here creates, edits, or transitions.
//
// acli has no board columns. A column is a status, ordered by the usual
// workflow and then by status category. Sprint, points, updated time, the
// description and comments come from one workitem view when an issue is opened.
// Search cannot return those fields. Description and comments are Atlassian
// document JSON; this file turns that into markdown.
//
// The backlog is the first 200 by rank. All issues are the latest 150.
// A sprint is its first 500. jq reduces every payload before it is parsed.
//
// Reads are kept in data/jira: cache.json (the account, projects, sprints and
// issue lists) and details.json (the issues that were opened). A fresh open
// uses those and does not call acli again until the entry is old, or the
// board is read again with r. Opening an issue rewrites only details.json.
// One sprint list covers active, coming and closed.
//
// What is kept is never copied whole: a list is handed out as one shallow copy
// per issue, made when that list is shown. Nothing kept is changed in place.

import { appHome, checking, exec, readTextFile, writeTextFile } from "herdr";

export const name = "acli";

const READ = [
  ["jira", "auth", "status"],
  ["jira", "project", "list"],
  ["jira", "board", "search"],
  ["jira", "board", "list-sprints"],
  ["jira", "workitem", "search"],
  ["jira", "workitem", "view"],
];

const LIST_FIELDS = "key,summary,status,issuetype,priority,assignee,reporter,labels";
const VIEW_FIELDS = "description,comment,updated,customfield_10020,customfield_10062,customfield_10016";
const BACKLOG_CAP = 200;
const ALL_CAP = 150;
export const SPRINT_CAP = 500;
// A kept file larger than this is not parsed: it starts over instead (ADR 0006).
const FILE_CAP = 2_000_000;

const PRIORITY = {
  highest: "highest", critical: "highest", blocker: "highest",
  high: "high", medium: "medium", moderate: "medium",
  low: "low", lowest: "lowest", trivial: "lowest",
};
const TYPE = { bug: "bug", story: "story", task: "task", epic: "epic", "sub-task": "task", subtask: "task" };
const COLUMN_ORDER = ["to do", "open", "backlog", "in progress", "dev", "dev complete", "in review", "qa", "done", "obsolete"];
const CATEGORY_ORDER = { new: 0, indeterminate: 1, done: 2 };

const LIST = '[.[] | {key, title: .fields.summary, column: .fields.status.id, status: .fields.status.name, category: .fields.status.statusCategory.key, type: .fields.issuetype.name, priority: .fields.priority.name, assignee: (if .fields.assignee then {id: .fields.assignee.accountId, name: .fields.assignee.displayName} else null end), reporter: (if .fields.reporter then {id: .fields.reporter.accountId, name: .fields.reporter.displayName} else null end), labels: (.fields.labels // [])}] | .[0:500]';
const VIEW = 'def item: if type == "array" then .[0] else . end; item | {description: .fields.description, updated: .fields.updated, points: (.fields.customfield_10062 // .fields.customfield_10016), sprints: [.fields.customfield_10020[]? | {name, state}], comments: [.fields.comment.comments[]? | {author: (.author.displayName // ""), at: (.created // ""), body: .body}]}';
const PROJECTS = '[.[] | select((.archived | not) and (.deleted | not)) | {key, name}]';
const BOARDS = '[.values[]? | {id, name, type, location}]';
const SPRINTS = '[.[] | .sprints[]? | {id, name, state}]';
const MINE = 'reduce .[] as $i ({}; .[($i.key | split("-")[0])] += 1)';
const WHO = '[.[] | {id: .fields.assignee.accountId, name: .fields.assignee.displayName}]';

const TTL = {
  me: 24 * 60 * 60 * 1000,
  projects: 12 * 60 * 60 * 1000,
  mine: 15 * 60 * 1000,
  board: 60 * 60 * 1000,
  list: 10 * 60 * 1000,
  detail: 60 * 60 * 1000,
};
const dir = () => `${appHome()}/data/jira`;
// Which file a key is kept in.
const fileOf = (key) => (key.startsWith("detail:") ? "details" : "cache");

let host = null;
const sprintName = new Map();
const mem = new Map();
const flight = new Map();
let diskReady = false;
let dirReady = false;
let saving = Promise.resolve();
const raw = { cache: null, details: null };
const dirty = { cache: false, details: false };

function noteSprints(sprints) {
  for (const sprint of sprints ?? []) sprintName.set(String(sprint.id), sprint.name);
}

function trim() {
  const drop = (prefix, keep) => {
    const keys = [...mem.keys()].filter((key) => key.startsWith(prefix)).sort((a, b) => mem.get(a).at - mem.get(b).at);
    while (keys.length > keep) mem.delete(keys.shift());
  };
  drop("detail:", 25);
  drop("list:", 8);
}

// One write at a time, and only of the file whose keys changed. Saves asked
// for while one is being written become a single write after it.
function queueSave(key) {
  if (checking()) return;
  dirty[fileOf(key)] = true;
  saving = saving.then(async () => {
    for (const file of ["cache", "details"]) {
      if (!dirty[file]) continue;
      dirty[file] = false;
      trim();
      const text = JSON.stringify({ v: 1, entries: [...mem].filter(([k]) => fileOf(k) === file) });
      if (!dirReady) { await exec("mkdir", ["-p", dir()], { timeout: 5000 }); dirReady = true; }
      const path = `${dir()}/${file}.json`;
      try { await writeTextFile(path, text, raw[file]); }
      catch { raw[file] = await readTextFile(path); await writeTextFile(path, text, raw[file]); }
      raw[file] = text;
    }
  }).catch(() => {});
}

// The value kept under a key while it is young enough, else what `run` reads.
// Callers get the kept value itself and must not change it.
function once(key, ttl, force, run) {
  const hit = mem.get(key);
  if (!force && hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.value);
  if (!force && flight.has(key)) return flight.get(key);
  const job = (async () => {
    const value = await run();
    mem.set(key, { at: Date.now(), value });
    queueSave(key);
    return value;
  })();
  const done = job.finally(() => { if (flight.get(key) === done) flight.delete(key); });
  if (!force) flight.set(key, done);
  return done;
}

export async function restore() {
  if (diskReady || checking()) return mem.size > 0;
  diskReady = true;
  for (const file of ["cache", "details"]) {
    try {
      const text = await readTextFile(`${dir()}/${file}.json`);
      raw[file] = text;
      if (!text || text.length > FILE_CAP) continue;
      const data = JSON.parse(text);
      if (data?.v !== 1 || !Array.isArray(data.entries)) continue;
      for (const [key, hit] of data.entries) {
        if (!mem.has(key) && fileOf(key) === file && hit && typeof hit.at === "number" && hit.value != null) mem.set(key, hit);
      }
    } catch { /* no file yet, or one that cannot be read: start without it */ }
  }
  const me = mem.get("me")?.value;
  if (me?.host) host = me.host;
  for (const key of mem.keys()) if (key.startsWith("board:")) noteSprints(mem.get(key).value?.sprints);
  return mem.size > 0;
}

// What is kept, without any issue list: those are asked for one at a time.
export function remembered() {
  const boards = {};
  for (const [key, hit] of mem) if (key.startsWith("board:")) boards[key.slice(6)] = hit.value;
  const me = mem.get("me")?.value ?? null;
  return {
    me: me ? { id: me.id, name: me.name } : null,
    projects: mem.get("projects")?.value ?? [],
    counts: mem.get("mine")?.value ?? {},
    boards,
  };
}

// The one list about to be shown, or null. `id` is "<project>|<scope>".
export function rememberedList(id) {
  const hit = mem.get(`list:${id}`);
  return hit ? withDetails(hit.value) : null;
}

// Each issue as its own object, with what was kept of it when it was opened.
// The view changes these (a detail arrives), never the kept rows.
function withDetails(rows) {
  const now = Date.now();
  return (rows ?? []).map((row) => {
    const hit = mem.get(`detail:${row.key}`);
    return hit && now - hit.at < TTL.detail ? { ...row, ...hit.value } : { ...row };
  });
}

function assertRead(args) {
  const ok = READ.some((prefix) => prefix.every((part, i) => args[i] === part));
  if (!ok) throw new Error(`READ access only. Refused: acli ${args.join(" ")}`);
}

function clean(text) {
  const line = String(text ?? "").split("\n").map((s) => s.trim()).find((s) => s && !/^[┌│└]/.test(s));
  return (line || "acli failed").replace(/^✗\s*/, "").replace(/^Error:\s*/, "");
}

// acli and jq as a login shell would find them: mise's shims first when they
// are here, then the PATH Herdr runs programs with. The order health.sh uses.
const SHIMS = 'd="${MISE_DATA_DIR:-$HOME/.local/share/mise}/shims"; [ -d "$d" ] && PATH="$d:$PATH"; export PATH; ';

// acli's answer is held by the shell and only handed to jq when acli ended
// well, so its own exit status and message are what a failure reports. Every
// sh has this; `set -o pipefail` is not in all of them.
async function acli(args, filter, { slurp = false, timeout = 90_000 } = {}) {
  assertRead(args);
  const jq = slurp ? "jq -sc" : "jq -c";
  const script = `${SHIMS}filter=$1; shift; out=$(acli "$@") || exit $?; printf '%s' "$out" | ${jq} "$filter"`;
  const r = await exec("sh", ["-c", script, "acli", filter, ...args], { timeout });
  if (r.code !== 0) throw new Error(clean(r.stderr || r.stdout));
  const out = r.stdout.trim();
  return out ? JSON.parse(out) : null;
}

async function acliText(args, timeout = 20_000) {
  assertRead(args);
  const r = await exec("sh", ["-c", `${SHIMS}exec acli "$@"`, "acli", ...args], { timeout });
  if (r.code !== 0) throw new Error(clean(r.stderr || r.stdout));
  return r.stdout;
}

function person(raw) {
  if (!raw?.name && !raw?.id) return null;
  return { id: raw.id ?? "", name: raw.name ?? "" };
}

function mapIssue(raw, sprint, sprintKnown) {
  const typeName = (raw.type ?? "").toLowerCase();
  const priorityName = (raw.priority ?? "").toLowerCase();
  return {
    key: raw.key,
    title: raw.title ?? "",
    column: String(raw.column ?? ""),
    status: raw.status ?? "",
    category: raw.category ?? "",
    type: TYPE[typeName] ?? (typeName || "task"),
    priority: PRIORITY[priorityName] ?? (priorityName || "medium"),
    assignee: person(raw.assignee),
    reporter: person(raw.reporter),
    labels: raw.labels ?? [],
    points: null,
    sprint: sprint ?? null,
    sprintKnown,
    updated: null,
    description: "",
    comments: [],
    url: host && raw.key ? `${host}/browse/${raw.key}` : null,
    detail: false,
  };
}

function applyMarks(text, marks) {
  let s = text;
  if ((marks ?? []).some((m) => m.type === "code")) s = `\`${text.replace(/`/g, "'")}\``;
  for (const m of marks ?? []) {
    if (m.type === "strong") s = `**${s}**`;
    else if (m.type === "em") s = `*${s}*`;
    else if (m.type === "strike") s = `~~${s}~~`;
    else if (m.type === "link" && m.attrs?.href) s = `[${s}](${m.attrs.href})`;
  }
  return s;
}

function inline(node) {
  if (!node) return "";
  if (node.type === "text") return applyMarks(node.text ?? "", node.marks);
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return `@${node.attrs?.text ?? "someone"}`;
  if (node.type === "emoji") return node.attrs?.text ?? node.attrs?.shortName ?? "";
  if (node.type === "inlineCard") return node.attrs?.url ?? "";
  if (node.content) return node.content.map(inline).join("");
  return "";
}

function listItem(item, prefix) {
  const parts = (item.content ?? []).map(adf).filter((s) => s !== "");
  if (!parts.length) return prefix.trimEnd();
  const pad = " ".repeat(prefix.length);
  const [first, ...rest] = parts;
  const head = prefix + first.replace(/\n/g, `\n${pad}`);
  const tail = rest.map((part) => part.split("\n").map((line) => pad + line).join("\n")).join("\n");
  return tail ? `${head}\n${tail}` : head;
}

// Atlassian document JSON to markdown. Unknown blocks fall through to their children.
export function adf(node) {
  if (node == null || node === "") return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adf).filter((s) => s !== "").join("\n\n");
  const kids = node.content ?? [];
  switch (node.type) {
    case "doc": return adf(kids);
    case "paragraph": return inline(node);
    case "heading": return `${"#".repeat(Math.min(6, node.attrs?.level || 1))} ${inline(node)}`;
    case "blockquote": return adf(kids).split("\n").map((line) => `> ${line}`).join("\n");
    case "bulletList": return kids.map((item) => listItem(item, "- ")).join("\n");
    case "orderedList": return kids.map((item, i) => listItem(item, `${i + 1}. `)).join("\n");
    case "codeBlock": return "```" + (node.attrs?.language ?? "") + "\n" + kids.map((n) => n.text ?? inline(n)).join("") + "\n```";
    case "rule": return "---";
    case "panel":
    case "expand": return adf(kids);
    case "mediaSingle":
    case "mediaGroup": return "";
    case "table": return kids.map((row) => "| " + (row.content ?? []).map((cell) => inline(cell).replace(/\|/g, "\\|").replace(/\n/g, " ")).join(" | ") + " |").join("\n");
    default: return kids.length ? adf(kids) : inline(node);
  }
}

export function columns(issues) {
  const seen = new Map();
  for (const issue of issues ?? []) {
    if (issue.column && !seen.has(issue.column)) seen.set(issue.column, issue);
  }
  const rank = (issue) => {
    const known = COLUMN_ORDER.indexOf(issue.status.toLowerCase());
    if (known >= 0) return known;
    return 100 + (CATEGORY_ORDER[issue.category] ?? 9);
  };
  return [...seen.values()]
    .sort((a, b) => rank(a) - rank(b) || a.status.localeCompare(b.status))
    .map((issue) => ({ id: issue.column, name: issue.status }));
}

function projectKey(key) {
  if (!/^[A-Za-z][A-Za-z0-9_]+$/.test(key ?? "")) throw new Error("Bad project key");
  return key;
}

export async function me({ force = false } = {}) {
  const value = await once("me", TTL.me, force, async () => {
    const text = await acliText(["jira", "auth", "status"]);
    if (!/Authenticated/.test(text)) throw new Error("Jira is not signed in.");
    const site = text.match(/Site:\s*(\S+)/)?.[1];
    const email = text.match(/Email:\s*(\S+)/)?.[1] ?? "";
    const siteHost = site ? `https://${site}` : null;
    let id = email;
    let name = email;
    try {
      const rows = await acli(["jira", "workitem", "search", "--jql", "assignee = currentUser()", "--limit", "1", "--fields", "assignee", "--json"], WHO, { timeout: 30_000 });
      if (rows?.[0]?.id) { id = rows[0].id; name = rows[0].name || email; }
    } catch { /* the email still names the account */ }
    return { id, name, host: siteHost };
  });
  host = value.host;
  return { id: value.id, name: value.name };
}

export async function projects({ force = false } = {}) {
  return once("projects", TTL.projects, force, async () => {
    const rows = await acli(["jira", "project", "list", "--paginate", "--json"], PROJECTS);
    return (rows ?? []).sort((a, b) => a.name.localeCompare(b.name));
  });
}

function homeBoard(boards, key) {
  const home = (boards ?? []).filter((b) => typeof b.location === "string" && b.location.endsWith(`(${key})`));
  return home.find((b) => b.type === "scrum") ?? home[0] ?? null;
}

async function sprintsOf(id) {
  let page;
  try {
    page = await acli(
      ["jira", "board", "list-sprints", "--id", String(id), "--limit", "100", "--json"],
      '{total: (.total // 0), sprints: [.sprints[]? | {id, name, state, start: .startDate}]}',
      { timeout: 30_000 },
    );
  } catch (e) {
    if (/support sprints/i.test(String(e?.message ?? e))) return [];
    throw e;
  }
  let rows = page?.sprints ?? [];
  if ((page?.total ?? rows.length) > rows.length) {
    rows = await acli(
      ["jira", "board", "list-sprints", "--id", String(id), "--paginate", "--json"],
      SPRINTS,
      { slurp: true },
    ) ?? [];
  }
  rows.forEach((sprint, index) => { sprint.order = index; });
  const rank = { active: 0, future: 1, closed: 2 };
  rows.sort((a, b) => {
    const byState = (rank[a.state] ?? 9) - (rank[b.state] ?? 9);
    if (byState) return byState;
    if (a.state === "closed") return String(a.start ?? "").localeCompare(String(b.start ?? ""));
    return a.order - b.order;
  });
  return rows.map((sprint) => ({ id: String(sprint.id), name: sprint.name, state: sprint.state }));
}

async function loadBoard(project) {
  const boards = await acli(["jira", "board", "search", "--project", project, "--json"], BOARDS, { timeout: 30_000 });
  const home = homeBoard(boards, project);
  const sprints = home ? await sprintsOf(home.id) : [];
  noteSprints(sprints);
  return { columns: [], sprints };
}

export async function board(key, { force = false } = {}) {
  const project = projectKey(key);
  const value = await once(`board:${project}`, TTL.board, force, () => loadBoard(project));
  noteSprints(value.sprints);
  return value;
}

function listId(project, scope) {
  if (scope.backlog) return `${project}|backlog`;
  if (scope.sprint) return `${project}|sprint:${scope.sprint}`;
  return `${project}|all`;
}

function issueQuery(project, scope) {
  if (scope.backlog) {
    return {
      q: `project = ${project} AND sprint is EMPTY ORDER BY rank`,
      limit: String(BACKLOG_CAP),
      sprint: null,
      sprintKnown: true,
    };
  }
  if (scope.sprint) {
    if (!/^\d+$/.test(String(scope.sprint))) throw new Error("Bad sprint id");
    return {
      q: `project = ${project} AND sprint = ${scope.sprint}`,
      limit: null,
      sprint: sprintName.get(String(scope.sprint)) ?? null,
      sprintKnown: true,
    };
  }
  return {
    q: `project = ${project} ORDER BY updated DESC`,
    limit: String(ALL_CAP),
    sprint: null,
    sprintKnown: false,
  };
}

async function loadIssues(project, scope) {
  const query = issueQuery(project, scope);
  const args = ["jira", "workitem", "search", "--jql", query.q, "--fields", LIST_FIELDS, "--json"];
  if (query.limit) args.push("--limit", query.limit);
  else args.push("--paginate");
  const rows = await acli(args, LIST, { timeout: 120_000 });
  return (rows ?? []).map((row) => mapIssue(row, query.sprint, query.sprintKnown));
}

export async function issues(key, scope = {}, { force = false } = {}) {
  const project = projectKey(key);
  // Read again on purpose: what was kept of this project's issues goes too, so
  // each one is read fresh when it is next shown.
  if (force) for (const key of [...mem.keys()]) if (key.startsWith(`detail:${project}-`)) mem.delete(key);
  const rows = await once(`list:${listId(project, scope)}`, TTL.list, force, () => loadIssues(project, scope));
  return withDetails(rows);
}

async function loadIssue(key) {
  const raw = await acli(["jira", "workitem", "view", key, "--fields", VIEW_FIELDS, "--json"], VIEW, { timeout: 30_000 });
  const sprints = raw?.sprints ?? [];
  const current = sprints.find((s) => s.state === "active") ?? sprints.at(-1) ?? null;
  const points = typeof raw?.points === "number" ? raw.points : null;
  return {
    description: adf(raw?.description),
    comments: (raw?.comments ?? []).map((c) => ({ author: c.author || "Someone", at: c.at || "", text: adf(c.body) })),
    updated: raw?.updated ?? null,
    points,
    sprint: current?.name ?? null,
    sprintKnown: true,
    detail: true,
  };
}

export async function issue(key, { force = false } = {}) {
  if (!/^[A-Za-z][A-Za-z0-9_]+-\d+$/.test(key ?? "")) throw new Error("Bad issue key");
  return once(`detail:${key}`, TTL.detail, force, () => loadIssue(key));
}

export async function openMine({ force = false } = {}) {
  return once("mine", TTL.mine, force, async () => {
    const rows = await acli(
      ["jira", "workitem", "search", "--jql", "assignee = currentUser() AND statusCategory != Done", "--fields", "key", "--limit", "100", "--json"],
      MINE,
      { timeout: 60_000 },
    );
    return rows ?? {};
  });
}
