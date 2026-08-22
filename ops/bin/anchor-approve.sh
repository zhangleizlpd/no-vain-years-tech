#!/usr/bin/env bash
# 按市场审批 optionsdesk.anchor_submission 待审箱 —— 三动词 plan / apply / watch。
#
# 为什么是一个确定性脚本, 而不是让模型跑 curl 循环 (这条判据别删):
#   · 直写口限频 **6 次/分** 且是漏桶 nodelay (429 当场拒不排队) ⇒ 上百条必须节流 + 退避
#     + 断点续跑, 这三件事靠模型自觉必漂;
#   · 一次 `action=create` 会让 prod 当日采集为该标的多做一整轮历史回填 (冷启动 worker
#     concurrency=1, 分钟级) ⇒ 批量建锚是**数小时的真 vendor 外呼**, 不是一次 HTTP;
#   · `anchor_submission.status` 服务端**没有任何采纳端点**能翻 (migration 注释写死「采纳与否
#     由人逐行判断」) ⇒ 翻 CONSUMED 只能 DB 直写, 必须与导入成功严格同序, 否则下轮重导。
#
# 采纳的语义单点在 apps/server/src/optionsdesk/optionsdesk-guest.controller.ts:
#   「采纳 = 本人用自己的凭证把同样的值经导入口重放一次」—— 本脚本就是那句话的机器实现,
#   **不是第二条写锚路径** (FR-012)。
#
# 用法:
#   anchor-approve.sh plan     <us|hk>
#   anchor-approve.sh apply    <us|hk> [--confirm] [--limit N] [--only T1,T2] [--include-existing]
#                                      [--shift-suspect-asof | --allow-suspect-asof]
#   anchor-approve.sh fix-asof <us|hk> [--confirm] [--only T1,T2]   # 修已有锚自己的口径日
#   anchor-approve.sh watch    <us|hk> [--interval S] [--timeout S]
#
# 🚨 apply 不带 --confirm 时**只打复述表不发送** —— 这道闸没有例外分支, 判据与背书见
#    .claude/commands/anchor-import.md「第三步」。
#
# 前置 (都在仓外, 仓内零标识符 per docs/conventions/information-boundary.md):
#   · ~/.nvy/fleet.env 的 NVY_APP_SSH        —— prod ssh 目标
#   · ~/.config/nvy-futu/token               —— 通道凭证 (本机持有者本人)
#   · wg2 隧道已起 (脚本用 /healthz 自检, 不用 wg show)

set -euo pipefail

readonly SCRIPT_NAME="${0##*/}"

# ── 可覆盖配置 ────────────────────────────────────────────────────────────────
FLEET_ENV="${NVY_FLEET_ENV:-$HOME/.nvy/fleet.env}"
TOKEN_FILE="${NVY_FUTU_TOKEN_FILE:-$HOME/.config/nvy-futu/token}"
CHANNEL_BASE="${NVY_CHANNEL_BASE:-http://10.90.0.1:8811}"
PG_CONTAINER="${NVY_PG_CONTAINER:-nvy-tight-postgres-1}"
LEDGER_DIR="${NVY_ANCHOR_LEDGER_DIR:-$HOME/.nvy/anchor-approve}"

# 🚨 psql 输出的字段分隔符必须是**非空白字符**。用 TAB 会踩 POSIX 的一条硬规则: tab 是 IFS
# 空白字符 ⇒ `IFS=$'\t' read` 把**连续的 tab 折叠成一个分隔符**, 于是「中间某列为空」的行整体
# 错位一格 —— 后面每个变量都读到上一列的值, 最后一个变量拿到空串。
# ⚠️ 这个 bug**只在 read 侧**: `awk -F'\t'` 单字符 FS 不折叠 ⇒ **复述表打出来是对的、发出去的
#    却是错的**, 没有任何一屏输出能揭示它 (2026-08-22 实撞: fix-asof 4 条全送出 asof="" 吃 400)。
# 0x1F (ASCII Unit Separator) 不是空白字符, read 逐列严格切分; 且它不可能出现在这些库值里。
# ⚠️ ledger 文件仍是 tab 分隔 —— 那边只由 awk 解析、不走 read, 不受此规则影响, 别一并改。
readonly SEP=$'\037'

# 直写口 6 次/分的漏桶 ⇒ 每 10 秒补一格。11 秒留 1 秒余量, 稳态不该见到 429。
PACE_SECONDS="${NVY_ANCHOR_PACE:-11}"
# 429 是「当场拒、没排队」⇒ 退避后重发, 不并发。
RETRY_429_MAX=3
RETRY_429_SLEEP=30

WATCH_INTERVAL=30
WATCH_TIMEOUT=3600

# ── 基础 ─────────────────────────────────────────────────────────────────────
die() { printf '%s: %s\n' "$SCRIPT_NAME" "$*" >&2; exit 1; }
log() { printf '%s\n' "$*" >&2; }
rule() { printf -- '─%.0s' $(seq 1 78); printf '\n'; }

usage() {
  sed -n '4,30p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-1}"
}

require_market() {
  case "$1" in
    # 通道的市场闸只放这两个 (nginx `$arg_ticker !~ "^(us|hk):"`), 服务端那份判据在
    # apps/server/src/optionsdesk/anchor-import.rules.ts。两处是独立文本、会漂, 这里是第三处
    # ⇒ 只做「早失败」用, **不是权威**: 真判据以服务端 400 为准。
    us|hk) : ;;
    *) die "market 只能是 us / hk (拿到 '$1')" ;;
  esac
}

resolve_ssh() {
  [ -r "$FLEET_ENV" ] || die "读不到 $FLEET_ENV —— 主机标识不入仓, 见 information-boundary.md"
  local v
  v="$(sed -n 's/^NVY_APP_SSH=//p' "$FLEET_ENV" | head -1 | sed 's/#.*//' | tr -d '"'\''' | xargs || true)"
  [ -n "$v" ] || die "$FLEET_ENV 里没有 NVY_APP_SSH"
  printf '%s' "$v"
}

resolve_token() {
  local t="${NVY_FUTU_TOKEN:-}"
  [ -n "$t" ] || t="$(cat "$TOKEN_FILE" 2>/dev/null || true)"
  [ -n "$t" ] || die "取不到通道凭证 ($TOKEN_FILE) —— 停下来问用户要, 别继续瞎试"
  printf '%s' "$t"
}

# SQL 走 ssh stdin, 远端只组装 psql 一条命令。
# -qAt -F 0x1F: 无对齐、只出元组、Unit Separator 分隔 ⇒ while-read 逐列严格切分 (见 SEP 那条)。
# ⚠️ psql 的 -U/-d 取容器内 env (实为 mbw/mbw), 硬编码 postgres 会 FATAL。
psql_tsv() {
  local sql="$1"
  printf '%s\n' "$sql" | ssh -o ConnectTimeout=15 "$SSH_TARGET" \
    "docker exec -i $PG_CONTAINER sh -c 'psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -v ON_ERROR_STOP=1 -qAt -F \"\$(printf \"\\037\")\" -P pager=off'"
}

healthz() {
  curl -sS -m 10 --noproxy '*' -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" "$CHANNEL_BASE/healthz" 2>/dev/null || printf '000'
}

# 🚨 curl 必带 --noproxy '*': 交互 shell 的代理变量会让请求绕出隧道, 拿到的失败与
#    「隧道没起」不可区分。
preflight() {
  local code; code="$(healthz)"
  case "$code" in
    200) : ;;
    000) die "隧道不通 (healthz=000)。请自行跑: sudo wg-quick up ~/.config/wireguard/wg2.conf" ;;
    401) die "通道凭证不对 (healthz=401)" ;;
    *)   die "通道异常 healthz=$code" ;;
  esac
}

# $2 = 可选后缀。fix-asof 刻意**不写 apply 的 ledger**: 那个文件同时是 apply 的断点续跑去重集
# 与 watch 的锚 id 来源, 往里塞 update 行会让「这只票导过了」与「这只票修过 asof」互相污染。
ledger_file() { printf '%s/%s%s.tsv' "$LEDGER_DIR" "$1" "${2:-}"; }

# ── plan ─────────────────────────────────────────────────────────────────────
# 一次查询同时回答两个问题: 待审箱里有什么 + 每条落地会是 create 还是 refresh。
# 复杂度 O(n) —— seq scan 十几~上百行 + 对 anchor.ticker 唯一键的点查, 表本身刻意只建 PK。
plan_rows() {
  local market="$1" tz
  case "$market" in us) tz='America/New_York' ;; hk) tz='Asia/Hong_Kong' ;; esac
  # 第 10 列 asof_shifted = 「该 asof 的前一个**真交易日**」, 只对 FUTURE / WEEKEND 行求值。
  # 🚨 判据取自 marketdata.trading_day (有行即交易日), **不是** 「往前退到周五」的星期算术 ——
  #    后者躲不过节假日, 会把 V 的口径日挪到一个同样不存在收盘价的日子上。
  #    日历缺行 ⇒ 求值为空串 ⇒ apply 侧 fail-closed 拦下, 不猜。
  psql_tsv "SELECT id, ticker, v, asof, method, confidence, submitter, disposition, asof_flag,
                   CASE WHEN asof_flag IN ('FUTURE','WEEKEND')
                        THEN COALESCE((SELECT max(t.date)::text FROM marketdata.trading_day t
                                        WHERE t.market = '${market}' AND t.date < asof), '')
                        ELSE '' END AS asof_shifted
            FROM (
              SELECT s.id, s.ticker, s.v, s.asof, s.method, s.confidence, s.submitter,
                     CASE WHEN a.ticker IS NULL THEN 'create' ELSE 'refresh' END AS disposition,
                     CASE
                       WHEN s.asof > (now() AT TIME ZONE '${tz}')::date THEN 'FUTURE'
                       WHEN EXTRACT(ISODOW FROM s.asof) >= 6            THEN 'WEEKEND'
                       WHEN s.asof = (now() AT TIME ZONE '${tz}')::date THEN 'TODAY'
                       ELSE ''
                     END AS asof_flag
              FROM optionsdesk.anchor_submission s
              LEFT JOIN optionsdesk.anchor a ON a.ticker = s.ticker
              WHERE s.status = 'PENDING' AND s.ticker LIKE '${market}:%'
            ) q
            ORDER BY id;"
}

# asof = 「算这个 V 时取的那个收盘价对应的交易日」。三种机器判得出的必错形态:
#   FUTURE  —— 晚于该市场当前日历日, 那天的收盘价还不存在
#   WEEKEND —— 落在周六周日
#   TODAY   —— 当天; 只有该场已收盘才成立, 收盘状态本查询判不了 ⇒ 只警告不拦
# 🚨 **这三条判不了节假日**: 无 FLAG 不等于已验证是交易日, 别向用户宣称验过
#    (判据同 .claude/commands/anchor-import.md 的 asof 一节)。

print_table() {
  # stdin: id \t ticker \t v \t asof \t method \t confidence \t submitter \t disposition
  awk -F"$SEP" '
    BEGIN {
      # 表头宽度是**字节数**加过料的: awk 的 %-Ns 按字节补齐, 而中日韩字每字 3 字节占 2 列
      # ⇒ 直接照数据行的宽度写, 表头必然错位 (每个 CJK 字多吃 1 列)。
      printf "%-6s %-12s %12s %-14s %-24s %9s %-13s %-8s %-11s %s\n",
             "id","标的","V","口径日","方法","置信度","提交方","落地","asof 存疑","修正为"
    }
    { printf "%-6s %-10s %12s %-11s %-22s %6s %-10s %-8s %-9s %s\n",
             $1,$2,$3,$4,$5,$6,$7,$8,$9,($10=="" ? "" : "→ " $10) }
  '
}

cmd_plan() {
  local market="$1"; require_market "$market"
  SSH_TARGET="$(resolve_ssh)"
  local rows; rows="$(plan_rows "$market")"
  if [ -z "$rows" ]; then
    log "待审箱里没有 market=$market 的 PENDING 条目。"
    return 0
  fi
  local total create refresh
  total="$(printf '%s\n' "$rows" | wc -l | tr -d ' ')"
  create="$(printf '%s\n' "$rows" | awk -F"$SEP" '$8=="create"' | wc -l | tr -d ' ')"
  refresh="$(printf '%s\n' "$rows" | awk -F"$SEP" '$8=="refresh"' | wc -l | tr -d ' ')"

  rule
  printf 'PENDING · market=%s · 共 %s 条 (新建 %s / 刷新既有锚 %s)\n' "$market" "$total" "$create" "$refresh"
  rule
  printf '%s\n' "$rows" | print_table
  rule
  if [ "$refresh" -gt 0 ]; then
    cat <<EOF
⚠️  上表 $refresh 条 disposition=refresh 的标的**你已经有锚**。重放会把 confidence_source
    翻成 model 并按路径 ① 回落三处人工位 (vManual / lLevelManual / positionCapManual),
    回执里出 fallbackEntries。apply 默认**跳过**它们; 要一并刷新加 --include-existing。
EOF
  fi
  printf '下一步: %s apply %s --limit 5      # 先打复述表, 不发送\n' "$SCRIPT_NAME" "$market" >&2
}

# ── apply ────────────────────────────────────────────────────────────────────
import_one() {
  # $1 ticker  $2 v  $3 asof  $4 method  $5 confidence
  # 🚨 ticker 原样写进 URL, 绝不走 --url-query: 那个选项会把冒号编码成 %3a, 而通道的市场闸
  #    **不解码**就比对前缀 ⇒ 必然 400 且怎么改参数都过不去 (能力目录实测记录)。
  curl -sS -m 60 --noproxy '*' -X POST \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -w '\n%{http_code}' \
    -d "$(jq -nc --arg v "$2" --arg asof "$3" --arg method "$4" --arg confidence "$5" \
            '{v:$v, asof:$asof, method:$method, confidence:$confidence}')" \
    "$CHANNEL_BASE/anchor-import?ticker=$1"
}

mark_consumed() {
  psql_tsv "UPDATE optionsdesk.anchor_submission
            SET status = 'CONSUMED', updated_at = now()
            WHERE id = $1 AND status = 'PENDING'
            RETURNING id;"
}

cmd_apply() {
  local market="$1"; shift; require_market "$market"
  local confirm=0 limit=0 only="" include_existing=0 allow_suspect=0 shift_suspect=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --confirm)            confirm=1; shift ;;
      --limit)              limit="${2:?--limit 要个数字}"; shift 2 ;;
      --only)               only="${2:?--only 要逗号分隔的 ticker}"; shift 2 ;;
      --include-existing)   include_existing=1; shift ;;
      --allow-suspect-asof) allow_suspect=1; shift ;;
      --shift-suspect-asof) shift_suspect=1; shift ;;
      --pace)               PACE_SECONDS="${2:?--pace 要秒数}"; shift 2 ;;
      *) die "apply 不认识的参数: $1" ;;
    esac
  done
  # 两个旗子处置方向相反 (照发 vs 改日期), 同时给等于没想清楚要哪个 ⇒ 直接拒。
  [ "$allow_suspect" -eq 1 ] && [ "$shift_suspect" -eq 1 ] && \
    die "--allow-suspect-asof 与 --shift-suspect-asof 互斥, 只能选一个"

  SSH_TARGET="$(resolve_ssh)"
  TOKEN="$(resolve_token)"
  preflight

  mkdir -p "$LEDGER_DIR"
  local ledger; ledger="$(ledger_file "$market")"
  [ -f "$ledger" ] || printf '# ts\tsubmission_id\tticker\taction\tanchor_id\thttp\tnote\n' > "$ledger"

  # 选集: plan → 去掉 refresh (除非 --include-existing) → --only 白名单 → 断点续跑去重 → --limit
  local selected; selected="$(plan_rows "$market")"
  [ -n "$selected" ] || { log "待审箱里没有 market=$market 的 PENDING 条目。"; return 0; }

  if [ "$include_existing" -eq 0 ]; then
    selected="$(printf '%s\n' "$selected" | awk -F"$SEP" '$8=="create"')"
  fi
  if [ -n "$only" ]; then
    selected="$(printf '%s\n' "$selected" | awk -F"$SEP" -v want=",$only," 'index(want, "," $2 ",") > 0')"
  fi
  # 断点续跑: ledger 里已成功导入过的 ticker 不再重发 —— 直写口**没有幂等**, 重发 = 库里
  # 被写两次 + 痕迹表多一条。
  if [ -s "$ledger" ]; then
    local done_list
    done_list="$(awk -F'\t' '$1 !~ /^#/ && $6=="201" {printf ",%s", $3} END{print ","}' "$ledger")"
    selected="$(printf '%s\n' "$selected" | awk -F"$SEP" -v done_l="$done_list" 'index(done_l, "," $2 ",") == 0')"
  fi
  selected="$(printf '%s\n' "$selected" | sed '/^$/d')"
  [ -n "$selected" ] || { log "选集为空 (可能都已在 ledger 里导入过)。"; return 0; }
  if [ "$limit" -gt 0 ]; then
    selected="$(printf '%s\n' "$selected" | head -n "$limit")"
  fi

  local n; n="$(printf '%s\n' "$selected" | wc -l | tr -d ' ')"

  # ── 复述闸 (无例外分支) ────────────────────────────────────────────────────
  rule
  printf '待发送 %s 条 · market=%s · 直写口 %s/anchor-import\n' "$n" "$market" "$CHANNEL_BASE"
  rule
  printf '%s\n' "$selected" | print_table
  rule

  # fail-closed: asof 明确必错的两种形态直接拦下, 不靠人眼在上百行里逮。
  local suspect; suspect="$(printf '%s\n' "$selected" | awk -F"$SEP" '$9=="FUTURE" || $9=="WEEKEND"')"
  if [ -n "$suspect" ]; then
    if [ "$shift_suspect" -eq 1 ]; then
      # 改日期这条路自己也要 fail-closed: 日历解不出前一个交易日 ⇒ 无从修正, 不许硬送。
      local unresolvable; unresolvable="$(printf '%s\n' "$suspect" | awk -F"$SEP" '$10==""')"
      if [ -n "$unresolvable" ]; then
        printf '🚨 以下条目 asof 存疑, 但交易日历解不出它之前的交易日 ⇒ 无从修正:\n' >&2
        printf '%s\n' "$unresolvable" | awk -F"$SEP" '{printf "  id=%-6s %-10s asof=%s  [%s]\n", $1,$2,$4,$9}' >&2
        die "日历缺行, 不猜日期。先补日历或用 --only 绕开这些条目"
      fi
      printf '📌 %s 条 asof 存疑将按**交易日历**改送前一个交易日 (上表「修正为」列):\n' \
        "$(printf '%s\n' "$suspect" | wc -l | tr -d ' ')" >&2
      printf '%s\n' "$suspect" | awk -F"$SEP" '{printf "  %-10s %s [%s] → %s\n", $2,$4,$9,$10}' >&2
      printf '⚠️  改的是**估值口径日**这条溯源信息, 不是 V —— 只有当提交方确属「把批次日当成口径日」\n' >&2
      printf '    时才成立。若他其实是按那个周末的**前一周**收盘算的, 这个修正一样是错的。\n' >&2
    elif [ "$allow_suspect" -eq 0 ]; then
      printf '🚨 以下条目的 asof 机器判定必错 (那天的收盘价不存在), 已拦下整批:\n' >&2
      printf '%s\n' "$suspect" | awk -F"$SEP" '{printf "  id=%-6s %-10s asof=%s  [%s]\n", $1,$2,$4,$9}' >&2
      die "先核实这些条目 (或 --only 绕开); 照发加 --allow-suspect-asof, 改送前一交易日加 --shift-suspect-asof"
    fi
  fi
  if printf '%s\n' "$selected" | awk -F"$SEP" '$9=="TODAY"' | grep -q .; then
    printf '⚠️  有条目的 asof = 该市场的今天 —— 只有那场**已收盘**才成立, 本脚本判不了收盘状态。\n' >&2
  fi

  if [ "$confirm" -ne 1 ]; then
    cat >&2 <<EOF
未发送 —— 这是复述闸。核对以上每一行:
  · 标的市场对吗？两地上市的选对边了吗？
  · V 的币种与市场匹配吗 (us→美元 / hk→港元)？每股还是每 ADS？
  · 口径日是收盘价那天吗？晚于最近一个已收盘 session 吗？落在周末吗？
  · 置信度是 10 分制吗 (0-1 制会静默落成「0.6 分」, 没有任何东西会告诉你)？
确认无误后重跑并加 --confirm。
EOF
    return 0
  fi

  local created=0 updated=0 noop=0 failed=0 i=0
  # submitter / disposition / asof_flag 在循环体内不用, 但**必须占位读掉** —— read 的最后一个
  # 变量会吞下剩余所有字段, 少一个位 disposition 就会变成 "create<TAB>WEEKEND"。
  # shellcheck disable=SC2034
  while IFS="$SEP" read -r id ticker v asof method confidence submitter disposition asof_flag asof_shifted; do
    [ -n "$ticker" ] || continue
    i=$((i + 1))
    [ "$i" -eq 1 ] || sleep "$PACE_SECONDS"

    # 真正送出去的口径日: 只有开了 --shift-suspect-asof 且该行确有修正值时才改。
    local send_asof="$asof"
    if [ "$shift_suspect" -eq 1 ] && [ -n "$asof_shifted" ]; then send_asof="$asof_shifted"; fi

    local attempt=0 resp="" code="" body=""
    while :; do
      resp="$(import_one "$ticker" "$v" "$send_asof" "$method" "$confidence" || true)"
      code="$(printf '%s' "$resp" | tail -1)"
      body="$(printf '%s' "$resp" | sed '$d')"
      if [ "$code" = "429" ] && [ "$attempt" -lt "$RETRY_429_MAX" ]; then
        attempt=$((attempt + 1))
        log "[$i/$n] $ticker 429 限频 → 退避 ${RETRY_429_SLEEP}s 后第 $attempt 次重发"
        sleep "$RETRY_429_SLEEP"
        continue
      fi
      break
    done

    if [ "$code" != "201" ]; then
      failed=$((failed + 1))
      local detail; detail="$(printf '%s' "$body" | jq -r '.detail // .message // .' 2>/dev/null | head -1)"
      log "[$i/$n] ✗ $ticker HTTP $code — $detail"
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$(date -u +%FT%TZ)" "$id" "$ticker" "-" "-" "$code" "${detail//$'\t'/ }" >> "$ledger"
      continue
    fi

    local action anchor_id fallbacks
    action="$(printf '%s' "$body" | jq -r '.action')"
    anchor_id="$(printf '%s' "$body" | jq -r '.anchor.id')"
    fallbacks="$(printf '%s' "$body" | jq -c '.fallbackEntries')"

    case "$action" in
      create) created=$((created + 1)) ;;
      update) updated=$((updated + 1)) ;;
      noop)   noop=$((noop + 1)) ;;
    esac

    # 口径日被改过的行必须在 ledger 留痕 —— 锚表此后只存修正后的值, **原值只剩这一处**。
    local shift_note=""
    [ "$send_asof" = "$asof" ] || shift_note=" asof:${asof}→${send_asof}"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$(date -u +%FT%TZ)" "$id" "$ticker" "$action" "$anchor_id" "$code" "${fallbacks}${shift_note}" >> "$ledger"
    log "[$i/$n] ✓ $ticker action=$action anchor_id=$anchor_id${shift_note}"

    # 🚨 fallbackEntries 非空 = 这次导入冲掉了你手动调过的判断, **禁静默回落** ⇒ 原样打出来。
    if [ "$fallbacks" != "[]" ]; then
      printf '%s' "$body" | jq -r '.fallbackEntries[] |
        "      ⚠ 人工位被冲: \(.slot) 原值 \(.manualValue) → 回落 \(.fallbackValue)"' >&2
    fi

    # 翻 CONSUMED 严格后置于导入成功 —— 反过来会在导入失败时把条目从待审箱里弄丢。
    if [ -z "$(mark_consumed "$id")" ]; then
      log "      ⚠ submission id=$id 的 status 未翻转 (可能已非 PENDING), 请人工核对"
    fi
  done <<EOF
$selected
EOF

  rule
  printf '完成: create=%s update=%s noop=%s failed=%s (ledger: %s)\n' \
    "$created" "$updated" "$noop" "$failed" "$ledger"
  if [ "$created" -gt 0 ]; then
    printf '\n%s 只**新锚**已建 ⇒ 已各自触发一次冷启动 (outbox relay 10s 一轮 → BullMQ,\n' "$created"
    printf 'worker concurrency=1 分钟级串行)。下一步: %s watch %s\n' "$SCRIPT_NAME" "$market"
  fi
}

# ── fix-asof ─────────────────────────────────────────────────────────────────
# 修**已存在的锚**自己的口径日, 与 apply 是两件事:
#   apply    —— 把访客提交的 (v, asof, method, confidence) 整组送进来 = 采纳他的估值
#   fix-asof —— 把锚**自己现有**的 (v, method, confidence) 原样重放, 只换 asof
# 二者都打同一个直写口 (FR-012: 系统 MUST NOT 存在第二条写锚路径) ⇒ 痕迹表照常记录,
# PIT 还原 (GET /anchors/:id/at) 仍然正确。**不要**用裸 SQL 改 asof 来「省掉副作用」。
#
# 🚨 副作用无法规避: buildModelImportPatch 里 confidenceSource:'model' 是**无条件写死**的,
#    没有保留分支 ⇒ 本动词必然把 manual 源翻成 model, 此后 App 内改不动该锚置信度且无回头路
#    (update-anchor 对 model 源硬拒改 confidence)。所以下面对 manual 源逐条点名再问。
cmd_fix_asof() {
  local market="$1"; shift; require_market "$market"
  local confirm=0 only="" include_manual_slots=0 tz
  while [ $# -gt 0 ]; do
    case "$1" in
      --confirm)              confirm=1; shift ;;
      --only)                 only="${2:?--only 要逗号分隔的 ticker}"; shift 2 ;;
      --include-manual-slots) include_manual_slots=1; shift ;;
      --pace)                 PACE_SECONDS="${2:?--pace 要秒数}"; shift 2 ;;
      *) die "fix-asof 不认识的参数: $1" ;;
    esac
  done
  case "$market" in us) tz='America/New_York' ;; hk) tz='Asia/Hong_Kong' ;; esac

  SSH_TARGET="$(resolve_ssh)"
  TOKEN="$(resolve_token)"
  preflight

  # 送出去的 v 取 a.v (**模型 V**) 而不是 COALESCE(v_manual, a.v): 导入会把 vManual 清空,
  # 送生效 V 等于把人工值固化成模型值 —— 那是另一件事, 不许在「修 asof」里顺手做。
  local rows; rows="$(psql_tsv "SELECT a.id, a.ticker, a.v, a.asof, to_char(a.asof,'Dy'),
                                       a.method, a.confidence, a.confidence_source,
                                       CASE WHEN a.v_manual IS NOT NULL
                                              OR a.l_level_manual IS NOT NULL
                                              OR a.position_cap_manual IS NOT NULL
                                            THEN 'MANUAL-SLOT' ELSE '' END,
                                       COALESCE((SELECT max(t.date)::text FROM marketdata.trading_day t
                                                  WHERE t.market = '${market}' AND t.date < a.asof), '')
                                FROM optionsdesk.anchor a
                                WHERE a.ticker LIKE '${market}:%'
                                  AND (EXTRACT(ISODOW FROM a.asof) >= 6
                                       OR a.asof > (now() AT TIME ZONE '${tz}')::date)
                                ORDER BY a.id;")"
  rows="$(printf '%s\n' "$rows" | sed '/^$/d')"
  [ -n "$rows" ] || { log "market=$market 的锚表里没有口径日落在周末 / 未来的锚。"; return 0; }
  if [ -n "$only" ]; then
    rows="$(printf '%s\n' "$rows" | awk -F"$SEP" -v want=",$only," 'index(want, "," $2 ",") > 0')"
    [ -n "$rows" ] || { log "--only 过滤后选集为空。"; return 0; }
  fi

  # fail-closed 之一: 日历解不出前一交易日 ⇒ 无从修正。
  local unresolvable; unresolvable="$(printf '%s\n' "$rows" | awk -F"$SEP" '$10==""')"
  if [ -n "$unresolvable" ]; then
    printf '🚨 交易日历解不出这些锚的前一个交易日, 不猜:\n' >&2
    printf '%s\n' "$unresolvable" | awk -F"$SEP" '{printf "  id=%-4s %-10s asof=%s\n", $1,$2,$4}' >&2
    die "先补日历, 或用 --only 绕开"
  fi

  local n; n="$(printf '%s\n' "$rows" | wc -l | tr -d ' ')"
  rule
  printf '待修口径日 %s 条 · market=%s —— **只换 asof, V / method / 置信度原样重放**\n' "$n" "$market"
  rule
  printf '%s\n' "$rows" | awk -F"$SEP" '
    BEGIN { printf "%-4s %-12s %10s %-13s %-5s %-24s %9s %-12s %s\n",
                   "id","标的","V","现口径日","星期","方法","置信度","来源","改为" }
    { printf "%-4s %-10s %10s %-11s %-5s %-22s %6s %-10s → %s%s\n",
             $1,$2,$3,$4,$5,$6,$7,$8,$10,($9=="" ? "" : "  [" $9 "]") }'
  rule

  # fail-closed 之二: 有人工位的锚, 这次重放会把人工位一并回落 ⇒ 生效 V / 档位会变, 不是「只换 asof」。
  local with_slots; with_slots="$(printf '%s\n' "$rows" | awk -F"$SEP" '$9!=""')"
  if [ -n "$with_slots" ] && [ "$include_manual_slots" -eq 0 ]; then
    printf '🚨 以下锚设了人工位, 重放会把它们一并回落 ⇒ **生效 V / 档位会变**, 不再是「只换 asof」:\n' >&2
    printf '%s\n' "$with_slots" | awk -F"$SEP" '{printf "  id=%-4s %-10s [%s]\n", $1,$2,$9}' >&2
    die "确要连人工位一起回落加 --include-manual-slots, 否则用 --only 绕开它们"
  fi

  local manual_src; manual_src="$(printf '%s\n' "$rows" | awk -F"$SEP" '$8=="manual"')"
  if [ -n "$manual_src" ]; then
    printf '⚠️  以下 %s 只锚现在是 manual 源, 本次重放后**不可逆**翻成 model ⇒ 此后 App 里改不动它们的置信度:\n' \
      "$(printf '%s\n' "$manual_src" | wc -l | tr -d ' ')" >&2
    printf '%s\n' "$manual_src" | awk -F"$SEP" '{printf "  %-10s confidence=%s\n", $2,$7}' >&2
  fi

  if [ "$confirm" -ne 1 ]; then
    printf '\n未发送 —— 复述闸。确认无误后重跑并加 --confirm。\n' >&2
    return 0
  fi

  mkdir -p "$LEDGER_DIR"
  local ledger; ledger="$(ledger_file "$market" '-fix-asof')"
  [ -f "$ledger" ] || printf '# ts\tanchor_id\tticker\taction\tasof_old\tasof_new\thttp\tnote\n' > "$ledger"

  local ok=0 failed=0 i=0
  # dow / src / slot 循环体内不用, 但必须占位读掉 (理由同 cmd_apply 那处)。
  # shellcheck disable=SC2034
  while IFS="$SEP" read -r aid ticker v asof dow method confidence src slot newasof; do
    [ -n "$ticker" ] || continue
    i=$((i + 1))
    [ "$i" -eq 1 ] || sleep "$PACE_SECONDS"

    local attempt=0 resp="" code="" body=""
    while :; do
      resp="$(import_one "$ticker" "$v" "$newasof" "$method" "$confidence" || true)"
      code="$(printf '%s' "$resp" | tail -1)"
      body="$(printf '%s' "$resp" | sed '$d')"
      if [ "$code" = "429" ] && [ "$attempt" -lt "$RETRY_429_MAX" ]; then
        attempt=$((attempt + 1))
        log "[$i/$n] $ticker 429 限频 → 退避 ${RETRY_429_SLEEP}s 后第 $attempt 次重发"
        sleep "$RETRY_429_SLEEP"
        continue
      fi
      break
    done

    if [ "$code" != "201" ]; then
      failed=$((failed + 1))
      local detail; detail="$(printf '%s' "$body" | jq -r '.detail // .message // .' 2>/dev/null | head -1)"
      log "[$i/$n] ✗ $ticker HTTP $code — $detail"
      printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
        "$(date -u +%FT%TZ)" "$aid" "$ticker" "-" "$asof" "$newasof" "$code" "${detail//$'\t'/ }" >> "$ledger"
      continue
    fi

    ok=$((ok + 1))
    local action fallbacks
    action="$(printf '%s' "$body" | jq -r '.action')"
    fallbacks="$(printf '%s' "$body" | jq -c '.fallbackEntries')"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "$(date -u +%FT%TZ)" "$aid" "$ticker" "$action" "$asof" "$newasof" "$code" "$fallbacks" >> "$ledger"
    log "[$i/$n] ✓ $ticker action=$action asof:${asof}→${newasof}"
    if [ "$fallbacks" != "[]" ]; then
      printf '%s' "$body" | jq -r '.fallbackEntries[] |
        "      ⚠ 人工位被冲: \(.slot) 原值 \(.manualValue) → 回落 \(.fallbackValue)"' >&2
    fi
    # 🚨 action=create 就是异常: 本动词只该修**已存在**的锚, 建出新锚说明 ticker 对不上。
    [ "$action" = "create" ] && log "      🚨 意外 action=create —— 该锚本应已存在, 请核对 ticker"
  done <<EOF
$rows
EOF

  rule
  printf '完成: 成功=%s 失败=%s (ledger: %s)\n' "$ok" "$failed" "$ledger"
  printf '⚠️  本动词不建新锚 ⇒ **不触发冷启动**, 无需跑 watch。\n'
}

# ── watch ────────────────────────────────────────────────────────────────────
# 冷启动的**唯一结局面**是 marketdata.anchor_cold_start_run (一锚一行, PK=anchor_id)。
# 「还没出行」= 排队中或正在跑; 八种 outcome 全是终态。
cmd_watch() {
  local market="$1"; shift; require_market "$market"
  while [ $# -gt 0 ]; do
    case "$1" in
      --interval) WATCH_INTERVAL="${2:?--interval 要秒数}"; shift 2 ;;
      --timeout)  WATCH_TIMEOUT="${2:?--timeout 要秒数}"; shift 2 ;;
      *) die "watch 不认识的参数: $1" ;;
    esac
  done

  SSH_TARGET="$(resolve_ssh)"
  local ledger; ledger="$(ledger_file "$market")"
  [ -f "$ledger" ] || die "没有 ledger ($ledger) —— 先跑 apply"

  # 只盯本市场 ledger 里 action=create 的锚: update / noop 不发建锚事件, 不该期待它们出行。
  local ids; ids="$(awk -F'\t' '$1 !~ /^#/ && $4=="create" && $5 != "-" {printf "%s,", $5}' "$ledger" | sed 's/,$//')"
  [ -n "$ids" ] || { log "ledger 里没有 action=create 的锚, 冷启动无需等待。"; return 0; }
  local expect; expect="$(printf '%s\n' "$ids" | tr ',' '\n' | sort -u | wc -l | tr -d ' ')"

  local start; start="$(date +%s)"
  while :; do
    local rows; rows="$(psql_tsv "SELECT r.ticker, r.outcome, COALESCE(r.target_session::text,'-'),
                                         to_char(r.last_run_at AT TIME ZONE 'Asia/Shanghai','MM-DD HH24:MI'),
                                         COALESCE(replace(r.reason, E'\n', ' '),'')
                                  FROM marketdata.anchor_cold_start_run r
                                  WHERE r.anchor_id IN ($ids)
                                  ORDER BY r.last_run_at;")"
    # 🚨 必须 printf '%s\n' 而不是 '%s': wc -l 数的是**换行符**, 而 BSD sed 不给末行补换行
    #    ⇒ 少一个 \n 就恒少数 1 行 (只有 1 行时直接成 0, 表现为「永远 0/N」)。
    local got; got="$(printf '%s\n' "$rows" | sed '/^$/d' | wc -l | tr -d ' ')"
    local elapsed; elapsed=$(( $(date +%s) - start ))

    printf '\r\033[K[%4ds] 冷启动 %s/%s 已出结局' "$elapsed" "$got" "$expect" >&2
    if [ "$got" -ge "$expect" ] || [ "$elapsed" -ge "$WATCH_TIMEOUT" ]; then
      printf '\n' >&2
      rule
      printf '%s\n' "$rows" | awk -F"$SEP" '
        BEGIN { printf "%-10s %-20s %-11s %-12s %s\n", "标的","结局","目标交易日","最后一跑","reason" }
        { printf "%-10s %-20s %-11s %-12s %s\n", $1,$2,$3,$4,$5 }'
      rule
      printf '%s\n' "$rows" | awk -F"$SEP" '{c[$2]++} END {for (o in c) printf "  %-22s %s\n", o, c[o]}'
      # 这四种是「做了但没成」或「判不了」⇒ 要人管; 与「本就不该做」(market_not_enabled /
      # already_present / intraday_skipped) 语义相反, FR-027 明禁折叠成一类。
      local attention
      attention="$(printf '%s\n' "$rows" | awk -F"$SEP" '$2 ~ /^(retry_exhausted|backfill_incomplete|calendar_missing|session_unregistered|ticker_unresolved)$/')"
      if [ -n "$attention" ]; then
        rule
        printf '🚨 需要人工介入 (期权 EOD 无跨日补救, 这些是永久缺口):\n'
        printf '%s\n' "$attention" | awk -F"$SEP" '{printf "  %-10s %-22s %s\n", $1,$2,$5}'
      fi
      [ "$elapsed" -ge "$WATCH_TIMEOUT" ] && [ "$got" -lt "$expect" ] && \
        printf '\n⏱  超时退出: 还有 %s 只未出结局 (队列串行, 可再跑一次 watch)\n' "$((expect - got))"
      return 0
    fi
    sleep "$WATCH_INTERVAL"
  done
}

# ── 入口 ─────────────────────────────────────────────────────────────────────
[ $# -ge 2 ] || usage 1
verb="$1"; shift
case "$verb" in
  plan)     cmd_plan "$@" ;;
  apply)    cmd_apply "$@" ;;
  fix-asof) cmd_fix_asof "$@" ;;
  watch)    cmd_watch "$@" ;;
  -h|--help|help) usage 0 ;;
  *) die "不认识的动词 '$verb' (只有 plan / apply / fix-asof / watch)" ;;
esac
