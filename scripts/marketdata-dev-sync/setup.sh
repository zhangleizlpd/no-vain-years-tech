#!/usr/bin/env bash
#
# setup.sh — 把「每天早上从 prod 同步投资域测试数据到本地 dev PG」装成 launchd 定时任务（仅 macOS）。
#
# 无需登录/凭据（prod 走免密 SSH，本地走非密钥 dev DSN）——只生成 wrapper + plist 并注册。
#
# 用法：
#   pnpm dev-marketdata:setup                 # 默认 09:05（须晚于 holdings 09:00）
#   pnpm dev-marketdata:setup --time 09:05
#   bash scripts/marketdata-dev-sync/setup.sh --time 09:05
#
set -euo pipefail

LABEL='com.nvy.marketdata-dev-sync'
TIME='09:05'
while [[ $# -gt 0 ]]; do
  case "$1" in
    --time) TIME="$2"; shift 2 ;;
    --time=*) TIME="${1#*=}"; shift ;;
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
SRC_SYNC_SH="$TOOL_DIR/sync.sh"
SRC_COMPOSE="$TOOL_DIR/../../docker-compose.dev.yml"   # repo 根；随 sync.sh 一并下发供 §0 自愈
SRC_LIB_DIR="$TOOL_DIR/../../ops/lib"                  # 飞书共享 lib（feishu-send + nvy-run-reported）
NVY_DIR="$HOME/.nvy/marketdata-dev-sync"
# launchd agent 对 ~/Documents 无 TCC 权限，故把 sync.sh 拷到 ~/.nvy 下执行（改了源码需重跑 setup）
SYNC_SH="$NVY_DIR/sync.sh"
LIB_DIR="$HOME/.nvy/lib"                               # 飞书 wrapper/原语共享落点（与 holdings 同用）
REPORTER="$LIB_DIR/nvy-run-reported.sh"
STAMP="$NVY_DIR/deployed.meta"                         # 部署印记，供 sync.sh 运行时自检漂移
WRAPPER="$NVY_DIR/run-scheduled.sh"
LAUNCHD_LOG="$NVY_DIR/launchd.log"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UID_NUM="$(id -u)"

mkdir -p "$NVY_DIR" "$LIB_DIR" "$(dirname "$PLIST")"
cp "$SRC_SYNC_SH" "$SYNC_SH"
chmod 755 "$SYNC_SH"
cp "$SRC_COMPOSE" "$NVY_DIR/docker-compose.dev.yml"   # §0 自愈用——拷到 ~/.nvy 保持脚本自包含（launchd 无 TCC）
# 飞书共享 lib 拷到 ~/.nvy/lib（脱离 git worktree，改 lib 须重跑 setup 覆盖；与 holdings 同范式）
cp "$SRC_LIB_DIR/feishu-send.sh" "$SRC_LIB_DIR/nvy-run-reported.sh" "$LIB_DIR/"
chmod 755 "$LIB_DIR/feishu-send.sh" "$LIB_DIR/nvy-run-reported.sh"

# ── 部署印记：把「这份副本出自仓内哪个版本」烙进 ~/.nvy，供 sync.sh 运行时自检漂移 ──────────
# 为什么非要烙一份、而不是运行时直接读仓内源比对：launchd agent 对 ~/Documents 无 TCC，
# 09:05 那次执行**读不到**仓库里的 sync.sh —— 唯一还留在它视野内的「仓内版长什么样」，就是
# 部署时刻写下的这份。sync.sh 侧的两臂检法与降级顺序见其「部署漂移自检」段。
# （2026-08-11 事故：仓内 08-10 已改，setup 没重跑，副本停在 08-09，而日志照常打 ✅ 同步完成。）
# file_sha256 与 sync.sh 里那份同形 —— 两个脚本各自自包含（setup 只 cp 不 source），5 行重复
# 换「零额外下发文件」，比抽 lib 划算。
file_sha256() { # 读不到 / 无工具 → 空串且退出 0（`|| true` 是给 pipefail 的，别省）
  if command -v shasum >/dev/null 2>&1; then
    { shasum -a 256 "$1" 2>/dev/null || true; } | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    { sha256sum "$1" 2>/dev/null || true; } | awk '{print $1}'
  fi
}
SRC_SHA="$(file_sha256 "$SRC_SYNC_SH")"
SRC_COMMIT="$(git -C "$TOOL_DIR" rev-parse --short HEAD 2>/dev/null || true)"
[[ -n "$SRC_COMMIT" ]] || SRC_COMMIT='unknown'
# 未提交的改动也要能看出来：印记里 commit 相同但内容不同才是最难查的一类
[[ -z "$(git -C "$TOOL_DIR" status --porcelain -- "$SRC_SYNC_SH" 2>/dev/null || true)" ]] || SRC_COMMIT="${SRC_COMMIT}-dirty"
{
  printf 'src=%s\n' "$SRC_SYNC_SH"
  printf 'sha256=%s\n' "$SRC_SHA"
  printf 'commit=%s\n' "$SRC_COMMIT"
  printf 'deployed_at_epoch=%s\n' "$(date +%s)"
  printf 'deployed_at=%s\n' "$(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M:%S')"
} >"$STAMP"

# launchd PATH 极简——固化 docker/psql/ssh/bash 实际所在目录 + 常见路径
resolve_bin_dirs() {
  local c p dirs=()
  for c in docker psql ssh bash; do
    p="$(command -v "$c" 2>/dev/null || true)"
    [[ -n "$p" ]] && dirs+=("$(cd "$(dirname "$p")" && pwd)")
  done
  printf '%s\n' "${dirs[@]}" /opt/homebrew/bin /usr/local/bin /usr/bin /bin /usr/sbin /sbin |
    awk 'NF && !seen[$0]++' | paste -sd: -
}
PATH_VAL="$(resolve_bin_dirs)"

cat >"$WRAPPER" <<EOF
#!/bin/zsh
# 由 scripts/marketdata-dev-sync/setup.sh 生成——请勿手改，重跑 setup 覆盖
export PATH="$PATH_VAL"
# 飞书公共配置（webhook/secret/机器名）——可选；缺文件 → feishu-send.sh 静默跳过
[ -f "\$HOME/.nvy/feishu-alert.env" ] && { set -a; . "\$HOME/.nvy/feishu-alert.env"; set +a; }
# 套通用 wrapper：跑完（成功/失败）都推飞书 report（机器+任务+逐表计数）+ 写心跳供看门狗
exec /bin/bash "$REPORTER" marketdata-dev-sync -- /bin/bash "$SYNC_SH"
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

printf '\n✅ 已安装定时任务 %s：每天 %s → prod 同步到本地 dev PG\n' "$LABEL" "$TIME"
printf '   wrapper: %s\n   plist:   %s\n   日志:    %s（结果）/ %s（原始输出）\n' \
  "$WRAPPER" "$PLIST" "$NVY_DIR/sync.log" "$LAUNCHD_LOG"
printf '   印记:    %s（commit=%s sha256=%s）\n' "$STAMP" "$SRC_COMMIT" "${SRC_SHA:0:12}"
WAKE_H="$(printf '%02d' "$([[ "$MIN" -ge 2 ]] && echo "$HOUR" || echo $(((HOUR + 23) % 24)))")"
WAKE_M="$(printf '%02d' "$([[ "$MIN" -ge 2 ]] && echo "$((MIN - 2))" || echo 58)")"
printf '\n⚠️ Mac 须在该时刻醒着。若希望睡眠时自动唤醒，用 sudo 跑一次（仅一次）：\n'
printf '   sudo pmset repeat wakeorpoweron MTWRFSU %s:%s:00\n' "$WAKE_H" "$WAKE_M"
printf '\n手动触发一次验证：\n   launchctl kickstart -k gui/%s/%s\n' "$UID_NUM" "$LABEL"
printf '卸载：pnpm dev-marketdata:uninstall\n'
