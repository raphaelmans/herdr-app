#!/bin/sh
# OpenCode merges inline settings with user, project and organization settings.
# Keep provider credentials available and give Lific its normal configuration.
set -eu
session_dir=$(cd "$(dirname "$0")" && pwd -P)
OPENCODE_CONFIG_CONTENT=$(jq -cn --arg bin "$1" --arg config "${XDG_CONFIG_HOME:-$HOME/.config}" \
  --arg hook "$session_dir/opencode-status.js" --rawfile prompt "$session_dir/system-prompt.md" \
  --rawfile skill "$session_dir/plugin/skills/lific/SKILL.md" '{
  mcp: {lific: {type: "local", command: [$bin, "mcp"], enabled: true, environment: {XDG_CONFIG_HOME: $config}}},
  permission: {"*": "deny", "lific_*": "allow"},
  plugin: ["file://" + ($hook | split("/") | map(@uri) | join("/"))],
  agent: {build: {prompt: ($prompt + "\n" + $skill), options: {}, permission: {}}}, default_agent: "build"
}')
shift
unset OPENCODE_CONFIG OPENCODE_CONFIG_DIR OPENCODE_PERMISSION OPENCODE_TUI_CONFIG
export OPENCODE_CONFIG_CONTENT OPENCODE_DISABLE_PROJECT_CONFIG=1 OPENCODE_DISABLE_CLAUDE_CODE=1 OPENCODE_DISABLE_EXTERNAL_SKILLS=1
export OPENCODE_TEST_HOME="$PWD" XDG_CONFIG_HOME="$PWD/.config"

# Account or managed settings can still merge after local configuration. Check
# the effective tools before launching an interactive session with them.
if ! opencode --pure debug config | jq -es '
  (env.OPENCODE_CONFIG_CONTENT | fromjson) as $wanted
  | length == 1 and (.[0] | .mcp == $wanted.mcp and .permission == $wanted.permission
    and .plugin == $wanted.plugin and .agent == $wanted.agent and .default_agent == "build"
    and ((.mode // {}) | length == 0))
' >/dev/null; then
  echo "OpenCode could not start with only Lific tools. Check its effective MCP and agent settings." >&2
  exit 1
fi
# The TUI needs our status hook to acknowledge a turn to herdr-core.
unset OPENCODE_PURE
exec opencode "$@"
