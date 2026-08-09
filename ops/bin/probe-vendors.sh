#!/usr/bin/env bash
#
# Probe marketdata vendor reachability / 风控 status from the production ECS host.
#
# 无 SLA 的逆向行情源 (东财 push2) 会对高频/异常请求起 IP 级风控 (直接关连接,
# UND_ERR_SOCKET); 理杏仁有 token + 明确限频。上线灌库 / 排障前先用本脚本确认各源
# 从生产 IP 当前可达 —— 区分「源被风控/挂了」vs「我们代码/参数错」。
#
# 在容器内 (有 LIXINGER_TOKEN 等 env) 经 node fetch 各发一个代表性请求, 报 OK/FAIL。
# 新增 provider = 在下方 NODE 段的 `VENDORS` 加一个条目 (代表性轻量调用 + ok 判定)。
#
# Runs on the production ECS host (需 docker 访问运行中的 app 容器):
#   本机$ ssh admin@<swas> 'bash -s' < ops/bin/probe-vendors.sh            # 探全部
#   本机$ ssh admin@<swas> 'bash -s eastmoney' < ops/bin/probe-vendors.sh  # 只探东财
#   ECS$  ./ops/bin/probe-vendors.sh [eastmoney|lixinger|all]
#
# Env overrides:
#   CONTAINER  运行中的 app 容器名 (default nvy-tight-app-1)
#
# 退出码: 0 = 选中的源全部可达; 1 = 有源 FAIL/风控/未知 vendor。
# (探针只读、单次轻量调用; 但风控期频繁探可能重置封禁窗口 → 排障时手动跑、勿循环高频。)

set -uo pipefail # 不用 -e: 要报完所有 vendor, 单个 FAIL 不中断

CONTAINER="${CONTAINER:-nvy-tight-app-1}"
VENDOR="${1:-all}"

PROBE="$(mktemp /tmp/vendor-probe.XXXXXX.mjs)"
trap 'rm -f "$PROBE"' EXIT

cat > "$PROBE" <<'NODE'
// 各 vendor 一个代表性调用 → { ok, detail }。容器内 node 跑 (env 含 LIXINGER_TOKEN)。
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const VENDORS = {
  eastmoney: {
    label: '东财 push2 clist (universe 枚举源)',
    async run() {
      const fs = 'm:1+t:2,m:0+t:6'; // 字面 + 分隔 (encodeURIComponent 会被东财忽略 → 全集)
      const r = await fetch(
        `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=5&fs=${fs}&fields=f12,f13`,
        { headers: { 'User-Agent': UA, Referer: 'https://www.eastmoney.com/' } },
      );
      const j = await r.json();
      return { ok: r.status === 200 && j?.data?.total > 0, detail: `status=${r.status} total=${j?.data?.total}` };
    },
  },
  lixinger: {
    label: '理杏仁 open API (eod/fundamental/calendar 源)',
    async run() {
      const token = process.env.LIXINGER_TOKEN;
      if (!token) return { ok: false, detail: 'LIXINGER_TOKEN 未注入容器' };
      const r = await fetch('https://open.lixinger.com/api/cn/company', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'gzip' },
        body: JSON.stringify({ token, stockCodes: ['600519'] }),
      });
      const j = await r.json();
      return {
        ok: r.status === 200 && j?.code === 1,
        detail: `status=${r.status} code=${j?.code} name=${j?.data?.[0]?.name ?? '-'}`,
      };
    },
  },
};

const want = process.env.PROBE_VENDOR || 'all';
const names = want === 'all' ? Object.keys(VENDORS) : [want];
let failed = 0;
for (const name of names) {
  const v = VENDORS[name];
  if (!v) {
    console.log(`??  未知 vendor "${name}" (可选: ${Object.keys(VENDORS).join(', ')}, all)`);
    failed++;
    continue;
  }
  let res;
  try {
    res = await v.run();
  } catch (e) {
    res = { ok: false, detail: `ERR ${(e.cause && e.cause.code) || e.message}` };
  }
  console.log(`${res.ok ? '✅ OK  ' : '❌ FAIL'} ${name.padEnd(10)} ${v.label} — ${res.detail}`);
  if (!res.ok) failed++;
}
process.exit(failed > 0 ? 1 : 0);
NODE

docker cp "$PROBE" "$CONTAINER:/tmp/vendor-probe.mjs" >/dev/null
docker exec -e PROBE_VENDOR="$VENDOR" "$CONTAINER" node /tmp/vendor-probe.mjs
rc=$?
docker exec "$CONTAINER" rm -f /tmp/vendor-probe.mjs 2>/dev/null || true
exit "$rc"
