#!/usr/bin/env bash
# PreToolUse(Write|Edit|Bash) hook — 外部世界断言的出处自检（non-blocking）。
#
# SoT: docs/conventions/comment-provenance.md
# 实测: docs/improvements/2026-09/09-01-comment-provenance-probe.md
#
# 🚨 它**不是缺陷检测器** —— 三版内容探针在本仓实证全部失败（见实测记录 §1；最后一版在真实
# 失误上 0/3 命中、在已知假阳上 2/2 命中，极性是反的）。「这句断言有没有出处」是语义属性，
# `claude-md-audit` 维度 5 早有结论：**禁做成正则**。本 hook 照 pretooluse-convention-rubric.sh
# 的既有形态，只判「你正在这个区域动文件」，把规约摆到写作时刻，判断留给人/模型。
#
# 触发面（PoC 实测：近 200 commit 中 74% 完全不触发；触发的 26% 平均 3.1 文件，长尾 10-11）：
# marketdata 的 adapter/rules/port + optionsdesk rules + ADR —— 外部世界断言的实际聚集地。
#
# ── Bash 通道（第二批加，补一个实测出来的洞）─────────────────────────────────────────
# EVIDENCE: 2026-09-01 A/B 实验 8 探针预登记对照（实测记录 §7）：`.claude/rules/
# comment-provenance-sync.md` 只在 **Read 工具**命中 glob 时注入，Bash `cat` 读同一个文件
# （探针 B1）与 heredoc 写覆盖面文件（探针 B6a）**两层全沉默**。而 auto mode 明确引导
# 「能用 Bash 就用 Bash 读写文件」⇒ 那种会话里主力层根本不点火。
# ⇒ Bash 侧只认**命令串里出现的覆盖面文件路径**，读写一视同仁，理由是两种时刻都有价值：
#   - 读命令（cat / sed -n / grep）→ 注入落在**构思之前**，与 rule 层同刻，价值最高；
#   - 写命令（heredoc / sed -i）→ 注入落在构思之后，与 Write/Edit 同档，作事后修订的触发器
#     （EVIDENCE: 同日 C2 臂实测，rubric 注入后子 agent 自发 6 次 Edit 修订，并按「拿不出
#     出处默认不写」删掉一条无出处的 vendor 猜测）。
#
# 🚨 **按 (session, 仓相对路径) 去重，三个通道共用一套 marker** —— 长尾那几个一次改 10+ 文件
# 的 commit 不去重就是刷屏，而刷屏会把规约训练成墙纸（同 sync-anchor-quote.scheduler 那条
# no-data warn 的教训）。路径先归一到仓相对形式才能跨通道去重：Write/Edit 给绝对路径、Bash
# 命令串里通常是相对路径，不归一就是同一个文件注入两次。
# ⚠️ 归一的代价：worktree 里的同名相对路径与主树共用 marker，先命中的那个会抑制后一个。
# 非阻塞 rubric，且 worktree 子 agent 与主树本就少有同文件重合 —— 接受。
#
# 契约同 pretooluse-local-verify-guard.sh：additionalContext + exit 0 = 注入且放行。
# NEVER blocks；任何解析失败一律静默放行（fail-open）。故无 `set -e` / 无 `set -u`。

JQ=/usr/bin/jq
[ -x "$JQ" ] || exit 0

input=$(cat) || exit 0

# 覆盖面判据。**pattern 不锚定开头** —— 同一份判据要同时吃绝对路径（Write/Edit）与相对路径
# （Bash 命令串）。`.spec.ts` 天然落不进来（结尾不匹配），与既有行为一致。
is_covered() {
  case "$1" in
    *apps/server/src/marketdata/*.adapter.ts) return 0 ;;
    *apps/server/src/marketdata/*.rules.ts)   return 0 ;;
    *apps/server/src/marketdata/*.port.ts)    return 0 ;;
    *apps/server/src/optionsdesk/*.rules.ts)  return 0 ;;
    *docs/adr/*.md)                           return 0 ;;
  esac
  return 1
}

# 归一到仓相对路径，供跨通道去重。绝对路径 / worktree 路径 / 相对路径都收敛到 `apps/…`
# 或 `docs/…`。匹配不上的原样返回（只会导致该条不与别的通道去重，是安全侧）。
normalize() {
  case "$1" in
    */apps/*) printf '%s' "apps/${1#*/apps/}" ;;
    */docs/*) printf '%s' "docs/${1#*/docs/}" ;;
    *)        printf '%s' "$1" ;;
  esac
}

candidates=""
fp=$("$JQ" -r '.tool_input.file_path // empty' <<<"$input" 2>/dev/null)
if [ -n "$fp" ]; then
  # Write / Edit 通道：单个 file_path。
  is_covered "$fp" && candidates=$(normalize "$fp")
else
  # Bash 通道：从命令串里捞路径。
  cmd=$("$JQ" -r '.tool_input.command // empty' <<<"$input" 2>/dev/null)
  [ -n "$cmd" ] || exit 0
  # 🚨 用 `tr -c` 把**路径字符以外的一切**换成空格，而不是逐个列 shell 元字符去删：后者是
  # 一张会漏的黑名单（引号 / 重定向 / 管道 / 括号 / 花括号 / 逗号 / 等号…），而路径的字符集
  # 是封闭的白名单。副作用正好是想要的：scrub 之后串里**不可能再有 glob 字符**，下面那圈
  # 无引号 `for` 的 word-splitting 因此安全（仍加 `set -f` 兜底）。
  scrubbed=$(printf '%s' "$cmd" | tr -c 'A-Za-z0-9_./-' ' ')
  set -f
  for tok in $scrubbed; do
    is_covered "$tok" && candidates="$candidates $(normalize "$tok")"
  done
  set +f
fi
[ -n "${candidates// /}" ] || exit 0

# ── (session, 仓相对路径) 去重 ──────────────────────────────────────────────
sid=$("$JQ" -r '.session_id // empty' <<<"$input" 2>/dev/null) || sid=""
[ -n "$sid" ] || sid="nosid-$(date +%Y%m%d)"
mark_dir="${TMPDIR:-/tmp}/nvy-comment-provenance/${sid//[^A-Za-z0-9_-]/_}"
mkdir -p "$mark_dir" 2>/dev/null || exit 0

# 一条命令可能带多个覆盖面文件：全部标记，但只注入一次（注入 N 份同样的 rubric = 刷屏）。
fresh=0
set -f
for path in $candidates; do
  mark="$mark_dir/$(printf '%s' "$path" | shasum | cut -d' ' -f1)"
  [ -e "$mark" ] && continue
  : > "$mark" 2>/dev/null || continue
  fresh=1
done
set +f
[ "$fresh" -eq 1 ] || exit 0   # 本 session 这些文件都注入过 → 静默放行

# 通道决定第一行的措辞；其余逐字同文，避免两份 rubric 各自漂移。
if [ -n "$fp" ]; then
  lede="你正在写「外部世界断言」的高发区"
else
  lede="你正在读 / 改「外部世界断言」高发区的文件"
fi

read -r -d '' RUBRIC <<'TXT'
🚨 注释出处闸 — @@LEDE@@（marketdata adapter/rules/port · optionsdesk rules · ADR）。

本次读写若涉及**关于 vendor / 交易所 / 第三方平台运行时行为**的断言，逐条过一遍：

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
   🚨 实测判据（2026-09-01 A/B，n=20）：无注入臂 10/10 写出裸断言，其中「东证大納会改全日」
   一条五个样本给出 2009/2010/2011/2022 四个互斥年份 —— 裸断言不是「省事但大概率对」，
   它们**互相矛盾**且读起来一样自信，下一个读者无从分辨。

完整约定：docs/conventions/comment-provenance.md
TXT

"$JQ" -n --arg ctx "${RUBRIC//@@LEDE@@/$lede}" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$ctx}}' 2>/dev/null || exit 0
exit 0
