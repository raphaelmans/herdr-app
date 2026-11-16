// Pure search helpers. Work yields between small batches; cancelled generations
// never publish results. No disk scan or file-content reads while typing.
export function prepare(query) {
  return query.trim().split(/\s+/).filter(Boolean).map(raw => {
    let text = raw, inverse = false, exact = false, prefix = false, suffix = false;
    if (text.startsWith("!")) { inverse = true; exact = true; text = text.slice(1); }
    if (text.startsWith("'")) { exact = true; text = text.slice(1); }
    if (text.startsWith("^")) { prefix = true; exact = true; text = text.slice(1); }
    if (text.endsWith("$")) { suffix = true; exact = true; text = text.slice(0, -1); }
    return { text, inverse, exact, prefix, suffix, sensitive: text !== text.toLowerCase() };
  });
}

export function score(item, terms) {
  let total = 0;
  for (const term of terms) {
    const haystack = term.sensitive ? item.path : item.lower, needle = term.text;
    let value = 0, found = true;
    if (term.exact) {
      const at = term.suffix ? haystack.length - needle.length : haystack.indexOf(needle);
      found = at >= 0 && haystack.slice(at, at + needle.length) === needle && (!term.prefix || at === 0);
      value = 100 + needle.length * 16 + (at >= item.basename ? 16 : 0);
    } else {
      let from = 0, previous = -2;
      for (let i = 0; i < needle.length; i++) {
        const at = haystack.indexOf(needle[i], from);
        if (at < 0) { found = false; break; }
        const boundary = at === 0 || /[\/\\._\-\s]/.test(item.path[at - 1]);
        value += 16 + (boundary ? 12 : 0) + (at === previous + 1 ? 10 : 0) + (at >= item.basename ? 6 : 0);
        if (previous >= 0) value -= Math.min(12, at - previous - 1);
        previous = at; from = at + 1;
      }
    }
    if (term.inverse ? found : !found) return null;
    if (!term.inverse) total += value;
  }
  return total;
}

export async function indexFiles(raw, pause, current) {
  const items = [];
  let offset = 0, end, sliceStart = Date.now();
  while ((end = raw.indexOf("\0", offset)) !== -1) {
    const path = raw.slice(offset, end).replace(/^\.[\/\\]/, "");
    offset = end + 1;
    if (path) items.push({ path, lower: path.toLowerCase(), basename: Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1 });
    if (items.length % 512 === 0 && Date.now() - sliceStart >= 4) {
      await pause(); if (!current()) return null; sliceStart = Date.now();
    }
  }
  return { items, truncated: offset !== raw.length };
}

const better = (a, b) => a.score > b.score || (a.score === b.score &&
  (a.item.path.length < b.item.path.length || (a.item.path.length === b.item.path.length && a.item.path < b.item.path)));

export async function search(items, query, pause, current) {
  const terms = prepare(query);
  if (!terms.length) return current() ? items : null;
  await pause(); if (!current()) return null;
  let sliceStart = Date.now();
  let matches = [];
  for (let start = 0; start < items.length; start += 256) {
    for (let i = start; i < Math.min(start + 256, items.length); i++) {
      const value = score(items[i], terms);
      if (value !== null) matches.push({ item: items[i], score: value });
    }
    if (Date.now() - sliceStart >= 4) {
      await pause(); if (!current()) return null; sliceStart = Date.now();
    }
  }
  // Cooperative merge sort: no unbounded Array.sort blocking the UI thread.
  let buffer = new Array(matches.length), operations = 0;
  for (let width = 1; width < matches.length; width *= 2) {
    for (let start = 0; start < matches.length; start += 2 * width) {
      const mid = Math.min(start + width, matches.length), end = Math.min(start + 2 * width, matches.length);
      let left = start, right = mid;
      for (let out = start; out < end; out++) {
        buffer[out] = right >= end || (left < mid && better(matches[left], matches[right])) ? matches[left++] : matches[right++];
        if (++operations % 2048 === 0 && Date.now() - sliceStart >= 4) {
          await pause(); if (!current()) return null; sliceStart = Date.now();
        }
      }
    }
    [matches, buffer] = [buffer, matches];
  }
  const result = [];
  for (let i = 0; i < matches.length; i++) {
    result.push(matches[i].item);
    if (i % 1024 === 0 && Date.now() - sliceStart >= 4) {
      await pause(); if (!current()) return null; sliceStart = Date.now();
    }
  }
  return current() ? result : null;
}
