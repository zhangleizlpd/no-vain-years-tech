#!/usr/bin/env bash
# `verify-guards.sh` 的**本地沙盒**：在开发机上用真模板 + 桩上游把闸 8（059 锚导入）
# 完整跑一遍，不需要 77、不需要 wg2、不需要真 shim / 真 app。
#
# ── 为什么它值得入库（而不是每次现搭）──────────────────────────────────────
# 059 收口把 mono 侧两把通道 token 合成了一把 ⇒ **服务端对「直写锚」与「提交待审」
# 再无可判之据**（理由与门槛见 `apps/server/src/config/guest-upload.config.ts` 顶部）。
# 「只有本人可以直写锚」这条需求因此**只剩通道层一道闸**，而验它的地方只有闸 8d 一处。
# 一个唯一的护栏，不能只在「有人想起来手搭环境」时才跑得动。
#
# ── 与 77 上真环境的三点差异，都是刻意的 ──────────────────────────────────
#   1. `listen` 从 wg2 的 10.90.0.1:8811 改成 0.0.0.0:8811 并 -p 出来 —— 那个地址只在
#      77 的 wg2 上存在（与 `deploy/install.sh` 预校验 (a) 同一手法、同一理由）。
#   2. 追加两个**桩 server**：桩 mono app（127.0.0.1:3001）与桩 shim（127.0.0.1:3002）。
#      🚨 桩 app **逐字节校验 Authorization 等于 `${GUEST_UPLOAD_TOKEN}`** —— 这正是
#      本 harness 最要紧的一条：某个 location 漏抄 `proxy_set_header` 会把 server 级
#      那把 shim token 漏下去、抄错会把访客自己的 bearer 漏下去，**两种都不会表现成
#      配置错误**，只会在桩 app 上变成 401 ⇒ 闸 8 当场红。
#   3. 桩上游只认那三条真路径，其余一律 404 ⇒ `proxy_pass` 路径写错（少个 s 之类）
#      会被抓到，而不是像纯 nginx return 的 4xx 那样全绿。
#
# ⇒ 因此**闸 8 之外的失败是 harness 的必然结果，不是回归**（没有真 shim / 真 app /
#   真能力目录）。本脚本只对闸 8 下判定，其余失败逐条列出但不计入退出码。
#
# ── 跑法 ────────────────────────────────────────────────────────────────────
#   ./verify-guards.local-harness.sh                  # 判定：闸 8 两种角色必须全绿
#   ./verify-guards.local-harness.sh --include-429    # 连限频那三条一起（慢）
#   MUTATE=1 ./verify-guards.local-harness.sh         # 自证：删掉授权闸，闸 8 必须真红
#   MUTATE=2 ./verify-guards.local-harness.sh         # 自证：直写口注错 bearer，必须真红
#
# 🚨 **`MUTATE` 是本脚本的自测，不是调试开关**。闸 8 是那条需求唯一的护栏，而「唯一的
#    护栏其实是恒真探针」正是本目录 2026-08-03 那次教训的原形。改动闸 8 或本 harness 后
#    两个变异都要跑一遍：它们覆盖**互补**的两半 —— 变异 1 只让 other 侧红（本人本来就
#    过得了授权闸），变异 2 只让 owner 侧红（他人在授权闸就被 403、根本到不了 token 那步）。
#
# 退出码：0 判定通过 · 1 判定失败 · 2 前置不满足 · 9 变异没改动文件（结果无效）
set -uo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE="${IMAGE:-nginx:1.27-alpine}"
CNAME="${CNAME:-nvy-guest-proxy-harness}"
HOSTPORT="${HOSTPORT:-18811}"
MUTATE="${MUTATE:-0}"

die() { printf '\n❌ %s\n' "$1" >&2; exit "${2:-1}"; }
hash_of() { # md5 在 macOS / Linux 上不同名，取第一个能用的
  if command -v md5 >/dev/null 2>&1; then md5 -q "$1"
  elif command -v md5sum >/dev/null 2>&1; then md5sum "$1" | cut -d' ' -f1
  else shasum "$1" | cut -d' ' -f1; fi
}

command -v docker >/dev/null 2>&1 || die "需要 docker（本 harness 在容器里装真模板跑 nginx）" 2
docker image inspect "$IMAGE" >/dev/null 2>&1 \
  || die "本机没有 $IMAGE —— 先 docker pull（国内网络可能静默卡住，见 CN 网络那几条缓解）" 2

# 📌 这里曾有一段「envsubst 过滤正则三份拷贝必须一致」的前置。那三份白名单已于 2026-08-17
#    整套删除（理由见 `deploy/install.sh` 文件头），一致性断言随之失去对象，一并删掉 ——
#    留着一条永远为真的检查，比没有检查更坏。

stage="$(mktemp -d)"
cleanup() { docker rm -f "$CNAME" >/dev/null 2>&1; rm -rf "$stage"; }
trap cleanup EXIT
docker rm -f "$CNAME" >/dev/null 2>&1

cp -r "$SRC/nginx" "$stage/nginx"
tpl="$stage/nginx/futu-shim-guest.conf.template"
perl -pi -e 's|listen 10\.\d+\.\d+\.\d+:\d+;|listen 0.0.0.0:8811;|' "$tpl"

# 桩上游**只追加到 stage 副本**，绝不落 `nginx/` —— 那个目录整体会被打包部署到 77。
cat >> "$tpl" <<'STUB'

# ══ 以下由 verify-guards.local-harness.sh 追加，不在仓内模板里 ════════════════
server {
    listen 127.0.0.1:3001;
    default_type application/json;
    # 🚨 逐字节校验通道注入的那一把：漏抄 proxy_set_header ⇒ 收到 shim 那把；
    #    抄错 ⇒ 收到访客自己那把。两种都在这里变成 401。
    location = /api/v1/optionsdesk/anchors/model-import {
        if ($http_authorization != "Bearer ${GUEST_UPLOAD_TOKEN}") { return 401 '{"status":401,"stub":"wrong bearer"}'; }
        return 400 '{"status":400,"detail":"stub app: DTO validation failed"}';
    }
    location = /api/v1/optionsdesk/anchors/submissions {
        if ($http_authorization != "Bearer ${GUEST_UPLOAD_TOKEN}") { return 401 '{"status":401,"stub":"wrong bearer"}'; }
        return 400 '{"status":400,"detail":"stub app: DTO validation failed"}';
    }
    location = /api/v1/research/reports {
        if ($http_authorization != "Bearer ${GUEST_UPLOAD_TOKEN}") { return 401 '{"status":401,"stub":"wrong bearer"}'; }
        return 400 '{"status":400,"detail":"stub app"}';
    }
    # 标的注册表两条（只读）。桩里同样逐字节校验注入的那把 token —— 新加的 location 最容易
    # 漏抄 `proxy_set_header` 整组三条，而那种漏法在纯 nginx 侧全绿。
    # 🚨 枚举口的桩 body 被刻意撑到 **> 1 KiB**：`gzip_min_length 1024` 按 Content-Length 判，
    #    桩若只回几十字节，闸 9f（Content-Encoding: gzip）会在本地恒红，而那是桩的形状问题、
    #    不是配置回归 —— 让唯一能抓「压缩静默失效」的那条断言在本地也真跑得动。
    location = /api/v1/marketdata/instrument-codes {
        if ($http_authorization != "Bearer ${GUEST_UPLOAD_TOKEN}") { return 401 '{"status":401,"stub":"wrong bearer"}'; }
        return 200 '{"market":"stub","count":1,"codes":["PAD00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"]}';
    }
    location = /api/v1/marketdata/instrument-basics {
        if ($http_authorization != "Bearer ${GUEST_UPLOAD_TOKEN}") { return 401 '{"status":401,"stub":"wrong bearer"}'; }
        return 200 '{"market":"stub","items":[],"missing":["STUB"]}';
    }
    # 路径写错（少个 s 之类）落这里 —— 纯 nginx return 的 4xx 抓不到那种错。
    location / { return 404 '{"status":404,"stub":"unknown app path"}'; }
}
server {
    listen 127.0.0.1:3002;
    default_type application/json;
    location = /healthz { return 200 '{"ok":true,"stub":"shim"}'; }
    location / { return 200 '{"stub":"shim"}'; }
}
STUB

# ── 变异（本脚本的自测，见文件头）──────────────────────────────────────────
before="$(hash_of "$tpl")"
case "$MUTATE" in
  0) ;;
  1) perl -0pi -e 's/\n        if \(\$anchor_write_allowed = "0"\) \{\n            return 403[^\n]*\n        \}\n//' "$tpl"
     echo "🧬 变异 1：删掉 /anchor-import 的授权闸 —— 期望 other 侧闸 8 真红" ;;
  2) perl -0pi -e 's/(location = \/anchor-import \{.*?)proxy_set_header Authorization "Bearer \$\{GUEST_UPLOAD_TOKEN\}";/${1}proxy_set_header Authorization "Bearer \${FUTU_SHIM_TOKEN}";/s' "$tpl"
     echo "🧬 变异 2：/anchor-import 改注入 FUTU_SHIM_TOKEN —— 期望 owner 侧闸 8 真红" ;;
  *) die "MUTATE 只支持 0 / 1 / 2" 2 ;;
esac
if [[ "$MUTATE" != "0" ]]; then
  # 🚨 没改成的变异会让结果全绿 —— 那是本 harness 能产出的最坏的假证据。
  [[ "$(hash_of "$tpl")" != "$before" ]] || die "变异 $MUTATE 没有改动模板（正则与模板文本漂了）—— 结果无效" 9
fi

# ── 假 env：由仓内模板派生，形状与 render-env.sh 的真产物一致 ────────────────
# 🚨 每个键的值必须**互不相同** —— 全填同一个串会让访客 map 撞 key
#    （`conflicting parameter`），那是 harness 的假红，不是配置的问题。
env_file="$stage/harness.env"
perl -pe 's|__FILL_([A-Z0-9_]+)__|lc($1) . "-" . ("x" x (43 - 1 - length($1)))|ge' \
  "$SRC/nvy-guest-proxy.env.example" | grep -E '^[A-Z]' > "$env_file"
perl -pi -e 's|^FUTU_SHIM_URL=.*|FUTU_SHIM_URL=http://127.0.0.1:3002|' "$env_file"
# owner 必须真等于某个 GUESTn_NAME，否则 map 命中不了（与 render-env.sh 自证 ④ 同判据）
owner_name="$(sed -n 's/^GUEST1_NAME=//p' "$env_file" | head -1)"
[[ -n "$owner_name" ]] || die "模板里取不到 GUEST1_NAME —— 结构变了，本 harness 需同步" 2
perl -pi -e "s|^ANCHOR_OWNER_NAME=.*|ANCHOR_OWNER_NAME=$owner_name|" "$env_file"
OWNER_TOKEN="$(sed -n 's/^GUEST1_TOKEN=//p' "$env_file" | head -1)"
OTHER_TOKEN="$(sed -n 's/^GUEST2_TOKEN=//p' "$env_file" | head -1)"

docker run -d --name "$CNAME" -p "$HOSTPORT:8811" \
  --env-file "$env_file" \
  -v "$stage/nginx:/etc/nginx/templates:ro" \
  -v /dev/null:/etc/nginx/conf.d/default.conf:ro \
  "$IMAGE" >/dev/null || die "容器起不来（$HOSTPORT 被占？HOSTPORT=xxxxx 换一个）" 2

BASE="http://127.0.0.1:$HOSTPORT"
for _ in $(seq 1 20); do
  curl -s -o /dev/null -m 2 "$BASE/healthz" && break
  sleep 0.5
done
docker ps --format '{{.Names}}' | grep -qx "$CNAME" \
  || { echo "容器日志："; docker logs "$CNAME" 2>&1 | tail -20; die "nginx 起来又退了（配置没过 nginx -t？）" 2; }

# ── 跑两种角色，只对闸 8 下判定 ──────────────────────────────────────────────
gate8() { awk '/^== 闸 8 /{f=1;next} /^== /{f=0} f' "$1"; }   # 闸 8 段（到下一个 == 为止）

total_bad=0
for role in other owner; do
  tok="$OTHER_TOKEN"; [[ "$role" == owner ]] && tok="$OWNER_TOKEN"
  log="$stage/out-$role.log"
  env BASE="$BASE" GUEST_TOKEN="$tok" ANCHOR_ROLE="$role" \
    bash "$SRC/verify-guards.sh" "$@" > "$log" 2>&1

  ok="$(gate8 "$log" | grep -c '✅')"
  bad="$(gate8 "$log" | grep -c '❌')"
  total_bad=$((total_bad + bad))
  printf '\n── ANCHOR_ROLE=%-6s 闸 8：%s 绿 / %s 红 ──\n' "$role" "$ok" "$bad"
  gate8 "$log" | grep -E '✅|❌' | sed 's/^/  /'
done

# 闸 8 之外的失败：harness 结构上盖不到的那些，列出来但不计入判定。
echo
echo "── 闸 8 之外的失败（harness 没有真 shim / 真 app / 真能力目录，属必然）──"
for role in other owner; do
  awk '/^== 闸 8 /{f=1;next} /^== /{f=0} !f' "$stage/out-$role.log" \
    | grep '❌' | sed "s/^/  [$role]/"
done | sort -u

echo
if [[ "$MUTATE" == "0" ]]; then
  [[ "$total_bad" == "0" ]] || die "闸 8 有 $total_bad 条红 —— 通道层那道唯一的授权闸出问题了" 1
  echo "✅ 闸 8 两种角色全绿"
else
  [[ "$total_bad" != "0" ]] \
    || die "变异 $MUTATE 之后闸 8 仍然全绿 —— 它是恒真探针，验不出这个改法" 1
  echo "✅ 变异 $MUTATE 被闸 8 抓到（$total_bad 条红）—— 它不是恒真探针"
fi
