#!/usr/bin/env bash
# 对照表测试：marketdata-dev-sync/sync.sh 里那几个**纯函数**（不连 prod、不碰任何 DB）。
# 用法: bash scripts/jobs/marketdata-dev-sync/sync.test.sh scripts/jobs/marketdata-dev-sync/sync.sh
#
# 为什么是「抽函数体 + eval」而不是 source：sync.sh 是可执行 payload，顶层就开始 ssh prod +
# TRUNCATE 本地库，一 source 就真跑同步。故按行抽出目标函数，在干净子 shell 里 eval。
# 🚨 抽取失配必须**当场红**，不能静默退化成平凡绿 —— 每个 extract 都断言非空 + 至少一个
#    对照用例会因抽空而失败（探针）。
set -u

SYNC="${1:?usage: $0 <sync.sh>}"
[ -r "$SYNC" ] || { echo "❌ 读不到 $SYNC"; exit 1; }
FAILED=0

ok() { printf '✅ %s\n' "$1"; }
bad() { printf '❌ %s — 期望 %s，实际 %s\n' "$1" "$2" "$3"; FAILED=1; }
eq() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "「$2」" "「$3」"; }

# 抽「以 `name()` 开头、到行首 `}` 为止」的整段函数定义
extract_fn() { awk -v n="$1" 'index($0, n "()") == 1 { p = 1 } p { print } p && /^}$/ { exit }' "$SYNC"; }

WHERE_FN="$(extract_fn where_for)"
VERDICT_FN="$(extract_fn drift_verdict)"
SHA_FN="$(extract_fn file_sha256)"
DEFAULTS="$(grep -E '^(RECENT_DAYS|OPTION_RECENT_DAYS)=' "$SYNC")"
for pair in "where_for:$WHERE_FN" "drift_verdict:$VERDICT_FN" "file_sha256:$SHA_FN" "env 默认值:$DEFAULTS"; do
  [ -n "${pair#*:}" ] || { echo "❌ 抽取失配：${pair%%:*} 在 $SYNC 里没抽到（改名了？）"; FAILED=1; }
done
[ "$FAILED" -eq 0 ] || { echo "—— FAILED（抽取阶段，后续用例无意义）"; exit 1; }

# —— where_for：策略 → WHERE 子句 ——————————————————————————————————————————————
# 🚨 子 shell 一律 `set -euo pipefail`，与 sync.sh 顶部**逐字一致**：这些函数的正确性有一半
#    在退出码上（读不到文件退 0、未知策略退非 0），而退出码只在同一套 shell 选项下才等价 ——
#    宽松的 harness 会把「pipefail 下 shasum 读不到就整条管道失败」这类真 bug 判成绿。
HARNESS="set -euo pipefail
SAMPLE_IDS='11,22'
CUTOFF='2026-01-01'
$DEFAULTS
$WHERE_FN
where_for \"\$1\""
where_out() { # $1=policy，其余为额外 env 赋值（如 OPTION_RECENT_DAYS=7）
  local policy="$1"; shift
  env "$@" bash -c "$HARNESS" _ "$policy" 2>&1
}

eq "full → 无 WHERE" "" "$(where_out full)"
eq "sample_only → 仅样本股" \
  "WHERE instrument_id IN (11,22)" "$(where_out sample_only)"
eq "sample_or_recent → 样本股全史 + 全股近窗（trade_date）" \
  "WHERE instrument_id IN (11,22) OR trade_date >= '2026-01-01'" "$(where_out sample_or_recent)"
eq "recent_sessions → 默认 30 自然日（按 session_date）" \
  "WHERE session_date >= CURRENT_DATE - INTERVAL '30 days'" "$(where_out recent_sessions)"
eq "recent_sessions 认 OPTION_RECENT_DAYS 覆盖" \
  "WHERE session_date >= CURRENT_DATE - INTERVAL '7 days'" "$(where_out recent_sessions OPTION_RECENT_DAYS=7)"

# 承重回归：两个近窗**不许合流**。RECENT_DAYS 是交易日（daily_bar），OPTION_RECENT_DAYS 是
# 自然日（期权快照）；哪天有人图省事复用同一个 env，下面两条会当场红。
eq "改 RECENT_DAYS 不动期权窗口" \
  "WHERE session_date >= CURRENT_DATE - INTERVAL '30 days'" "$(where_out recent_sessions RECENT_DAYS=999)"
eq "改 OPTION_RECENT_DAYS 不动 daily_bar 窗口" \
  "WHERE instrument_id IN (11,22) OR trade_date >= '2026-01-01'" "$(where_out sample_or_recent OPTION_RECENT_DAYS=7)"

where_out 未知策略 >/dev/null 2>&1
code=$?
[ "$code" -ne 0 ] && ok "未知策略 → 非零（§2 靠这个 fail-loud）" \
  || bad "未知策略 → 非零（§2 靠这个 fail-loud）" "非 0" "${code}"

# —— TABLE_POLICIES 注册表的两条硬 invariant ——————————————————————————————————
grep -q '"marketdata.option_daily_snapshot:recent_sessions"' "$SYNC" \
  && ok "option_daily_snapshot 走近窗（唯一无上限增长表）" \
  || bad "option_daily_snapshot 走近窗（唯一无上限增长表）" "recent_sessions" "别的策略"
# 🚨 父表被窗口裁 = 子表 FK 断 = 整个重灌事务回滚（表现是「同步全挂」，不是「少几行」）
grep -q '"marketdata.option_contract:full"' "$SYNC" \
  && ok "option_contract 保持 full（快照的 FK 父表）" \
  || bad "option_contract 保持 full（快照的 FK 父表）" "full" "别的策略"
# 注册表里出现 where_for 不认识的策略 = 09:05 当场 fail-loud，早一步在 CI 拦下
unknown="$(sed -n 's/^  "[a-z0-9_]*\.[a-z0-9_]*:\([a-z_]*\)".*/\1/p' "$SYNC" |
  grep -vxE 'full|sample_or_recent|sample_only|recent_sessions|skip' || true)"
eq "注册表策略值域 ⊆ where_for 已实现的 5 种" "" "$unknown"

# —— drift_verdict：部署漂移判定 ——————————————————————————————————————————————
verdict() { bash -c "set -euo pipefail
$VERDICT_FN
drift_verdict \"\$1\" \"\$2\"" _ "$1" "$2"; }

eq "两侧同 hash → same" "same" "$(verdict aaa aaa)"
eq "两侧不同 hash → drift" "drift" "$(verdict aaa bbb)"
# 🚨 「看不见对面」≠「对面变了」：launchd 无 TCC 读不到仓内源是**每天都会发生**的常态，
#    判成 drift 就是天天误报，而误报会让人学会忽略这条告警。
eq "对面读不到（空 hash）→ unreadable 而非 drift" "unreadable" "$(verdict aaa '')"
eq "自身算不出 → unreadable" "unreadable" "$(verdict '' bbb)"

# —— file_sha256：读不到必须「空串 + 退出 0」——————————————————————————————————
sha() { bash -c "set -euo pipefail
$SHA_FN
file_sha256 \"\$1\"" _ "$1"; }

tmp="$(mktemp "${TMPDIR:-/tmp}/sync-test.XXXXXX")"
printf 'nvy\n' >"$tmp"
expected_sha="$(shasum -a 256 "$tmp" 2>/dev/null | awk '{print $1}')"
[ -n "$expected_sha" ] || expected_sha="$(sha256sum "$tmp" | awk '{print $1}')"
eq "存在的文件 → 与系统 sha256 一致" "$expected_sha" "$(sha "$tmp")"
rm -f "$tmp"

out="$(sha /nonexistent/definitely/not/here.sh)"
code=$?
eq "读不到的文件 → 空串" "" "$out"
# 🚨 sync.sh 是 set -euo pipefail + ERR trap：这里若非零，ERR trap 会把「读不到对面」升级成
#    「同步失败」——而漂移的正确处置是 warn + 继续（旧逻辑通常还能跑出部分数据）。
eq "读不到的文件 → 退出码 0（不许触发 sync.sh 的 ERR trap）" "0" "$code"

if [ "$FAILED" -ne 0 ]; then
  echo "—— FAILED"
  exit 1
fi
echo "—— all green"
exit 0
