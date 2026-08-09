#!/usr/bin/env bash
#
# Switch which Expo account / EAS project the mobile app builds under, to spread
# builds across two free-tier accounts (15 Android builds/mo EACH, reset on the
# 1st). Reads the slot->account map from apps/mobile/eas-accounts.json (the SAME
# file CI's "Select EAS account" step uses), patches apps/mobile/app.json
# `owner` + `extra.eas.projectId` in place, then verifies your eas auth matches.
#
# WHY switching the LOGIN alone is not enough: EAS Free quota is billed to the
# account that OWNS the project (owner + projectId), NOT whoever is logged in.
# So you must switch the project AND auth as that account.
#
# SCOPE — for DEV-phase internal sideload APKs ONLY (matches the CI rotation,
# which is internal-only). Each account's project has its OWN keystore +
# versionCode counter, so cross-account APKs can't upgrade in place (uninstall +
# reinstall). Unify keystores before any public / Play Store release.
#
# Usage (run from anywhere in the repo):
#   scripts/eas/switch-account.sh a        # → account A (xiaocaishen)
#   scripts/eas/switch-account.sh b        # → account B (configure in eas-accounts.json first)
#   scripts/eas/switch-account.sh status   # show current app.json + eas whoami
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_JSON="$ROOT/apps/mobile/app.json"
CFG="$ROOT/apps/mobile/eas-accounts.json"

usage() { echo "usage: $(basename "$0") <a|b|status>" >&2; exit 2; }
[ $# -eq 1 ] || usage
SLOT="$1"

if [ "$SLOT" = "status" ]; then
  echo "app.json:"
  jq -r '"  owner     = \(.expo.owner)\n  projectId = \(.expo.extra.eas.projectId)"' "$APP_JSON"
  if command -v eas >/dev/null 2>&1; then
    echo "eas whoami = $(eas whoami 2>/dev/null || echo '(not logged in)')"
  fi
  exit 0
fi

# --- resolve slot from the shared config (NOT secret; safe to commit) -------
OWNER="$(jq -r --arg s "$SLOT" '.[$s].owner // empty' "$CFG")"
PROJECT_ID="$(jq -r --arg s "$SLOT" '.[$s].projectId // empty' "$CFG")"
TOKEN_SECRET="$(jq -r --arg s "$SLOT" '.[$s].tokenSecret // empty' "$CFG")"

if [ -z "$OWNER" ]; then
  echo "ERROR: unknown slot '$SLOT' in $CFG" >&2
  exit 1
fi
if [ "$OWNER" = "__SET_ME__" ]; then
  echo "ERROR: slot '$SLOT' not configured. Fill owner/projectId in:" >&2
  echo "       $CFG" >&2
  exit 1
fi

# --- patch app.json (jq keeps it valid JSON; sed would not) -----------------
tmp="$(mktemp)"
jq --arg o "$OWNER" --arg p "$PROJECT_ID" \
  '.expo.owner = $o | .expo.extra.eas.projectId = $p' \
  "$APP_JSON" >"$tmp"
mv "$tmp" "$APP_JSON"
echo "OK: app.json now owner=$OWNER projectId=$PROJECT_ID"

# --- safety: auth must match target owner, else you burn the wrong quota -----
# `eas whoami` can print multiple lines (username + email), so match the owner
# slug as a whole line rather than string-equality against the full output.
if command -v eas >/dev/null 2>&1; then
  WHOAMI="$(eas whoami 2>/dev/null || true)"
  if [ -n "$WHOAMI" ] && ! printf '%s\n' "$WHOAMI" | grep -qx "$OWNER"; then
    echo "" >&2
    echo "WARN: eas whoami='$(printf '%s' "$WHOAMI" | head -1)' but target owner='$OWNER'." >&2
    echo "      A build now would burn the logged-in account's quota, not '$OWNER'." >&2
    echo "      Re-auth as '$OWNER' (its token secret: ${TOKEN_SECRET:-?}):" >&2
    echo "        eas logout && eas login              # interactive" >&2
    echo "        export EXPO_TOKEN=<robot-token-of-$OWNER>   # or token" >&2
  fi
else
  echo "NOTE: eas CLI not found; ensure you're authed as $OWNER before building."
fi
