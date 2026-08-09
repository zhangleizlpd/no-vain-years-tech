#!/usr/bin/env bash
#
# backup.sh — 把主仓的三个 local-only 文档目录镜像进备份 hub，打 git bundle，age 加密后推 prod 主机。
#
# 数据流：
#   <mono>/docs/{private,experience,explore}      ← 唯一物理位置（plan mode 也落这里）
#        │  rsync --delete（hub 是镜像，不是第二真相源；删除也同步过去）
#   ~/nvy-private/{private,experience,explore}    ← 备份 hub：git 版本化
#        │  git bundle --all → age -r <pubkey> → ssh
#   <代号>:~/nvy-private-backup/<date>.age        ← 异地密文副本
#
# 为什么中间要过一层 hub 而不是直接 tar 主仓：git 历史是「误删 5 分钟前」的唯一救命稻草，
# 而远端密文副本是天级的。hub 落在仓外，`git clean -xfd` 和「整个仓被误删」都伤不到它。
#
# 为什么加密：主机盘上放一份「提权购物清单」的明文，等于把私有化这件事白做。age 只用公钥
# 加密（私钥不参与、不下发），主机侧与任何拿到密文的人都解不开。
#
# 🚨 launchd 读 ~/Documents 撞 macOS TCC —— 本机因 holdings 早已授予 /bin/zsh 完全磁盘访问
# 而通过（2026-08-09 用完整调用链实测：read / find / git / rsync 全 OK）。换机或授权被撤会
# 失效，故下面每一步都 fail-loud：读不到就硬失败 + 由 wrapper 推飞书，绝不静默跳过。
#
# 用法：backup.sh   （无参数；配置全部来自 ~/.nvy 与环境变量，见下）
#
# 依赖的仓外配置：
#   ~/.nvy/fleet.env                        主机代号 → SSH 目标（真值仓外，per information-boundary）
#   ~/.nvy/nvy-private-backup/recipient.txt age 公钥（setup.sh 从 ~/.config/sops/age/keys.txt 派生）
#   NVY_MONO_HOME                           主仓路径（setup.sh 生成 wrapper 时注入，仓内不硬编码）
#
set -euo pipefail

MONO_HOME="${NVY_MONO_HOME:-}"
HUB="${NVY_PRIVATE_HOME:-$HOME/nvy-private}"
STATE_DIR="$HOME/.nvy/nvy-private-backup"
RECIPIENT_FILE="$STATE_DIR/recipient.txt"
FLEET_ENV="$HOME/.nvy/fleet.env"
# 目标主机取哪个代号：默认 app（业务 server 宿主，常驻可靠）。换机只改 ~/.nvy/fleet.env。
TARGET_VAR="${NVY_BACKUP_TARGET_VAR:-NVY_APP_SSH}"
TARGET_CODENAME="${NVY_BACKUP_TARGET_CODENAME:-app}"
REMOTE_DIR="${NVY_BACKUP_REMOTE_DIR:-nvy-private-backup}"   # 远端 home 下的相对路径
KEEP="${NVY_BACKUP_KEEP:-30}"                                # 远端保留份数
SUBDIRS="private experience explore"

# ── 前置检查：缺任何一项都硬失败。静默失败 = 以为有备份其实没有，正是本脚本要根治的 ──
[ -n "$MONO_HOME" ]      || { echo "❌ NVY_MONO_HOME 未设 —— 重跑 scripts/nvy-private-backup/setup.sh"; exit 1; }
[ -d "$MONO_HOME/docs" ] || { echo "❌ 读不到 ${MONO_HOME}/docs —— 路径错，或 launchd 撞 TCC（见脚本头注释）"; exit 1; }
[ -d "$HUB/.git" ]       || { echo "❌ ${HUB} 不是 git 仓"; exit 1; }
[ -f "$RECIPIENT_FILE" ] || { echo "❌ 缺 age 公钥 ${RECIPIENT_FILE} —— 重跑 setup.sh"; exit 1; }
[ -f "$FLEET_ENV" ]      || { echo "❌ 缺 ${FLEET_ENV} —— 主机真值仓外解析，见 ops/host/fleet.env.example"; exit 1; }
command -v age >/dev/null    || { echo "❌ age 未安装（brew install age）"; exit 1; }
command -v rsync >/dev/null  || { echo "❌ rsync 未安装"; exit 1; }

set -a; . "$FLEET_ENV"; set +a
TARGET="${!TARGET_VAR:-}"     # bash 间接展开；代号→真值只在运行时发生，仓内永远只有变量名
[ -n "$TARGET" ] || { echo "❌ ${FLEET_ENV} 里 ${TARGET_VAR} 为空 —— 代号 ${TARGET_CODENAME} 未绑定"; exit 1; }

RECIPIENT="$(tr -d '[:space:]' < "$RECIPIENT_FILE")"
[ -n "$RECIPIENT" ] || { echo "❌ ${RECIPIENT_FILE} 为空"; exit 1; }

umask 077

# ── 1. 镜像主仓 → hub。--delete 让 hub 真是镜像：主仓删了的，hub 也删（删除记在 git 里，可回溯）──
SRC_FILES=0
for d in $SUBDIRS; do
  src="$MONO_HOME/docs/$d"
  [ -d "$src" ] || continue
  mkdir -p "$HUB/$d"
  rsync -a --delete "$src/" "$HUB/$d/"
  SRC_FILES=$(( SRC_FILES + $(find "$src" -type f | wc -l | tr -d ' ') ))
done
[ "$SRC_FILES" -gt 0 ] || { echo "❌ 主仓三个目录里一个文件都没读到 —— 疑似 TCC 拒绝或路径错，拒绝备份空内容"; exit 1; }

# ── 2. hub 侧 commit（无变化则跳过，避免每日空 commit 刷历史）──
git -C "$HUB" add -A
if git -C "$HUB" diff --cached --quiet; then
  COMMITTED="无变化"
else
  git -C "$HUB" -c user.name="nvy-backup" -c user.email="nvy-backup@localhost" \
    commit -q -m "chore(backup): 同步自主仓 $(TZ=Asia/Shanghai date '+%Y-%m-%d %H:%M')"
  COMMITTED="$(git -C "$HUB" diff --stat 'HEAD^' HEAD 2>/dev/null | tail -1 | tr -d ' ' || echo '已提交')"
fi

# ── 3. 打 bundle，加密前先 verify：推一个损坏的 bundle 等于没备份 ──
TMP_DIR="$STATE_DIR/tmp"
mkdir -p "$TMP_DIR"
BUNDLE="$(mktemp "$TMP_DIR/bundle.XXXXXX")"
trap 'rm -f "$BUNDLE"' EXIT

git -C "$HUB" bundle create "$BUNDLE" --all >/dev/null 2>&1
git -C "$HUB" bundle verify "$BUNDLE" >/dev/null 2>&1 \
  || { echo "❌ bundle 自检未通过，不推送"; exit 1; }

COMMITS="$(git -C "$HUB" rev-list --count --all)"
FILES="$(git -C "$HUB" ls-files | wc -l | tr -d ' ')"
PLAIN_SIZE="$(wc -c < "$BUNDLE" | tr -d ' ')"

# ── 4. 加密 + 传输（远端目录不存在则建，首跑即可用）──
STAMP="$(TZ=Asia/Shanghai date '+%Y%m%d-%H%M')"
REMOTE_FILE="$REMOTE_DIR/nvy-private-$STAMP.age"
age -r "$RECIPIENT" < "$BUNDLE" \
  | ssh -o BatchMode=yes "$TARGET" "mkdir -p '$REMOTE_DIR' && cat > '$REMOTE_FILE'"

# ── 5. 回读远端字节数核对：ssh 管道写入被静默截断过（对端盘满 / 连接中断），只看退出码看不出来 ──
REMOTE_SIZE="$(ssh -o BatchMode=yes "$TARGET" "wc -c < '$REMOTE_FILE'" | tr -d ' ')"
[ -n "$REMOTE_SIZE" ] && [ "$REMOTE_SIZE" -gt 0 ] \
  || { echo "❌ 远端文件为空或读不到"; exit 1; }
# 密文比明文略大（age 头 + chunk 开销），绝不该小于明文一半 —— 那必是截断
[ "$REMOTE_SIZE" -gt $(( PLAIN_SIZE / 2 )) ] \
  || { echo "❌ 远端 ${REMOTE_SIZE}B 远小于明文 ${PLAIN_SIZE}B，疑似截断"; exit 1; }

# ── 6. 保留期：只删本任务自己的产物（严格前缀 + 后缀），别的文件一概不碰。
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
printf '源=主仓 %s 文件 → hub commit: %s\n' "$SRC_FILES" "$COMMITTED"
printf 'hub: commits=%s files=%s\n' "$COMMITS" "$FILES"
printf 'bundle=%sB → 密文 %sB\n' "$PLAIN_SIZE" "$REMOTE_SIZE"
printf '目标=%s:~/%s\n' "$TARGET_CODENAME" "$REMOTE_FILE"
printf '远端留存=%s 份（上限 %s，本次清理 %s）\n' "$KEPT" "$KEEP" "$(printf '%s' "$PRUNED" | tail -1)"
