#!/usr/bin/env bash
#
# uninstall.sh — 卸载 marketdata-dev-sync 定时任务（不删已同步的本地数据）。
#
# 用法：pnpm dev-marketdata:uninstall
#
set -euo pipefail

LABEL='com.nvy.marketdata-dev-sync'
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
rm -f "$PLIST"

printf '✅ 已卸载 %s（已同步的本地 dev 数据保留；如需停掉 pmset 唤醒：sudo pmset repeat cancel）\n' "$LABEL"
