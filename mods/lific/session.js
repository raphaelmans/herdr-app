// Lific sessions are local agents. Each new one gets its own Herdr tab. A
// terminal address survives recovery, so bind the session to its launch process.
import { exec, home, panes, run, setShared, shared, spaces, terminals } from "herdr";

const LABEL = "lific.session";
const BOOT = 'exec "${SHELL:-/bin/zsh}" -lic "$1"';
const readyState = (word) => word === "idle" || word === "done";
const notSent = (message) => Object.assign(new Error(message), { notSent: true });
const isolatedOpenCode = (command) => command?.startsWith("sh '") && command.includes("/mods/lific/session/opencode.sh' ");

async function hc(args, timeout = 30_000) {
  const result = await exec("hc", args, { timeout });
  if (result.code !== 0) {
    let error;
    try { error = JSON.parse(result.stderr || result.stdout).error; } catch {}
    throw Object.assign(new Error(error?.message || result.stderr.trim() || `hc ${args[0]} exited ${result.code}`), { kind: error?.kind });
  }
  return JSON.parse(result.stdout);
}

function original(t) {
  if (t?.state !== "live" || t.labels?.[LABEL] !== "1" || t.address.includes("/")) return false;
  const pid = t.labels["lific.pid"];
  const recipe = t.labels["lific.agent"];
  const command = t.argv?.[4];
  // A standing OpenCode from the old recipe still has its personal tools.
  const oldOpenCode = !recipe && (command?.includes("OPENCODE_CONFIG_CONTENT=") ||
    (t.report?.app ?? t.status?.app ?? t.program?.key) === "opencode");
  if ((recipe === "opencode" || oldOpenCode) && !isolatedOpenCode(command)) return false;
  // Before PID labels, the launch command still distinguished a Lific
  // session from the login shell Herdr substituted after a loss.
  return t.argv?.[2] === BOOT && (!pid || String(t.pid) === pid);
}

export const sessions = () => terminals().filter((t) => original(t) &&
  (!t.labels["lific.agent"] || t.labels["lific.pid"])).sort((a, b) => a.created_ms - b.created_ms);

export const choose = (address) => setShared(LABEL, address);

export function current(all = sessions()) {
  const selected = shared(LABEL);
  if (selected) return all.find((t) => t.address === selected) ?? null;
  return all.find((t) => t.name === "lific") ?? all[0] ?? null;
}

export function show(address) {
  // Earlier Lific sessions can still be opened before they have a model pane.
  const pane = panes().find((p) => p.terminal === address);
  if (pane) run("pane.focus", { pane: pane.pane });
  else run("terminal.peek", { terminal: address });
}

export async function start(choice) {
  if (choice.agent === "opencode" && !isolatedOpenCode(choice.command)) {
    throw new Error("Open Config → Lific to update the OpenCode recipe, then send the request again.");
  }
  const cwd = `${home()}/.local/state/lific-session`;
  const dir = await exec("mkdir", ["-p", cwd]);
  if (dir.code !== 0) throw new Error(dir.stderr.trim() || `Couldn't create ${cwd}`);
  const local = spaces().filter((s) => !s.machine);
  const space = local.find((s) => s.active) ?? local[0];
  const { address } = await hc(["run", "--bg", "--json", "--outlive-parent", "--no-parent", "--no-notify",
    "--label", `${LABEL}=1`, "--label", `lific.agent=${choice.agent || "custom"}`,
    "--cwd", cwd, "--", "sh", "-c", BOOT, "sh", choice.command]);
  if (!address) throw new Error("herdr-core returned no address for the Lific session.");
  const term = await hc(["get", address, "--json"]);
  if (!original(term) || !term.pid) throw new Error("The Lific agent exited during startup. Check its command in Config.");
  // The core assigns the address. Using it for the tab ID keeps simultaneous
  // launches distinct, including launches from different Herdr screens.
  await hc(["label", address, `lific.pid=${term.pid}`, `herdr.space=${space?.id ?? "lific"}`, `herdr.tab=lific-${address}`, "--json"]);
  choose(address);
  return address;
}

const agentKey = (name) => String(name || "").split(/[\\/]/).pop().toLowerCase().replace(/^claude-code$/, "claude");

async function recipient(address, cx) {
  let t = await hc(["get", address, "--json"]);
  if (!original(t)) throw new Error("The Lific agent has ended. Choose a new session with T.");
  // Adopting a terminal as a tab enables core keep. A request can wait for
  // someone's draft before delivery. Finish adoption before disabling recovery
  // so the app cannot turn it back on while a request is queued.
  if (t.labels["herdr.tab"] && !panes().some((p) => p.terminal === address)) {
    for (let i = 0; i < 30 && !panes().some((p) => p.terminal === address); i++) await cx.sleep(100);
    if (!panes().some((p) => p.terminal === address)) throw new Error("The session's tab is still opening. Send again when it appears.");
    t = await hc(["get", address, "--json"]);
    if (!original(t)) throw new Error("The Lific session changed while its tab was opening.");
  }
  if (t.keep) {
    await hc(["keep", address, "--off", "--json"]);
    t = await hc(["get", address, "--json"]);
  }
  if (!original(t) || t.keep) throw new Error("The Lific session changed before delivery. Open it with t.");
  const agent = agentKey(t.labels["lific.agent"]);
  const app = agentKey(t.status?.app || t.foreground?.argv?.[0]);
  if (!t.status || !app || (agent && agent !== "custom" && agent !== app) ||
      /^(sh|bash|zsh|fish|pwsh|powershell|cmd)(\.exe)?$/.test(agentKey(t.foreground?.argv?.[0]))) {
    throw new Error("The terminal is no longer reporting the Lific agent. Open it with t.");
  }
  if (!readyState(t.status.state)) throw new Error(`The Lific session is ${t.status.state}. Open it with t.`);
  return t.status.state;
}

export async function ready(address) {
  const w = await hc(["wait", address, "--json", "--timeout", "30"], 40_000);
  if (w.reason === "status" && w.ended && readyState(w.status)) return;
  if (w.reason === "exit") throw new Error("The Lific agent exited during startup. Check its command in Config.");
  throw new Error("The Lific session is waiting to start. Press t to check for a trust prompt, then send your request.");
}

// hc records the turn at delivery. On a check-in, wait for that turn without
// sending again. A late or missing working report leaves delivery uncertain.
export async function ask(address, text, sending, cx) {
  let state;
  try { state = await recipient(address, cx); }
  catch (error) { throw notSent(error.message); }
  sending();
  let receipt;
  try {
    receipt = await hc(["send", "--json", "--wait", "--timeout", "120", ...(state === "idle" ? ["--if", "idle"] : []), address, text], 590_000);
  } catch (error) {
    if (["blocked", "status_mismatch", "not_found", "finished"].includes(error.kind)) throw notSent(error.message);
    throw error;
  }
  if (receipt.started !== true) throw new Error("Delivery was not confirmed. Read the session with t before sending again.");
  let w = receipt.wait;
  while (w?.reason === "timeout" || w?.reason === "message") {
    w = await hc(["wait", address, "--json", "--timeout", "120"], 150_000);
  }
  if (w?.reason === "exit") throw new Error("The Lific session exited before confirming the request.");
  if (w?.reason !== "status" || !w.ended || !Number.isInteger(receipt.turn) || w.turn !== receipt.turn + 1) {
    throw new Error("Could not confirm how this request ended. Open the session with t.");
  }
  if (w.status === "blocked") return "blocked";
  if (!readyState(w.status)) throw new Error(`The Lific session reported ${w.status}. Open it with t.`);
  return "done";
}

// A fresh marker identifies this request's optional issue receipt, even when
// earlier turns, the echoed request, or another user's input remain on screen.
export function request(text, project) {
  const marker = "Lific-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  return { marker, text: `[Lific window · ${project ?? "no project"} shown]\n${text}\n\nIf you changed an issue, end your reply with ${marker} followed by a space and the last changed issue ID on the same line.` };
}

export async function changedIssue(address, marker) {
  const result = await exec("hc", ["read", "--lines", "60", address], { timeout: 30_000 }).catch(() => null);
  if (result?.code !== 0) return null;
  return new RegExp(`(?:^|\\s)${marker} +([A-Z][A-Z0-9]*-\\d+)\\b`).exec(result.stdout)?.[1] ?? null;
}
