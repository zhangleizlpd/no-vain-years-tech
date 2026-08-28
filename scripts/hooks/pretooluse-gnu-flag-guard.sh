#!/usr/bin/env bash
# PreToolUse(Bash) hook — deny a small set of GNU-only flags that fail on this
# machine's BSD userland, so one illegal-option command can't trigger a
# parallel-batch sibling cascade (Claude Code #22264, where a single non-zero
# exit cancels ~20 in-flight calls in the same turn).
# See docs/private/plans/quiet-knitting-hare.md §1.5.
#
# SCOPE IS EMPIRICAL, NOT "all known GNU flags". Only flags verified to actually
# fail in THIS repo's Bash environment on 2026-06-01 (macOS 26.4 / Darwin 25.4)
# are blocked. The blocked set is PATH-dependent: grep -P / ls --color /
# readlink -f / sort -V all WORK here because GNU tools sit on this PATH, so
# blocking them would be false positives ("零误伤" guarantee). If you add or
# remove Homebrew gnubin (which would also make GNU `cat -A` start working),
# re-run the probe in the plan and re-derive this list.
#   blocked:  cat -A   |   date -d   |   cp --parents   |   sed -i <script>
#   allowed:  sed -i '' <script>  (the valid BSD in-place form)
#
# Contract (https://code.claude.com/docs/en/hooks):
#   - reads PreToolUse JSON on stdin; only .tool_input.command is used.
#   - DENY  = exit 0 + a single hookSpecificOutput JSON on stdout.
#   - ALLOW = exit 0 + empty stdout (falls through to normal permission flow).
#   - matcher is "Bash", so non-Bash tools never reach here.
# FAIL-OPEN BY DESIGN: any parse ambiguity, missing jq, or unmatched command →
# allow. We NEVER exit 2 (exit 2 would *block* and could itself become a new
# cascade source); even an outright crash exits non-2 and is treated as
# non-blocking by the harness. Hence no `set -e` / no `set -u` (a stray unbound
# var must not turn into a blocking failure).
set -o pipefail

JQ=/usr/bin/jq                       # hard-coded: survives a PATH polluted by zshrc
[ -x "$JQ" ] || exit 0               # no jq → can't parse → fail open

INPUT="$(cat)"
CMD="$("$JQ" -r '.tool_input.command // empty' <<<"$INPUT" 2>/dev/null)" || exit 0
[ -n "$CMD" ] || exit 0

# All diagnostics go to stderr; the ONLY thing we ever print to stdout is the
# final deny-JSON below (a stray stdout line would corrupt the hook protocol).
deny() {
  "$JQ" -n --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

# Split the command into shell segments at command boundaries (&&, ||, |, ;) so
# we only inspect tokens in *command position*. This avoids false matches on a
# bad flag that merely appears inside a quoted argument (e.g. echo "cat -A").
# Order: collapse && first, then any | (also turns || into empty segments), then ;.
# Note: a separator inside quotes (e.g. awk 'a && b') over-splits into garbage
# fragments whose first word is not a checked command → no match → allow. Safe.
segs="${CMD//&&/$'\n'}"
segs="${segs//|/$'\n'}"
segs="${segs//;/$'\n'}"

while IFS= read -r seg; do
  [ -n "${seg// /}" ] || continue
  read -ra toks <<<"$seg"            # whitespace split only; quotes kept literal
  [ "${#toks[@]}" -gt 0 ] || continue

  # Skip leading prefixes so `command cat -A`, `sudo cp ...`, `VAR=x sed ...`
  # resolve to their real command word.
  i=0
  while [ "$i" -lt "${#toks[@]}" ]; do
    case "${toks[$i]}" in
      command|builtin|sudo|nice|time|env|\\command) i=$((i + 1)) ;;
      *=*)                                           i=$((i + 1)) ;;  # leading VAR=val
      *) break ;;
    esac
  done
  [ "$i" -lt "${#toks[@]}" ] || continue

  cmd="${toks[$i]#\\}"               # strip a leading backslash (\cat)
  cmd="${cmd##*/}"                   # basename, so /bin/cat → cat
  rest=("${toks[@]:$((i + 1))}")

  case "$cmd" in
    cat)
      for a in ${rest[@]+"${rest[@]}"}; do
        case "$a" in
          --) break ;;               # end-of-options marker
          --*) : ;;                  # long option (not our target)
          -*A*) deny "BSD 'cat' has no -A flag (this machine's userland). Use 'cat -v -e -t', or—better for inspecting a file—the Read tool. Blocked to prevent a #22264 sibling-cascade. (GNU-flag guard, plan §1.5)" ;;
        esac
      done
      ;;
    date)
      for a in ${rest[@]+"${rest[@]}"}; do
        [ "$a" = "-d" ] && deny "BSD 'date' has no -d (GNU date-string parsing). Use 'date -v' for relative dates (e.g. date -v-2d) or 'date -r <epoch>'. (GNU-flag guard, plan §1.5)"
      done
      ;;
    cp)
      for a in ${rest[@]+"${rest[@]}"}; do
        [ "$a" = "--parents" ] && deny "BSD 'cp' has no --parents. Use 'ditto src dst' or 'rsync -R src dst', or mkdir -p the target dir first. (GNU-flag guard, plan §1.5)"
      done
      ;;
    sed)
      n="${#rest[@]}"
      j=0
      while [ "$j" -lt "$n" ]; do
        if [ "${rest[$j]}" = "-i" ]; then
          nxt="${rest[$((j + 1))]:-}"
          # BSD requires an explicit suffix arg after -i; only the empty-string
          # forms ('' or "") are the valid no-backup spelling. Anything else
          # (a sed script, a filename) gets eaten as the suffix and breaks.
          if [ "$nxt" != "''" ] && [ "$nxt" != '""' ]; then
            deny "BSD 'sed -i' needs an explicit backup-suffix argument: write \"sed -i '' 's/../'\" (empty string = no backup). Bare 'sed -i' makes BSD eat the script as the suffix. (GNU-flag guard, plan §1.5)"
          fi
        fi
        j=$((j + 1))
      done
      ;;
  esac
done <<<"$segs"

exit 0   # no segment matched → allow
