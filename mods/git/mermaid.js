// Mermaid diagrams for the markdown popup, rendered by Pele (./pele.js).
//
// Pele returns an SVG whose colors are CSS variables (--pele-bg, ...) and
// color-mix() expressions. The app draws SVGs as images, which don't run CSS,
// so `bake` swaps every variable for a real color from the Herdr theme
// before the file is written.

import { render } from "./pele.js";

// Markdown text split into [{kind: "md", text} | {kind: "mermaid", text}].
export function splitMermaid(text) {
  const out = [];
  let md = [];
  let fence = null;
  let code = [];
  const flush = () => {
    if (md.length) out.push({ kind: "md", text: md.join("\n") });
    md = [];
  };
  for (const line of text.split("\n")) {
    if (fence) {
      if (line.trim().startsWith(fence) && line.trim().replace(/[`~]/g, "") === "") {
        out.push({ kind: "mermaid", text: code.join("\n") });
        fence = null;
        code = [];
      } else code.push(line);
      continue;
    }
    const open = /^\s{0,3}(`{3,}|~{3,})\s*mermaid\s*$/i.exec(line);
    if (open) {
      flush();
      fence = open[1];
      continue;
    }
    md.push(line);
  }
  if (fence) md.push("```mermaid", ...code); // unclosed: show as text
  flush();
  return out;
}

// --pele-* names → Herdr theme colors.
function palette(t) {
  return {
    "--pele-bg": t.background,
    "--pele-fg": t.foreground,
    "--pele-muted": t.muted,
    "--pele-line": t.foreground,
    "--pele-surface": t.raised ?? t.surface,
    "--pele-surface-alt": t.hover ?? t.selected,
    "--pele-border": t.border,
    "--pele-accent": t.accent,
    "--pele-error": t.blocked ?? t.ansi1,
    "--pele-critical": t.blocked ?? t.ansi1,
    "--pele-fg-on-light": "#1f1f1f",
    "--pele-fg-on-dark": "#f5f5f5",
    "--pele-series-1": t.ansi4, "--pele-series-2": t.ansi2, "--pele-series-3": t.ansi3,
    "--pele-series-4": t.ansi5, "--pele-series-5": t.ansi6, "--pele-series-6": t.ansi1,
    "--pele-series-7": t.ansi12, "--pele-series-8": t.ansi10,
  };
}

function parseColor(c) {
  c = c.trim();
  let m = /^#([0-9a-f]{3,8})$/i.exec(c);
  if (m) {
    let h = m[1];
    if (h.length <= 4) h = [...h].map((x) => x + x).join("");
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  }
  m = /^rgba?\(([^)]*)\)$/i.exec(c);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    return [p[0], p[1], p[2], p[3] ?? 1];
  }
  if (c === "transparent") return [0, 0, 0, 0];
  return null;
}

const hex = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
const toCss = ([r, g, b, a]) => `#${hex(r)}${hex(g)}${hex(b)}${a < 1 ? hex(a * 255) : ""}`;

// color-mix(in srgb, A p%, B q%) with plain colors.
function mix(args) {
  const parts = args.split(/,(?![^(]*\))/).map((s) => s.trim());
  const [, a, b] = parts;
  const side = (s) => {
    const m = /^(.*?)\s+([\d.]+)%$/.exec(s);
    return m ? [m[1], parseFloat(m[2]) / 100] : [s, null];
  };
  let [ca, pa] = side(a ?? "");
  let [cb, pb] = side(b ?? "");
  if (pa == null && pb == null) pa = pb = 0.5;
  else if (pa == null) pa = 1 - pb;
  else if (pb == null) pb = 1 - pa;
  const A = parseColor(ca), B = parseColor(cb);
  if (!A || !B) return ca;
  const sum = pa + pb || 1;
  return toCss(A.map((v, i) => (v * pa + B[i] * pb) / sum));
}

// The SVG with every var() and color-mix() resolved.
function bake(svg, t) {
  const vars = { ...palette(t) };
  for (const k of Object.keys(vars)) if (!vars[k]) delete vars[k];
  // Custom properties declared in style attributes (--_bg:var(--pele-bg,#fff)).
  for (const [, body] of svg.matchAll(/style="([^"]*)"/g)) {
    for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*((?:[^;()]|\([^()]*(?:\([^()]*\))*[^()]*\))*)/g)) {
      if (!(name in vars) || name.startsWith("--_")) vars[name] = value.trim();
    }
  }
  const resolve = (s, depth = 0) => {
    if (depth > 12) return s;
    const next = s.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (_, name, fb) =>
      vars[name] != null ? vars[name] : (fb ?? "").trim(),
    );
    return next === s ? s : resolve(next, depth + 1);
  };
  for (const k of Object.keys(vars)) vars[k] = resolve(vars[k]);
  let out = resolve(svg);
  out = out.replace(/color-mix\(((?:[^()]|\([^()]*\))*)\)/g, (_, args) => mix(args));
  // Drop the now-unused declarations, and give rounded corners a real attribute.
  out = out.replace(/style="([^"]*)"/g, (_, body) => {
    const kept = body.split(";").filter((d) => d.trim() && !d.trim().startsWith("--"));
    return kept.length ? `style="${kept.join(";")}"` : "";
  });
  out = out.replace(/<rect([^>]*?)\sstyle="rx:([\d.]+)px"/g, '<rect$1 rx="$2"');
  return out;
}

// {svg, width, height} or {error}.
export function renderMermaid(source, t, font) {
  try {
    const r = render(source, { responsive: false, fontFamily: font, padding: 8 });
    return { svg: bake(r.svg, t), width: r.width, height: r.height };
  } catch (e) {
    return { error: e?.message ?? String(e) };
  }
}
