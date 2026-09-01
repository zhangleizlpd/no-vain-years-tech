#!/usr/bin/env bash
# PreToolUse(Write|Edit) hook — 外部世界断言的出处自检（non-blocking）。
#
# SoT: docs/conventions/comment-provenance.md
# 实测: docs/improvements/2026-09/09-01-comment-provenance-probe.md
#
# 🚨 它**不是缺陷检测器** —— 三版内容探针在本仓实证全部失败（见实测记录 §1；最后一版在真实
# 失误上 0/3 命中、在已知假阳上 2/2 命中，极性是反的）。「这句断言有没有出处」是语义属性，
# `claude-md-audit` 维度 5 早有结论：**禁做成正则**。本 hook 照 pretooluse-convention-rubric.sh
# 的既有形态，只判「你正在这个区域写东西」，把规约摆到写作时刻，判断留给人/模型。
#
# 触发面（PoC 实测：近 200 commit 中 74% 完全不触发；触发的 26% 平均 3.1 文件，长尾 10-11）：
# marketdata 的 adapter/rules/port + optionsdesk rules + ADR —— 外部世界断言的实际聚集地。
#
# 🚨 **按 (session, 文件) 去重** —— 长尾那几个一次改 10+ 文件的 commit 不去重就是刷屏，
# 而刷屏会把规约训练成墙纸（同 sync-anchor-quote.scheduler 那条 no-data warn 的教训）。
#
# 契约同 pretooluse-local-verify-guard.sh：additionalContext + exit 0 = 注入且放行。
# NEVER blocks；任何解析失败一律静默放行（fail-open）。

JQ=/usr/bin/jq
[ -x "$JQ" ] || exit 0

input=$(cat) || exit 0
fp=$("$JQ" -r '.tool_input.file_path // empty' <<<"$input" 2>/dev/null) || exit 0
[ -n "$fp" ] || exit 0

case "$fp" in
  */apps/server/src/marketdata/*.adapter.ts) ;;
  */apps/server/src/marketdata/*.rules.ts)   ;;
  */apps/server/src/marketdata/*.port.ts)    ;;
  */apps/server/src/optionsdesk/*.rules.ts)  ;;
  */docs/adr/*.md)                           ;;
  *) exit 0 ;;
esac

# ── (session, 文件) 去重 ────────────────────────────────────────────────────
sid=$("$JQ" -r '.session_id // empty' <<<"$input" 2>/dev/null) || sid=""
[ -n "$sid" ] || sid="nosid-$(date +%Y%m%d)"
mark_dir="${TMPDIR:-/tmp}/nvy-comment-provenance/${sid//[^A-Za-z0-9_-]/_}"
mark="$mark_dir/$(printf '%s' "$fp" | shasum | cut -d' ' -f1)"
mkdir -p "$mark_dir" 2>/dev/null || exit 0
[ -e "$mark" ] && exit 0          # 本 session 这个文件已注入过 → 静默放行
: > "$mark" 2>/dev/null || exit 0

read -r -d '' RUBRIC <<'TXT'
🚨 注释出处闸 — 你正在写「外部世界断言」的高发区（marketdata adapter/rules/port · optionsdesk rules · ADR）。

本次写入若含**关于 vendor / 交易所 / 第三方平台运行时行为**的断言，逐条过一遍：

① **要不要写**：我此刻能指出出处吗？
   • 能 → 写，带 `EVIDENCE:` 指针
   • 不能 → ① 去验证（查一手文档 / 实取 / 翻 fixture）→ ② **不写（默认）** → ③ 非写不可才标 `ASSUMED:`
   🚨 判据是外部实证：**错注释实质降低下游模型表现，缺失注释影响轻微** ⇒ 拿不出出处时「不写」代价更小。
   🚨 且下游**摆脱不掉**误导注释（明确指示它忽略也没用）—— 无出处的断言会主动把下一个读者带偏。

② **怎么写**：
   // EVIDENCE: <断言> —— <出处>   出处 = 一手 URL / fixture 或 spec 路径 / ADR / FR / 具名实验(p3b E8·T015) / 实测日期+**观测值**
   // ASSUMED:  <断言> —— 未验证；<它错了会怎样>
   🚨 **观测值本身就是合法出处**（`72/100`、`→ 403`）——比只给日期更强，且是本仓主流写法。

③ **复述别人的实测要点名是谁测的** —— MUST NOT 写成无主语的「实测」，读者会以为你复算过。
④ 🚫 **MUST NOT 用自评置信度代替出处**（「大概 / 应该是 / 比较确定」）。二元：给得出出处，或直说未验证。

完整约定：docs/conventions/comment-provenance.md
TXT

"$JQ" -n --arg ctx "$RUBRIC" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$ctx}}' 2>/dev/null || exit 0
exit 0
