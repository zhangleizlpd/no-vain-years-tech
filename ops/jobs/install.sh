#!/usr/bin/env bash
#
# ops/jobs/install.sh — 把 ops/jobs/ 下的宿主机定时任务装到本机（77）。**幂等，可反复跑。**
#
# 用法（仓根，需 root）：
#   sudo bash ops/jobs/install.sh
#
# 🚨 **常态是自动的**：`deploy.yml` 每次部署在最后一步无条件跑本脚本（77 的 checkout 已由
#    同一次部署 `git reset --hard origin/main`）。上面那条手动命令只用于**急用**（改了
#    ops/jobs 但近期不发版）或**部署里这一步红了**时补跑。
#    为什么必须有这一步：2026-08-17 假红事故 —— #73 的 ET 周末闸合进了 main、77 的 checkout
#    也更新了，但 /usr/local/lib/nvy/jobs/ 下**真正被 timer 跑的那份**没人来铺，探针继续跑
#    旧谓词，次晨照常推假红。**仓里改了 ≠ 机器上生效。**
#
# 落点：
#   ops/lib/*.sh         → /usr/local/lib/nvy/        共享件（wrapper / 飞书 / 看门狗）
#   ops/jobs/*.sh|*.sql  → /usr/local/lib/nvy/jobs/   任务本体，`<unit>.sh` 与 `<unit>.sql` 同目录兄弟
#   ops/jobs/systemd/*   → /etc/systemd/system/       unit 文件名即 unit 名
#
# 🚨 **不自动 enable**：哪些 timer 该开着是人的决定，不该被一次装机脚本悄悄改写。
#    开：sudo systemctl enable --now <unit>.timer   关：sudo systemctl disable --now <unit>.timer
#
# 🚨 本脚本 2026-08-07 随 ops/jobs 扁平化诞生，替掉了原先散在 6 个 .service 头注释里的**6 段
#    各不相同**的 cp 说明（其中两个任务装 /usr/local/bin、四个装 /usr/local/lib/nvy/<dir>/，
#    且两个带谓词的任务必须整目录 cp 才不散架）。扁平化后落点同构，一段就够。
#
# 退出码：0 装完且自检过 | 2 环境不对（非 root / 找不到源树） | 5 装完但自检失败
set -euo pipefail

SRC_JOBS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_LIB="$(cd "$SRC_JOBS/../lib" && pwd)"
DEST_LIB=/usr/local/lib/nvy
DEST_JOBS="$DEST_LIB/jobs"
DEST_UNITS=/etc/systemd/system

[[ "${EUID:-$(id -u)}" -eq 0 ]] || { echo "需要 root：sudo bash ops/jobs/install.sh" >&2; exit 2; }
[[ -d "$SRC_LIB" ]] || { echo "找不到 ops/lib（源树不完整？）: $SRC_LIB" >&2; exit 2; }

echo "① 共享件 → $DEST_LIB"
install -d -m 0755 "$DEST_LIB"
install -m 0755 -t "$DEST_LIB" "$SRC_LIB"/*.sh

echo "② 任务本体 → $DEST_JOBS"
install -d -m 0755 "$DEST_JOBS"
install -m 0755 -t "$DEST_JOBS" "$SRC_JOBS"/*.sh
install -m 0644 -t "$DEST_JOBS" "$SRC_JOBS"/*.sql
# install.sh 自己不该躺在运行目录里冒充任务（它没有对应 unit，且需要 root）。
rm -f "$DEST_JOBS/install.sh"

echo "③ unit → $DEST_UNITS"
install -m 0644 -t "$DEST_UNITS" "$SRC_JOBS"/systemd/*

# ── ④ 清理扁平化之前的旧落点 ────────────────────────────────────────────────────
# 逐条写死，不用通配 —— 这个目录下还有别的东西，glob 删是拿整台机器赌一个 typo。
# 留着旧副本的害处不是占空间，是「有人手动跑到那个陈旧版本」且看不出它是陈旧的。
echo "④ 清理旧落点（扁平化前的形状）"
legacy_removed=0
for p in "$DEST_LIB/futu-shim-health" \
         "$DEST_LIB/marketdata-calendar-health" \
         "$DEST_LIB/marketdata-table-health" \
         "$DEST_LIB/static-calendar-annual-reminder" \
         /usr/local/bin/check-cert-expiry.sh \
         /usr/local/bin/marketdata-sync-report.sh; do
  if [[ -e "$p" ]]; then rm -rf "$p"; echo "   removed $p"; legacy_removed=1; fi
done
[[ "$legacy_removed" -eq 0 ]] && echo "   无旧落点（已清或首装）"

systemctl daemon-reload

# ── ⑤ 自检：每个 unit 的 ExecStart 指到的东西**真的装上了** ──────────────────────
# 这正是本次重排最大的风险面：unit 指着一个已经不存在的脚本，systemd 不会提前告诉你，
# 要等到下一次 OnCalendar 触发才 203/EXEC —— 而 5 个任务是 --on-success silent，
# 失败会推飞书，但「装错了」和「探到了真故障」在飞书上长得一样。这里当场判掉。
echo "⑤ 自检：ExecStart 目标存在性"
fail=0
for unit in "$SRC_JOBS"/systemd/*.service; do
  name="$(basename "$unit")"
  # 取 ExecStart 行里所有 /usr/local/ 开头的 token（wrapper 自身 + 被包裹的任务脚本）。
  while read -r target; do
    [[ -z "$target" ]] && continue
    if [[ -x "$target" ]]; then
      printf '  ✅ %-42s %s\n' "$name" "$target"
    else
      printf '  ❌ %-42s %s 不存在或不可执行\n' "$name" "$target"; fail=1
    fi
  done < <(grep -h '^ExecStart=' "$unit" | tr ' ' '\n' | grep '^/usr/local/' || true)
done

echo
echo "⑥ timer 现状（本脚本不改 enable 状态）"
# 🚨 这个 grep 是**手写白名单**，加新任务时必须同步加进来 —— 漏一个的表现是「装完了、清单里
#    却没有它」，看起来像没装上（backup-pg 在 2026-08-08 就这么骗过一次人）。
systemctl list-timers --all --no-pager \
  | grep -E 'backup-pg|cert-expiry|futu-shim-health|marketdata-|static-calendar|nvy-watchdog' || echo "   （一个都没 enable）"

if (( fail )); then
  echo
  echo "⚠️  自检未过：上面标 ❌ 的 unit 会在下次触发时 203/EXEC。先修再 enable。" >&2
  exit 5
fi
echo
echo "✅ 装完。enable 由你定：sudo systemctl enable --now <unit>.timer"
