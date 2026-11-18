// The reference text: what Copy reference puts on the clipboard. Plain data in,
// text out, so it can be tested without Herdr (reference.test.js).
// Terms: GLOSSARY.md (Address, Reference, Message).

// Leading status glyphs agents put in titles: spinners (braille), ✳, ●, emoji.
const TITLE_NOISE = /^[⠀-⣿✀-➿☀-⛿■-◿•·*\p{Extended_Pictographic}️\s]+/u;

const cleanTitle = (t) => (t ?? "").replace(TITLE_NOISE, "").trim();

// Attribute values, escaped as the Agent hub's tags escape them.
const attr = (s) => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// pane: { address, title, agent: string | null (null for a shell or another program),
//         program: string, space: string, tab: number | null,
//         machine: string | null, core: string (the source core's permanent ID) }
export function reference({ address, title, agent, program, space, tab, machine, core }) {
  const name = cleanTitle(title);
  const where = [space, tab].filter((x) => x != null && x !== "").join(" / ");
  const attrs = [`to="${attr(address)}"`];
  if (name) attrs.push(`name="${attr(name)}"`);
  attrs.push(`agent="${attr(agent ?? program ?? "shell")}"`);
  if (where) attrs.push(`where="${attr(where)}"`);
  if (machine) attrs.push(`machine="${attr(machine)}"`);
  attrs.push(`core="${attr(core)}"`);
  const id = address.split("/").pop();
  const kind = (agent ? "Another agent in Herdr" : "A terminal in Herdr") + (machine ? ` on ${machine}` : "");
  const route = `If hc server status --json shows core.id ${core}, set target=${id}. Otherwise find that id in hc machine ls --json and set target=NAME/${id} using its name on your machine. If the core is unreachable, ask how to reach it.`;
  const read = 'Read its screen with hc read "$target" --lines 400';
  // A shell has nobody to answer a message, so only reading is offered.
  const ask = agent ? ` · ask it with hc send "$target" '<herdr-message from="YOUR_ADDRESS">your question</herdr-message>' (your local address is $HC_TERMINAL_ID)` : "";
  return `<herdr-ref ${attrs.join(" ")}/>\n${kind}. Act only when asked. ${route} ${read}${ask}\n`;
}

// The toast line: the address, and the title unless the curtain is drawn.
export function toastBody({ address, title }, veiled) {
  const name = cleanTitle(title);
  return veiled || !name ? address : `${address} · ${name}`;
}
