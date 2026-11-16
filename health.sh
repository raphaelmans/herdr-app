#!/bin/sh
# health.sh: looks for every requirement of the mods that are on, without Herdr
# running. The Health page of Config (mods/config/health.js) draws this same
# check. Terms: GLOSSARY.md (requirement, owner, mod spec).
#
#   ./health.sh          a line per requirement, then a summary
#   ./health.sh --json   the same rows as JSON, for the Health page and scripts
# Exit: 0 everything needed is here, 1 something needed is missing, 2 could not check.
#
# What is looked for comes from two places:
#   mods/config/requirements.json   each program: name, bin or app, owner, fix
#   mods/<mod>/mod.json "spec"      which a mod needs, and which are extras:
#     "spec": { "needs": ["nvim"], "extras": ["jq"],
#               "for": { "<another mod>": { "needs": [...], "extras": [...] } } }
#   "for" speaks for a mod whose files are not ours to change (vendored, shipped).
#
# Owners and fixes follow the toolchain standard (github.com/raphaelmans/toolchain)
# when it is on this computer: `toolchain` on PATH, else a checkout at
# $TOOLCHAIN_HOME or ~/toolchain. A requirement whose program that catalog gives
# to mise or a package manager takes its owner and install command from there;
# requirements.json holds a copy for a machine without it, and one the two
# disagree on is listed as drift. Programs the standard has no command for
# (built here, apps, vendor installers) keep what requirements.json says.
#
# Only mods in mods/ count: one that is off (mods-disabled/) asks for nothing.
# A row's state: ok, missing (needed, not here), extra (one feature wants it,
# not here), route (works, but its owner did not install it), off (no mod that is on asks).

root=$(cd "$(dirname "$0")" && pwd)
catalog="$root/mods/config/requirements.json"
json=0
case "${1:-}" in
  --json) json=1 ;;
  "") ;;
  *) sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

command -v jq >/dev/null 2>&1 || { echo "health.sh: jq is not here, and it reads the mod specs. Get it with: mise use --global jq@1 (or brew install jq)" >&2; exit 2; }
[ -r "$catalog" ] || { echo "health.sh: $catalog is not there" >&2; exit 2; }

# Each mod that is on, with its spec.
specs=$(for f in "$root"/mods/*/mod.json; do
  [ -r "$f" ] || continue
  mod=$(basename "$(dirname "$f")")
  jq -c --arg mod "$mod" '{mod: $mod, spec: (.spec // {})}' "$f" 2>/dev/null || printf '{"mod":"%s","spec":{}}\n' "$mod"
done | jq -sc '.')

tmp=$(mktemp -d) || exit 2
trap 'rm -rf "$tmp"' EXIT

# The toolchain standard's catalog for this platform, [] when it is not here.
standard='[]'; from=""
if command -v toolchain >/dev/null 2>&1 && out=$(toolchain catalog --json 2>/dev/null); then
  standard=$out; from=$(command -v toolchain)
else
  dir=${TOOLCHAIN_HOME:-$HOME/toolchain}
  if [ -d "$dir/toolchain" ] && out=$(cd "$dir" && python3 -m toolchain catalog --json 2>/dev/null); then standard=$out; from=$dir; fi
fi
printf '%s' "$standard" | jq -e 'type == "array"' >/dev/null 2>&1 || { standard='[]'; from=""; }
printf '%s' "$standard" > "$tmp/standard"

# id|kind|where|flag for each requirement, then one background probe each.
jq -r 'to_entries[] | [.key, (if .value.app then "app" else "bin" end),
  ((.value.app // .value.bin) | sub("^~"; env.HOME)), (.value.flag // "" | if . == "" then "-" else . end)] | join("|")' "$catalog" > "$tmp/list" || exit 2

# A personal bin directory may link to its owner's installation. Follow links
# for ownership without losing the PATH entry that actually launches the tool.
resolve_path() (
  path=$1; links=0
  while [ -L "$path" ]; do
    [ "$links" -lt 40 ] || exit 1
    target=$(readlink "$path") || exit 1
    case "$target" in
      /*) path=$target ;;
      *) path=$(dirname "$path")/$target ;;
    esac
    links=$((links + 1))
  done
  directory=$(cd -P "$(dirname "$path")" && pwd) || exit 1
  printf '%s/%s\n' "$directory" "$(basename "$path")"
)

while IFS='|' read -r id kind where flag; do
  (
    if [ "$kind" = app ]; then
      [ -d "$where" ] && printf '%s\t%s\t%s\n' "$id" "$where" "$(defaults read "$where/Contents/Info" CFBundleShortVersionString 2>/dev/null)"
    else
      p=$(command -v "$where" 2>/dev/null) || exit 0
      v=""; [ "$flag" != "-" ] && v=$("$where" "$flag" 2>&1 </dev/null | head -n 1)
      resolved=$(resolve_path "$p") || resolved=""
      printf '%s\t%s\t%s\t%s\n' "$id" "$p" "$v" "$resolved"
    fi
  ) > "$tmp/$id.out" 2>/dev/null &
done < "$tmp/list"
wait
cat "$tmp"/*.out > "$tmp/found" 2>/dev/null

rows=$(jq -n --slurpfile catalog "$catalog" --argjson specs "$specs" --rawfile found "$tmp/found" --slurpfile standard "$tmp/standard" --arg from "$from" '
  ($specs | map(.mod)) as $on
  # the standard, by program name, for the owners that have an install command
  | ($standard[0] | map(select((.command // "") != "" and (.requires_verification | not) and (.owner | IN("mise", "brew", "pacman")))
      | {key: .command, value: {owner: .owner, fix: (if .owner == "mise" then "mise use --global \(.spec)@\(.pin)" elif .owner == "brew" then "brew install \(.spec)" else "sudo pacman -S --needed \(.spec)" end)}})
     | from_entries) as $std
  | ($found | split("\n") | map(select(length > 0) | split("\t")) | map({key: .[0], value: {path: (.[1] // ""), said: (.[2] // ""), resolved: (.[3] // "")}}) | from_entries) as $hit
  # $asks: every (mod, requirement, needed) a spec states, "for" included when that mod is on;
  # $unknown: one no catalog entry describes
  | [ $specs[] | .mod as $m | .spec as $s
      | ( {mod: $m, s: $s}, ( ($s.for // {}) | to_entries[] | select(.key as $k | $on | index($k)) | {mod: .key, s: .value} ) )
      | .mod as $mod | .s as $sp
      | ( ($sp.needs // [])[] | {mod: $mod, id: ., needed: true} ), ( ($sp.extras // [])[] | {mod: $mod, id: ., needed: false} ) ] as $asks
  | ( [ $asks[] | select(.id as $i | $catalog[0] | has($i) | not) | .id ] | unique ) as $unknown
  | [ $catalog[0] | to_entries[] | .key as $id | .value as $own
      | ($std[($own.bin // "") | split("/") | last // ""]) as $s
      | (if $s then $own + $s else $own end) as $r
      | [ $asks[] | select(.id == $id) ] as $a
      | ($a | map(.mod) | unique) as $users
      | (($r.all == "needed") or ($a | any(.needed))) as $needed
      | ($hit[$id] // {path: "", said: ""}) as $h
      | { id: $id, name: $r.name, owner: ($r.owner // ""), needed: $needed, mods: $users, all: ($r.all != null),
          why: ($r.why // ""), fix: ($r.fix // ""), path: $h.path, standard: ($s != null),
          drift: ($s != null and (($own.owner // "") != $s.owner or ($own.fix // "") != $s.fix)),
          version: (([ $h.said | scan("[0-9]+\\.[0-9]+(?:\\.[0-9]+)?") ] | first) // ""),
          state: ( if ($r.all == null) and ($users | length) == 0 then "off"
                   elif $h.path == "" then (if $needed then "missing" else "extra" end)
                   elif $r.owner == "mise" and ([$h.path, ($h.resolved // "")] | any(test("/mise/")) | not) then "route"
                   else "ok" end ) } ]
  | { rows: ., unknown: $unknown, standard: (if $from == "" then null else $from end) }') || { echo "health.sh: could not read the specs" >&2; exit 2; }

missing=$(printf '%s' "$rows" | jq '[.rows[] | select(.state == "missing")] | length')

if [ "$json" = 1 ]; then
  printf '%s\n' "$rows"
else
  printf '%s' "$rows" | jq -r --arg home "$HOME" '
    def short: if startswith($home) then "~" + .[($home | length):] else . end;
    def pad($n): . + (" " * ([$n - length, 0] | max));
    (.rows[] |
      ({ok: "ok     ", missing: "MISSING", extra: "extra  ", route: "route  ", off: "off    "}[.state]) + "  " + (.name | pad(20)) +
      ( if .state == "ok" then ([.version, .owner] | map(select(. != "")) | join(" · ") | pad(22)) + (.path | short)
        elif .state == "off" then "no mod that is on asks for it"
        elif .state == "route" then "at " + (.path | short) + ", but " + .owner + " owns it:  " + .fix
        else "not found; without it, no " + .why + (if (.mods | length) > 0 then " (" + (.mods | join(", ")) + ")" else "" end) + ":  " + .fix end )),
    (.unknown[] | "?        " + . + ": a mod spec names it, but mods/config/requirements.json does not describe it"),
    (.rows[] | select(.drift) | "drift    " + (.name | pad(20)) + "requirements.json no longer matches the toolchain standard; the standard is shown. Update the copy."),
    "",
    ( [.rows[] | .state] as $s
      | ($s | map(select(. == "missing")) | length) as $m | ($s | map(select(. == "extra")) | length) as $e
      | ($s | map(select(. == "route")) | length) as $r | ($s | map(select(. == "ok")) | length) as $k
      | (if $m > 0 then "\($m) needed missing" else "Everything needed is here" end)
        + (if $e > 0 then " · \($e) extra missing" else "" end)
        + (if $r > 0 then " · \($r) off their route" else "" end) + " · \($k) fine" ),
    ( if .standard then "Owners and fixes follow the toolchain standard at " + (.standard | short)
      else "The toolchain standard is not on this computer, so owners and fixes are this repo\u0027s copy. Get it: git clone git@github.com:raphaelmans/toolchain.git ~/toolchain" end )'
fi
[ "$missing" -eq 0 ]
