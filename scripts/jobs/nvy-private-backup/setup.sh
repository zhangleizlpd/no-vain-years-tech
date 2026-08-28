#!/usr/bin/env bash
#
# setup.sh — 把「私有文档仓异地密文备份」装成 launchd 定时任务（仅 macOS）。
#
# 装完的形态（与 marketdata-dev-sync / watchdog 同范式）：
#   launchd(每日 HH:MM) → ~/.nvy/nvy-private-backup/run-scheduled.sh
#                       → ops/lib/nvy-run-reported.sh（跑完必推飞书 report + 写心跳）
#                       → ~/.nvy/nvy-private-backup/backup.sh
#                          （rsync 主仓 → hub ~/nvy-private → git commit → bundle | age | ssh）
#
# 自包含：backup.sh 与共享 lib 全部拷进 ~/.nvy，plist 只 exec ~/.nvy 下的脚本 —— launchd agent
# 默认对 ~/Documents 无 TCC 权限，直接 exec 仓内脚本会被系统**静默拒绝**。副作用：改仓内源码
# 后必须重跑本 setup 覆盖副本。
#
# ⚠️ 但备份**数据源**必然在 ~/Documents —— 私有文档的物理位置就是主 worktree。本机因 holdings
# 早已授予 /bin/zsh 完全磁盘访问而读得通（2026-08-09 以完整调用链实测：read / find / git / rsync
# 全 OK）。换机或授权被撤时 backup.sh 的前置检查会 fail-loud + 由 wrapper 推飞书，不会静默备份空内容。
#
# age 公钥在此固化：从 ~/.config/sops/age/keys.txt 派生出**公钥**写进 ~/.nvy/nvy-private-backup/
# recipient.txt。此后备份进程只碰公钥，私钥不参与加密路径（最小权限）。
#
# 用法：
#   bash scripts/jobs/nvy-private-backup/setup.sh                    # 默认每日 09:30，目标代号 app
#   bash scripts/jobs/nvy-private-backup/setup.sh --time 09:30
#   bash scripts/jobs/nvy-private-backup/setup.sh --target index     # 换目标代号（需 fleet.env 里有对应 *_SSH）
#   bash scripts/jobs/nvy-private-backup/setup.sh --keep 30          # 远端保留份数
#
set -euo pipefail

LABEL='com.nvy.nvy-private-backup'
TASK='nvy-private-backup'
TIME='09:30'          # 晚于 holdings 09:00 / marketdata 09:05，错开抢网络
TARGET_CODENAME='app'
KEEP='30'

while [[ $# -gt 0 ]]; do
  case "$1" in
    --time) TIME="$2"; shift 2 ;;
    --time=*) TIME="${1#*=}"; shift ;;
    --target) TARGET_CODENAME="$2"; shift 2 ;;
    --target=*) TARGET_CODENAME="${1#*=}"; shift ;;
    --keep) KEEP="$2"; shift 2 ;;
    --keep=*) KEEP="${1#*=}"; shift ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

[[ "$(uname)" == 'Darwin' ]] || { echo '定时能力仅支持 macOS（launchd）。' >&2; exit 1; }
# 🚨 `${TIME}` 花括号不可省：裸 $TIME 紧跟全角「）」在 CJK locale 下会被 bash 折进变量名
#    （同 scripts/jobs/nvy-watchdog/setup.sh 的 2026-08-04 实测坑）。
[[ "$TIME" =~ ^([0-9]{1,2}):([0-9]{2})$ ]] || { echo "--time 格式应为 HH:MM（收到 ${TIME}）" >&2; exit 1; }
HOUR="$((10#${BASH_REMATCH[1]}))"
MIN="$((10#${BASH_REMATCH[2]}))"
{ [[ "$HOUR" -le 23 ]] && [[ "$MIN" -le 59 ]]; } || { echo "--time 越界：$TIME" >&2; exit 1; }
[[ "$KEEP" =~ ^[0-9]+$ ]] && [[ "$KEEP" -ge 1 ]] || { echo "--keep 应为正整数（收到 ${KEEP}）" >&2; exit 1; }

# 代号 → fleet.env 变量名。代号是角色不是机器，换机只改 ~/.nvy/fleet.env。
TARGET_VAR="NVY_$(printf '%s' "$TARGET_CODENAME" | tr '[:lower:]-' '[:upper:]_')_SSH"

TOOL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_LIB_DIR="$TOOL_DIR/../../../ops/lib"
NVY_DIR="$HOME/.nvy/nvy-private-backup"
LIB_DIR="$HOME/.nvy/lib"
BACKUP_SH="$NVY_DIR/backup.sh"
REPORTER="$LIB_DIR/nvy-run-reported.sh"
RECIPIENT_FILE="$NVY_DIR/recipient.txt"
WRAPPER="$NVY_DIR/run-scheduled.sh"
LAUNCHD_LOG="$NVY_DIR/launchd.log"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"
AGE_KEY="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"
FLEET_ENV="$HOME/.nvy/fleet.env"
# 备份源固定取**主** worktree —— 私有文档的物理位置只有那一处，副 worktree 里只是
# symlink。`git worktree list` 首行恒为主 worktree，故本 setup 在任何 worktree 跑都对。
MONO_HOME="$(git -C "$TOOL_DIR" worktree list --porcelain | head -1 | awk '{print $2}')"

# ── 前置：缺一不可，装了也白装，不如现在就红 ────────────────────────────────
command -v age >/dev/null || { echo '❌ age 未安装：brew install age' >&2; exit 1; }
command -v rsync >/dev/null || { echo '❌ rsync 未安装' >&2; exit 1; }
[[ -f "$AGE_KEY" ]] || { echo "❌ 缺 age 私钥 $AGE_KEY" >&2; exit 1; }
[[ -f "$FLEET_ENV" ]] || { echo "❌ 缺 ${FLEET_ENV}（主机真值仓外解析，见 ops/host/fleet.env.example）" >&2; exit 1; }
[[ -n "$MONO_HOME" && -d "$MONO_HOME/docs" ]] || { echo "❌ 推导主仓失败：${MONO_HOME:-<空>}" >&2; exit 1; }
set -a; . "$FLEET_ENV"; set +a
[[ -n "${!TARGET_VAR:-}" ]] || { echo "❌ $FLEET_ENV 里 $TARGET_VAR 为空 —— 代号 ${TARGET_CODENAME} 未绑定" >&2; exit 1; }

mkdir -p "$NVY_DIR" "$LIB_DIR" "$(dirname "$PLIST")"

# ── 派生 age 公钥并固化（备份路径此后不碰私钥）───────────────────────────────
umask 077
age-keygen -y "$AGE_KEY" > "$RECIPIENT_FILE"
[[ -s "$RECIPIENT_FILE" ]] || { echo "❌ 从 $AGE_KEY 派生公钥失败" >&2; exit 1; }

# ── 自包含拷贝（launchd 无 TCC，必须脱离 ~/Documents）─────────────────────────
cp "$TOOL_DIR/backup.sh" "$BACKUP_SH"
cp "$SRC_LIB_DIR/feishu-send.sh" "$SRC_LIB_DIR/nvy-run-reported.sh" "$LIB_DIR/"
chmod 755 "$BACKUP_SH" "$LIB_DIR/feishu-send.sh" "$REPORTER"

# launchd PATH 极简——固化 git/age/ssh/bash 实际所在 + 常见路径
resolve_bin_dirs() {
  local c p dirs=()
  for c in git age ssh rsync bash; do
    p="$(command -v "$c" 2>/dev/null || true)"
    [[ -n "$p" ]] && dirs+=("$(cd "$(dirname "$p")" && pwd)")
  done
  printf '%s\n' "${dirs[@]}" /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin |
    awk 'NF && !seen[$0]++' | paste -sd: -
}
PATH_VAL="$(resolve_bin_dirs)"

cat >"$WRAPPER" <<EOF
#!/bin/zsh
# 由 scripts/jobs/nvy-private-backup/setup.sh 生成——请勿手改，重跑 setup 覆盖
export PATH="$PATH_VAL"
export NVY_MONO_HOME="$MONO_HOME"
export NVY_BACKUP_TARGET_VAR="$TARGET_VAR"
export NVY_BACKUP_TARGET_CODENAME="$TARGET_CODENAME"
export NVY_BACKUP_KEEP="$KEEP"
# 飞书公共配置（webhook/secret/机器名）——可选；缺文件 → feishu-send.sh 静默跳过
[ -f "\$HOME/.nvy/feishu-alert.env" ] && { set -a; . "\$HOME/.nvy/feishu-alert.env"; set +a; }
# 套通用 wrapper：跑完（成功/失败）都推飞书 report + 写心跳供看门狗检 no-show
exec /bin/bash "$REPORTER" $TASK -- /bin/bash "$BACKUP_SH"
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

printf '\n✅ 已安装 %s：每天 %s 把 ~/nvy-private 加密备份到代号 %s\n' "$LABEL" "$TIME" "$TARGET_CODENAME"
printf '   wrapper: %s\n   plist:   %s\n   日志:    %s\n   收件人:  %s\n' \
  "$WRAPPER" "$PLIST" "$LAUNCHD_LOG" "$(cat "$RECIPIENT_FILE")"
printf '\n手动触发一次验证：\n   launchctl kickstart -k gui/%s/%s\n' "$UID_NUM" "$LABEL"
printf '卸载：launchctl bootout gui/%s/%s && rm -f %s\n' "$UID_NUM" "$LABEL" "$PLIST"
printf '\n⚠️  本任务须在看门狗清单里，否则 no-show（根本没跑）无人兜底。清单已含 %s 则无需动作；\n' "$TASK"
printf '   若缺，改 scripts/jobs/nvy-watchdog/setup.sh 的 TASKS **默认值**后重跑它 —— 只传 --tasks\n'
printf '   会在将来任何人裸跑一次 setup 时被静默摘掉（2026-07-30 futu-eod 踩过）。\n'
printf '\n🚨 age 私钥 %s 是单点：它丢了，所有密文备份一起变废纸。确保另有离线副本。\n' "$AGE_KEY"
