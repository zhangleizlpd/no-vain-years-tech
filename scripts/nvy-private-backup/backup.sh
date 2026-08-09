#!/usr/bin/env bash
#
# backup.sh — 把仓外私有文档仓 ~/nvy-private 打成 git bundle，age 加密后推 prod 主机存异地副本。
#
# 为什么需要：docs/private（plans + runbook）/ experience / explore 是 local-only 文档，
# 内容本身即情报（主机清单、RAM 用户↔权限↔凭据路径映射），永不入公开仓。搬到 ~/nvy-private
# 之后误删有 git 兜底，但**盘坏 / 机器丢仍然全丢** —— 本机 Time Machine 未配置。
#
# 为什么是 bundle 而不是 tar：bundle 是 git 原生的「整仓打包成单文件」，含全部历史与 ref，
# 恢复就是 `git clone <bundle>`；tar 走 .git 目录恢复后还得赌目录状态一致。
#
# 为什么加密：主机盘上放一份「提权购物清单」的明文，等于把私有化这件事白做。age 只用公钥
# 加密（私钥不参与、不下发），主机侧与任何拿到密文的人都解不开。
#
# 用法：backup.sh   （无参数；配置全部来自 ~/.nvy，见下）
#
# 依赖的仓外配置：
#   ~/.nvy/fleet.env                        主机代号 → SSH 目标（真值仓外，per information-boundary）
#   ~/.nvy/nvy-private-backup/recipient.txt age 公钥（setup.sh 从 ~/.config/sops/age/keys.txt 派生）
#
set -euo pipefail

SRC_REPO="${NVY_PRIVATE_HOME:-$HOME/nvy-private}"
STATE_DIR="$HOME/.nvy/nvy-private-backup"
RECIPIENT_FILE="$STATE_DIR/recipient.txt"
FLEET_ENV="$HOME/.nvy/fleet.env"
# 目标主机取哪个代号：默认 app（业务 server 宿主，常驻可靠）。换机只改 ~/.nvy/fleet.env。
TARGET_VAR="${NVY_BACKUP_TARGET_VAR:-NVY_APP_SSH}"
TARGET_CODENAME="${NVY_BACKUP_TARGET_CODENAME:-app}"
REMOTE_DIR="${NVY_BACKUP_REMOTE_DIR:-nvy-private-backup}"   # 远端 home 下的相对路径
KEEP="${NVY_BACKUP_KEEP:-30}"                                # 远端保留份数

# ── 前置检查：缺任何一项都硬失败。静默失败 = 以为有备份其实没有，正是本脚本要根治的 ──
[ -d "$SRC_REPO/.git" ]  || { echo "❌ $SRC_REPO 不是 git 仓"; exit 1; }
[ -f "$RECIPIENT_FILE" ] || { echo "❌ 缺 age 公钥 $RECIPIENT_FILE —— 重跑 scripts/nvy-private-backup/setup.sh"; exit 1; }
[ -f "$FLEET_ENV" ]      || { echo "❌ 缺 $FLEET_ENV —— 主机真值仓外解析，见 ops/host/fleet.env.example"; exit 1; }
command -v age >/dev/null || { echo "❌ age 未安装（brew install age）"; exit 1; }

set -a; . "$FLEET_ENV"; set +a
TARGET="${!TARGET_VAR:-}"     # bash 间接展开；代号→真值只在运行时发生，仓内永远只有变量名
[ -n "$TARGET" ] || { echo "❌ $FLEET_ENV 里 $TARGET_VAR 为空 —— 代号 $TARGET_CODENAME 未绑定"; exit 1; }

RECIPIENT="$(tr -d '[:space:]' < "$RECIPIENT_FILE")"
[ -n "$RECIPIENT" ] || { echo "❌ $RECIPIENT_FILE 为空"; exit 1; }

# ── 打 bundle 到私有 tmp（umask 077），加密前先 verify：推一个损坏的 bundle 等于没备份 ──
umask 077
TMP_DIR="$STATE_DIR/tmp"
mkdir -p "$TMP_DIR"
BUNDLE="$(mktemp "$TMP_DIR/bundle.XXXXXX")"
trap 'rm -f "$BUNDLE"' EXIT

git -C "$SRC_REPO" bundle create "$BUNDLE" --all >/dev/null 2>&1
git -C "$SRC_REPO" bundle verify "$BUNDLE" >/dev/null 2>&1 \
  || { echo "❌ bundle 自检未通过，不推送"; exit 1; }

COMMITS="$(git -C "$SRC_REPO" rev-list --count --all)"
FILES="$(git -C "$SRC_REPO" ls-files | wc -l | tr -d ' ')"
PLAIN_SIZE="$(wc -c < "$BUNDLE" | tr -d ' ')"

# ── 加密 + 传输（远端目录不存在则建，首跑即可用）──
STAMP="$(TZ=Asia/Shanghai date '+%Y%m%d-%H%M')"
REMOTE_FILE="$REMOTE_DIR/nvy-private-$STAMP.age"
age -r "$RECIPIENT" < "$BUNDLE" \
  | ssh -o BatchMode=yes "$TARGET" "mkdir -p '$REMOTE_DIR' && cat > '$REMOTE_FILE'"

# ── 回读远端字节数核对：ssh 管道写入被静默截断过（对端盘满 / 连接中断），只看退出码看不出来 ──
REMOTE_SIZE="$(ssh -o BatchMode=yes "$TARGET" "wc -c < '$REMOTE_FILE'" | tr -d ' ')"
[ -n "$REMOTE_SIZE" ] && [ "$REMOTE_SIZE" -gt 0 ] \
  || { echo "❌ 远端文件为空或读不到"; exit 1; }
# 密文比明文略大（age 头 + chunk 开销），绝不该小于明文一半 —— 那必是截断
[ "$REMOTE_SIZE" -gt $(( PLAIN_SIZE / 2 )) ] \
  || { echo "❌ 远端 ${REMOTE_SIZE}B 远小于明文 ${PLAIN_SIZE}B，疑似截断"; exit 1; }

# ── 保留期：只删本任务自己的产物（严格前缀 + 后缀），别的文件一概不碰。
#    逻辑走 stdin 喂给远端 bash，避免在双层引号里拼 shell（那是最容易出错的地方）──
PRUNED="$(ssh -o BatchMode=yes "$TARGET" bash -s -- "$REMOTE_DIR" "$KEEP" <<'REMOTE_PRUNE'
set -eu
dir="$1"; keep="$2"
old="$(ls -1t "$dir"/nvy-private-*.age 2>/dev/null | tail -n +$((keep + 1)) || true)"
if [ -n "$old" ]; then
  printf '%s\n' "$old" | xargs rm -f      # ls 输出已含 dir 前缀，直接删
  printf '%s\n' "$old" | wc -l
else
  echo 0
fi
REMOTE_PRUNE
)"
KEPT="$(ssh -o BatchMode=yes "$TARGET" "ls -1 '$REMOTE_DIR'/nvy-private-*.age 2>/dev/null | wc -l" | tr -d ' ')"

# ── 汇总打 stdout：nvy-run-reported 抓末尾行推飞书。只打代号，不打主机真值 ──
printf 'commits=%s files=%s\n' "$COMMITS" "$FILES"
printf 'bundle=%sB → 密文 %sB\n' "$PLAIN_SIZE" "$REMOTE_SIZE"
printf '目标=%s:~/%s\n' "$TARGET_CODENAME" "$REMOTE_FILE"
printf '远端留存=%s 份（上限 %s，本次清理 %s）\n' "$KEPT" "$KEEP" "$(printf '%s' "$PRUNED" | tail -1)"
