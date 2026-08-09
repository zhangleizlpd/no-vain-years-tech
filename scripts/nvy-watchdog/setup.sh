#!/usr/bin/env bash
#
# setup.sh — 把「本地每日任务 no-show 看门狗」装成 launchd 定时任务（仅 macOS）。
#
# 补 in-job report 的盲区：本地每日任务（holdings 09:00 / marketdata 09:05 / futu-eod 09:15）若
# **根本没跑**（Mac 睡死 / plist 丢 / launchd 没醒），既不推成功 report 也不推失败告警 = 静默。
# 看门狗每日 10:00 查这些任务过去 ~25h 有没有写过心跳（nvy-run-reported 每跑必写），没写就推飞书告警。
#
# 自包含：把 nvy-watchdog.sh + feishu-send.sh 拷到 ~/.nvy/lib（脱离 git worktree，改 lib 须重跑）。
#
# 用法：
#   bash scripts/nvy-watchdog/setup.sh                       # 默认 10:00，查 holdings + marketdata + futu-eod
#   bash scripts/nvy-watchdog/setup.sh --time 10:00
#   bash scripts/nvy-watchdog/setup.sh --tasks "holdings-sync:90000 futu-eod:90000"   # 覆盖默认清单
#
set -euo pipefail

LABEL='com.nvy.watchdog'
TIME='10:00'
# <task>:<max-age-sec>；90000s≈25h。⚠️ 默认值必须与 ops/runbook/scheduled-tasks.md 的看门狗清单
# 保持一致 —— 漏一项 = 裸跑本 setup 会静默摘掉该任务的 no-show 兜底，且不报错（2026-07-30 修）。
TASKS='holdings-sync:90000 marketdata-dev-sync:90000 futu-eod:90000 nvy-private-backup:90000'
while [[ $# -gt 0 ]]; do
  case "$1" in
    --time) TIME="$2"; shift 2 ;;
    --time=*) TIME="${1#*=}"; shift ;;
    --tasks) TASKS="$2"; shift 2 ;;
    --tasks=*) TASKS="${1#*=}"; shift ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

[[ "$(uname)" == 'Darwin' ]] || { echo '定时能力仅支持 macOS（launchd）。' >&2; exit 1; }
# 🚨 `${TIME}` 花括号不可省：裸 `$TIME` 紧跟全角「）」在 CJK locale 下会被 bash 折进变量名，
#    `set -u` 当场炸「未绑定的变量」，盖掉本行本该报的格式错误（2026-08-04 实测 zh_TW.UTF-8
#    + bash 5.3.9 必炸，en_US.UTF-8 正常 —— 是 locale 相关，不是 bash 版本相关）。
[[ "$TIME" =~ ^([0-9]{1,2}):([0-9]{2})$ ]] || { echo "--time 格式应为 HH:MM（收到 ${TIME}）" >&2; exit 1; }
HOUR="$((10#${BASH_REMATCH[1]}))"
MIN="$((10#${BASH_REMATCH[2]}))"
{ [[ "$HOUR" -le 23 ]] && [[ "$MIN" -le 59 ]]; } || { echo "--time 越界：$TIME" >&2; exit 1; }

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_LIB_DIR="$TOOL_DIR/../../ops/lib"
LIB_DIR="$HOME/.nvy/lib"
WATCHDOG_SH="$LIB_DIR/nvy-watchdog.sh"
NVY_DIR="$HOME/.nvy/watchdog"
WRAPPER="$NVY_DIR/run-scheduled.sh"
LAUNCHD_LOG="$NVY_DIR/launchd.log"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

# 自包含拷 lib（看门狗 + 发送原语）到 ~/.nvy/lib（launchd 无 TCC，须脱离 ~/Documents）
mkdir -p "$NVY_DIR" "$LIB_DIR" "$(dirname "$PLIST")"
cp "$SRC_LIB_DIR/nvy-watchdog.sh" "$SRC_LIB_DIR/feishu-send.sh" "$LIB_DIR/"
chmod 755 "$WATCHDOG_SH" "$LIB_DIR/feishu-send.sh"

# launchd PATH 极简——固化 bash/openssl/curl 实际所在 + 常见路径
resolve_bin_dirs() {
  local c p dirs=()
  for c in bash openssl curl; do
    p="$(command -v "$c" 2>/dev/null || true)"
    [[ -n "$p" ]] && dirs+=("$(cd "$(dirname "$p")" && pwd)")
  done
  printf '%s\n' "${dirs[@]}" /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin |
    awk 'NF && !seen[$0]++' | paste -sd: -
}
PATH_VAL="$(resolve_bin_dirs)"

cat >"$WRAPPER" <<EOF
#!/bin/zsh
# 由 scripts/nvy-watchdog/setup.sh 生成——请勿手改，重跑 setup 覆盖
export PATH="$PATH_VAL"
# 飞书公共配置（webhook/secret/机器名）——可选；缺文件 → feishu-send.sh 静默跳过
[ -f "\$HOME/.nvy/feishu-alert.env" ] && { set -a; . "\$HOME/.nvy/feishu-alert.env"; set +a; }
exec /bin/bash "$WATCHDOG_SH" "$TASKS"
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
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>$HOUR</integer>
    <key>Minute</key>
    <integer>$MIN</integer>
  </dict>
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

# 幂等：先 bootout 旧实例（不存在则忽略），再 bootstrap
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl print "gui/$UID_NUM/$LABEL" >/dev/null

printf '\n✅ 已安装看门狗 %s：每天 %s 查心跳 [%s]\n' "$LABEL" "$TIME" "$TASKS"
printf '   wrapper: %s\n   plist:   %s\n   日志:    %s\n' "$WRAPPER" "$PLIST" "$LAUNCHD_LOG"
printf '\n手动触发一次验证：\n   launchctl kickstart -k gui/%s/%s\n' "$UID_NUM" "$LABEL"
printf '卸载：launchctl bootout gui/%s/%s && rm -f %s\n' "$UID_NUM" "$LABEL" "$PLIST"
