#!/usr/bin/env bash
# 访客入口四道闸的**证伪脚本**。每道闸都配一条应当被拒的请求 —— 只跑正例等于没验。
#
# 起因（2026-08-03）：shim 部署自检里那条「401 = 路由存在」的探针，从写下那天起就
# 恒真、检不出任何缺失路由，因为未注册路径同样返回 401。教训不是「多写注释」，是
# **每条断言都要有一条能让它失败的输入**。本脚本就是那些输入。
#
# 跑法：
#   在 77 上：  ./verify-guards.sh                       # 默认打 10.90.0.1:8811
#   在访客机：  BASE=http://10.90.0.1:8811 GUEST_TOKEN=xxx ./verify-guards.sh
#   带限频用例：./verify-guards.sh --include-429         # 见下方说明，默认不跑
set -uo pipefail

BASE="${BASE:-http://10.90.0.1:8811}"
GUEST_TOKEN="${GUEST_TOKEN:-}"
# PEP 是既有 12 只锚之一 ⇒ 已占着 history_kline 的配额槽（per security / 7 天滚动）。
# 拿它做正例**不额外消耗配额**（E38 实证：同票窗内重复查免费）。别改成随便一只票。
PROBE_CODE="${PROBE_CODE:-US.PEP}"

[[ -n "$GUEST_TOKEN" ]] || { echo "需要 GUEST_TOKEN 环境变量" >&2; exit 2; }

pass=0; fail=0
check() { # check <说明> <期望码> <实得码>
  if [[ "$2" == "$3" ]]; then printf '  ✅ %-46s %s\n' "$1" "$3"; pass=$((pass+1))
  else printf '  ❌ %-46s 期望 %s 实得 %s\n' "$1" "$2" "$3"; fail=$((fail+1)); fi
}
code() { curl -s -o /dev/null -m 100 -w '%{http_code}' "$@"; }

AUTH=(-H "Authorization: Bearer $GUEST_TOKEN")

# ── 反空转闸 ────────────────────────────────────────────────────────────────
# 服务压根不通时，下面每条「期望 4xx」都会拿到 000 而整体看着像在工作。先证明它活着。
echo "== 前置：服务可达 =="
reach=$(code "${AUTH[@]}" "$BASE/healthz")
if [[ "$reach" == "000" ]]; then
  echo "  ❌ $BASE 完全不可达（隧道没起？wg show / systemctl status nvy-guest-proxy）" >&2
  exit 1
fi
check "带 token 打 /healthz" 200 "$reach"

echo "== 闸 1 身份（认证，不是授权）=="
check "无 token"                     401 "$(code                                   "$BASE/healthz")"
check "错 token"                     401 "$(code -H 'Authorization: Bearer nope'    "$BASE/healthz")"
check "有 token 但缺 Bearer scheme"  401 "$(code -H "Authorization: $GUEST_TOKEN"   "$BASE/healthz")"

echo "== 闸 2 端点白名单（放 /kline + 期权链三条 + /overview + /healthz）=="
# 🔴 /earnings-calendar 与 /his-vol 在上游是**存在**的（shim 有这两条路由），在这里必须
#    404 —— 它们是「上游有、但刻意不给访客」的那几条，因此是本组里最有价值的断言：能抓到
#    「照着 shim 的 routes 一把梭全开」这个改法。别把它们从列表里删掉。
#    ⚠️ /overview 已于 2026-08-07 放行 ⇒ **已从本列表移出**，它的闸在下面单独验。
for p in /his-vol /universe /trading-days /earnings-calendar /definitely-not-a-route; do
  check "$p 不可见" 404 "$(code "${AUTH[@]}" "$BASE$p?code=US.PEP&codes=US.PEP&market=US")"
done

echo "== 闸 3 市场白名单（只放美股）=="
check "HK.00700 被拒"      400 "$(code "${AUTH[@]}" "$BASE/kline?code=HK.00700")"
check "SH.600519 被拒"     400 "$(code "${AUTH[@]}" "$BASE/kline?code=SH.600519")"
check "缺 code 被拒"       400 "$(code "${AUTH[@]}" "$BASE/kline")"
check "US 前缀伪造被拒"    400 "$(code "${AUTH[@]}" "$BASE/kline?code=XUS.PEP")"
# 重复参数不构成绕过：nginx 的 $arg_code 与 Flask 的 args.get 都取**第一个**。
# 这条正是闸 3 成立的前提，改动前必须复核 —— 所以它是断言不是注释。
check "重复 code（首个为 HK）被拒" 400 "$(code "${AUTH[@]}" "$BASE/kline?code=HK.00700&code=US.PEP")"

echo "== 闸 3 市场白名单 · 期权面（单数 code 两条 + 复数 codes 四条）=="
# 单数 code 的两个端点：与 /kline 同形态，但**必须各自断言** —— 闸是逐 location 写的，
# 漏写一个 location 的形态是「那一条恒放行」，而其余全绿看不出来。
check "option-expirations HK 被拒" 400 "$(code "${AUTH[@]}" "$BASE/option-expirations?code=HK.00700")"
check "option-chain SH 被拒"       400 "$(code "${AUTH[@]}" "$BASE/option-chain?code=SH.600519")"

# 复数 codes：`$arg_code`（单数）在这个端点恒为空 ⇒ 单数写法对它**完全不生效**。
check "snapshot 多值含 HK 被拒"    400 "$(code "${AUTH[@]}" "$BASE/option-snapshot?codes=US.PEP,HK.00700")"
check "snapshot 缺 codes 被拒"     400 "$(code "${AUTH[@]}" "$BASE/option-snapshot")"

# 🚨 **本组最重要的一条。** nginx 的 $arg_* 不做 URL 解码 ⇒ `%2C` 在这里不是逗号，
#    整串因此「不含分隔符」，`^US\.` 会匹配通过并放行；而 Flask 侧会解码成
#    `US.PEP,HK.00700` 并按逗号切开 —— 港股就这么进去了，且日志里像一次合法请求。
#    挡住它的是字符集白名单那一步（`%` 越界）。**这条红了说明那一步被删了或被放宽了。**
check "snapshot %2C 编码绕过被拒"  400 "$(code "${AUTH[@]}" "$BASE/option-snapshot?codes=US.PEP%2CHK.00700")"

# 满批 400 个 code ⇒ query string ≈ 8.8 KB，**超过 nginx 默认 large_client_header_buffers
# 的单个 8k 缓冲**（官方：请求行放不进一个缓冲就返 414）。不加 `4 16k` 的形态是
# 「小批正常、满批恒 414」，且请求根本到不了 shim、上游日志查不到痕迹。
# 🔎 **故意把最后一个 code 设成港股**：这样期望值是闸 3 的 400 而不是上游的 200 ——
#    既验到了缓冲够大（够大才解析得出 codes、才轮得到闸 3），又不打上游一发。
big_codes="$(printf 'US.PEP250815P%08d,' $(seq 1 399))HK.00700"
check "满批 400 codes 不撞 414"    400 "$(code "${AUTH[@]}" "$BASE/option-snapshot?codes=$big_codes")"

# 🚨 /overview 的两步 codes 闸是从 /option-snapshot **抄**过来的（nginx 没有跨 location
#    复用 if 的干净写法，且本文件里单数版闸同样是三份）。抄本必然有漂移风险 ⇒ **这两条
#    断言就是那份复制的安全阀**：只验 /option-snapshot 不验 /overview 等于只验了一半。
check "overview 多值含 HK 被拒"    400 "$(code "${AUTH[@]}" "$BASE/overview?codes=US.PEP,HK.00700")"
check "overview %2C 编码绕过被拒"  400 "$(code "${AUTH[@]}" "$BASE/overview?codes=US.PEP%2CHK.00700")"

echo "== 闸 4 上游 token 不外泄 =="
body="$(curl -s -m 20 "${AUTH[@]}" "$BASE/healthz")"
if grep -qi 'authorization\|bearer' <<<"$body"; then
  printf '  ❌ %-46s 响应体里出现 authorization/bearer 字样\n' "响应不回显凭证"; fail=$((fail+1))
else
  printf '  ✅ %-46s\n' "响应不回显凭证"; pass=$((pass+1))
fi

if [[ " $* " == *" --from-guest "* ]]; then
  # ── 闸 0：接口级包过滤（只有从访客机跑才有意义）─────────────────────────
  # WireGuard 把包直接交给 77 的 IP 栈，且**安全组管不到隧道内流量** ⇒ 若 wg2 上
  # 没有 PostUp 那两条 iptables 规则，访客能打到 77 上任何绑 0.0.0.0 的服务:
  # sshd 22、prod nginx 80/443……「AllowedIPs 只有 10.90.0.1/32」限的是地址不是端口。
  # ⚠️ 在 77 本机跑这几条会假红（那些端口在本机本来就通），故只在 --from-guest 下测。
  echo "== 闸 0 接口级包过滤（除 8811 外应全部不可达）=="
  host="$(printf '%s' "$BASE" | sed -E 's#^https?://##; s#[:/].*$##')"
  for port in 22 80 443; do
    # -w 3 连不上就退非零;通了才是问题。
    if nc -z -w 3 "$host" "$port" 2>/dev/null; then
      printf '  ❌ %-46s 端口 %s **通了**——PostUp 规则没生效\n' "$host:$port 应不可达" "$port"; fail=$((fail+1))
    else
      printf '  ✅ %-46s\n' "$host:$port 不可达"; pass=$((pass+1))
    fi
  done
fi

echo "== 上游可达性（零 vendor 调用：让 shim 自己的参数校验来回答）=="
# 🚨 **这两条堵的是一个真盲区。** 上面所有闸的反例都由 nginx 直接 `return`，
#    **永远到不了 `proxy_pass`** ⇒ 只有反例的话，把 `proxy_pass` 的端点名写错
#    （`option-chian` 之类）也会全绿通过，直到访客第一次真用才炸。
#    ⇒ 构造一个**过得了 nginx 的闸、但会被 shim 自己拒**的请求，再断言那句错误文案
#    确实出自 shim（nginx 说不出这些话）。shim 这两条校验都在**触碰 OpenD 之前**
#    （其 pytest 明写 "not touching OpenD"）⇒ 零 vendor 调用、零配额。
reached() { # reached <说明> <期望出现的 shim 文案> <url>
  local body; body="$(curl -s -m 100 "${AUTH[@]}" "$3")"
  if grep -q "$2" <<<"$body"; then printf '  ✅ %-46s\n' "$1"; pass=$((pass+1))
  else printf '  ❌ %-46s 未见 shim 文案，实得 %s\n' "$1" "${body:0:100}"; fail=$((fail+1)); fi
}

# 365 天窗 —— 过得了市场闸，但远超 vendor 的 30 天上限 ⇒ shim 拒。
reached "/option-chain 确实转到了 shim" 'expiry window too wide' \
        "$BASE/option-chain?code=US.PEP&start=2026-01-01&end=2026-12-31"

# 401 个合法美股 code —— 过得了两道 codes 闸，但超 vendor 的 400 批上限 ⇒ shim 拒。
# ⚠️ 末尾的 `sed` **是承重的**：留着结尾逗号会让格式闸的 `(,US\.[^,]+)*$` 匹配失败，
#    请求被 nginx 判 400，这条断言就变成在验 nginx 而不是在验上游可达。
over_codes="$(printf 'US.PEP250815P%08d,' $(seq 1 401) | sed 's/,$//')"
reached "/option-snapshot 确实转到了 shim" 'too many codes' \
        "$BASE/option-snapshot?codes=$over_codes"

# 501 个标的 —— 过得了两道 codes 闸，但超 /overview 的 500 批上限 ⇒ shim 拒。
# ⚠️ 同上，结尾的 `sed` 是承重的。
ov_codes="$(printf 'US.A%05d,' $(seq 1 501) | sed 's/,$//')"
reached "/overview 确实转到了 shim" 'too many codes' \
        "$BASE/overview?codes=$ov_codes"

echo "== 正例（会真打上游的两条）=="
# OpenD 自 2026-08-04 (#868) 起**常驻**，正常路径首发就是 200（同日实测空闲 14343s 后
# 仍 connected，首发 0.21s）。
# 🚨 热身重试**保留但降级为兜底**，不是因为冷启还在，而是因为两件事仍会让首发失败：
#   ① OpenD 崩溃后正被 Restart=always 拉起 ② shim 刚部署重启。
#   另外常驻只是一个 knob（FUTU_OPEND_IDLE_STOP_S），env 回退会把窗口化模式打回来。
# ⇒ 首发若非 200 就等一会重试，并把首发状态**打印出来**——不是吞掉，是如实说
#   「第一次确实没成功」。**它现在应当很少触发；经常触发就是上游有问题的信号。**
# 🚨 429 那一档是 2026-08-07 加 /overview 时**实测撞出来的**，不是预防性设计：
#    本套件自己要从 `guest_option_meta`（20 次/分）里取 4 发（两条可达性探针 + 两条正例）
#    ⇒ **连着跑两遍就会撞上自己的脚印**，正例当场 429。那是限频闸在干活，不是通路坏了。
positive() { # positive <说明> <url>
  local first wait
  first="$(code "${AUTH[@]}" "$2")"
  if [[ "$first" == "200" ]]; then check "$1" 200 "$first"; return; fi
  # 502 = 上游正在重启（OpenD 被 Restart=always 拉起 / shim 刚部署）→ 等久一点
  # 429 = 撞到限频（多半是本套件自己的脚印）→ 漏桶补一格即可
  wait=8; [[ "$first" == "502" ]] && wait=30
  # 🚨 printf 参数化，不要写成 "…$first（…" —— **裸变量后紧跟全角字符**在 CJK locale 下
  #    会被 bash 吞进变量名，`set -u` 当场炸「未绑定的变量」。本脚本随访客包发出去、跑在
  #    别人机器上（多半中文 locale），77 的 en_US.UTF-8 不复现**不代表对方那侧安全**。
  #    2026-08-04 实测：zh_TW.UTF-8 + bash 5.3.9 必炸，en_US.UTF-8 + bash 5.2.21 正常。
  printf '     ↻ %s 首发 %s → 等 %ss 重试一次\n' "$1" "$first" "$wait"
  sleep "$wait"
  check "$1（重试后）" 200 "$(code "${AUTH[@]}" "$2")"
}

positive "US.PEP /kline 通" "$BASE/kline?code=$PROBE_CODE&ktype=K_DAY"

# 期权面的端到端一发。选 /option-expirations 是因为它最便宜：单 code、无日期参数、
# 限频档 60/30s（不是 option_chain 那个 10/30s 的紧池），且是整条链路的入口 ——
# 它通了，说明「隧道 → 代理 → shim → OpenD → 富途」这条路对期权也是通的。
# ℹ️ 配额口径：富途文档化的 per-security 配额只挂在 **history_kline** 上，期权几个
#    capability 未见同类配额声明。这是**按文档推断、未主动实测**；若日后发现期权侧
#    也有配额，这条正例就是要重新权衡的地方。
positive "US.PEP /option-expirations 通" "$BASE/option-expirations?code=$PROBE_CODE"

# 标的级总览（iv / iv_rank / iv_percentile + HV 梯队）。一发即可,批量接口。
# prod 侧消费它的维度一天只打 1-2 发,这条正例几乎不与之争用。
positive "US.PEP /overview 通" "$BASE/overview?codes=$PROBE_CODE"

if [[ "${1:-}" == "--include-429" ]]; then
  # 默认不跑的理由：闸 3 的 `if` 在 nginx 的 rewrite 阶段、早于 limit_req 所在的
  # preaccess 阶段 ⇒ **被 400 拒掉的请求不进限频桶**，想触发 429 只能发真请求。
  # 26 发同票请求：配额免费（同票窗内），且远在 shim 自己 60/30s 之下，但确实会
  # 把 OpenD 拉起来。别在你不想唤醒它的时候跑。
  echo "== 闸 5 限频（26 发同票，末尾应见 429）=="
  last=""
  for _ in $(seq 1 26); do last=$(code "${AUTH[@]}" "$BASE/kline?code=$PROBE_CODE&ktype=K_DAY"); done
  check "突发后触发限频" 429 "$last"

  # 🚫 **这里刻意没有「/option-chain 走的是更紧的那个池」这条断言 —— 别加。**
  #
  # 它挂的确实是另一个、更紧的 zone（guest_option_chain 10r/m burst3，对比
  # guest_option_meta 20r/m burst5），误挂过去不会有任何请求失败，只是悄悄放宽。
  # 想黑盒验它只有一个可测量：**第一次 429 之前放过几发**。2026-08-04 实测两种桶状态：
  #
  #   桶状态          紧池   宽池
  #   干净桶           4      6     ← 可区分
  #   跑完本套件之后    3      3     ← **完全不可区分**
  #
  # 原因：跑到这一步时 guest_option_meta 早被前面的用例抽干，两种配置都退化成 3 发。
  # ⇒ 在本脚本的真实运行形态下，这个判据**必然恒真**。写了也是一条不会失败的断言，
  #   而那正是本脚本存在要反对的东西（见文件头注释）。
  #
  # 真判据在别处：**prod 06:00 那轮链发现的墙钟**（SC-009 15 分钟门）。见 runbook。
else
  echo "== 闸 5 限频：跳过（加 --include-429 才跑，它会拉起 OpenD）=="
fi

echo
echo "通过 $pass / 失败 $fail"
[[ $fail -eq 0 ]]
