import { appHome, exec, home, knownAgents, panes, readTextFile, spaces } from "herdr";

const executable = (value) => String(value ?? "").split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
const identity = (value) => executable(value).replace(/[^a-z0-9]/g, "");
export const supportsFork = (key) => ["claude", "claude-code", "codex"].includes(key);

export function detectAgent(pane, terminal, catalog) {
  const fg = terminal.foreground ?? {};
  const match = (value) => value && catalog.find((a) =>
    [a.key, a.name, a.run?.[0]].some((alias) => alias && identity(alias) === identity(value)));
  const process = match(fg.argv?.[0]) ?? match(fg.name);
  if (process) return process;
  if (pane.program?.agent) return catalog.find((a) => a.key === pane.program.key) ?? pane.program;
  const app = terminal.status?.app ?? pane.app;
  return match(app) || (app ? { key: app, name: app } : null);
}

function checked(result, fallback) {
  let data;
  try { data = JSON.parse(result.stdout || "null"); } catch {}
  if (result.code !== 0 || data?.error) {
    let error = data?.error;
    try { error ??= JSON.parse(result.stderr).error; } catch {}
    throw new Error(error?.message ?? (typeof error === "string" ? error : null) ?? (result.stderr?.trim() || fallback));
  }
  return data;
}

// Pin the source before opening the picker; changing focus never retargets it.
// Inspect again on selection, before starting a process or sending a message.
export async function inspect(source) {
  const pane = panes().find((p) => p.pane === source.pane);
  if (!pane?.terminal || pane.terminal !== source.terminal) throw new Error("The source terminal pane is no longer available.");
  const terminal = checked(await exec("hc", ["get", pane.terminal, "--json"], { timeout: 5000 }), "Could not inspect the source terminal");
  if (terminal?.state !== "live") throw new Error("The source terminal has finished.");
  const on = spaces().find((s) => s.tabs?.some((tab) => tab.id === pane.tab))?.machine ?? null;
  const catalog = await knownAgents({ on });
  const agent = detectAgent(pane, terminal, catalog);
  if (!agent) throw new Error("No agent CLI detected in this pane.");
  if (source.key && agent.key !== source.key) throw new Error("The source agent changed while the picker was open. Open Fork again.");
  return { pane, terminal, on, agent, catalog, folder: terminal.foreground?.cwd || pane.cwd || terminal.cwd || null };
}

// run() returns no result. The app's command interface returns the terminal
// address we need for the native handover, and accepts an explicit source pane.
async function split(source, argv) {
  const pane = panes().find((p) => p.pane === source.pane.pane);
  if (pane?.terminal !== source.pane.terminal) throw new Error("The source terminal pane is no longer available.");
  const result = await exec("env", ["HERDR_APP_HOME=" + appHome(), "herdr-app", "do", "pane.split",
    JSON.stringify({ pane: source.pane.pane, direction: "right", argv })], { timeout: 15000 });
  const opened = checked(result, "Could not open the new agent pane");
  if (!opened?.terminal) throw new Error("The app did not return the new terminal address. Check the source tab before trying again.");
  return opened;
}

async function nativePlan(source, target) {
  const { terminal, on, folder, agent } = source;
  const fg = terminal.foreground ?? {}, prompt = target.task ? [target.task] : [];
  const argv = [...target.argv];
  if (agent.key === "codex") {
    if (!argv.includes("--no-daemon")) argv.push("--no-daemon");
    const open = fg.pid ? await exec("lsof", ["-p", String(fg.pid)], { on, timeout: 5000 }).catch(() => null) : null;
    const id = /rollout-[^\s/]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/.exec(open?.stdout ?? "")?.[1];
    return { argv: [...argv, "fork", id || "--last", ...prompt], guessed: !id };
  }
  if (agent.key === "claude" || agent.key === "claude-code") {
    const root = on ? (await exec("sh", ["-c", 'printf %s "$HOME"'], { on, timeout: 5000 })).stdout.trim() : home();
    const raw = fg.pid && root ? await readTextFile(root + "/.claude/sessions/" + fg.pid + ".json", { on }).catch(() => null) : null;
    const session = raw ? JSON.parse(raw) : null;
    if (!session?.sessionId) return { argv: [...argv, "--continue", "--fork-session", ...prompt], guessed: true };
    // Claude's background resume copies a running session. Keep the chosen
    // model, effort and permission options on that copy, then attach to it.
    const bg = await exec(argv[0], [...argv.slice(1), "--bg", "--resume", session.sessionId, ...prompt],
      { on, cwd: session.cwd || folder || undefined, timeout: 60000 });
    checked(bg, "Claude could not create the fork");
    const id = /backgrounded · ([\w-]+)/.exec(bg.stdout + "\n" + bg.stderr)?.[1];
    if (!id) throw new Error("Claude did not return the copy's ID. Check claude agents before trying again.");
    return { argv: [...target.run, "attach", id] };
  }
  throw new Error("No native fork recipe for " + agent.name + " yet. Choose another CLI to hand over.");
}

const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";
// Same contract as the Agent hub's Message: what arrives is wrapped in a
// <herdr-message> naming the session it came from, plus one line saying how to
// answer it, so the receiver can reply to the source with hc send.
const attr = (s) => String(s ?? "").replace(/"/g, "'").replace(/[<>\n]/g, " ").trim();
export function handoverMessage(source, target, destination) {
  // The receiver is on the source's machine. Its hc needs that machine's
  // local address, not the app's machine-qualified address on this computer.
  const local = (a) => source.on && a.startsWith(source.on + "/") ? a.slice(source.on.length + 1) : a;
  const address = local(destination), from = local(source.pane.terminal);
  const to = quote(address);
  const name = attr(source.pane.title || source.pane.label || source.agent.name);
  const head = '<herdr-message from="' + from + '" name="' + name + '" agent="' + attr(source.agent.name) + '">';
  const tail = "</herdr-message>\nHanded over by the user from another agent session in Herdr (terminal " + from + "). If that session needs an answer, send it with: hc send " + from + " '<herdr-message from=\"" + address + "\">your reply</herdr-message>'";
  return [
    "The user chose Fork → " + target.name + " to hand this conversation over to terminal " + address + ".",
    "Prepare a self-contained handover from this conversation: the user's goal and latest instructions, constraints and decisions, files/branches changed, checks and results, unfinished work, blockers, and concrete next steps. Include the working directory and any operations still running. Distinguish facts from assumptions. Tell the receiving agent to continue the user's task from that state, check the workspace first, and preserve existing changes.",
    "Before delivery, run hc wait " + to + " --timeout 60, then hc get " + to + " --json. Send only when the destination is live and reports idle or done. If it is blocked, has exited, or is not ready, report the blocker here; do not use --force or bypass a dialog.",
    "Deliver it as a Herdr message with hc send " + to + " (quote it safely), in exactly this form, the summary in place of SUMMARY:\n" + head + "\nSUMMARY\n" + tail + "\nUse Herdr Core's native messaging, not simulated keys or a handover file.",
    ...(target.task ? ["Additional instructions from the user for the receiving agent (put them inside the message):\n" + target.task] : []),
    "This turn is for the handover only. Do not start other agents or continue editing. Keep this source session open; after sending, briefly confirm delivery here and wait. If send fails, inspect the destination before retrying because a message may have arrived."
  ].join("\n\n");
}

export async function start(source, target) {
  const installed = source.catalog.find((a) => a.key === target.key && a.installed);
  if (!installed || !Array.isArray(target.argv) || !target.argv.length) throw new Error(target.name + " is no longer available on this machine.");
  if (source.agent.key === target.key) {
    const plan = await nativePlan(source, target);
    await split(source, plan.argv);
    return { guessed: plan.guessed };
  }
  if (["blocked", "error"].includes(source.terminal.status?.state)) throw new Error("The source agent needs attention. Resolve its dialog or error, then open Fork again.");
  // A blank receiver is intentional: the source supplies its real context.
  // hc send handles the source's draft and working state; never force it.
  const argv = [...target.argv];
  if (target.key === "codex" && !argv.includes("--no-daemon")) argv.push("--no-daemon");
  const opened = await split(source, argv);
  try {
    checked(await exec("hc", ["send", source.pane.terminal, handoverMessage(source, target, opened.terminal), "--json"],
      { timeout: 120000 }), "The handover request could not be delivered");
  } catch (e) {
    throw new Error(target.name + " is open in " + opened.terminal + ", but the handover request was not confirmed: " + e.message + ". Check the source and new pane before retrying.");
  }
  return { handover: true, terminal: opened.terminal };
}
