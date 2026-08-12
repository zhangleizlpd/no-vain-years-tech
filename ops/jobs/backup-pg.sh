#!/usr/bin/env bash
#
# Daily PostgreSQL backup — pg_dump | gzip → 77 本地磁盘。
#
# 🚨 **本机唯一副本，无异地。** 2026-08-08 维护者定：撤掉 OSS 上传（账号 B `UserDisable`
#    403，见 #887），异地冗余后续另议（可能走云数据库自带备份）。⇒ 本脚本覆盖的是
#    **误 DROP / 灾难 migration**（从本地 dump 恢复），**不覆盖** 盘坏 / 实例丢 / 账号停
#    —— dump 与 PG 数据在同一块 vda3 上（A-Tight v2 单机形态，per ADR-0026：无独立数据盘）。
#    再动本文件前先确认这个前提是否还成立。
#
# 观测：本脚本**零飞书 I/O**，只管干活 + 打 stdout + 给退出码。告警由 unit 套的
#   `nvy-run-reported backup-pg` 提供（退出码驱动飞书 + 写心跳供 nvy-watchdog 查 no-show），
#   与其余 7 个任务同构。—— 这正是 #892 的修复：改造前它走 `/etc/cron.d/`，**失败零信号**，
#   OSS 上传自 2026-07-13 起失败、07-29 起连续全败，潜伏三周直到上机巡检才撞见（#887）。
#
# 保留：本地最新 `RETENTION_COPIES` 份（默认 3）。**不是「深度」需求** —— 维护者判定只会出现
#   「立即发现」类故障（盘坏 / 误 DROP），永远只用最新一份；留 3 份纯粹是防**最新那份自己
#   是坏的**（截断 / dump 当时 PG 异常）。想改成 1 或 2 就是下面一个常量。
#
# Prereqs (one-time on the node):
#   1. .env.production at the repo root with DB_USERNAME / DB_PASSWORD
#      (single-node — same env file as the app).
#   2. BACKUP_DIR (default /home/admin/backup) writable by the admin user.
#   3. /etc/nvy-fleet.env with NVY_ACR_REPO —— 反直觉但必需，理由见下方 compose 调用处。
#
# Install: 仓根跑 `sudo bash ops/jobs/install.sh`（幂等，一次装齐全部任务；enable 由人定）
# 手动触发验证：systemctl start backup-pg.service  （→ 应收一条飞书 report）
# 飞书 webhook/secret + 心跳目录来自 /etc/nvy-alert.env（NVY_ALERT_* / NVY_HEARTBEAT_DIR）。
#
# All paths are env-overridable so the same script serves any deploy form.

set -euo pipefail

# Config — defaults for the mono A-Tight v2 single-node form.
COMPOSE_FILE="${COMPOSE_FILE:-/home/admin/no-vain-years-mono/docker-compose.tight.yml}"
ENV_FILE="${ENV_FILE:-/home/admin/no-vain-years-mono/.env.production}"
BACKUP_DIR="${BACKUP_DIR:-/home/admin/backup}"
RETENTION_COPIES="${RETENTION_COPIES:-3}"
# 本轮 dump 相对上一份的体积下限（百分比）。见下方「产物判据 ②」为何是相对值。
MIN_SIZE_PCT="${MIN_SIZE_PCT:-50}"

if [[ ! -f "$ENV_FILE" ]]; then
    echo "Error: $ENV_FILE not found" >&2
    exit 1
fi
# shellcheck source=/dev/null
source "$ENV_FILE"

if [[ -z "${DB_USERNAME:-}" ]]; then
    echo "Error: DB_USERNAME not set in $ENV_FILE" >&2
    exit 1
fi

if [[ ! -d "$BACKUP_DIR" ]]; then
    mkdir -p "$BACKUP_DIR"
fi

if [[ ! -w "$BACKUP_DIR" ]]; then
    echo "Error: $BACKUP_DIR not writable" >&2
    exit 1
fi

TS=$(date +%Y%m%d-%H%M)
OUT="$BACKUP_DIR/pg-${TS}.sql.gz"

# 🚨 先写点文件、验过再 mv —— 不要直接 `… | gzip > "$OUT"`。
#    重定向在管道跑起来**之前**就创建了 $OUT：pg_dump / 容器挂掉时 pipefail + set -e 会中止
#    脚本（这是对的），但盘上已经留下一个**名字与正常备份完全同构**的截断文件，prune 不会
#    删它（它是最新的），也没有任何东西会指出它是坏的。点开头 ⇒ 不被 pg-*.sql.gz 通配命中。
TMP="$(mktemp "$BACKUP_DIR/.pg-${TS}.XXXXXX")"
trap 'rm -f "$TMP"' EXIT

# 🚨 compose 插值的是**整份文件**，哪怕本脚本只 `exec postgres` —— `services.app.image` 那行是
#    `${MBW_APP_IMAGE:-${NVY_ACR_REPO:?…}}`，取不到值 compose 在**加载阶段**就拒跑，压根走不到
#    postgres。⇒ 一个纯备份任务也得把**镜像仓地址**备好，这个耦合是意外的，不是设计的。
#    2026-08-09 起连续 4 天全败正栽在这：08-08 22:03 仓库转公开，compose 里的镜像仓字面量换成
#    `${NVY_ACR_REPO:?}`（含实例 ID ⇒ 属仓外解析层，per docs/conventions/information-boundary.md）。
#    该 compose 有**三个**消费方，deploy.yml（CI secrets 里 export）与 rollback-prod.sh（读
#    /etc/nvy-fleet.env）都随改补了取值，**唯独本脚本这第三个漏了** —— 而它是这台机器上唯一的
#    数据保护机制。取值范式与 rollback-prod.sh 对齐：环境里没有就读主机侧 /etc/nvy-fleet.env。
if [[ -z "${NVY_ACR_REPO:-}" && -z "${MBW_APP_IMAGE:-}" && -f /etc/nvy-fleet.env ]]; then
    # shellcheck source=/dev/null
    . /etc/nvy-fleet.env
fi
# 🚨 必须 export：下面的 `docker compose` 是**子进程**，插值读的是环境变量，而 `.` 只赋当前 shell
#    的变量、不导出。漏 export 的症状具有迷惑性：脚本前面 `echo "$NVY_ACR_REPO"` 明明有值，
#    compose 却仍报 `required variable NVY_ACR_REPO is missing a value`。
export NVY_ACR_REPO

echo "[$(date -Iseconds)] starting pg_dump → ${OUT}"
docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" \
    exec -T postgres pg_dump -U "$DB_USERNAME" -F p mbw \
    | gzip > "$TMP"

# ── 产物判据 ①：gzip 完整性 ────────────────────────────────────────────────────
# pipefail 抓的是「命令返回非 0」，抓不到「命令返回 0 但产物是半截的」。这一条判产物本身。
if ! gzip -t "$TMP"; then
    echo "[$(date -Iseconds)] ERROR: gzip 完整性校验失败，产物已丢弃" >&2
    exit 1
fi

SIZE=$(stat -c %s "$TMP")

# ── 产物判据 ②：相对上一份的体积下限 ───────────────────────────────────────────
# 🚨 **绝不能写死绝对阈值**：2026-06-23 首轮 95M → 2026-08-08 552M，47 天涨 5.8×（HK
#    marketdata 回填 + optionsdesk 落库）。任何硬编码下限半个月就过时，然后要么恒红要么恒绿。
#    取相对值 ⇒ 判据随库自然长大，零维护。范式同 marketdata-table-health（判相对数据年龄，
#    不判绝对行数）。
# 用 glob 数组而非解析 `ls` 输出（SC2012）。**文件名 pg-YYYYMMDD-HHMM.sql.gz 各段零填充
# ⇒ 字典序恒等于时间序**，而 glob 展开本身就是字典升序 ⇒ 末位 = 最新，无需 `ls -t`。
# 点开头的在途临时文件（.pg-*.XXXXXX）不被 pg-* 命中，天然排除。
shopt -s nullglob
PRIOR=("$BACKUP_DIR"/pg-*.sql.gz)
shopt -u nullglob
if (( ${#PRIOR[@]} > 0 )); then
    PREV="${PRIOR[-1]}"
    PREV_SIZE=$(stat -c %s "$PREV")
    MIN_SIZE=$(( PREV_SIZE * MIN_SIZE_PCT / 100 ))
    if (( SIZE < MIN_SIZE )); then
        printf '[%s] ERROR: dump 体积异常 —— 本轮 %s B < 上一份 %s B 的 %s%%（阈值 %s B）\n' \
            "$(date -Iseconds)" "$SIZE" "$PREV_SIZE" "$MIN_SIZE_PCT" "$MIN_SIZE" >&2
        printf '       上一份：%s\n' "$PREV" >&2
        printf '       本轮产物保留在 %s 供排查（不进保留轮换，需人工清理）\n' "$TMP" >&2
        trap - EXIT   # 留证据，别在 exit 时删掉
        exit 1
    fi
fi

mv "$TMP" "$OUT"
trap - EXIT
echo "[$(date -Iseconds)] dump complete, size=$(du -h "$OUT" | cut -f1)"

# ── prune：保留最新 N 份 ───────────────────────────────────────────────────────
# 按**份数**而非 mtime 窗口（原实现是 `find -mtime +7`）：调度改点、Persistent=true 补跑、
# 手动多跑一次，都会让「天数窗口」给出意外结果，而「留最新 N 份」在任何调度形态下语义不变。
shopt -s nullglob
ALL=("$BACKUP_DIR"/pg-*.sql.gz)   # 字典升序 == 时间升序（见上）⇒ 要删的是**前面**那些
shopt -u nullglob
if (( ${#ALL[@]} > RETENTION_COPIES )); then
    for old in "${ALL[@]:0:${#ALL[@]} - RETENTION_COPIES}"; do
        printf '[%s] pruning %s\n' "$(date -Iseconds)" "$old"
        rm -f "$old"
    done
else
    printf '[%s] 现存 %s 份，未超过保留数 %s，无需清理\n' \
        "$(date -Iseconds)" "${#ALL[@]}" "$RETENTION_COPIES"
fi

echo "[$(date -Iseconds)] done"
