#!/usr/bin/env bash
# 访客代理在 77 上的安装器。**随 tar 流送达并就地执行**，77 上不预装任何脚本 ——
# 逻辑因此随仓版本化、每次部署自我更新。
#
# 调用形状（由 GH Actions 发起）：
#
#   tar -czf - -C services/guest-proxy . | ssh admin@77 \
#     'd=$(mktemp -d); tar -xzf - -C "$d"; sudo bash "$d/deploy/install.sh" <sha>'
#
# 🚨 为什么配置装到 /opt 而不是留在仓 clone 里：`deploy.yml` 会在
# `/home/admin/no-vain-years-mono` 上跑 `git reset --hard origin/main`，而访客代理的
# compose 原先直接挂那个目录 ⇒ prod 每次发版都会把新配置**带到磁盘上却不 reload**，
# 留下「磁盘新、运行旧」的半态，且之后任何一次容器重建都会把它静默滚上线。
# 搬到 /opt 之后配置来源与那个 clone 彻底解耦，这个半态从机制上消失。
#
# 退出码（刻意分开，好让 workflow 一眼判因）：
#   0 成功 | 2 入参非法 | 3 检出手改漂移 | 4 预校验失败 | 5 部署后自检失败
set -euo pipefail

SHA="${1:-}"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "❌ 需要 40 位 SHA 作为第一个参数，实得：'$SHA'" >&2; exit 2; }
FORCE="${2:-}"

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST=/opt/nvy-guest-proxy
ENV_FILE=/etc/nvy-guest-proxy.env
UNIT=/etc/systemd/system/nvy-guest-proxy.service
MANIFEST_NAME=.deployed.manifest
IMAGE=nginx:1.27-alpine
# 🚨 **这条正则在仓里有三份拷贝，加新键时必须三处一起改**（2026-08-15 实撞：057 只改了
#    compose 那份，deploy 当场以 `unknown "guest_upload_token" variable` 红在下面的预校验上）：
#      ① 本行 —— 预校验 (a) 的一次性容器用它
#      ② `docker-compose.guest.yml` 的 `NGINX_ENVSUBST_FILTER` —— **真容器**用它
#      ③ 本文件 (d) 的残留扫描 —— 用它反向确认没有 `${VAR}` 漏替换
#    ①③ 漏改的表现不同、都很阴：① 让部署恒红在预校验（**至少它红了**）；③ 让残留检不出来，
#    自检在配置已经坏掉的情况下判绿。三处不合并成一份是因为 ② 在 YAML 里、①③ 在 shell 里，
#    没有干净的共享点；代价就是这条注释。
ENVSUBST_FILTER='^(FUTU_SHIM_URL|FUTU_SHIM_TOKEN|GUEST_UPLOAD_TOKEN|GUEST[0-9]+_TOKEN|GUEST[0-9]+_NAME)$'

log() { printf '\n\033[1m%s\033[0m\n' "$*"; }
die() { printf '\n❌ %s\n' "$*" >&2; exit "${2:-1}"; }

[[ -f "$SRC/nginx/futu-shim-guest.conf.template" ]] \
  || die "收到的树里没有 nginx/futu-shim-guest.conf.template —— 管道空了或打包目录错了" 2
[[ -f "$ENV_FILE" ]] || die "$ENV_FILE 不存在。首次上线要先按 runbook 步骤 4 渲染 env" 2

# ── ① 漂移检测：有人在 77 上手改过就红 ────────────────────────────────────────
# 判据是上一次部署时落的 sha256 清单。**红是刻意的** —— 手改能被发现，比被静默覆盖好。
# 2026-08-05 就发生过一次（guest_kline 手改成 110 且没进仓），当时是 `git pull --ff-only`
# 拒绝脏树才没被抹掉；搬到 /opt 之后没有 git 兜着了，这段就是它的替代品。
log "① 漂移检测"
if [[ -f "$DEST/$MANIFEST_NAME" ]]; then
  if ! ( cd "$DEST" && sha256sum -c --quiet "$MANIFEST_NAME" ) 2>/tmp/drift.txt; then
    echo "以下文件与上次部署时不一致（有人直接在 77 上改过）：" >&2
    ( cd "$DEST" && sha256sum -c "$MANIFEST_NAME" 2>/dev/null || true ) | grep -v ': OK$' >&2 || true
    if [[ "$FORCE" == "--force" ]]; then
      echo "⚠️  收到 --force，**覆盖**上述手改继续部署" >&2
    else
      die "拒绝覆盖手改。先把它写回仓走 PR；确实要丢弃就用 workflow_dispatch 的 force 选项" 3
    fi
  fi
  echo "  ✅ 无漂移"
else
  echo "  ℹ️ 首次部署（无清单），跳过"
fi

# ── ② 预校验：坏配置绝不能碰到真容器 ──────────────────────────────────────────
# 🚨 这一步是自动化相对人工**必须多做**的：`reload` 的实现是
# `docker compose up -d --force-recreate --wait`，配置非法时 nginx 起不来、容器进重启
# 循环 ⇒ **访客通路直接断**。人工部署有人盯着，自动部署没有。
#
# 🚨 **`nginx -t` 会真 bind**（2026-08-07 实测：先报 `syntax is ok`，随后
# `bind() to 10.90.0.1:8811 failed (99: Address not available)` 并判 test failed）。
# 所以不能直接拿原模板在容器里测 —— 那个地址只存在于宿主的 wg2 上。
# ⇒ 拆成两段，各自覆盖一个**它真能覆盖**的失败面，谁都不假装覆盖了对方：

# (a) 语法 / map / 正则 / 变量引用 —— 在容器里跑，listen 改写成容器内必然可 bind 的地址。
#     这一段能抓到的正是历史上真踩过的那几个：`could not build map_hash`（桶宽不够）、
#     `unknown "guest2_name" variable`（模板引用了 env 里还不存在的键）、正则写错。
#     它们全都在**配置解析阶段**报错，早于 bind ⇒ 换个 listen 地址不影响这一段的效力。
log "② 预校验 (a) 语法 · 一次性容器"
stage="$(mktemp -d)"; trap 'rm -rf "$stage"' EXIT
cp -r "$SRC/nginx" "$stage/nginx"
listen_line="$(grep -oP '^\s*listen \K10\.\d+\.\d+\.\d+:\d+(?=;)' "$SRC/nginx/futu-shim-guest.conf.template" | head -1)"
[[ -n "$listen_line" ]] || die "模板里找不到 wg2 的 listen 行 —— 结构变了，本脚本需同步" 4
sed -i "s|listen ${listen_line};|listen 127.0.0.1:18811;|" "$stage/nginx/futu-shim-guest.conf.template"
docker run --rm \
  --env-file "$ENV_FILE" \
  -e NGINX_ENVSUBST_FILTER="$ENVSUBST_FILTER" \
  -v "$stage/nginx:/etc/nginx/templates:ro" \
  -v /dev/null:/etc/nginx/conf.d/default.conf:ro \
  "$IMAGE" nginx -t \
  || die "新配置没通过 nginx -t —— 真容器一个字节都没动，现网仍是旧配置" 4

# (b) 真实 listen 地址**在本机存在** —— 这是 (a) 结构上盖不到的那一半，也是「容器起不来
#     进重启循环」最现实的成因（改错地址 / wg2 没起）。判据是派生的：模板里那个地址必须
#     出现在宿主的网卡上，不是拿一个写死的期望值去比。
log "② 预校验 (b) listen 地址在本机存在：$listen_line"
if ! ip -4 -o addr show | grep -qF " ${listen_line%%:*}/"; then
  die "模板要 bind ${listen_line}，但本机没有 ${listen_line%%:*} 这个地址（wg2 起了吗？）—— 真容器未动" 4
fi
echo "  ✅ 地址在 $(ip -4 -o addr show | grep -F " ${listen_line%%:*}/" | awk '{print $2}') 上"

# (c) 🚨 **Gate A：能力目录声明的端点集 == nginx 实际放行的端点集。**
#     访客手里的 skill 是薄壳、不含端点清单,清单只在 `capabilities/capabilities.md` 里,
#     由 `/capabilities` 下发。⇒ 目录一旦与白名单不一致,访客侧的坏法有两种,**都不会
#     有任何东西报错**：
#       ① 目录列了 nginx 没放的 → agent 照着打,恒 404,它会以为是自己参数写错反复试;
#       ② nginx 放了目录没列的 → 新能力上线了但访客永远不知道,**这正是本次改造要消灭的
#          那个问题原样复活**,而且比原来更隐蔽(原来至少还有「发包」这个动作提醒你)。
#     所以它必须是闸,不是约定。
#
#     🚨 **放在预校验而不是部署后自检**:两侧都是本次送来的树里的静态文件,不需要容器就能
#     判 ⇒ 按本文件的原则,坏配置一个字节都不该碰到真容器。
#
#     🚨 **`/__ping` 必须豁免**:它在文件顶部那个 `listen 127.0.0.1:8812` 的独立探针 server
#     里,访客根本够不到,不属于对外能力。不豁免的话本闸恒红。
#
#     🚨 **新解析一律 POSIX ERE(`-oE`),不用 `-oP`**:本文件别处的 `-oP` 都跑在 77 的 GNU grep
#     上没问题,但这段逻辑要能在开发机上被反例测试,而 macOS 侧的 `grep` 可能是 BSD grep /
#     ugrep(实测本仓开发机是 ugrep 7.5.0)。同名工具跨环境实现不同 ⇒ 能不依赖就不依赖。
log "② 预校验 (c) Gate A：能力目录 ↔ 端点白名单"
CATALOG="$SRC/capabilities/capabilities.md"
[[ -f "$CATALOG" ]] || die "找不到 $CATALOG —— 薄壳 skill 靠它下发端点清单,缺了访客侧就没有任何能力说明" 4

nginx_set="$(grep -oE 'location = [^ {]+' "$SRC/nginx/futu-shim-guest.conf.template" \
             | sed 's|location = ||' | grep -v '^/__ping$' | sort -u)"
# 目录侧只认「端点一览」表里那种以反引号路径开头的行。研报参数表的 `symbol` 之类同样带
# 反引号,靠 `/` 这一位把它们排除掉。
catalog_set="$(grep -oE '^\| `/[a-z-]+`' "$CATALOG" | sed -E 's/^\| `//; s/`$//' | sort -u)"

# 🚨 反空转闸:任一侧为空则 `comm` 的差集恒空、本闸恒绿 —— 那正是本文件反复在打的那种病。
if [[ -z "$nginx_set" || -z "$catalog_set" ]]; then
  die "Gate A 自己坏了：nginx 侧解析出 $(wc -w <<<"$nginx_set") 条 / 目录侧 $(wc -w <<<"$catalog_set") 条，有一侧为空" 4
fi

only_nginx="$(comm -23 <(echo "$nginx_set") <(echo "$catalog_set") | tr '\n' ' ')"
only_catalog="$(comm -13 <(echo "$nginx_set") <(echo "$catalog_set") | tr '\n' ' ')"
if [[ -n "$only_nginx" || -n "$only_catalog" ]]; then
  [[ -n "$only_nginx"  ]] && echo "  ❌ nginx 放行但目录没列（访客看不到这些新能力）：$only_nginx" >&2
  [[ -n "$only_catalog" ]] && echo "  ❌ 目录列了但 nginx 没放（访客照着打会恒 404）：$only_catalog" >&2
  die "Gate A 不通过 —— 改 nginx 的 location 就必须同步 capabilities/capabilities.md。真容器一个字节都没动" 4
fi
echo "  ✅ 两侧一致，$(wc -l <<<"$nginx_set") 个对外端点"

# ── ③ 落盘 ────────────────────────────────────────────────────────────────────
# 先铺到 .new 再 mv，避免「铺一半被 reload 撞上」。运行中的容器是 bind mount，
# 跟的是 inode，mv 目录不会把它打断 —— 它继续用旧的，直到 ④ 重建。
log "③ 落盘到 $DEST"
rm -rf "$DEST.new"
mkdir -p "$DEST.new"
tar -C "$SRC" -cf - . | tar -C "$DEST.new" -xf -
printf '%s\n' "$SHA" > "$DEST.new/VERSION"
# 清单在**换目录之前**生成，内容即本次部署的权威状态；VERSION 自身也纳入。
( cd "$DEST.new" && find . -type f ! -name "$MANIFEST_NAME" -print0 \
    | sort -z | xargs -0 sha256sum > "$MANIFEST_NAME" )
chmod -R go-w "$DEST.new"
rm -rf "$DEST.prev"
[[ -d "$DEST" ]] && mv "$DEST" "$DEST.prev"
mv "$DEST.new" "$DEST"
echo "  ✅ $(wc -l < "$DEST/$MANIFEST_NAME") 个文件，VERSION=$SHA"

# ── ④ unit：幂等，首跑顺带完成从仓 clone 到 /opt 的切换 ──────────────────────
log "④ systemd unit"
if ! cmp -s "$SRC/nvy-guest-proxy.service" "$UNIT"; then
  install -m 0644 "$SRC/nvy-guest-proxy.service" "$UNIT"
  systemctl daemon-reload
  echo "  ✅ unit 已更新并 daemon-reload"
else
  echo "  ℹ️ unit 无变化"
fi

# 🚨 一次性切换闸：清掉「名字对得上、但属于另一个 compose project」的遗留容器。
#    compose 默认从目录名派生 project，而配置目录 2026-08-07 从仓 clone 内（当时叫
#    `ops/guest-access`，同日已挪到 `services/guest-proxy`）搬到
#    了 `/opt/nvy-guest-proxy`；`container_name` 又是写死的 ⇒ 新 project 创建时会撞
#    `name is already in use`，**首次自动部署当场失败**。compose 里已补 `name:` 钉死身份，
#    这里再把遗留的那个收掉。判据取自 compose 自己打的标签，不是猜目录名。
want_project="$(grep -oP '^name:\s*\K\S+' "$DEST/docker-compose.guest.yml" || echo nvy-guest-proxy)"
have_project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' \
                  nvy-guest-proxy 2>/dev/null || echo '')"
if [[ -n "$have_project" && "$have_project" != "$want_project" ]]; then
  echo "  ⚠️ 检出遗留容器（project=${have_project}，目标 ${want_project}）—— 一次性切换，先移除"
  docker rm -f nvy-guest-proxy >/dev/null
fi

started_at="$(date -u +%s)"
systemctl reload nvy-guest-proxy || systemctl restart nvy-guest-proxy

# ── ⑤ 部署后自检：**零 vendor 调用**，全部只看本机状态 ────────────────────────
log "⑤ 自检（零 vendor 调用）"
fail=0
ck() { if [[ "$2" == "$3" ]]; then printf '  ✅ %-38s %s\n' "$1" "$3"; else printf '  ❌ %-38s 期望 %s 实得 %s\n' "$1" "$2" "$3"; fail=1; fi; }

# (a) unit 活着
ck "unit active" active "$(systemctl is-active nvy-guest-proxy || true)"

# (b) 容器**确实被重建了**。只看 is-active 不够 —— reload 失败但旧容器还跑着时它照样 active，
#     那正是「部署了个寂寞」的形态。用创建时刻晚于本次开始来证明。
created="$(docker inspect -f '{{.Created}}' nvy-guest-proxy 2>/dev/null || echo '')"
created_ts="$(date -u -d "$created" +%s 2>/dev/null || echo 0)"
if (( created_ts >= started_at - 5 )); then
  printf '  ✅ %-38s %s\n' "容器已重建" "$created"
else
  printf '  ❌ %-38s %s（早于本次部署）\n' "容器已重建" "$created"; fail=1
fi

# (c) 运行实例加载的路由集 ⊇ 本次送来的模板里声明的路由集。
#     两侧都是**派生的**，没有手维护清单 —— 加端点不需要同步任何地方。
#     🚨 反空转闸：任一侧为空则集合比较恒真，那正是本脚本要消灭的病，别让它换形状回来。
#     🚨🚨 **解析一律在宿主机做，容器里只 `cat`。** 镜像是 nginx:1.27-alpine，其 grep 是
#     BusyBox v1.37.0（usage 仅 `-HhnlLoqvsrRiwFE`），**不认 `-P`** —— 容器内跑 `grep -oP`
#     会 `unrecognized option: P` 退出，被 `2>/dev/null || true` 吞成空，于是恰好触发上面
#     那条反空转闸。首次自动部署（2026-08-07 run 31162526709）就是这么红的：模板侧 7 条 /
#     运行侧 0 条。两侧改用同一条宿主机表达式后，「两侧工具不对称 ⇒ 静默不对称」这一整类
#     病一并消失；容器里今后**只准 `cat`**，别再把解析挪回去。
running_conf="$(docker exec nvy-guest-proxy cat /etc/nginx/conf.d/futu-shim-guest.conf 2>/dev/null || true)"
want="$(grep -oP '(?<=location = )\S+' "$DEST/nginx/futu-shim-guest.conf.template" | sort -u || true)"
got="$(grep -oP '(?<=location = )\S+' <<<"$running_conf" | sort -u || true)"
if [[ -z "$want" || -z "$got" ]]; then
  printf '  ❌ %-38s 模板侧 %s 条 / 运行侧 %s 条 —— 有一侧解析为空，探针自己坏了\n' \
    "路由集比对" "$(wc -w <<<"$want")" "$(wc -w <<<"$got")"; fail=1
elif [[ -z "$(comm -23 <(echo "$want") <(echo "$got"))" ]]; then
  printf '  ✅ %-38s %s 条全部就位\n' "路由集比对" "$(wc -l <<<"$want")"
else
  printf '  ❌ %-38s 运行实例缺少：%s\n' "路由集比对" \
    "$(comm -23 <(echo "$want") <(echo "$got") | tr '\n' ' ')"; fail=1
fi

# (d) 敏感占位零残留。漏替换的形态最阴：nginx 起得来、日志正常，只是那个访客恒 401。
#     🚨 **别写 `grep -c … || echo 0`**：无匹配时 grep **打印 `0` 且退出 1**，`|| echo 0` 会再
#     追一个 0，变量成 `"0\n0"`，与期望值 `0` 永不相等 ⇒ **恒红**。同一次 run 的第二条红就是
#     它——日志里「期望 0 实得 0」下面那个孤零零的 `0`，正是被追加的第二个 0 被 `%s` 换行打出来。
#     无匹配是本断言的**正常态**，所以这里只能用 `|| true`（吞退出码、不碰 stdout）。
if [[ -z "$running_conf" ]]; then
  printf '  ❌ %-38s 运行侧配置读不到，无从判定\n' "敏感占位残留"; fail=1
else
  # 🚨 第三份拷贝，见文件头 ENVSUBST_FILTER 处的三处同步说明。漏一个键在**这里**不会让
  #    部署红 —— 只会让这条断言对那个键失明，配置坏了也判绿。
  residue="$(grep -cE '\$\{(FUTU_SHIM_URL|FUTU_SHIM_TOKEN|GUEST_UPLOAD_TOKEN|GUEST[0-9]+_(TOKEN|NAME))\}' <<<"$running_conf" || true)"
  ck "敏感占位残留" 0 "$residue"
fi

if (( fail )); then
  echo
  echo "⚠️  自检未过。上一版仍在 $DEST.prev，回滚："
  echo "    rm -rf $DEST && mv $DEST.prev $DEST && systemctl reload nvy-guest-proxy"
  exit 5
fi

log "✅ 部署完成 @ $SHA"
