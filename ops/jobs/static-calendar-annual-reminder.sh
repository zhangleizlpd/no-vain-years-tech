#!/usr/bin/env bash
#
# static-calendar-annual-reminder.sh — 静态交易日历「年更」覆盖感知提醒（77，每月只读一次）。
#
# 背景：L2 静态离线日历（apps/server/src/marketdata/static-calendar.data.ts）是官方 HKEX
# 年历离线抽出、**入仓 + 人工年更**的常量表（无稳定接口、每年格式微调 ⇒ 不能自动生成，见
# ops/runbook/scheduled-tasks.md#静态交易日历年更）。它只覆盖到某一年 12-31；跨年后 L2 对
# 次年请求会 throw（设计如此，禁返空）。若忘记年更、且主源(腾讯)同时失效 → 日历填充全链失败。
#
# 本脚本把「人有没有按时更新次年日历」变成可观测：读 committed data 文件里的
# STATIC_CALENDAR_COVERAGE.to（77 checkout 由每次 deploy `git reset --hard origin/main` 同步，
# 故反映**已部署**状态，而非仅 merge——催更催到真上 prod 为止），与当前年月比对：
#   - 已覆盖次年             → ✅ exit 0（--on-success silent 静默）
#   - 未覆盖 + Q1–Q3         → ✅ exit 0（次年官方年历尚未到更新期，静默）
#   - 未覆盖 + 10/11 月       → 📅 exit 1（该更新了）
#   - 未覆盖 + 12 月          → 🔴 exit 1（截止在即）
#   - 未覆盖 + 已跨入该年      → 🔴🔴 exit 1（prod 已在风险区）
#   - 数据文件缺失 / 解析失败  → 🔴 exit 1（不静默放过——文件丢了 / 生成脚本格式变了也要有人看）
#
# 判据是**日期算术**：standalone ops probe，照 ops/jobs/cert-expiry-monitor.sh 先例允许 bash
# 阈值判断（044 的「零逻辑 bash」是 feature 宪法 §II 约束，不绑本脚本）。运行时真失败由
# marketdata-calendar-health 探针兜底，本脚本只是**提前**几个月的催更，误判成本极低。
#
# 退出码驱动飞书由外层 nvy-run-reported wrapper 统一推（--on-success silent）；本脚本零飞书 I/O。
#
# Config — optional（一般无需设）：
#   NVY_REPO_DIR             77 上的仓库 checkout（默认 /home/admin/no-vain-years-mono）
#   NVY_STATIC_CALENDAR_FILE 直接指定数据文件（默认 = $NVY_REPO_DIR/apps/server/src/marketdata/static-calendar.data.ts）
#   NVY_FAKE_TODAY           YYYY-MM-DD，注入固定「今天」（本地多态验证用；生产不设 → date）
set -uo pipefail

REPO_DIR="${NVY_REPO_DIR:-/home/admin/no-vain-years-mono}"
DATA_FILE="${NVY_STATIC_CALENDAR_FILE:-${REPO_DIR}/apps/server/src/marketdata/static-calendar.data.ts}"
TODAY="${NVY_FAKE_TODAY:-$(date +%Y-%m-%d)}"

this_year="${TODAY%%-*}"
_mm="${TODAY#*-}"; _mm="${_mm%%-*}"
month=$((10#${_mm}))            # 强制十进制：避免 08/09 被当八进制炸（bash 数值坑）
next_year=$((this_year + 1))

RUNBOOK='ops/runbook/scheduled-tasks.md#静态交易日历年更'

if [ ! -f "$DATA_FILE" ]; then
  echo "🔴 静态日历年更提醒：数据文件不存在 ($DATA_FILE) —— 无法判定次年覆盖，请人工核（checkout 路径 / 是否已部署 ?）。"
  exit 1
fi

# STATIC_CALENDAR_COVERAGE = { from: '....', to: 'YYYY-MM-DD', } —— 取 to 的日期
covered_to="$(grep -A3 'STATIC_CALENDAR_COVERAGE' "$DATA_FILE" \
  | grep -oE "to: *'[0-9]{4}-[0-9]{2}-[0-9]{2}'" \
  | grep -oE '[0-9]{4}-[0-9]{2}-[0-9]{2}' | head -1)"
if [ -z "$covered_to" ]; then
  echo "🔴 静态日历年更提醒：STATIC_CALENDAR_COVERAGE.to 解析失败 ($DATA_FILE) —— 生成脚本格式可能变了，请人工核。"
  exit 1
fi
covered_to_year="${covered_to%%-*}"

if [ "$covered_to_year" -ge "$next_year" ]; then
  echo "✅ 静态交易日历已覆盖次年 (${next_year})，止于 ${covered_to}。无需动作。"
  exit 0
fi

# —— 未覆盖次年 ——
if [ "$this_year" -gt "$covered_to_year" ]; then
  printf '🔴🔴 CRITICAL：已进入 %s，但静态交易日历只覆盖到 %s —— L2 对本年请求会 throw。\n' "$this_year" "$covered_to"
  printf '    若主源(腾讯)同时失效 → 日历填充全链失败。立即跑年更：%s\n' "$RUNBOOK"
  exit 1
fi
if [ "$month" -ge 12 ]; then
  printf '🔴 URGENT：12 月截止在即，静态交易日历尚未更新到 %s（当前止于 %s）。\n' "$next_year" "$covered_to"
  printf '    年更（brew poppler → HKEX %s PDF → gen 脚本 → PR）：%s\n' "$next_year" "$RUNBOOK"
  exit 1
fi
if [ "$month" -ge 10 ]; then
  printf '📅 提醒：该更新次年 (%s) 静态交易日历了（当前止于 %s，须当年 12 月前跑完）。\n' "$next_year" "$covered_to"
  printf '    步骤：%s\n' "$RUNBOOK"
  exit 1
fi

# Q1–Q3 且未覆盖次年 = 正常（次年官方年历尚未发布/无需），静默放行。
echo "✅ 当前 ${TODAY}，静态交易日历覆盖到 ${covered_to}（当年）—— 次年年历尚未到更新期（Q4 起提醒）。"
exit 0
