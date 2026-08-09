#!/usr/bin/env bash
# 港机侧部署入口。**安装到 `/usr/local/sbin/futu-shim-deploy`（root:root 0755）**，并作为
# 部署专用 ssh key 的 forced command —— 那把 key 因此只能触发部署，拿不到 shell。
#
# 调用形状（由 77 发起，代码走 stdin，不在港机上放 GitHub 凭证）：
#
#   tar -czf - -C services/futu-shim . | ssh 77 "ssh -T hk <sha>"
#
# authorized_keys 里对应一行：
#
#   command="sudo /usr/local/sbin/futu-shim-deploy",restrict ssh-ed25519 AAAA... nvy-shim-deploy@77
#
# 🚨 为什么代码走 stdin 而不是让港机自己 `git pull`：那需要在港机上放一把能读私有仓的
# GitHub 凭证，凭证面 +1；而 tar 流的内容就是 **CI 刚验过的那棵工作树**，来源与验证对象
# 严格同一份。港机因此不需要认识 GitHub。
#
# 退出码（刻意分开，好让上游 workflow 一眼判因）：
#   0 成功 | 2 入参非法 | 3 装完版本对不上 | 4 端点自检失败 | 其它 = install.sh 自身失败
set -euo pipefail

ENV_FILE=/etc/futu-shim.env

[[ $EUID -eq 0 ]] || { echo "must run as root (forced command 应带 sudo)" >&2; exit 2; }

# forced command 下真实入参在 SSH_ORIGINAL_COMMAND；手工调用时退化到 $1。
raw="${SSH_ORIGINAL_COMMAND:-${1:-}}"
# 🚨 白名单取值，不是黑名单过滤：这串会进环境变量与文件，来源是网络输入。
sha="$(printf '%s' "$raw" | tr -cd '0-9a-f')"
if [[ ${#sha} -lt 7 || ${#sha} -gt 40 ]]; then
  echo "非法版本参数: 期望 7-40 位十六进制 git SHA, 实得 ${raw@Q}" >&2
  exit 2
fi

workdir="$(mktemp -d /tmp/futu-shim-deploy.XXXXXX)"
trap 'rm -rf "$workdir"' EXIT

echo "==> 收取代码 (stdin tar.gz)"
tar -xzf - -C "$workdir"

# 收到的必须真是这个 service 的树 —— 防「管道空了 / 传错目录」被当成一次成功部署。
for required in deploy/install.sh src/futu_shim/app.py requirements.txt; do
  [[ -f "$workdir/$required" ]] || { echo "包内缺 $required —— 拒绝部署" >&2; exit 2; }
done

echo "==> install.sh (version=$sha)"
NVY_SHIM_VERSION="$sha" bash "$workdir/deploy/install.sh"

echo "==> 部署后自检"
BIND_HOST="$(grep -oP '(?<=^FUTU_SHIM_HOST=).*' "$ENV_FILE")"
BIND_PORT="$(grep -oP '(?<=^FUTU_SHIM_PORT=).*' "$ENV_FILE")"
BASE="http://${BIND_HOST}:${BIND_PORT}"

# ① 跑着的版本 == 刚部署的版本。这条是整个版本闸的兑现点：**不比对就等于没有闸**。
running="$(curl -fsS --max-time 5 "$BASE/healthz" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("version",""))')"
if [[ "$running" != "$sha" ]]; then
  echo "版本对不上: 跑着的=${running:-<空>} 期望=$sha" >&2
  echo "（这正是 2026-08-01 那次静默回退的形状 —— 装上的不是你以为的那份）" >&2
  exit 3
fi
echo "    version ✓ $running"

# ② 跑着的进程真的加载了这棵树的路由。
#
# 判据 = 「本次收到的源码里声明的 route」⊆「运行实例 url_map 里注册的 route」。两侧都是
# 派生的，没有手维护清单 —— 新增 route 不需要同步任何地方。
#
# 🚨 为什么不再「探一组路径看状态码」（2026-08-03 实测推翻了原判据）：不带 token 时
# **未注册的路径同样返回 401**，因为 Flask 的 preprocess_request（鉴权钩子）跑在
# dispatch_request 抛路由 404 之前。拿 /definitely-not-a-route 去打也是 401 ⇒ 那个探法
# 恒真、检不出任何缺失路由。它也不是 08-01 那次 /kline 被静默抹掉的发现者 —— 那次是 ① 抓的。
#
# 🚨 为什么 ① 不够：`/healthz` 的 version 是**现读磁盘上的 VERSION 文件**，install.sh 铺完
# 新树但服务没真重启时，内存里的旧代码照样读到新文件、报出新 SHA，版本闸就被绕过去了。
# url_map 是**已加载代码的内存状态**，磁盘文件伪造不了。⇒ ① 管「装的是不是那棵树」，
# ② 管「跑的是不是那棵树」，两者缺一不可。
declared="$(grep -oP '(?<=@app\.get\(")[^"]+' "$workdir/src/futu_shim/app.py" | sort -u || true)"
registered="$(curl -fsS --max-time 5 "$BASE/healthz" \
  | python3 -c 'import json,sys; print("\n".join(json.load(sys.stdin).get("routes") or []))' \
  | sort -u || true)"

# 🚨 反空转闸。任一侧解析为空，集合比较就恒真 —— 那正是本次要消灭的病，别让它换个形状回来。
# 空 = 探针自己坏了 = 失败，不是通过。
[[ -n "$declared" ]] || {
  echo "探针失效: 从源码里没解析出任何 @app.get 路由（装饰器写法变了？）" >&2; exit 4; }
[[ -n "$registered" ]] || {
  echo "探针失效: /healthz 没返回 routes 字段（装上的是不带该字段的旧版 shim？）" >&2; exit 4; }

missing="$(comm -23 <(printf '%s\n' "$declared") <(printf '%s\n' "$registered"))"
if [[ -n "$missing" ]]; then
  echo "跑着的实例缺这些已声明的 route:" >&2
  while IFS= read -r route; do printf '      %s\n' "$route" >&2; done <<<"$missing"
  echo "（源码里有、url_map 里没有 = 进程没加载这棵树，多半是没真重启）" >&2
  exit 4
fi
printf '    routes ✓ 声明 %s 条，全部已注册\n' "$(wc -l <<<"$declared" | tr -d ' ')"

echo "done. futu-shim @ $sha"
