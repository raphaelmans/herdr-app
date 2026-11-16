#!/bin/sh
# Tell the Herdr desktop app that this Cursor Agent session is an agent.
#
# Herdr lists a terminal as an agent only after the program reports status
# (OSC 7501). The `agent` and `cursor` CLIs are a node process whose argv0
# is the script name, and they never send that sequence, so a live session
# stays at "0 agents".
#
# A hook has no controlling terminal of its own. The report is written to
# an ancestor's tty, which is the Herdr pane. Herdr's TUI integration is a
# different path (HERDR_ENV / HERDR_SOCKET_PATH) and is left alone.
#
# Usage: herdr-app-status.sh <idle|working|done|blocked|error|clear> [continue]
# `continue` prints the beforeSubmitPrompt allow response.

state=${1:-idle}
reply=${2:-}

emit_reply() {
  if [ "$reply" = "continue" ]; then
    printf '%s\n' '{"continue":true}'
  else
    printf '%s\n' '{}'
  fi
}

if [ -z "${HC_TERMINAL_ID:-}" ]; then
  emit_reply
  exit 0
fi

case $state in
  idle|working|done|blocked|error|clear) ;;
  *)
    emit_reply
    exit 0
    ;;
esac

find_tty() {
  pid=$$
  i=0
  while [ "$i" -lt 12 ]; do
    t=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d '[:space:]')
    case $t in
      ""|??|-|"?") ;;
      *)
        if [ -w "/dev/$t" ]; then
          printf '%s' "/dev/$t"
          return 0
        fi
        ;;
    esac
    next=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d '[:space:]')
    if [ -z "$next" ] || [ "$next" = "$pid" ] || [ "$next" = 0 ] || [ "$next" = 1 ]; then
      break
    fi
    pid=$next
    i=$((i + 1))
  done
  return 1
}

tty=$(find_tty) || {
  emit_reply
  exit 0
}
printf '\033]7501;state=%s:app=cursor-agent\033\\' "$state" >"$tty" 2>/dev/null || true
emit_reply
exit 0
