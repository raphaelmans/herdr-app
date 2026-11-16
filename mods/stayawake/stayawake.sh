#!/usr/bin/env bash
# stayawake: keep this Mac awake, on battery or charger. Bundled with the
# Herdr `stayawake` mod (main.js beside it), and usable from a shell as well.
#
# Usage: stayawake on [--keep-awake] | off | state | status
#
# Awake is one `caffeinate -dimsu`, which needs no password. Staying awake with
# the lid closed is `pmset disablesleep 1`, which needs root: asked with sudo in
# a terminal, with the system's password dialog anywhere else (the mod).

set -euo pipefail

KEEP='caffeinate -dimsu'

usage() {
  echo "Usage: stayawake on [--keep-awake] | off | state | status"
  echo
  echo "  on               Keep awake with the lid open; closing it allows sleep"
  echo "  on --keep-awake  Keep running even with the lid closed, including on battery"
  echo "  off              Restore normal sleep behavior"
  echo "  state            One word: off, on, or lid (awake with the lid closed)"
  echo "  status           Show current sleep settings and caffeinate processes"
}

# 1 while sleep is disabled outright (lid closed included), else 0.
lid() {
  pmset -g | awk 'tolower($1) == "sleepdisabled" || tolower($1) == "disablesleep" { v = $2 } END { print v + 0 }'
}

# Asks for root only when the setting really changes.
set_lid() {
  [[ "$(lid)" == "$1" ]] && return 0
  if sudo -n /usr/bin/pmset -a disablesleep "$1" 2>/dev/null; then return 0; fi
  if [[ -t 0 ]]; then
    sudo /usr/bin/pmset -a disablesleep "$1"
  else
    osascript -e "do shell script \"/usr/bin/pmset -a disablesleep $1\" with prompt \"Stay awake changes whether this Mac sleeps with the lid closed.\" with administrator privileges" > /dev/null
  fi
}

awake() { pgrep -xf "$KEEP" > /dev/null; }

case "${1:-}" in
  on)
    want=0
    if [[ $# -eq 2 && "$2" == "--keep-awake" ]]; then want=1
    elif [[ $# -ne 1 ]]; then usage >&2; exit 1
    fi
    set_lid "$want"
    if ! awake; then
      nohup $KEEP > /dev/null 2>&1 < /dev/null &
      disown
    fi
    if [[ "$want" -eq 1 ]]; then
      echo "Stay-awake: ON — keeps running with the lid CLOSED, on battery or charger"
    else
      echo "Stay-awake: ON — closing the lid allows sleep, on battery or charger"
    fi
    ;;
  off)
    [[ $# -eq 1 ]] || { usage >&2; exit 1; }
    set_lid 0
    # Only our own: other programs' caffeinate (timed ones) are left alone.
    pkill -xf "$KEEP" 2>/dev/null || true
    echo "Stay-awake: OFF"
    ;;
  state)
    if [[ "$(lid)" == 1 ]]; then echo lid
    elif awake; then echo on
    else echo off
    fi
    ;;
  status)
    echo "--- pmset ---"
    pmset -g | grep -Ei 'disablesleep|SleepDisabled' || echo "disablesleep: not set"
    echo "--- caffeinate ---"
    pgrep -lf caffeinate || echo "caffeinate not running"
    ;;
  -h|--help) usage ;;
  *) usage >&2; exit 1 ;;
esac
