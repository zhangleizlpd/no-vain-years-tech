#!/usr/bin/env bash
#
# setup.sh — 把「代号 quant-win 实盘机磁盘 + 交易进程健康探针」装成 launchd 定时任务（仅 macOS）。
#
# 背景：该机无 CloudMonitor agent ⇒ 云监控采不到磁盘指标 ⇒ 配不出告警；且无 SSH，只能走云助手。
# 2026-08-15 系统盘满到 27.9MB 全程无声，本任务补的就是这个面。
#
# 自包含：把 probe.sh + feishu-send.sh 拷到 ~/.nvy（launchd 对 ~/Documents 无 TCC，必须脱离 worktree）。
# ⚠️ 改仓内 probe.sh 后**必须重跑本 setup**，否则跑的仍是旧副本（marketdata-dev-sync 踩过的「静默的成功」）。
#
# 用法：
#   bash scripts/jobs/quantwin-health/setup.sh                    # 默认每 30 分钟
#   bash scripts/jobs/quantwin-health/setup.sh --interval 900     # 每 15 分钟
#
set -euo pipefail

LABEL='com.nvy.quantwin-health'
INTERVAL=1800

while [[ $# -gt 0 ]]; do
  case "$1" in
    --interval) INTERVAL="$2"; shift 2 ;;
    --interval=*) INTERVAL="${1#*=}"; shift ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

[[ "$(uname)" == 'Darwin' ]] || { echo '定时能力仅支持 macOS（launchd）。' >&2; exit 1; }
# 🚨 花括号不可省：裸 $INTERVAL 紧跟全角「）」在 CJK locale 下会被折进变量名（同 nvy-watchdog/setup.sh）
[[ "$INTERVAL" =~ ^[0-9]+$ ]] && [[ "$INTERVAL" -ge 60 ]] \
  || { echo "--interval 应为 ≥60 的整数秒（收到 ${INTERVAL}）" >&2; exit 1; }

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 部署前机械守门 ──────────────────────────────────────────────────────────
# 🚨 裸 `$VAR` 紧跟全角标点（）「」等）在 CJK locale 下会被 bash 折进变量名，`set -u` 当场炸
#    「未绑定的变量」。probe.sh 2026-08-15 在**恢复通知**那条上真炸过 —— 而且只在恢复路径触发，
#    happy-path 全绿也发现不了；崩在 write_state 之前 ⇒ 状态永久卡 CRIT、每 6h 重复误报。
#    修法一律是加花括号 `${VAR}`。同 scripts/jobs/nvy-watchdog/setup.sh 头部那条注释。
if command -v python3 >/dev/null 2>&1; then
  if ! python3 - "$TOOL_DIR/probe.sh" <<'PYEOF'
import re, sys, pathlib
pat = re.compile(r'\$([A-Za-z_][A-Za-z0-9_]*)([^\x00-\x7F])')
bad = [(i, m.group(1), m.group(2))
       for i, line in enumerate(pathlib.Path(sys.argv[1]).read_text().split("\n"), 1)
       for m in pat.finditer(line)]
for i, v, c in bad:
    print(f"  probe.sh:{i}  裸 ${v} 紧跟 {c!r} —— 必须写成 ${{{v}}}", file=sys.stderr)
sys.exit(1 if bad else 0)
PYEOF
  then
    echo '🔴 部署中止：probe.sh 存在「裸 $VAR 紧跟全角标点」，CJK locale 下必炸。' >&2
    exit 1
  fi
fi

SRC_LIB_DIR="$TOOL_DIR/../../ops/lib"
LIB_DIR="$HOME/.nvy/lib"
NVY_DIR="$HOME/.nvy/quantwin-health"
PROBE="$NVY_DIR/probe.sh"
WRAPPER="$NVY_DIR/run-scheduled.sh"
LAUNCHD_LOG="$NVY_DIR/launchd.log"
ENV_FILE="$HOME/.nvy/quantwin-health.env"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

mkdir -p "$NVY_DIR" "$LIB_DIR" "$(dirname "$PLIST")"
cp "$TOOL_DIR/probe.sh" "$PROBE"
cp "$SRC_LIB_DIR/feishu-send.sh" "$LIB_DIR/"
chmod 755 "$PROBE" "$LIB_DIR/feishu-send.sh"

# 部署印记（同 marketdata-dev-sync 的 deployed.meta 范式：便于事后判断副本是否落后于仓内源）
{
  printf 'deployed_at=%s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')"
  printf 'source_commit=%s\n' "$(git -C "$TOOL_DIR" rev-parse --short HEAD 2>/dev/null || echo unknown)"
  printf 'interval_sec=%s\n' "$INTERVAL"
} >"$NVY_DIR/deployed.meta"

# env 模板（机器专属值仓外落地，per information-boundary.md 第二层）——已存在则不覆盖
if [[ ! -f "$ENV_FILE" ]]; then
  cp "$TOOL_DIR/quantwin-health.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "📝 已生成 $ENV_FILE —— 请填入 NVY_QUANTWIN_PROCS 后本任务才能判定进程存活"
fi

# launchd PATH 极简——固化实际所在 + 常见路径（aliyun CLI 必须在内，否则探针跑不起来）
resolve_bin_dirs() {
  local c p dirs=()
  for c in bash openssl curl base64 aliyun; do
    p="$(command -v "$c" 2>/dev/null || true)"
    [[ -n "$p" ]] && dirs+=("$(cd "$(dirname "$p")" && pwd)")
  done
  printf '%s\n' "${dirs[@]}" /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin |
    awk 'NF && !seen[$0]++' | paste -sd: -
}
PATH_VAL="$(resolve_bin_dirs)"
command -v aliyun >/dev/null 2>&1 || echo '⚠️ aliyun CLI 当前不在 PATH，装完后需重跑本 setup 固化路径' >&2

cat >"$WRAPPER" <<EOF
#!/bin/zsh
# 由 scripts/jobs/quantwin-health/setup.sh 生成——请勿手改，重跑 setup 覆盖
export PATH="$PATH_VAL"
[ -f "\$HOME/.nvy/feishu-alert.env" ] && { set -a; . "\$HOME/.nvy/feishu-alert.env"; set +a; }
exec /bin/bash "$PROBE"
EOF
chmod 755 "$WRAPPER"

cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$WRAPPER</string>
  </array>
  <key>StartInterval</key>
  <integer>$INTERVAL</integer>
  <key>StandardOutPath</key>
  <string>$LAUNCHD_LOG</string>
  <key>StandardErrorPath</key>
  <string>$LAUNCHD_LOG</string>
  <key>ProcessType</key>
  <string>Background</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
EOF

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl print "gui/$UID_NUM/$LABEL" >/dev/null

printf '\n✅ 已安装 %s：每 %s 秒探测一次\n' "$LABEL" "$INTERVAL"
printf '   probe:   %s\n   wrapper: %s\n   env:     %s\n   日志:    %s\n' "$PROBE" "$WRAPPER" "$ENV_FILE" "$LAUNCHD_LOG"
printf '\n手动触发一次验证：\n   launchctl kickstart -k gui/%s/%s && sleep 45 && tail -20 %s\n' "$UID_NUM" "$LABEL" "$LAUNCHD_LOG"
printf '卸载：bash scripts/jobs/quantwin-health/uninstall.sh\n'
