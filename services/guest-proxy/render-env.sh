#!/usr/bin/env bash
# 渲染 /etc/nvy-guest-proxy.env —— shim 真 token 只经内存，不进 shell history。
#
# 用法（在仓库根 /home/admin/no-vain-years-mono 下，77 上以 root 跑）：
#   export SOPS_AGE_KEY_FILE=/home/admin/.config/sops/age/keys.txt
#   sops exec-env ~/.nvy/secrets.enc.env services/guest-proxy/render-env.sh
#
# 加一个访客（模板里已加好 GUESTn 那组之后）：
#   FORCE=1 sops exec-env ~/.nvy/secrets.enc.env services/guest-proxy/render-env.sh
#   → 既有访客的 token **原样沿用**，只有新占位会现生成。
#
# 轮换某个访客（点名，其余不动）：
#   ROTATE=GUEST2_TOKEN FORCE=1 sops exec-env ~/.nvy/secrets.enc.env services/guest-proxy/render-env.sh
#
# 🚨 **为什么是脚本而不是一行 `sops exec-env ... 'perl -e "...$ENV{...}"'`**：
#    那种写法里 perl 表达式外层是双引号，`sops exec-env` 经 `sh -c` 执行时
#    **shell 会先把 `$ENV` 当自己的变量展开**（空），剩下 `{FUTU_SHIM_TOKEN}`,
#    替换出来是垃圾且不报错。嵌套引号在这里必踩,所以下沉成脚本 —— 顺带也可测。
#    ⚠️ 下面所有 perl 表达式因此**一律单引号**，要传的值全走 $ENV{}。
set -euo pipefail

DEST="${DEST:-/etc/nvy-guest-proxy.env}"
TEMPLATE="${TEMPLATE:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/nvy-guest-proxy.env.example}"
# 点名要轮换的键（空格分隔，如 "GUEST1_TOKEN GUEST2_TOKEN"）。默认空 = 谁都不换。
ROTATE="${ROTATE:-}"

# sops 注入。缺了就停 —— 渲染出一个带占位符的 env 比报错危险得多:
# nginx 会拿字面量 __FILL_FUTU_SHIM_TOKEN__ 当 bearer 去打上游,401 且难查。
: "${FUTU_SHIM_TOKEN:?未拿到 FUTU_SHIM_TOKEN —— 忘了用 sops exec-env 包起来?}"
# 研报投递（057）转发给本机 mono app 的 bearer。走与 shim token 同一条路径而**不是**
# __FILL_GUESTn_TOKEN__ 那条自动发现路径：那条会现生成随机值，而这个值必须与 mono 侧
# SOPS 里的逐字节一致 —— 现生成就永远对不上，表现是投递恒 401 且 401 按设计不泄露原因。
: "${GUEST_UPLOAD_TOKEN:?未拿到 GUEST_UPLOAD_TOKEN —— 忘了用 sops exec-env 包起来?}"
# 锚直写导入（059）的第二把 bearer。同上：必须与 mono 侧 SOPS 逐字节一致 ⇒ 走 sops 注入，
# 不是 __FILL_GUESTn_TOKEN__ 那条现生成路径。
: "${ANCHOR_IMPORT_TOKEN:?未拿到 ANCHOR_IMPORT_TOKEN —— 忘了用 sops exec-env 包起来?}"
# 有权直写锚的访客名（059）。它**不是秘密**（nginx map 的 key，access log 里本就打印），
# 但空值会让直写口恒 403 ⇒ 同样要求显式提供，别让它悄悄渲染成空。
: "${ANCHOR_OWNER_NAME:?未拿到 ANCHOR_OWNER_NAME —— 它是某个 GUESTn_NAME 的值, 从 sops 或显式 env 给}"

[[ -f "$TEMPLATE" ]] || { echo "模板不存在: $TEMPLATE" >&2; exit 2; }

# 已存在就不覆盖 —— 防手滑重跑。加访客 / 轮换都要显式 FORCE=1。
# ⚠️ 语义已变（2026-08-04）：FORCE=1 **不再无差别重发所有 token**，既有值默认沿用，
#    要换谁必须 ROTATE 点名。旧行为下「加访客 2」会把访客 1 一起踢下线。
if [[ -e "$DEST" && "${FORCE:-0}" != "1" ]]; then
  echo "$DEST 已存在 —— 不覆盖。加访客/轮换加 FORCE=1（既有 token 默认沿用）。" >&2
  exit 3
fi

# ── 访客占位从**模板里发现**，不硬编码 ──────────────────────────────────────
# 加访客 3 时只改模板（和 nginx 的 map），本脚本不用动。硬编码 GUEST1/GUEST2 的话，
# 这里就成了第三个必须同步的地方 —— 而漏同步的表现是「新访客恒 401」，很难查。
guest_keys="$(grep -oE '__FILL_GUEST[0-9]+_TOKEN__' "$TEMPLATE" \
              | sed -E 's/^__FILL_(.*)__$/\1/' | sort -u)"
[[ -n "$guest_keys" ]] || { echo "模板里没有任何 __FILL_GUESTn_TOKEN__ 占位？" >&2; exit 2; }

# 既有值回读：沿用 = 不打扰已经在用的人。被 ROTATE 点名的则丢弃旧值、重新生成。
carry() {
  local k="$1"
  [[ -f "$DEST" ]] || return 0
  [[ " $ROTATE " == *" $k "* ]] && return 0
  sed -n "s/^${k}=//p" "$DEST" | head -1
}

umask 077
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
cp "$TEMPLATE" "$tmp"

FUTU_SHIM_TOKEN="$FUTU_SHIM_TOKEN" \
  perl -pi -e 's|__FILL_FUTU_SHIM_TOKEN__|$ENV{FUTU_SHIM_TOKEN}|' "$tmp"

GUEST_UPLOAD_TOKEN="$GUEST_UPLOAD_TOKEN" \
  perl -pi -e 's|__FILL_GUEST_UPLOAD_TOKEN__|$ENV{GUEST_UPLOAD_TOKEN}|' "$tmp"

ANCHOR_IMPORT_TOKEN="$ANCHOR_IMPORT_TOKEN" \
  perl -pi -e 's|__FILL_ANCHOR_IMPORT_TOKEN__|$ENV{ANCHOR_IMPORT_TOKEN}|' "$tmp"

ANCHOR_OWNER_NAME="$ANCHOR_OWNER_NAME" \
  perl -pi -e 's|__FILL_ANCHOR_OWNER_NAME__|$ENV{ANCHOR_OWNER_NAME}|' "$tmp"

# 两个清单在循环里直接攒出来 —— 别到最后再用正则从文件里反推谁新谁旧（试过，
# fresh 为空/非空两种形态下的分支正则很容易写出空子表达式，grep 直接报错）。
fresh_keys=""; kept_names=""
for key in $guest_keys; do
  # 优先级：显式 env 覆盖 > 既有值沿用 > 现生成。
  val="$(printenv "$key" 2>/dev/null || true)"
  [[ -n "$val" ]] || val="$(carry "$key")"
  if [[ -z "$val" ]]; then
    val="$(openssl rand -hex 24)"; fresh_keys="$fresh_keys $key"
  else
    kept_names="$kept_names ${key%_TOKEN}"
  fi
  # \Q…\E 把 key 里的字符当字面量（这里只会是 [A-Z0-9_]，但别指望调用方永远如此）。
  KEY="$key" VAL="$val" perl -pi -e 's|__FILL_\Q$ENV{KEY}\E__|$ENV{VAL}|' "$tmp"
done

mv "$tmp" "$DEST"
trap - EXIT
chmod 600 "$DEST"

# 🚨 用 printf '%s' 而不是 "…$DEST）" —— **全角右括号紧跟变量名**时 bash 会把
#    `DEST）` 整体当变量名解析，`set -u` 下当场炸「未绑定的变量」，退出码变成 1、
#    盖掉本函数要传的 4/5。中文注释/文案里这个形态到处都是，一律走 printf 参数化。
#    （2026-08-04 实测：只有跑失败路径才暴露，happy path 永远碰不到这个函数。）
fail() {
  rm -f "$DEST"
  printf '%s\n' "$1" >&2
  printf '（已回滚，未留下 %s）\n' "$DEST" >&2
  exit "$2"
}

# 自证 ①：没漏填。**只匹配赋值行** —— 模板注释里也含 `__FILL_` 字样,
# 裸 grep 会恒有输出,那种「永远报警」的检查等于没有检查。
# 🚨 回滚而不是留着：留着的话 ① 会被 nginx 当真配置读走 ② 下次重跑撞「已存在」而拒，
#    逼人手工 rm —— 失败路径不该留一个需要人收拾的半成品。
if grep -nE '^[A-Za-z0-9_]+ *= *__FILL_' "$DEST"; then
  fail "❌ 上面这些还没填" 4
fi

# 自证 ②：每个访客 token 非空且够长。
# 🚨 空值不是「少一个访客」，是**多一个几乎无口令的身份** —— nginx 的 map key 会退化成
#    字面量 `Bearer `。这条判据能真失败（显式传 GUESTn_TOKEN='' 即触发），不是恒真探针。
while IFS='=' read -r k v; do
  [[ ${#v} -ge 32 ]] || fail "❌ $k 长度 ${#v} < 32 —— 空/过短的访客 token 会在 nginx map 里退化成 'Bearer '" 5
done < <(grep -E '^GUEST[0-9]+_TOKEN=' "$DEST")

# 自证 ③：转发给 mono app 的两把 token 各自够长，且**互不相同**（059）。
# 🚨 两把取同值 = 回到「一把 token 走天下」，而**看上去**是两把 —— 服务端那层再也分不出
#    「直写锚」与「往待审箱里放」，整条授权闸只剩 nginx 一处。这条能真失败（把两个值填成
#    一样即触发），不是恒真探针。
mono_import="$(sed -n 's/^ANCHOR_IMPORT_TOKEN=//p' "$DEST" | head -1)"
mono_upload="$(sed -n 's/^GUEST_UPLOAD_TOKEN=//p' "$DEST" | head -1)"
[[ ${#mono_import} -ge 32 ]] || fail "❌ ANCHOR_IMPORT_TOKEN 长度 ${#mono_import} < 32" 5
[[ ${#mono_upload} -ge 32 ]] || fail "❌ GUEST_UPLOAD_TOKEN 长度 ${#mono_upload} < 32" 5
[[ "$mono_import" != "$mono_upload" ]] || fail "❌ ANCHOR_IMPORT_TOKEN 与 GUEST_UPLOAD_TOKEN 取了同一个值 —— 授权分流形同虚设" 5

# 自证 ④：直写授权的访客名非空，**且真的是某个访客的名字**（059）。
# 空值 → 直写口恒 403（fail-closed，可接受但要能一眼看出）；填了个不存在的名字 → 同样恒 403，
# 而那种错更隐蔽：值看着「有」，只是永远匹配不上任何 $guest_name。
owner="$(sed -n 's/^ANCHOR_OWNER_NAME=//p' "$DEST" | head -1)"
[[ -n "$owner" ]] || fail "❌ ANCHOR_OWNER_NAME 为空 —— 直写口会恒 403（谁都不许写）" 5
if ! grep -qE "^GUEST[0-9]+_NAME=${owner}$" "$DEST"; then
  fail "❌ ANCHOR_OWNER_NAME=$owner 不是任何 GUESTn_NAME 的值 —— 直写口会恒 403 且看不出哪错" 5
fi

echo "✅ 已渲染 $DEST (0600)"
echo
if [[ -n "$fresh_keys" ]]; then
  echo "本次**新生成**的 bearer（只此一次打印，之后从文件里取）："
  for key in $fresh_keys; do
    printf '    %-14s %s\n' "${key%_TOKEN}" "$(sed -n "s/^${key}=//p" "$DEST" | head -1)"
  done
else
  echo "本次没有新 token —— 既有访客全部沿用（要换某个：ROTATE=GUESTn_TOKEN FORCE=1）。"
fi
if [[ -n "$kept_names" ]]; then
  echo
  echo "沿用未变、**无需通知**的访客：${kept_names# }"
fi
echo
echo "⚠️ 上游的 FUTU_SHIM_TOKEN 不在上面、也不该出现在任何要发出去的地方。"
