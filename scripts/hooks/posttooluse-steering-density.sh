#!/usr/bin/env bash
# PostToolUse(Write|Edit) hook — SDD 产物「强调标记」预算提醒（non-blocking）。
#
# SoT: .claude/rules/sdd-authoring.md § 反模式「规范性动词 / 强调标记当强调号用」（原 MUST / MUST NOT
# 那条 2026-09-17 扩成同一条；本 hook 就是它下条「grep -n 'MUST' spec.md | grep -vE FR|SC」自查配方的机械化）
#
# 管什么：specs/*/{spec,plan,tasks}.md 写完之后数一遍 🚫 / 🚨 / ⚠️、MUST / NEVER / CRITICAL 一族
# 大写指令词、严禁 / 绝对禁止；超过预算就把「三问」摆回写作时刻。只提醒，不拦。
#
# 为什么要有它（2026-09-17 普查，脚本与全表见 docs/improvements/2026-09/09-17-steering-marker-census.md）：
#   - plan.md 每百行标记密度：001–016 在 1–6，044 起 18–37；079 一份 35 个 🚫，四个挤在一行当「不」字用。
#   - 模板自身曾带十几个（🚨 段头 / ⚠️ CRITICAL banner / NEVER ×6，注释还写着「do not soften」），
#     作者顺着模板的音区往下写 —— 那是源头，preset 0.7.2 已改成陈述句；本 hook 管作者自己写的部分。
#   - Anthropic 对 Claude 4.5+ 的官方指引是「dial back any aggressive language」，模型对强调语会
#     overtrigger（platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices）。
#     密度一高，真红线跟墙纸没有区别。
#
# 为什么是 PostToolUse 而不是 PreToolUse：预算是**整份文件**的属性，Edit 的 PreToolUse 只看得到
# new_string；写完落盘再数才是同一个数。additionalContext 在 PostToolUse 同样回到模型上下文。
#
# 去重：按 (session, 文件) 记上次提醒时的计数，计数没变就不再提醒 —— /implement 期 tasks.md 每个
# [X] flip 都是 Edit，不去重就是逐 task 刷屏，而刷屏会把规约训练成墙纸（同 comment-provenance 那条）。
# 计数变了（升或降、仍超线）再提醒一次，让「越改越多」有反馈、「已经在减」也看得见。
#
# spec.md 的 `- **FR-` / `- **SC-` 行不计 MUST / MUST NOT：那是 RFC 2119 规范句式，模板设计如此；
# 其余行照计（sdd-authoring.md「散文里下没有编号的需求」那条正是要抓这个）。
#
# grep 钉死 /usr/bin/grep：dev 机 PATH 上的 `grep` 是 ugrep（CJK 下会报错，见 memory shell 坑），
# /usr/bin 下 macOS 是 BSD grep、CI ubuntu 是 GNU grep，-o / -w / -E 三者都有。
# 契约同 pretooluse-convention-rubric.sh：additionalContext + exit 0；任何解析失败一律静默放行
# （fail-open），故无 set -e / set -u。预算可用 NVY_STEERING_BUDGET 覆盖（测试用）。

JQ=/usr/bin/jq
[ -x "$JQ" ] || exit 0
GREP=/usr/bin/grep
[ -x "$GREP" ] || GREP='grep'
input=$(cat) || exit 0

fp=$("$JQ" -r '.tool_input.file_path // empty' <<<"$input" 2>/dev/null)
[ -n "$fp" ] || exit 0
case "$fp" in
  */specs/*/spec.md|*/specs/*/plan.md|*/specs/*/tasks.md) ;;
  *) exit 0 ;;
esac
[ -r "$fp" ] || exit 0

BUDGET=${NVY_STEERING_BUDGET:-10}
case "$BUDGET" in ''|*[!0-9]*) BUDGET=10 ;; esac

# 计数一律 `grep -o | wc -l`：-o 每个命中一行。emoji / 中文按字节序列匹配，不依赖 locale。
count() { "$GREP" -o -E "$1" 2>/dev/null | wc -l | tr -d ' '; }
n_ban=$(count '🚫' <"$fp")
n_siren=$(count '🚨' <"$fp")
n_warn=$(count '⚠' <"$fp")
n_cn=$(count '严禁|绝对禁止' <"$fp")
# 大写指令词：-w 整词（BSD / GNU 都有；MUSTARD 不算），交替最左最长，`MUST NOT` 不会再被数成 `MUST`。
CAPS='MUST NOT|MUST|NEVER|ALWAYS|CRITICAL|IMPORTANT|NON-NEGOTIABLE|MANDATORY|ENFORCED|FORBIDDEN|ABSOLUTELY'
case "$fp" in
  */spec.md) n_caps=$("$GREP" -v -E '^- \*\*(FR|SC)-' "$fp" 2>/dev/null | "$GREP" -o -w -E "$CAPS" 2>/dev/null | wc -l | tr -d ' ') ;;
  *)         n_caps=$("$GREP" -o -w -E "$CAPS" "$fp" 2>/dev/null | wc -l | tr -d ' ') ;;
esac
total=$((n_ban + n_siren + n_warn + n_caps + n_cn))
[ "$total" -gt "$BUDGET" ] || exit 0

# ── (session, 文件) 去重：计数不变不重复提醒 ────────────────────────────────
sid=$("$JQ" -r '.session_id // empty' <<<"$input" 2>/dev/null) || sid=""
[ -n "$sid" ] || sid="nosid-$(date +%Y%m%d)"
rel="specs/${fp#*/specs/}"
mark_dir="${TMPDIR:-/tmp}/nvy-steering-density/${sid//[^A-Za-z0-9_-]/_}"
mkdir -p "$mark_dir" 2>/dev/null || exit 0
mark="$mark_dir/$(printf '%s' "$rel" | shasum | cut -d' ' -f1)"
last=$(cat "$mark" 2>/dev/null)
[ "$last" = "$total" ] && exit 0
printf '%s' "$total" > "$mark" 2>/dev/null

# 提醒文案自己不用 🚨 / MUST —— 它就是在讲这个。占位符事后替换，heredoc 引住避免 shell 展开。
read -r -d '' MSG <<'TXT'
标记预算提醒 — @@REL@@ 现有 @@TOTAL@@ 个强调标记，预算 ≤ @@BUDGET@@：🚫 @@BAN@@ · 🚨 @@SIREN@@ · ⚠️ @@WARN@@ · 大写指令词（MUST / NEVER / CRITICAL 一族）@@CAPS@@ · 严禁 / 绝对禁止 @@CN@@。

一个标记只给同时满足三条的条目，答不全的改成陈述句：
① 实施者默认会做错吗 —— 默认做法恰好是对的，就不用标
② 有没有机器闸当场拦（eslint / check 脚本 / 类型 / lefthook）—— 有就写「由 X 拦」，闸才是约束，喊不是
③ 有实证吗（PoC / 事故 / 行号）—— 没有的先去拿

常见虚胖：🚫 当「不」字用（一行四个）；同句 🚫 + MUST NOT 是说了两遍；「反例臂」清单段头已说明性质，逐条再挂 🚨 没有信息量。
细则：.claude/rules/sdd-authoring.md § 反模式。依据：Anthropic 对 Claude 4.5+ 的指引「dial back any aggressive language」。
TXT
MSG=${MSG//@@REL@@/$rel}
MSG=${MSG//@@TOTAL@@/$total}
MSG=${MSG//@@BUDGET@@/$BUDGET}
MSG=${MSG//@@BAN@@/$n_ban}
MSG=${MSG//@@SIREN@@/$n_siren}
MSG=${MSG//@@WARN@@/$n_warn}
MSG=${MSG//@@CAPS@@/$n_caps}
MSG=${MSG//@@CN@@/$n_cn}

"$JQ" -n --arg ctx "$MSG" \
  '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$ctx}}' 2>/dev/null || exit 0
exit 0
