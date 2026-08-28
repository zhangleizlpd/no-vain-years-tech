#!/usr/bin/env bash
# uninstall.sh — 摘掉 quantwin-health launchd 任务。
# 刻意**不删** ~/.nvy/quantwin-health/（state / launchd.log 留作事后排查），要清自己 rm。
set -euo pipefail
LABEL='com.nvy.quantwin-health'
UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
printf '✅ 已摘除 %s（保留 %s 供排查）\n' "$LABEL" "$HOME/.nvy/quantwin-health"
printf '⚠️ 别忘了同步删掉 ops/runbook/scheduled-tasks.md 里的注册表行，否则注册表静默 stale\n'
