// Project icons. Lific keeps a project's icon in its `emoji` field: an emoji,
// `lucide:<Name>` (a Lucide icon, picked in Lific's web UI) or `lific:logo`.
// Printing that field as text shows "lucide:Radar". An emoji is drawn as text.
// A Lucide icon is drawn from the fork's own copy of Lucide
// (web/node_modules/lucide, there once the web UI is built) and kept as an
// SVG under data/lific/icons/, so each icon is made once per machine.
// Anything else draws nothing.

import { appHome, exec, home, readTextFile, writeTextFile } from "herdr";

const DIR = "data/lific/icons";
const lucide = () => `${home()}/Documents/Coding/2026/lific/web/node_modules/lucide/dist/esm`;

// { kind: "emoji", text } | { kind: "lucide", name } | null
export function icon(value) {
  const v = String(value ?? "").trim();
  if (!v || v.startsWith("lific:")) return null;
  const m = v.match(/^lucide:([A-Za-z0-9]+)$/);
  if (m) return { kind: "lucide", name: m[1] };
  if (v.includes(":")) return null; // another provider's name: no text for it
  return { kind: "emoji", text: v };
}

// Lucide's icon node, `[["path", { d: "…" }], …]`, as an SVG drawn in the text color.
function draw(source) {
  const body = source.match(/=\s*(\[[\s\S]*?\]);/)?.[1];
  if (!body) return null;
  let nodes;
  try { nodes = JSON.parse(body.replace(/([{,]\s*)([A-Za-z][\w-]*)\s*:/g, '$1"$2":')); } catch { return null; }
  const attr = (a) => Object.entries(a).map(([k, v]) => `${k}="${String(v).replace(/"/g, "&quot;")}"`).join(" ");
  const inner = nodes.map(([tag, a]) => `<${tag} ${attr(a ?? {})}/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>\n`;
}

// The icon's SVG, relative to the app's folder (what svg() takes), or null when
// it can't be had. Made once and kept.
export async function lucideSvg(name) {
  if (!/^[A-Za-z0-9]+$/.test(name)) return null;
  const rel = `${DIR}/${name}.svg`, abs = `${appHome()}/${rel}`;
  if (await readTextFile(abs).catch(() => null)) return rel;
  // Lucide's index names each icon's file (one line, not the whole index: ADR 0006).
  const r = await exec("grep", ["-h", "-m", "1", `default as ${name} }`, `${lucide()}/lucide.js`], { timeout: 5000 }).catch(() => null);
  const file = r?.stdout.match(/from '\.\/(icons\/[a-z0-9-]+\.js)'/)?.[1];
  if (!file) return null;
  const svgText = draw(await readTextFile(`${lucide()}/${file}`).catch(() => null) ?? "");
  if (!svgText) return null;
  await exec("mkdir", ["-p", `${appHome()}/${DIR}`]).catch(() => null);
  try { await writeTextFile(abs, svgText, null); } catch { if (!(await readTextFile(abs).catch(() => null))) return null; }
  return rel;
}
