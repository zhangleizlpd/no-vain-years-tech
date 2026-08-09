#!/usr/bin/env bash
# PreToolUse(Bash) hook — deny a small set of DESTRUCTIVE commands during
# UNATTENDED headless burst runs only (Track 2 / scripts/sdd-run/burst.mjs).
# Defense-in-depth on top of `--permission-mode dontAsk --allowedTools`: dontAsk
# gates which TOOLS run, but `Bash` is allowed, so Bash command *content* is
# otherwise unrestricted. This catches the realistic ACCIDENT set for an
# unattended SDD impl (a subagent rm -rf'ing the wrong path / force-pushing /
# resetting --hard / dropping the DB) before it executes. A PreToolUse deny
# fires even under dontAsk / bypassPermissions (verified vs official docs).
#
# 🔒 ENV-GATED: enforces ONLY when SDD_BURST=1 (set by burst.mjs on the spawned
# `claude -p` process, inherited by this hook). In normal interactive sessions
# the env is unset → this hook no-ops immediately, so it NEVER changes your
# day-to-day Bash behavior. The sibling pretooluse-gnu-flag-guard.sh stays
# always-on; this one is burst-only.
#
# ⚠️ BEST-EFFORT, not a sandbox. Substring/segment matching can be evaded by
# obfuscation (var indirection, base64, etc.). The threat model is ACCIDENTAL
# destruction by a well-meaning-but-wrong agent, not an adversary. True
# isolation for adversarial safety = run burst in a container/worktree (Phase 3).
#
# Contract (mirror of pretooluse-gnu-flag-guard.sh, per
# https://code.claude.com/docs/en/hooks):
#   - reads PreToolUse JSON on stdin; only .tool_input.command is used.
#   - DENY  = exit 0 + a single hookSpecificOutput JSON on stdout.
#   - ALLOW = exit 0 + empty stdout (falls through to normal permission flow).
# FAIL-OPEN: missing jq / parse error / no match → allow. NEVER exit 2.
set -o pipefail

[ "${SDD_BURST:-}" = "1" ] || exit 0  # interactive / non-burst → no-op, allow

JQ=/usr/bin/jq                        # hard-coded: survives a PATH polluted by zshrc
[ -x "$JQ" ] || exit 0                # no jq → can't parse → fail open

INPUT="$(cat)"
CMD="$("$JQ" -r '.tool_input.command // empty' <<<"$INPUT" 2>/dev/null)" || exit 0
[ -n "$CMD" ] || exit 0

deny() {
  "$JQ" -n --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

# Each rule: an ERE matched against the whole command string (so a destructive
# command in any &&/|/; segment is caught, incl. the `cd /tmp && rm -rf` form).
# Matching the full string over-blocks a destructive pattern that only appears
# inside a quoted string — acceptable in unattended mode (a rare false-block
# surfaces as a stop-signal at morning review, far cheaper than a real wipe).
match() { printf '%s' "$CMD" | grep -qE "$1"; }

# rm -rf / -fr / -r -f (recursive force delete)
match 'rm[[:space:]]+(-[[:alnum:]]*[rR][[:alnum:]]*[fF]|-[[:alnum:]]*[fF][[:alnum:]]*[rR]|-[rR][[:space:]]+-[fF]|-[fF][[:space:]]+-[rR]|--recursive.*--force|--force.*--recursive)' &&
  deny "Unattended burst 禁 'rm -rf'(递归强删)。删大量文件属高风险——若 task 真需要,这是 stop-signal,abort 让人审。(burst destructive-guard)"

# git force push (any branch)
match 'git[[:space:]]+push([[:space:]]+[^&|;]*)?[[:space:]]+(--force([^-]|$|-with-lease)|-f([[:space:]]|$))' &&
  deny "Unattended burst 禁 git force-push(--force / -f / --force-with-lease)。burst 只开普通 PR,不重写远端历史。(burst destructive-guard)"

# git reset --hard (destroys committed/uncommitted work in the worktree)
match 'git[[:space:]]+reset[[:space:]]+([^&|;]*[[:space:]])?--hard' &&
  deny "Unattended burst 禁 'git reset --hard'(毁工作区/已 commit 进度)。每 task atomic commit 是可续的真相源,不许整片回退。(burst destructive-guard)"

# git clean -fd... (wipes untracked files/dirs)
match 'git[[:space:]]+clean[[:space:]]+([^&|;]*[[:space:]])?-[[:alnum:]]*f' &&
  deny "Unattended burst 禁 'git clean -f'(抹未跟踪文件)。(burst destructive-guard)"

# prisma DB-dropping ops
match 'prisma[[:space:]]+migrate[[:space:]]+reset|prisma[[:space:]]+db[[:space:]]+push[^&|;]*--force-reset|prisma[[:space:]]+db[[:space:]]+execute' &&
  deny "Unattended burst 禁 prisma migrate reset / db push --force-reset / db execute(可丢库)。schema/DB 不可逆变更永远是 stop-signal。(burst destructive-guard)"

# destructive raw SQL
match '(DROP|TRUNCATE)[[:space:]]+(TABLE|DATABASE|SCHEMA)|DROP[[:space:]]+DATABASE|dropdb([[:space:]]|$)' &&
  deny "Unattended burst 禁 DROP/TRUNCATE TABLE|DATABASE|SCHEMA。(burst destructive-guard)"

# overwrite-redirect onto a production env file
match '>[[:space:]]*[^|;&]*\.env\.production' &&
  deny "Unattended burst 禁向 .env.production 重定向写入(覆盖生产密钥)。(burst destructive-guard)"

exit 0  # no rule matched → allow
