#!/usr/bin/env bash
# PreToolUse(Bash) hook — block local verification commands whose failure mode is
# indistinguishable from real code breakage, and therefore costs minutes each time.
#
# WHY A HOOK AND NOT A DOC: every one of these gotchas was already written down
# somewhere in this repo (server-impl-playbook / migration-rules /
# implement-task-closure). They still got hit on 2026-08-02, because all of those
# are path-triggered on *editing* a file, while the trap springs when *running* a
# command. The trigger moment was structurally wrong. This hook fires at the
# right moment. SoT for the content: docs/conventions/local-verification.md
#
# SCOPE IS DELIBERATELY NARROW — only the "runs, then lies to you" tier is denied:
#   - testcontainers spec via `vitest --root` → cannot resolve prisma schema
#   - `nx <target> … | tail` / `| head` → swallows BOTH the exit code and the
#         evidence needed to diagnose the failure. See that rule's comment block.
# The "merely not rigorous" tier (--skip-nx-cache on new files, NX_DAEMON=false,
# blast radius) is NOT enforced here — it needs judgement a string match can't do.
# Those live in docs/conventions/local-verification.md §3-§4.
#
# 🧟 THREE RULES WERE REMOVED ON 2026-08-02 — do not re-add them from memory:
#   - "export-openapi / contract-smoke 必须显式给 MARKETDATA_PROVIDER=mock" —— 规则本身
#     没错,但**已无必要**:三条会 boot 真 server 的路径现在都在属主内部钉死 mock
#     (server:export-openapi 的 project.json options.env / contract-smoke 与
#     e2e-real-backend 共用的 real-backend-harness.ts)。继续拦 = 误伤。
#     ⇒ 把正确的事做成默认之后,对应的护栏要**同 PR 拆掉**。
#   - "server test 必须显式给 dev DATABASE_URL / REDIS_URL" — **证伪**。三组对照全绿,
#     含把 datastore 指向死端口跑当初红掉的那 7 个 accounts IT: 50/50 通过。测试路径
#     压根不读这两个值 (IT 自起 Testcontainers 并在 beforeAll 里自己设 env;boot 类
#     吃 apps/server/vitest.config.ts 的 test.env)。当初归因错在**一次改了两个变量**
#     (cwd 落进 apps/server + 没带 env),把结果算到了 env 头上。
#     那 2520 条 ECONNREFUSED 的真凶是 Testcontainers 映射到宿主的**临时高位端口**
#     (57058/57019/…) —— 即 ~75 个 IT 文件并行各起 PG+Redis 起不来,与 env 无关。
#   - "跑前必 `env -u OSS_*` 四件套" — **当前仓状态下不可复现**:泄漏假 OSS creds 且不
#     unset,boot 依然成功零 ZodError,因为 `.env` 提供了 OSS_PUBLIC_BASE_URL。该失败
#     要求它缺失。⇒ 降级为文档提示 (SoT §1,标注证据等级),不再 deny。
#   两条当初都是「看起来很有道理 + 来自 memory / 他人报告」就写进来的。**新增规则前先拿
#   到可复跑的对照实验**,否则守卫会开始保护错误的东西。
#
# Contract (https://code.claude.com/docs/en/hooks):
#   - reads PreToolUse JSON on stdin; only .tool_input.command is used.
#   - DENY  = exit 0 + a single hookSpecificOutput JSON on stdout.
#   - ALLOW = exit 0 + empty stdout (falls through to normal permission flow).
#   - matcher is "Bash", so non-Bash tools never reach here.
# FAIL-OPEN BY DESIGN: any parse ambiguity, missing jq, or unmatched command →
# allow. We NEVER exit 2 (exit 2 would block and could become a cascade source);
# even an outright crash exits non-2 and is treated as non-blocking. Hence no
# `set -e` / no `set -u`.
set -o pipefail

JQ=/usr/bin/jq                       # hard-coded: survives a PATH polluted by zshrc
[ -x "$JQ" ] || exit 0               # no jq → can't parse → fail open

INPUT="$(cat)"
CMD="$("$JQ" -r '.tool_input.command // empty' <<<"$INPUT" 2>/dev/null)" || exit 0
[ -n "$CMD" ] || exit 0

# 🚨 先折叠「反斜杠 + 换行」的续行，再做任何切分。下面的 segment 循环是**按行**读的
# (`while IFS= read -r seg`)，所以一条 shell 语义上的单命令若写成续行形式，会被切成好几段：
# env 前缀落一段、真正的 runner 落另一段 → per-segment 判定看不到前缀 → 必然误判 DENY。
# 最尖锐的证据：本 hook 的 deny 消息推荐的就是续行写法，照抄回去**仍然被 deny**（2026-08-02
# 实证，连撞两次）。续行折叠后它们回到同一段，判定才成立。
# ⚠️ 只折叠续行，**不折叠裸换行** —— 裸换行分隔的是真正互相独立的命令，必须各判各的。
# 兼容性: `${var//\\$'\n'/ }` 在 bash 3.2 (macOS 自带) 与 5.x 上行为一致，已实测。
CMD="${CMD//\\$'\n'/ }"

SOT="docs/conventions/local-verification.md"

# Only stdout carries the deny-JSON; a stray stdout line corrupts the protocol.
deny() {
  "$JQ" -n --arg r "$1" \
    '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
  exit 0
}

# Resolve a fragment's real command word (basename), skipping env prefixes and
# pnpm/npx/exec wrappers — same technique as pretooluse-gnu-flag-guard.sh.
# Echoes the word, or empty when the fragment is nothing but wrappers.
# 共用于 rule 3 的管道级判定与下方的 per-segment 判定,两处必须用**同一套**解析,
# 否则「哪些写法算 nx 调用」会在两个规则间悄悄分叉。
resolve_cmd_word() {
  seg_="$1"
  read -ra toks_ <<<"$seg_"          # whitespace split only; quotes kept literal
  [ "${#toks_[@]}" -gt 0 ] || return 0
  i_=0
  while [ "$i_" -lt "${#toks_[@]}" ]; do
    case "${toks_[$i_]}" in
      command|builtin|sudo|nice|time|env|npx|pnpm|yarn|bun|exec) i_=$((i_ + 1)) ;;
      -u) i_=$((i_ + 2)) ;;                                # `env -u VAR`
      # value-taking wrapper flags. `pnpm -C <dir> exec nx …` is THIS repo's
      # prescribed invocation style (bash-cwd-discipline skill), and the corpus
      # replay found 13 real `nx test server` runs missed purely because `-C`
      # was not skipped — the command word resolved to "-C". Highest-value fix
      # that experiment produced; do not drop these without re-running E1.
      -C|--dir|--filter|-F|--prefix) i_=$((i_ + 2)) ;;
      # boolean wrapper flags
      -w|--workspace-root|-r|--recursive|-s|--silent) i_=$((i_ + 1)) ;;
      *=*) i_=$((i_ + 1)) ;;                               # leading VAR=val
      *) break ;;
    esac
  done
  [ "$i_" -lt "${#toks_[@]}" ] || return 0
  w_="${toks_[$i_]##*/}"                                   # basename
  printf '%s' "${w_#\\}"
}

# --- rule 3: 本地验证命令被 `| tail` / `| head` 截断 --------------------------
# 管道一次吞掉两样东西：
#   ① **退出码** —— `$?` 变成 tail 的，恒 0。`local-verification.md §3` 早写过「exit code
#      会说谎」，但那是一条要求人在命令时刻记得的约束。
#   ② **失败证据** —— 日志只剩末尾 N 行，而 nx 的失败摘要在尾部、**失败的 spec 文件名却
#      在中间**，于是连"哪个文件红了"都看不到，只能整轮重跑。
# 2026-08-02 实证（本 hook 的作者本人，在读过 §3 之后当轮踩中）：
#   `nx affected -t lint typecheck test build runtime-smoke --base=origin/main 2>&1 | tail -40`
#   → harness 报 exit 0，实际 nx 终态是 `Failed tasks: - server:test`，且截断后无法定位，
#     被迫重跑一整轮（19 分钟）。⇒ 文档拦不住，下沉为机器强制。
# 判定按**相邻管道级**做，绝不做整条命令的子串匹配（顶部 per-segment 段解释了为什么）：
#   `rg 'x' | head -5`      左侧命令词 = rg   → 不命中（分析端截断是合理的）
#   `grep -n "a|b" docs/`   引号内的 | 被切开后两侧命令词都不是 nx/tail → 不命中
# 只管真正「跑 target」的 nx；`nx show projects | head` 之类查询不受限。
while IFS= read -r line_; do
  [ -n "${line_// /}" ] || continue
  IFS='|' read -ra stages_ <<<"$line_"
  [ "${#stages_[@]}" -gt 1 ] || continue
  si_=0
  while [ "$((si_ + 1))" -lt "${#stages_[@]}" ]; do
    lw_="$(resolve_cmd_word "${stages_[$si_]}")"
    rw_="$(resolve_cmd_word "${stages_[$((si_ + 1))]}")"
    si_=$((si_ + 1))
    [ "$lw_" = "nx" ] || continue
    case "$rw_" in tail|head) : ;; *) continue ;; esac
    case "${stages_[$((si_ - 1))]}" in
      *" test"*|*" build"*|*" lint"*|*" typecheck"*|*affected*|*run-many*|*" run "*|*e2e*|*smoke*) : ;;
      *) continue ;;
    esac
    deny "别把本地验证命令接进 \`| ${rw_}\` —— 它同时吞掉两样东西：
① **退出码**：\$? 变成 ${rw_} 的，恒 0。绿了也可能是假的。
② **失败证据**：nx 的失败摘要在尾部，但**失败的 spec 文件名在中间**，截断后定位不到，只能整轮重跑。

2026-08-02 实证（本 hook 作者本人，在读过 SoT §3「exit code 会说谎」之后当轮踩中）：
\`nx affected -t … | tail -40\` 报 exit 0，实际是 \`Failed tasks: - server:test\`，重跑一轮 19 分钟。

改跑（全量落盘 → 再查终态串）：
  <cmd> > /tmp/verify.log 2>&1; echo \"EXIT=\$?\"
  rg -n 'Successfully ran target|Failed tasks' /tmp/verify.log

SoT: $SOT §3"
  done
done <<<"$CMD"

# --- everything below is decided PER SEGMENT, never on the whole command ----
# 🚨 The whole-command-substring approach is WRONG here and was caught by this
# guard blocking its own author (2026-08-02): splitting on `|` also splits
# INSIDE quotes, so `grep -n "a\|vitest --root" docs/` yields a garbage fragment
# whose first word is `vitest`. With a single global "is this an invocation?"
# flag, that fragment unlocked a whole-command match and the doc-grep was denied.
# Two separate false-positive classes exist:
#   1. prose mentions          — `git commit -m "add contract-smoke case"`
#   2. a real runner in ONE segment + the marker in ANOTHER
#      — `nx lint server && grep -rn "test server" docs/`
# Both die if (and only if) each segment is judged on its own text. So: resolve
# a segment's real command word; if it is not a runner we care about, that
# segment contributes NOTHING — not even a flag.
segs="${CMD//&&/$'\n'}"
segs="${segs//|/$'\n'}"
segs="${segs//;/$'\n'}"

while IFS= read -r seg; do
  [ -n "${seg// /}" ] || continue

  w="$(resolve_cmd_word "$seg")"
  [ -n "$w" ] || continue
  case "$w" in nx|tsx|vitest) : ;; *) continue ;; esac     # not a runner → skip

  # --- rule 1: testcontainers spec run through raw vitest ------------------
  if [ "$w" = "vitest" ]; then
    case " $seg " in
      *" --root "*|*" --root="*)
        deny "本仓 server spec（尤其 Testcontainers IT）必须走 nx、cwd=apps/server：\`nx test server <file>\`。
\`vitest --root\` 解析不到 prisma schema，会以看不出根因的方式失败。
SoT: $SOT §2"
        ;;
    esac
  fi

  # 🧟 曾经这里还有一条「boot 路径缺 MARKETDATA_PROVIDER=mock 就 deny」的规则，
  # **已于 2026-08-02 随「env 烘进属主」一并退役** —— 不是因为它错，而是因为它没必要了：
  # 三条会 boot 真 server 的路径现在各自在**属主内部**钉死 mock，
  #   · server:export-openapi        → project.json 的 options.env
  #   · mobile:contract-smoke        ┐ 两者共用 e2e/_support/real-backend-harness.ts,
  #   · mobile:e2e-real-backend      ┘ 在它注入的 serverEnv 里钉死
  # 测试路径本就由 vitest.config.ts 的 test.env / server-boot-smoke.ts 钉死。
  # ⇒ 继续拦只会变成**误伤**：命令本来就能跑了，却因为没写前缀被拒。
  # 教训：hook 是「人还会写错时」的护栏；一旦把正确的事做成默认，护栏要跟着拆，
  # 否则它就从保护变成阻碍。改结构时**必须同 PR 拆对应规则**。
  :
done <<<"$segs"

exit 0   # no segment matched → allow
