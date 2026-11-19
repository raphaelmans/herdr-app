// An agent's own title: what the agent CLI sets as its terminal's title,
// whichever CLI it is. "" when the title tells nothing about the work: only
// the program's name, a folder, or user@host.
//
// CLIs dress it up differently: Claude Code puts a status glyph in front
// ("✳ Fix login"); Grok wraps it in a spinner, a status and its own name
// ("⠹ - Waiting for response… - Fix login - grok"). Of " - " parts, the
// program's name is dropped and the longest left is the title.

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").replace(/[\s\-–—·|]+$/u, "").trim();

export function agentTitle(title, program) {
  const raw = (title ?? "").trim();
  // A folder: test with only the status glyph gone (clean would strip ~ or /).
  if (!raw || /^[~/]|^[A-Za-z]:\\/.test(raw.replace(/^[^\p{L}\p{N}~/]+/u, ""))) return "";
  const names = [program?.name, program?.key].filter(Boolean).map((n) => n.toLowerCase());
  const parts = raw.split(/\s+[-–—|]\s+/).map(clean).filter((p) => p && !names.includes(p.toLowerCase()));
  const best = parts.reduce((a, b) => (b.length > a.length ? b : a), "");
  if (!best || best.includes("@")) return "";
  return best;
}
