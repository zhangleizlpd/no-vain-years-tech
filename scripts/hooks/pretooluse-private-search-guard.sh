#!/usr/bin/env bash
# PreToolUse(Bash) hook — docs/private 搜索盲区提醒（non-blocking）。
#
# 问题：`docs/private/`（plans / evidence / runbook）对常规搜索**结构性不可见**，且
# 静默 —— 不是「搜到 0 条」，是「管道根本没进去，还 exit=1 装作正常」。两层叠加：
#   ① .gitignore 收了 docs/private ⇒ rg 默认跳过；
#   ② docs/private 本身是 symlink ⇒ rg 即使加 --no-ignore 仍不进，grep -r 同样不进。
# 2026-09-17 实测可见性矩阵（本仓、macOS）：
#   rg 'X' docs/            → 0 命中   rg --no-ignore 'X' docs/ → 0 命中
#   rg --no-ignore -L …     → 命中     rg 'X' docs/private/…    → 命中（指名即可，零额外 flag）
#   grep -r 'X' docs/       → 0 命中   grep -R 'X' docs/        → 命中
# ⇒ 解掉 gitignore 并不够，symlink 才是卡死的那层。
#
# WHY A HOOK AND NOT A DOC（两条，都不是推断）:
#   1. 内建 **Explore / Plan 子 agent 不加载 CLAUDE.md，也不加载 project rules**
#      （官方 sub-agents 文档：“Explore and Plan skip your CLAUDE.md files…”）。而
#      「派个 agent 去仓里扫一遍」正是 Explore 的活 ⇒ 写进 CLAUDE.md / .claude/rules/
#      的护栏，恰好到不了最可能踩坑的那个执行者。
#   2. PreToolUse hook **会在子 agent 自己的工具循环里触发**（2026-09-17 探针实测：
#      子 agent 的 ToolSearch / Read 两次调用都进了 hook 日志，且 payload 顶层多出
#      agent_id / agent_type 两个主 session 没有的字段）⇒ hook 是唯一够得到 Explore 的层。
# 另：path-triggered rule 也不适用 —— 搜索发生在**任何文件被触碰之前**，没有路径可锚。
#
# SCOPE IS DELIBERATELY NARROW（零误伤优先于全覆盖）:
#   只在**搜索目标是 docs/ 本身**时出声。`rg 'x' apps/server/src`、`rg 'x' docs/adr/`
#   （子目录）、点名单个文件、已点名 private、已用能穿透 symlink 的写法（rg -L /
#   --follow、grep -R）⇒ 一律静默。省略路径的形态（`ls | grep foo`、`rg 'pat'`）也放过。
#
#   🚨 **仓根 `.` 蓄意不判**，这是实测定的，不是想当然：2026-09-17 拿 792 个 transcript
#   里的 31,479 条真实命令回放，含仓根 `.` 时触发 117 条，埋点查出其中 **115 条的 scope
#   是 `.`、仅 11 条是真 docs 范围**，且 `find` 占 83 条 —— 绝大多数是 `find . -name
#   'openapi.json'` 这类按文件名找东西，与找 plan / 取证无关。**收窄后同一语料重放：触发
#   14 条（0.04%），埋点核对 15 条判中记录 100% 落在 docs 范围、零仓根**（工具 find 12 /
#   rg 2 / grep 1），留下的全是 `find …/docs -name '*broker-account-master*'` 这类目标人群。
#   代价是仓根内容搜索不再提醒（它确实也看不见 docs/private）—— 这是刻意用覆盖率换
#   signal 质量：一条主要在「找文件名」时响的提醒，会被学会整体忽略，那等于零保护。
#
# Contract (https://code.claude.com/docs/en/hooks):
#   - 读 stdin 的 PreToolUse JSON，只用 .tool_input.command。
#   - 注入 = exit 0 + 单个 {"hookSpecificOutput":{…,"additionalContext":…}} 到 stdout。
#   - 静默 = exit 0 + 空 stdout。
#   - matcher 是 "Bash"，非 Bash 工具到不了这里。
# FAIL-OPEN BY DESIGN：解析歧义 / 无 jq / 未命中一律静默放行。**NEVER exit 2** —— 本闸
# 是提示，误拦的代价远高于漏提醒（契约同 pretooluse-gnu-flag-guard.sh）。故无 set -e / set -u。
set -o pipefail

JQ=/usr/bin/jq                       # hard-coded: survives a PATH polluted by zshrc
[ -x "$JQ" ] || exit 0               # no jq → can't parse → fail open

INPUT="$(cat)"
CMD="$("$JQ" -r '.tool_input.command // empty' <<<"$INPUT" 2>/dev/null)" || exit 0
[ -n "$CMD" ] || exit 0

# 已经点名 private ⇒ 调用方知道它的存在，不必提醒。放在分段之前：整串命令任意位置命中即静默。
case "$CMD" in *private*) exit 0 ;; esac

# 按命令边界（&&、||、|、;）分段，只看**命令位**的 token，避免 prose 误命中
# （如 git commit -m 'grep docs/'）。折叠续行，否则前缀与真命令会被切成两段。
segs="${CMD//\\$'\n'/ }"
segs="${segs//&&/$'\n'}"
segs="${segs//|/$'\n'}"
segs="${segs//;/$'\n'}"

hit=0
while IFS= read -r seg; do
  [ -n "${seg// /}" ] || continue
  read -ra toks <<<"$seg"
  [ "${#toks[@]}" -gt 0 ] || continue

  # 跳过前缀，使 `sudo rg …` / `VAR=x grep …` 解析到真正的命令词
  i=0
  while [ "$i" -lt "${#toks[@]}" ]; do
    case "${toks[$i]}" in
      command|builtin|sudo|nice|time|env|xargs|\\command) i=$((i + 1)) ;;
      *=*)                                                i=$((i + 1)) ;;
      *) break ;;
    esac
  done
  [ "$i" -lt "${#toks[@]}" ] || continue

  cmd="${toks[$i]#\\}"
  cmd="${cmd##*/}"
  rest=("${toks[@]:$((i + 1))}")

  case "$cmd" in
    rg|grep|find) : ;;               # 只收本机实测过 symlink 语义的三个；ag / ack / fd 未验证，不收
    *) continue ;;
  esac

  # 能穿透 symlink 的写法 ⇒ 这条命令本来就看得见 docs/private，静默。
  # grep 只有大写 -R 跟随 symlink，小写 -r 不跟随 ⇒ 必须区分大小写地逐字符查。
  follows=0
  for a in ${rest[@]+"${rest[@]}"}; do
    case "$a" in
      --follow|--dereference-recursive) follows=1 ;;
      --*) : ;;                       # 其它长选项（含 --no-ignore：它解不开 symlink）
      -*)
        case "$cmd" in
          grep) case "$a" in *R*) follows=1 ;; esac ;;
          rg|find) case "$a" in *L*) follows=1 ;; esac ;;
        esac
        ;;
    esac
  done
  [ "$follows" = 1 ] && continue

  # 搜索范围：只有「docs/ 本身」才与本盲区相关（仓根 `.` 不判，理由见文件头）。**必须有显式
  # 路径实参**才判 —— 省略路径的形态（`ls | grep foo` 读 stdin、`rg 'pat'` 扫 cwd）从命令串上
  # 分不出是不是仓内搜索，一律放过：零误伤优先于全覆盖。
  # rg / grep = 「pattern [path]」⇒ 路径是**最后**一个非选项 token，且非选项 token 须 ≥ 2；
  # find      = 「find path …」    ⇒ 路径是**第一**个非选项 token。
  # 剥掉 token 两侧的双引号：`find "$R/docs"` 是真实流量里的常见写法（2026-09-17 回放实测
  # 24 条），不剥就整类漏判 —— 带引号的 token 末尾是 `"` 而不是 `/docs`，匹配不上。
  scope=""; nargs=0; first=""
  for a in ${rest[@]+"${rest[@]}"}; do
    case "$a" in
      -*) : ;;
      *) a="${a//\"/}"; nargs=$((nargs + 1)); [ -n "$first" ] || first="$a"; scope="$a" ;;
    esac
  done
  case "$cmd" in
    find) scope="$first" ;;
    *)    [ "$nargs" -ge 2 ] || continue ;;
  esac
  case "$scope" in
    docs|docs/|./docs|./docs/|*/docs|*/docs/) hit=1 ;;
  esac
done <<<"$segs"

[ "$hit" = 1 ] || exit 0

CTX='🚨 docs/private 搜索盲区 — 你正在搜索 docs/，而 docs/private/（plans / evidence / runbook）对它**结构性不可见且静默**：该目录既被 .gitignore、本身又是 symlink ⇒ rg 默认零命中、rg --no-ignore 仍零命中、grep -r 也零命中，且一律 exit=1 不报错。「搜不到」会被当成「不存在」。
• 找历史 PoC / plan / 取证记录时 MUST 显式点名：rg '\''<pat>'\'' docs/private/（指名即可，无需额外 flag）；或用 rg --no-ignore -L / grep -R 穿透 symlink。
• 派子 agent 做取证时 MUST 把 docs/private/ 写进 brief —— 内建 Explore / Plan 不加载 CLAUDE.md 与 project rules，只有 brief 到得了它们。
• 判据：docs/conventions/information-boundary.md § 验证纪律。'

"$JQ" -n --arg ctx "$CTX" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$ctx}}' 2>/dev/null || exit 0
exit 0
