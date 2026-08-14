#!/usr/bin/env bash
#
# probe.sh — 代号 `quant-win`（实盘交易终端宿主）的磁盘水位 + 交易进程存活探针。
#
# 为什么存在：该机 2026-08-15 被发现系统盘从 40G 满到只剩 27.9MB，Windows 更新连续失败 5 次、
# CBS.log 涨到 810MB —— **全程无任何告警**，靠人工点进去才发现。机上没装 CloudMonitor agent
# ⇒ 云监控侧采不到磁盘指标 ⇒ 配不出告警。本探针从**机外**补这个面，不在实盘机上装任何东西。
#
# 通道：该机**无 SSH**，只能走云助手 `aliyun ecs RunCommand`（per fleet 词汇表）。
#
# 分类：**高频监控**（默认 30 min），per `.claude/rules/scheduled-tasks-registry.md` §①.3 ——
#   - **不套** `nvy-run-reported.sh`（每轮都推会刷屏），保留自身告警逻辑；
#   - 飞书发送一律走 `ops/lib/feishu-send.sh` 的 `feishu_send`（全仓唯一出口，CI 硬门 A 卡这条）；
#   - 正向 liveness 走**每日摘要**（每天首次跑过 `QW_SUMMARY_HOUR` 时推一条 OK）。
#
# 告警合并：磁盘 + 进程 + 探测失败**合成一条**消息，不分开推。
#
# 状态机（`$STATE_FILE`）：只在**状态跃迁**时推，持续异常每 `QW_REALERT_SEC` 复推一次，
# 恢复时推一条 ✅ —— 避免每 30 min 刷同一条。
#
# 配置（仓外，per information-boundary.md 第二层）：
#   ~/.nvy/fleet.env            NVY_QUANT_WIN_ECS_ID   实例 ID
#   ~/.nvy/quantwin-health.env  NVY_QUANTWIN_*         进程名等机器专属值（见 *.env.example）
#   ~/.nvy/feishu-alert.env     NVY_ALERT_*            飞书 webhook / 签名密钥
#
# 退出码：0 = 探测成功（无论健康与否）；1 = 探测本身失败（云助手不可达 / 超时）。
#
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 配置载入（缺失一律优雅降级，不硬失败）───────────────────────────────────
[ -f "$HOME/.nvy/fleet.env" ]            && { set -a; . "$HOME/.nvy/fleet.env"; set +a; }
[ -f "$HOME/.nvy/quantwin-health.env" ]  && { set -a; . "$HOME/.nvy/quantwin-health.env"; set +a; }
[ -f "$HOME/.nvy/feishu-alert.env" ]     && { set -a; . "$HOME/.nvy/feishu-alert.env"; set +a; }

# 飞书发送原语：优先用 ~/.nvy/lib 的自包含副本（launchd 对 ~/Documents 无 TCC）
if [ -f "$HOME/.nvy/lib/feishu-send.sh" ]; then
  . "$HOME/.nvy/lib/feishu-send.sh"
elif [ -f "$SELF_DIR/../../ops/lib/feishu-send.sh" ]; then
  . "$SELF_DIR/../../ops/lib/feishu-send.sh"
else
  feishu_send() { printf '[probe] feishu-send.sh 缺失，消息未发送：\n%s\n' "$1" >&2; }
fi

# ── 可调参数 ────────────────────────────────────────────────────────────────
ALIYUN_PROFILE="${NVY_QUANTWIN_ALIYUN_PROFILE:-mbw-server}"
ALIYUN_REGION="${NVY_QUANTWIN_REGION:-cn-shanghai}"
INSTANCE_ID="${NVY_QUANT_WIN_ECS_ID:-}"
# 逗号分隔的进程名（不含 .exe）。机器专属 ⇒ 仓内不写死，见 quantwin-health.env.example
PROCS="${NVY_QUANTWIN_PROCS:-}"
DISK_WARN_MB="${NVY_QUANTWIN_DISK_WARN_MB:-4096}"
DISK_CRIT_MB="${NVY_QUANTWIN_DISK_CRIT_MB:-2048}"
REALERT_SEC="${NVY_QUANTWIN_REALERT_SEC:-21600}"   # 持续异常复推间隔，默认 6h
SUMMARY_HOUR="${NVY_QUANTWIN_SUMMARY_HOUR:-9}"     # 每日正向摘要的最早小时
POLL_MAX="${NVY_QUANTWIN_POLL_MAX:-12}"            # 云助手结果轮询次数（×5s）
HOSTLABEL="${NVY_QUANTWIN_LABEL:-quant-win}"       # 只用代号，永不写真实主机名

STATE_DIR="${NVY_QUANTWIN_STATE_DIR:-$HOME/.nvy/quantwin-health}"
STATE_FILE="$STATE_DIR/state"
mkdir -p "$STATE_DIR"

now_epoch="$(date +%s)"
now_human="$(date '+%Y-%m-%d %H:%M:%S')"
today_ymd="$(date '+%Y%m%d')"

# ── 读旧状态 ────────────────────────────────────────────────────────────────
PREV_STATUS='UNKNOWN'; LAST_ALERT_EPOCH=0; LAST_SUMMARY_YMD=''; CONSEC_FAIL=0
# shellcheck disable=SC1090
[ -f "$STATE_FILE" ] && . "$STATE_FILE"

write_state() {
  cat >"$STATE_FILE" <<EOF
PREV_STATUS='$1'
LAST_ALERT_EPOCH=$2
LAST_SUMMARY_YMD='$3'
CONSEC_FAIL=$4
EOF
}

fail_probe() {
  # 截断：aliyun 报错含 EncodedDiagnosticMessage 时可达 2KB+，整串塞进告警既没用也可能超限。
  # （ANSI 颜色码的剔除归 ops/lib/feishu-send.sh 的转义器统一负责，见那里 2026-08-15 的注释。）
  local reason
  reason="$(printf '%s' "$1" | cut -c1-300)"
  CONSEC_FAIL=$((CONSEC_FAIL + 1))
  # 单次抖动不报（云 API 偶发超时很常见），连续 2 次才认定为真失败
  if [ "$CONSEC_FAIL" -ge 2 ] && { [ "$PREV_STATUS" != 'PROBE_FAIL' ] || [ $((now_epoch - LAST_ALERT_EPOCH)) -ge "$REALERT_SEC" ]; }; then
    feishu_send "🔴 [$HOSTLABEL] 健康探测失败（连续 ${CONSEC_FAIL} 次）
时间：$now_human
原因：$reason
影响：**无法确认该实盘机的磁盘与交易进程状态**，不代表机器一定有问题，但监控面已失明。"
    write_state 'PROBE_FAIL' "$now_epoch" "$LAST_SUMMARY_YMD" "$CONSEC_FAIL"
  else
    write_state "$PREV_STATUS" "$LAST_ALERT_EPOCH" "$LAST_SUMMARY_YMD" "$CONSEC_FAIL"
  fi
  printf '[probe] FAIL: %s\n' "$reason" >&2
  exit 1
}

[ -n "$INSTANCE_ID" ] || fail_probe '未解析到 NVY_QUANT_WIN_ECS_ID（检查 ~/.nvy/fleet.env）'
command -v aliyun >/dev/null 2>&1 || fail_probe 'aliyun CLI 不在 PATH 上'

# ── 构造远端探测脚本（输出压成一行 KV，避开云助手输出体积限制）──────────────
build_ps() {
  local names_ps="''" n
  if [ -n "$PROCS" ]; then
    names_ps=''
    local IFS=','
    for n in $PROCS; do
      [ -n "$n" ] || continue
      [ -n "$names_ps" ] && names_ps="$names_ps,"
      names_ps="$names_ps'$n'"
    done
  fi
  cat <<PSEOF
\$ErrorActionPreference='SilentlyContinue'
\$f=[math]::Round((Get-PSDrive C).Free/1MB)
\$t=[math]::Round((Get-PSDrive C).Used/1MB + (Get-PSDrive C).Free/1MB)
\$os=Get-CimInstance Win32_OperatingSystem
\$up=[math]::Round(((Get-Date)-\$os.LastBootUpTime).TotalHours,1)
\$names=@($names_ps)
\$miss=@(); \$alive=@()
foreach(\$n in \$names){
  if(-not \$n){continue}
  \$c=(Get-Process \$n -EA SilentlyContinue | Measure-Object).Count
  if(\$c -gt 0){\$alive+="\$n=\$c"} else {\$miss+=\$n}
}
\$pids=@(Get-Process \$names -EA SilentlyContinue | ForEach-Object {\$_.Id})
\$gw=0
if(\$pids.Count -gt 0){
  \$gw=(Get-NetTCPConnection -State Established -EA SilentlyContinue |
       Where-Object {\$pids -contains \$_.OwningProcess -and \$_.RemoteAddress -notmatch '^(127\.|::1\$)'} |
       Measure-Object).Count
}
"NVYPROBE free_mb=\$f total_mb=\$t uptime_h=\$up gw=\$gw alive=[\$(\$alive -join ';')] missing=[\$(\$miss -join ';')]"
PSEOF
}

PS_B64="$(build_ps | base64 | tr -d '\n')"

# ── 发起 + 轮询 ─────────────────────────────────────────────────────────────
invoke_json="$(aliyun ecs RunCommand \
  --profile "$ALIYUN_PROFILE" --region "$ALIYUN_REGION" \
  --InstanceId.1 "$INSTANCE_ID" --Type RunPowerShellScript \
  --Name nvy-quantwin-health --ContentEncoding Base64 --Timeout 120 \
  --CommandContent "$PS_B64" 2>&1)" || fail_probe "RunCommand 调用失败：$(printf '%s' "$invoke_json" | head -3 | tr '\n' ' ')"

invoke_id="$(printf '%s' "$invoke_json" | sed -n 's/.*"InvokeId": *"\([^"]*\)".*/\1/p' | head -1)"
[ -n "$invoke_id" ] || fail_probe "RunCommand 未返回 InvokeId：$(printf '%s' "$invoke_json" | head -3 | tr '\n' ' ')"

b64_decode() { base64 -D 2>/dev/null || base64 -d 2>/dev/null; }

raw=''
i=0
while [ "$i" -lt "$POLL_MAX" ]; do
  i=$((i + 1))
  sleep 5
  res="$(aliyun ecs DescribeInvocationResults \
    --profile "$ALIYUN_PROFILE" --region "$ALIYUN_REGION" \
    --InvokeId "$invoke_id" --InstanceId "$INSTANCE_ID" 2>&1)" || continue
  printf '%s' "$res" | grep -q '"InvocationStatus": *"Running"' && continue
  out_b64="$(printf '%s' "$res" | sed -n 's/.*"Output": *"\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$out_b64" ] || continue
  raw="$(printf '%s' "$out_b64" | b64_decode | tr -d '\r')"
  break
done

# 🚨 `${invoke_id}` 花括号不可省：裸 $VAR 紧跟全角「）」在 CJK locale 下会被 bash 折进变量名，
#    `set -u` 当场炸「未绑定的变量」。同 scripts/nvy-watchdog/setup.sh 头部那条。setup.sh 有机械守门。
[ -n "$raw" ] || fail_probe "云助手 $((POLL_MAX * 5))s 内未返回结果（InvokeId=${invoke_id}）"

line="$(printf '%s\n' "$raw" | grep '^NVYPROBE ' | head -1)"
[ -n "$line" ] || fail_probe "远端输出无法解析：$(printf '%s' "$raw" | head -2 | tr '\n' ' ')"

kv() { printf '%s' "$line" | sed -n "s/.*[[:space:]]$1=\([^ ]*\).*/\1/p" | head -1; }
brack() { printf '%s' "$line" | sed -n "s/.*[[:space:]]$1=\[\([^]]*\)\].*/\1/p" | head -1; }

free_mb="$(kv free_mb)"; total_mb="$(kv total_mb)"; uptime_h="$(kv uptime_h)"; gw="$(kv gw)"
alive="$(brack alive)"; missing="$(brack missing)"

case "$free_mb" in ''|*[!0-9]*) fail_probe "free_mb 解析异常：$line" ;; esac

# ── 判定 ────────────────────────────────────────────────────────────────────
problems=''
status='OK'

if [ "$free_mb" -lt "$DISK_CRIT_MB" ]; then
  status='CRIT'
  problems="$problems
🔴 磁盘 C: 仅剩 ${free_mb} MB（低于 CRIT 阈值 ${DISK_CRIT_MB} MB）"
elif [ "$free_mb" -lt "$DISK_WARN_MB" ]; then
  status='WARN'
  problems="$problems
🟡 磁盘 C: 剩 ${free_mb} MB（低于 WARN 阈值 ${DISK_WARN_MB} MB）"
fi

if [ -n "$missing" ]; then
  status='CRIT'
  problems="$problems
🔴 交易进程缺失：$(printf '%s' "$missing" | tr ';' ' ')"
fi

pct=''
[ -n "$total_mb" ] && [ "$total_mb" -gt 0 ] 2>/dev/null && pct="（$((free_mb * 100 / total_mb))%）"

facts="磁盘 C: ${free_mb} / ${total_mb} MB 可用${pct}
进程 $(printf '%s' "$alive" | tr ';' ' ')
外部已建连 ${gw} 条 · 开机 ${uptime_h} h
探测于 $now_human"

# ── 推送决策 ────────────────────────────────────────────────────────────────
CONSEC_FAIL=0
sent=0

if [ "$status" != 'OK' ]; then
  if [ "$PREV_STATUS" != "$status" ] || [ $((now_epoch - LAST_ALERT_EPOCH)) -ge "$REALERT_SEC" ]; then
    icon='🟡'; [ "$status" = 'CRIT' ] && icon='🔴'
    feishu_send "$icon [$HOSTLABEL] 实盘机健康告警
$problems

$facts"
    LAST_ALERT_EPOCH="$now_epoch"; sent=1
  fi
elif [ "$PREV_STATUS" = 'WARN' ] || [ "$PREV_STATUS" = 'CRIT' ] || [ "$PREV_STATUS" = 'PROBE_FAIL' ]; then
  feishu_send "✅ [$HOSTLABEL] 已恢复正常（上一状态 ${PREV_STATUS}）

$facts"
  LAST_ALERT_EPOCH="$now_epoch"; sent=1
fi

# 每日正向摘要（liveness）：确认「探针本身还活着」，只在健康且今天还没发过时推一条
if [ "$sent" -eq 0 ] && [ "$status" = 'OK' ] \
   && [ "$LAST_SUMMARY_YMD" != "$today_ymd" ] \
   && [ "$(date '+%-H')" -ge "$SUMMARY_HOUR" ]; then
  feishu_send "🟢 [$HOSTLABEL] 每日健康摘要

$facts"
  LAST_SUMMARY_YMD="$today_ymd"
fi

write_state "$status" "$LAST_ALERT_EPOCH" "$LAST_SUMMARY_YMD" 0
printf '[%s] %s %s\n' "$now_human" "$status" "$line"
