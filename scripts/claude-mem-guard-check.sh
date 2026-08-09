#!/usr/bin/env bash
# Verify every claude-mem hook command still starts with the env-gate prefix.
# Run after `npx claude-mem upgrade` to detect re-patch needed.
#
# Usage:
#   scripts/claude-mem-guard-check.sh                    # uses default hooks.json
#   scripts/claude-mem-guard-check.sh /path/to/hooks.json
#
# Exit 0 = all hooks gated. Exit 1 = at least one missing gate.

set -euo pipefail

HOOKS_JSON="${1:-/Users/butterfly/.claude/plugins/marketplaces/thedotmack/plugin/hooks/hooks.json}"
GATE_TOKEN='CLAUDE_MEM_ENABLE'

if [ ! -f "$HOOKS_JSON" ]; then
  echo "ERROR: hooks.json not found at $HOOKS_JSON" >&2
  exit 1
fi

TOTAL=$(jq -r '[.hooks | to_entries[] | .value[] | .hooks[]] | length' "$HOOKS_JSON")
GATED=$(jq -r --arg t "$GATE_TOKEN" '[.hooks | to_entries[] | .value[] | .hooks[] | select(.command | startswith("[ -z \"$" + $t + "\" ]"))] | length' "$HOOKS_JSON")

if [ "$TOTAL" -eq 0 ]; then
  echo "ERROR: no hook commands found in $HOOKS_JSON" >&2
  exit 1
fi

if [ "$GATED" -ne "$TOTAL" ]; then
  MISSING=$((TOTAL - GATED))
  echo "ERROR: $MISSING of $TOTAL hook command(s) missing env-gate prefix"
  echo "Re-patch with:"
  echo "  jq '.hooks |= with_entries(.value |= map(.hooks |= map(.command = \"[ -z \\\"\$$GATE_TOKEN\\\" ] && exit 0\\n\" + .command)))' $HOOKS_JSON > $HOOKS_JSON.new && mv $HOOKS_JSON.new $HOOKS_JSON"
  exit 1
fi

echo "OK: $GATED/$TOTAL hook commands env-gated"
