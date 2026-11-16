// Stub source for the Jira board: made-up projects and issues, so the board can
// be designed on a computer with no Jira. Nothing here reaches the network.
//
// A source is what main.js reads a board through. A real one (Jira's REST API
// or a CLI) exports the same four things and is picked in main.js's SOURCES:
//   name            shown in the window ("stub", "jira")
//   me()            the authenticated account: { id, name }
//   projects()      [{ key, name }]
//   board(key)      { columns: [{ id, name }], sprints: [{ id, name, state }] } for
//                   one project; state is "active" | "future" | "closed", oldest first
//   issues(key, scope)  the project's issues in a scope: { sprint: id }, { backlog:
//                   true } (in no sprint, in rank order) or {} (all of them)
//   openMine()      { projectKey: n }: the account's issues that are not done
// An issue: { key, title, column (a column id), status (Jira's own name for it),
//   type: "story" | "bug" | "task" | "epic", priority: "highest" | "high" |
//   "medium" | "low" | "lowest", assignee: { id, name } | null, reporter, labels,
//   points, sprint (its name, null in the backlog), updated (ISO date),
//   description (markdown), comments: [{ author, at, text }], url | null }
//
// With acli these are about: `acli jira auth status`, `acli jira project list`,
// `acli jira board list-sprints`, and `acli jira workitem search --jql` with
// `sprint = <id>`, `sprint is EMPTY ORDER BY rank`, or
// `assignee = currentUser() AND statusCategory != Done`, each with `--json`.

export const name = "stub";

const ME = { id: "stub-me", name: "You" };
const ANA = { id: "stub-ana", name: "Ana Reyes" };
const KOFI = { id: "stub-kofi", name: "Kofi Mensah" };
const MEI = { id: "stub-mei", name: "Mei Tanaka" };

const COLUMNS = [
  { id: "todo", name: "To Do" },
  { id: "progress", name: "In Progress" },
  { id: "review", name: "In Review" },
  { id: "done", name: "Done" },
];

const PROJECTS = [
  { key: "WEB", name: "Web app" },
  { key: "API", name: "Platform API" },
  { key: "OPS", name: "Operations" },
];

const STATUS = { todo: "To Do", progress: "In Progress", review: "In Review", done: "Done" };

// [key, column, type, priority, assignee, points, title, labels, description, comments]
const ROWS = [
  ["WEB-142", "progress", "story", "high", ME, 5, "Checkout: save the cart between sessions", ["checkout"],
    "A signed-in shopper who closes the tab loses the cart.\n\n## Acceptance\n\n- The cart is restored on the next visit, on any device\n- Items that went out of stock are marked, not dropped\n- A cart older than 30 days is cleared\n\n```ts\ntype SavedCart = { items: CartItem[]; savedAt: string };\n```",
    [[ANA, "2026-11-12T09:14", "Design is in the file under *Checkout / v3*. The out-of-stock state is new."], [ME, "2026-11-13T16:40", "Storing it server-side; local storage only as a fallback when signed out."]]],
  ["WEB-151", "progress", "bug", "highest", ME, 2, "Login form submits twice on a slow connection", ["auth", "regression"],
    "Pressing Enter and then clicking **Sign in** sends two requests. The second one fails with `409` and shows an error over a working session.\n\nSeen since the form moved to the new button component.", []],
  ["WEB-139", "review", "task", "medium", ME, 3, "Replace the date picker in the booking flow", ["a11y"],
    "The current picker cannot be used with the keyboard. Swap in the one from the design system and keep the same value format.",
    [[KOFI, "2026-11-14T11:02", "Reviewed the first half. One question on the time zone handling, left inline."]]],
  ["WEB-160", "todo", "story", "medium", ME, 8, "Order history: filter by date and status", [],
    "People with many orders scroll to find one. Add a date range and a status filter above the list; keep them in the URL.", []],
  ["WEB-163", "todo", "bug", "low", ME, 1, "Footer links wrap badly at 360px", ["css"], "", []],
  ["WEB-131", "done", "story", "high", ME, 5, "Show delivery estimates on the product page", ["checkout"],
    "Shipped behind `delivery_estimates`. Rollout finished 12 Nov.", []],
  ["WEB-155", "todo", "story", "high", ANA, 5, "Empty states for search, orders and wishlist", ["design"], "Three screens still show a blank area when there is nothing to list.", []],
  ["WEB-148", "progress", "task", "medium", KOFI, 3, "Move image resizing to the CDN", ["perf"], "", []],
  ["WEB-157", "review", "bug", "high", MEI, 2, "Wishlist count is wrong after merging a guest cart", [], "", []],
  ["WEB-120", "done", "task", "low", ANA, 1, "Remove the old promo banner component", [], "", []],
  ["WEB-166", "todo", "task", "medium", null, 3, "Audit bundle size after the router upgrade", ["perf"], "Nobody has picked this up yet.", []],

  ["API-88", "progress", "story", "high", ME, 8, "Rate limits per API key, with headers", ["limits"],
    "Limits are per IP today, which punishes offices behind one address.\n\n- Count per key, in a sliding window\n- Return `X-RateLimit-Remaining` and `Retry-After`\n- Keep the per-IP limit for unauthenticated calls",
    [[MEI, "2026-11-10T08:30", "The gateway already has the key at that point, so no extra lookup."]]],
  ["API-93", "todo", "bug", "medium", ME, 2, "Webhook retries ignore the backoff setting", ["webhooks"], "Retries fire every 5 seconds whatever `backoff` says.", []],
  ["API-79", "done", "task", "medium", ME, 3, "Document the pagination cursors", ["docs"], "", []],
  ["API-90", "review", "story", "high", KOFI, 5, "Bulk endpoint for order updates", [], "", []],
  ["API-95", "todo", "story", "low", MEI, 5, "Idempotency keys on POST /payments", ["payments"], "", []],
  ["API-84", "progress", "bug", "highest", ANA, 3, "Timeouts on report export above 50k rows", ["reports"], "", []],

  ["OPS-31", "todo", "task", "medium", ME, 2, "Rotate the staging database credentials", ["security"], "Due before the end of the sprint. The runbook is in the wiki under *Secrets*.", []],
  ["OPS-28", "review", "task", "high", KOFI, 3, "Alert when the queue is older than 5 minutes", ["alerts"], "", []],
  ["OPS-25", "done", "task", "low", MEI, 1, "Archive last year's deploy logs", [], "", []],
];

// Rows not named here are in the active sprint, 42. null: the backlog.
const SPRINT_OF = {
  "WEB-131": 41, "WEB-120": 41, "API-79": 41, "OPS-25": 41,
  "WEB-160": 43, "WEB-155": 43, "API-95": 43,
  "WEB-163": null, "WEB-166": null, "API-93": null, "OPS-31": null,
};

// The backlog beyond those, in rank order: [key, type, priority, assignee, points, title, labels]
const BACKLOG = [
  ["WEB-170", "story", "high", null, 8, "Guest checkout without an account", ["checkout"]],
  ["WEB-171", "story", "medium", ME, 5, "Remember the last used delivery address", ["checkout"]],
  ["WEB-168", "bug", "medium", null, 2, "Search suggestions flicker while typing", ["search"]],
  ["WEB-172", "task", "low", ANA, 3, "Dark mode for the order emails", ["design"]],
  ["WEB-169", "story", "low", null, 13, "Gift cards", []],
  ["WEB-173", "task", "lowest", ME, 1, "Drop the IE11 polyfills", ["perf"]],
  ["API-97", "story", "high", null, 8, "Scoped API keys: read-only and per resource", ["limits"]],
  ["API-98", "task", "medium", ME, 3, "Publish the OpenAPI file with each release", ["docs"]],
  ["API-99", "bug", "low", null, 2, "Sorting by a missing field returns 500, not 400", []],
  ["OPS-33", "task", "medium", null, 5, "Move cron jobs to the scheduler", []],
  ["OPS-34", "task", "low", ME, 2, "Trim the on-call runbook", ["docs"]],
];

const SPRINTS = [
  { n: 41, state: "closed" },
  { n: 42, state: "active" },
  { n: 43, state: "future" },
];
const project = (key) => key.split("-")[0];

const ISSUES = [
  ...ROWS,
  ...BACKLOG.map(([key, type, priority, assignee, points, title, labels]) => [key, "todo", type, priority, assignee, points, title, labels, "", []]),
].map(([key, column, type, priority, assignee, points, title, labels, description, comments], n) => {
  const sprint = key in SPRINT_OF ? SPRINT_OF[key] : ROWS.some((r) => r[0] === key) ? 42 : null;
  return {
    key, title, column, status: STATUS[column], type, priority, assignee, reporter: ANA, labels, points,
    sprintId: sprint == null ? null : `${project(key)}-${sprint}`,
    sprint: sprint == null ? null : `Sprint ${sprint}`,
    updated: `2026-11-${String(15 - (n % 9)).padStart(2, "0")}`,
    description,
    comments: comments.map(([author, at, text]) => ({ author: author.name, at, text })),
    url: null,
  };
});

export async function me() { return ME; }

export async function projects() { return PROJECTS; }

export async function board(key) {
  return { columns: COLUMNS, sprints: SPRINTS.map((s) => ({ id: `${key}-${s.n}`, name: `Sprint ${s.n}`, state: s.state })) };
}

export async function issues(key, scope = {}) {
  const all = ISSUES.filter((i) => project(i.key) === key);
  if (scope.backlog) return all.filter((i) => !i.sprintId);
  return scope.sprint ? all.filter((i) => i.sprintId === scope.sprint) : all;
}

export async function openMine() {
  const counts = {};
  for (const i of ISSUES) if (i.assignee?.id === ME.id && i.column !== "done") counts[project(i.key)] = (counts[project(i.key)] ?? 0) + 1;
  return counts;
}
