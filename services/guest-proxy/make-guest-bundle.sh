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

# ⑤ **包里不许出现端点清单**（Gate C）。
#    本包的全部意义已经变了：以前它是「把能力说明送到访客手上」，现在能力说明走
#    `/capabilities` 下发，本包只送「怎么够到通道」。⇒ 任何端点名重新出现在 skill 或
#    README 里，就是那份会漂的第二拷贝**原样复活**，而漂移的形态是「访客手里那份还在按
#    旧规矩跑」—— 最难发现的一类（同本文件头部「canonical 不复制」那条的理由）。
#
#    🚨 **判据从目录派生，不写死清单。** 写死的话，日后新增的端点不在名单里 ⇒ 有人把它
#    抄进 skill 也照样绿，本闸对新端点失明。
#    豁免只有两个：`/capabilities` 是入口本身，`/healthz` 是通路探针 —— 两者都属于
#    「怎么够到通道」，不随能力增删而变。
CATALOG="$SELF_DIR/capabilities/capabilities.md"
[ -s "$CATALOG" ] || die "找不到 $CATALOG —— 端点清单的 canonical 没了，本闸无从判定"
stray=""
while read -r ep; do
  [ -n "$ep" ] || continue
  case "$ep" in /capabilities|/healthz) continue ;; esac
  for f in openclaw-skill/SKILL.md README.md; do
    # 🚨 写成 `grep -qF … && stray=…` 在 `set -e` 下是雷：不命中(= 正常态)时整条 `&&`
    #    列表返回非零，而它又是循环体最后一条命令 ⇒ 循环退出码非零。用显式 if 避开。
    if grep -qF "$ep" "$STAGE/$NAME/$f"; then stray="$stray $f:$ep"; fi
  done
done <<EOF
$(grep -oE '^\| `/[a-z-]+`' "$CATALOG" | sed -E 's/^\| `//; s/`$//' | sort -u)
EOF
[ -z "$stray" ] || die "包里出现了端点清单（应只在 capabilities.md 里）：$stray"

# ⑥ **skill 的 description 必须带泛化闸**（Gate D）。
#    2026-08-16 PoC 实测（MiniMax-M3，隔离 profile）：description 写成能力级（只提
#    K 线）时，问一个**只存在于远端目录**的能力，skill **根本不会被激活** ——
#    而失败形态不是「agent 说做不到」，是**它拿训练数据编了一整张表并标注「✅ 已确认」**。
#    访客拿到一份看起来很权威的假数据，且没有任何东西会告诉他那是假的。
#
#    ⇒ 本闸不是查「有没有能力词」（PoC 里通过的那版 description 本身就举了几个能力当例子），
#    而是查**两个泛化子句在不在**：
#      · `catalog`             —— 告诉模型清单在别处、要去取
#      · `any other capability` —— 明说清单不封闭，别拿这几个例子当全集
#    把旧的能力级 description 粘回来，两者都会消失 ⇒ 出包当场红。
desc="$(grep -m1 '^description: ' "$STAGE/$NAME/openclaw-skill/SKILL.md" || true)"
[ -n "$desc" ] || die "SKILL.md 没有 description —— skill 不会被模型看到"
printf '%s' "$desc" | grep -qi 'catalog' \
  || die "description 里没提 catalog —— 模型不知道要去取清单，会拿记忆编（PoC 实测形态）"
printf '%s' "$desc" | grep -qi 'any other capability' \
  || die "description 缺 catch-all（'any other capability'）—— 新能力上线后 skill 不会被激活"

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
