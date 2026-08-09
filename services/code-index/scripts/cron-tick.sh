#!/usr/bin/env bash
# Cron tick (~every 2min, ADR-0060 §2): fetch → compare SHA → if remote moved,
# fast-forward then spawn ONE incremental builder (one-shot process; RAM is
# reclaimed on exit per ADR-0060 §1). No change → no spawn → host stays at 0 models.
#
# Wrapped by a systemd timer in S2.3. Requires CODE_INDEX_REPO_MONO_ROOT (the
# host's checkout) and the same CODE_INDEX_PG_* env the builder reads.
set -euo pipefail

SERVICE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
REPO_ROOT="${CODE_INDEX_REPO_MONO_ROOT:?set CODE_INDEX_REPO_MONO_ROOT to the host checkout}"
BRANCH="${CODE_INDEX_BRANCH:-main}"

# S2.2 builder×query mutex hook: a warm query session writes a heartbeat; skip this
# tick if one is active so ≤1 bge-m3 is ever resident (query > index priority).
HEARTBEAT="${CODE_INDEX_HEARTBEAT:-/tmp/code-index-query.heartbeat}"
if [ -f "$HEARTBEAT" ]; then
  AGE=$(( $(date +%s) - $(stat -c %Y "$HEARTBEAT" 2>/dev/null || stat -f %m "$HEARTBEAT") ))
  if [ "$AGE" -lt "${CODE_INDEX_HEARTBEAT_TTL:-120}" ]; then
    echo "query session active (${AGE}s) — skipping index tick"
    exit 0
  fi
fi

git -C "$REPO_ROOT" fetch --quiet origin "$BRANCH"
LOCAL=$(git -C "$REPO_ROOT" rev-parse HEAD)
REMOTE=$(git -C "$REPO_ROOT" rev-parse "origin/${BRANCH}")
if [ "$LOCAL" != "$REMOTE" ]; then
  echo "remote moved ${LOCAL:0:8} → ${REMOTE:0:8} — fast-forwarding checkout"
  # Normally a fast-forward (mono uses squash merges → linear main). If origin was
  # rebased / force-pushed, ff-only fails (diverged) and WITHOUT recovery every tick
  # would abort here → indexing silently stalls forever. The host checkout is a
  # read-only mirror (never has local commits), so reset --hard is safe and recovers;
  # index-incremental then diffs lastSha..HEAD as usual (baseline still a valid tree).
  if ! git -C "$REPO_ROOT" merge --ff-only "origin/${BRANCH}"; then
    echo "non-fast-forward (origin/${BRANCH} rewritten) — hard-resetting read-only checkout"
    git -C "$REPO_ROOT" reset --hard "origin/${BRANCH}"
  fi
fi

# Always hand off to the builder — it owns the "is there work left" question, comparing
# index_meta.last_sha against HEAD and returning before it loads a model when they match.
#
# Do NOT gate this on `LOCAL = REMOTE` (it used to). The checkout's HEAD tracks what git
# fetched, NOT what got embedded, so the two diverge the moment a builder dies after the
# fast-forward: on 2026-08-09 a builder was SIGTERMed at the unit's start timeout with
# last_sha still on the old commit, and because the checkout was already fast-forwarded,
# every subsequent tick saw HEAD == origin/main and exited 0 without retrying. 105 ticks,
# ~3.5h, zero work — and it would have stayed that way until the next commit to main
# happened to un-wedge it. The timeout's own self-heal comment assumed the retry would
# resume the batch; it never could, because this check swallowed it first.
exec "${SERVICE_DIR}/node_modules/.bin/tsx" "${SERVICE_DIR}/src/index-incremental.ts" mono
