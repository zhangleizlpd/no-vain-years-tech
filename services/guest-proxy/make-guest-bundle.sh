#!/usr/bin/env bash
# 组包：把访客侧要用的东西打成一个 tar.gz，交给访客本人。
#
# 🚨 **canonical 不复制**：`verify-guards.sh` 与 `openclaw-skill/SKILL.md` 在仓里已有
#    唯一真相源，本脚本在**打包时**拷进去。仓里不存第二份 —— 存了必漂移，而漂移的形态是
#    「访客手里那份还在按旧规矩跑」，最难发现的一类。
#
# 跑法：
#   services/guest-proxy/make-guest-bundle.sh              # 落到 $TMPDIR
#   OUT_DIR=~/Desktop services/guest-proxy/make-guest-bundle.sh
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${OUT_DIR:-${TMPDIR:-/tmp}}"
# 包名按**通道**取（承载 K 线 + 后续期权链），不按当下唯一的那个端点取 —— 否则期权
# 开放时要么改名（访客手里的旧包名对不上），要么留一个名不副实的 kline 包。
NAME="nvy-us-market-guest"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

die() { printf '\n❌ %s\n' "$*" >&2; exit 1; }

# ── 1. 装配 ────────────────────────────────────────────────────────────────
mkdir -p "$STAGE/$NAME/openclaw-skill"

cp "$SELF_DIR/guest-bundle/README.md" "$STAGE/$NAME/"
cp "$SELF_DIR/guest-bundle/setup.sh"  "$STAGE/$NAME/"
cp "$SELF_DIR/verify-guards.sh"       "$STAGE/$NAME/"          # ← canonical
cp "$SELF_DIR/openclaw-skill/SKILL.md" "$STAGE/$NAME/openclaw-skill/"  # ← canonical

chmod 0755 "$STAGE/$NAME/setup.sh" "$STAGE/$NAME/verify-guards.sh"
chmod 0644 "$STAGE/$NAME/README.md" "$STAGE/$NAME/openclaw-skill/SKILL.md"

# ── 2. 交付前自证 ──────────────────────────────────────────────────────────
# 每条都配了「若违反会怎样」，不是走过场。

# ① 四个文件齐全 —— 少一个，访客那侧的失败形态是「脚本报缺文件」，尚可定位；
#    但少 SKILL.md 会表现成「skill 装上了但模型看不见」，极难查。
for f in README.md setup.sh verify-guards.sh openclaw-skill/SKILL.md; do
  [ -s "$STAGE/$NAME/$f" ] || die "缺文件或为空：$f"
done

# ② **包内不得含任何真凭证**。这是本脚本存在意义的一半 —— 一旦把 token 打进包，
#    它就随微信/邮件扩散且无法收回。判据挂「长十六进制 / base64 串」而非关键字，
#    因为关键字（token=）恰恰是最容易被规避的形态。
if grep -rEn '[0-9a-f]{40,}|[A-Za-z0-9+/]{43}=' "$STAGE/$NAME" \
     --include='*' 2>/dev/null | grep -v '^\s*$'; then
  die "包内出现疑似凭证（长 hex / base64 串），拒绝出包 —— 上面是命中行"
fi

# ③ setup.sh 语法可解析 —— 访客那侧多半没有 shellcheck，语法错会在他机器上才炸。
bash -n "$STAGE/$NAME/setup.sh"        || die "setup.sh 语法错"
bash -n "$STAGE/$NAME/verify-guards.sh" || die "verify-guards.sh 语法错"

# ④ README 里没有残留占位 —— 交给大模型执行的手册里留占位会让它照着填假值。
#    ⚠️ 本条**故意严到会误伤散文**：README 里连「提到」占位串都会被拦（2026-08-04 首次
#    组包即因一句描述文案命中）。宁可偶尔改措辞，也不放松一条能拦住真占位的闸 ——
#    放松的那一刻，它就退化成第二个「恒真探针」。
! grep -qE '__FILL_|TODO|FIXME' "$STAGE/$NAME/README.md" || die "README.md 有残留占位/TODO（含散文里提及）"

# ── 3. 出包 ────────────────────────────────────────────────────────────────
mkdir -p "$OUT_DIR"
TARBALL="$OUT_DIR/$NAME.tar.gz"
# --no-xattrs / COPYFILE_DISABLE：macOS 的 tar 默认会塞 ._ AppleDouble 文件，
# 解包到 Linux 上会多出一堆垃圾文件，看着像包坏了。
COPYFILE_DISABLE=1 tar -czf "$TARBALL" -C "$STAGE" "$NAME"

printf '\n✅ 已出包：%s\n\n' "$TARBALL"
printf '内容：\n'
tar -tzf "$TARBALL" | sed 's/^/  /'
printf '\n大小：%s\n' "$(du -h "$TARBALL" | cut -f1)"
printf '\n交付前请确认：包里**没有** token 与私钥（已由自证 ② 机器校验）。\n'
printf '访客还需要你单独给他两个值：77 的 wg2 公钥 + GUEST2_TOKEN。\n'
