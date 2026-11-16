// Sets or removes one key of a TOML file as text, leaving every other line,
// comment and blank line as it was. Not a TOML parser: it knows [table]
// headers, `key = value` lines and multi-line strings, which is what
// worktrunk's config uses. The caller has worktrunk read the result back
// before it is written (./worktrunk.js), so a file it gets wrong is never saved.

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// A value as TOML: true/false, a "basic string", or a """multi-line""" one.
export const toml = (v) => typeof v === "boolean" ? String(v)
  : v.includes("\n") ? `"""\n${v.replace(/\\/g, "\\\\").replace(/"""/g, '""\\"')}\n"""`
  : JSON.stringify(v);

// Per line: `header` (the table it opens, "[[" for an array of tables) and
// `inside` (a later line of a multi-line string).
function scan(lines) {
  const marks = [];
  let open = null;
  for (const line of lines) {
    if (open) { marks.push({ inside: true }); if (line.includes(open)) open = null; continue; }
    const head = line.match(/^\s*(\[\[?)([^\[\]]+)\]\]?\s*(#.*)?$/);
    if (head) { marks.push({ header: head[1] === "[[" ? "[[" : head[2].replace(/\s+/g, "") }); continue; }
    const start = line.match(/^\s*[^=#]+=\s*("""|''')(.*)$/);
    if (start && !start[2].includes(start[1])) open = start[1];
    marks.push({});
  }
  return marks;
}

const finish = (lines) => {
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  while (lines.length && !lines[0].trim()) lines.shift();
  return lines.length ? `${lines.join("\n")}\n` : "";
};

// `section`: a table name ("commit.generation"), "" for the top of the file.
// `value`: boolean or string; null removes the key, and a table left empty.
export function edit(text, section, key, value) {
  const lines = text.split("\n");
  const marks = scan(lines);
  const headers = marks.flatMap((m, i) => (m.header ? [i] : []));
  const line = value === null ? [] : `${key} = ${toml(value)}`.split("\n");
  let from = 0, to = headers[0] ?? lines.length;
  if (section) {
    const at = headers.find((i) => marks[i].header === section);
    if (at === undefined) {
      if (value === null) return text;
      while (lines.length && !lines.at(-1).trim()) lines.pop();
      return finish([...lines, ...(lines.length ? [""] : []), `[${section}]`, ...line]);
    }
    from = at + 1;
    to = headers.find((i) => i > at) ?? lines.length;
  }
  const is = new RegExp(`^\\s*(?:${esc(key)}|"${esc(key)}"|'${esc(key)}')\\s*=`);
  let at = -1;
  for (let i = from; i < to; i++) if (!marks[i].inside && is.test(lines[i])) { at = i; break; }
  if (at < 0) {
    if (value === null) return text;
    let i = to;
    while (i > from && !lines[i - 1].trim()) i--;
    lines.splice(i, 0, ...line, ...(i === to && to < lines.length ? [""] : []));
    return finish(lines);
  }
  let end = at;
  while (end + 1 < to && marks[end + 1].inside) end++;
  lines.splice(at, end - at + 1, ...line);
  if (value === null && section) {
    const now = to - (end - at + 1);
    if (lines.slice(from, now).every((l) => !l.trim())) lines.splice(from - 1, now - from + 1);
  }
  return finish(lines);
}
