// Only the last path component is completed. Keep the spelling of its parent
// (~/, ../, absolute, or relative) when inserting a directory.
export const FOLDER_LIMIT = 100;

export function folderQuery(value) {
  if (value === "~" || value === "." || value === "..") return { literal: `${value}/` };
  const end = value.lastIndexOf("/") + 1;
  return { parent: value.slice(0, end), name: value.slice(end) };
}

// Paths are positional arguments, never shell source. Quoting the prefix keeps
// spaces, quotes, glob characters and command substitutions literal. A trailing
// slash includes directory symlinks and excludes files. NUL preserves names.
const DIRECTORIES = `dir=$1; prefix=$2; limit=$3
case $dir in "~"|"~/") dir=$HOME ;; "~/"*) dir=$HOME/\${dir#"~/"} ;; esac
case $dir in /*) ;; *) dir=./$dir ;; esac
CDPATH= cd "$dir" 2>/dev/null || { printf '%s' 'Could not read this folder.' >&2; exit 1; }
[ -r . ] && [ -x . ] || { printf '%s' 'Could not read this folder.' >&2; exit 1; }
count=0
for entry in ./"$prefix"*/; do
  [ -d "$entry" ] || continue
  name=\${entry#./}; name=\${name%/}
  case $name in .|..) continue ;; esac
  printf '%s\\0' "$name"
  count=$((count + 1))
  [ "$count" -ge "$limit" ] && break
done
exit 0`;

export async function folderSuggestions(value, exec, options) {
  const query = folderQuery(value);
  if (query.literal) return { items: [{ label: query.literal, value: query.literal }], more: false };
  const result = await exec("sh", ["-c", DIRECTORIES, "herdr-folders", query.parent || ".", query.name, String(FOLDER_LIMIT + 1)],
    { ...options, timeout: 5000 });
  if (result.code !== 0) throw new Error(result.stderr.trim() || "Could not read this folder.");
  const names = result.stdout.split("\0").filter(Boolean);
  return {
    items: names.slice(0, FOLDER_LIMIT).map(name => ({ label: `${name}/`, value: `${query.parent}${name}/` })),
    more: names.length > FOLDER_LIMIT,
  };
}
