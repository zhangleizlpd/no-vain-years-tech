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
#   本人跑（059 直写授权那组）：ANCHOR_ROLE=owner ./verify-guards.sh
#   在**开发机**上（无 77 / 无 wg2 / 无真上游）：./verify-guards.local-harness.sh
#     └ 真模板 + 桩上游把闸 8 两种角色都跑掉，并带两个变异自证它不是恒真探针。
#       改闸 8 之前先读那个文件的头。
set -uo pipefail

BASE="${BASE:-http://10.90.0.1:8811}"
GUEST_TOKEN="${GUEST_TOKEN:-}"
# PEP 是既有 12 只锚之一 ⇒ 已占着 history_kline 的配额槽（per security / 7 天滚动）。
# 拿它做正例**不额外消耗配额**（E38 实证：同票窗内重复查免费）。别改成随便一只票。
PROBE_CODE="${PROBE_CODE:-US.PEP}"
# 059 锚导入的直写授权闸按**访客身份**分流 ⇒ 期望值取决于手里这把 token 是谁的。
# `other`（默认）= 其他访客：直写口应当 403；`owner` = 本人：直写口应当过闸打到 app。
# 🚨 默认取 other 是刻意的：**弱期望不该是默认** —— 本人跑时忘了带 ANCHOR_ROLE=owner，
#    结果是「期望 403 实得 400」当场红，而不是悄悄放过一条本该验的分流。
ANCHOR_ROLE="${ANCHOR_ROLE:-other}"

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

echo "== 闸 6 研报投递（057；本代理唯一的写端点，且不打 shim）=="
RESEARCH="$BASE/research-report"
RQ_OK="symbol=us:PEP&reportDate=2026-08-01&title=probe"

# ── 6a. 只放 POST ─────────────────────────────────────────────────────────
# `limit_except POST { deny all; }`。读取动作在服务端本就没实装，这条验的是**通道层
# 也独立拒了一次** —— 两层各拒一次，不依赖对方（FR-013）。
#
# ── 6b/6c. 市场闸 ─────────────────────────────────────────────────────────
# 这几条由 nginx 的 `if` 在 **rewrite 阶段**直接 return，早于 limit_req 所在的
# preaccess 阶段 ⇒ **不进限频桶**（与闸 3 同理），可以随便跑。
check "研报 symbol 缺市场前缀被拒" 400 "$(code -X POST "${AUTH[@]}" "$RESEARCH?symbol=PEP&reportDate=2026-08-01&title=x")"
check "研报 symbol 非归一 us.PEP 被拒" 400 "$(code -X POST "${AUTH[@]}" "$RESEARCH?symbol=us.PEP&reportDate=2026-08-01&title=x")"
# 🚨 `$arg_*` 不解码 ⇒ 投递方把冒号写成 %3A 时，nginx 看到的就是字面量 `hk%3A01698`，
#    撞不上 `^(cn|hk|us):` 而 400。方向 fail-closed（安全），错误文案里写了「不要编码」。
check "研报 symbol %3A 编码被拒" 400 "$(code -X POST "${AUTH[@]}" "$RESEARCH?symbol=hk%3A01698&reportDate=2026-08-01&title=x")"
check "研报无 token 被拒" 401 "$(code -X POST "$RESEARCH?$RQ_OK")"

# ── 6d. 过得了 nginx 那几道闸的探针 ───────────────────────────────────────
# 🚨 下面这些**会进限频桶**（guest_upload 2r/m + burst 1）。连着跑就会撞上自己的脚印，
#    与 guest_option_meta 那几条同款形态。撞到 429 时等一个漏桶周期再重试一次 ——
#    **不是把 429 当通过**，最终仍按真实期望值判定。
upload_check() { # upload_check <说明> <期望码> <curl 参数...>
  local first
  first="$(code "${@:3}")"
  if [[ "$first" != "429" ]]; then check "$1" "$2" "$first"; return; fi
  printf '     ↻ %s 撞限频 429 → 等 35s 重试一次\n' "$1"
  sleep 35
  check "$1（重试后）" "$2" "$(code "${@:3}")"
}

# 🚨 期望是 **403 不是 405** —— `limit_except POST { deny all; }` 里干活的是 `deny`，它返回
#    403 Forbidden。写成 405 是想当然（"method not allowed" 的直觉），2026-08-16 首次真跑
#    当场证伪。nginx 不为这个场景发 405，也不会带 `Allow` 头。
# 它同样走限频桶：`limit_except` 在 access 阶段，而 limit_req 在它**之前**的 preaccess。
upload_check "研报 GET 被拒（limit_except 生效）" 403 -X GET "${AUTH[@]}" "$RESEARCH?$RQ_OK"

# 非 PDF → 422。🚨 **这条的价值不在「非 PDF 被拒」，在于证明请求真的到了 app** ——
# 上面所有 4xx 都是 nginx 自己 return 的，只有它们的话，`proxy_pass` 的路径写错
# （`/api/v1/research/report` 少个 s 之类）也会全绿，直到真投递才炸。
notpdf="$(mktemp)"; printf 'this is definitely not a pdf' > "$notpdf"
upload_check "研报非 PDF 被拒（说明到了 app）" 422 -X POST "${AUTH[@]}" \
  -F "file=@$notpdf;filename=probe.pdf;type=application/pdf" "$RESEARCH?$RQ_OK"
rm -f "$notpdf"

# 超上限 → 413，且**必须是 app 那层返的**。四层天花板刻意让 multipart（16MB）先于
# nginx（20m）跳闸，因为只有它能给干净的 ProblemDetail；nginx 那层跳闸给的是 HTML 页、
# 且 server 日志里什么都没有。⇒ 这里连**谁返的**一起验：JSON 体 = app，HTML = nginx。
#
# 🚨 **它是本组第三发进限频桶的请求，而桶只有 `2r/m + burst 1`** —— 前面 GET(403) 与
#    非 PDF(422) 已经把两格用掉，这一发**必然**撞 429。2026-08-16 首跑实测：本条是 39/1
#    里唯一那个 ❌，实得 `<html>…429 Too Many Requests`。
#    前两发用的 `upload_check` 自带 429 重试，这一发因为要读**响应体**（判 413 是谁返的）
#    走的是裸 curl —— 当时漏了给它同样的处理。⇒ 这里显式重试一次，与 `upload_check` 同款。
big="$(mktemp)"; { printf '%%PDF-1.4\n'; dd if=/dev/zero bs=1048576 count=17 2>/dev/null; } > "$big"
oversize_probe() { curl -s -m 300 -X POST "${AUTH[@]}" -F "file=@$big;filename=big.pdf;type=application/pdf" "$RESEARCH?$RQ_OK"; }
big_body="$(oversize_probe)"
if grep -q '429 Too Many Requests' <<<"$big_body"; then
  printf '     ↻ %s 撞限频 429 → 等 35s 重试一次\n' "研报超上限"
  sleep 35
  big_body="$(oversize_probe)"
fi
rm -f "$big"
if grep -q '"status":413\|"status": 413' <<<"$big_body"; then
  printf '  ✅ %-46s\n' "研报超上限 413 由 app 返（非 nginx）"; pass=$((pass+1))
else
  printf '  ❌ %-46s 实得 %s\n' "研报超上限 413 由 app 返（非 nginx）" "${big_body:0:100}"; fail=$((fail+1))
fi

echo "== 闸 8 锚导入（059；本代理上唯一能改业务数据的端点）=="
IMPORT="$BASE/anchor-import"
SUBMIT="$BASE/anchor-submit"
# 过得了通道所有闸、但 app 侧一定会拒的 body（缺 v/asof/method/confidence）——
# 用它当探针就不会在对方的待审箱 / 锚表里留下任何东西。
PROBE_BODY='{}'
JSON=(-H 'Content-Type: application/json')

# ── 8a. 无凭证：两个口各拒一次 ────────────────────────────────────────────
check "锚直写无 token 被拒" 401 "$(code -X POST "${JSON[@]}" -d "$PROBE_BODY" "$IMPORT?ticker=us:PEP")"
check "锚提交无 token 被拒" 401 "$(code -X POST "${JSON[@]}" -d "$PROBE_BODY" "$SUBMIT?ticker=us:PEP")"

# ── 8b. 只放 POST（两个口各写一份 —— 闸是逐 location 写的）─────────────────
# 🚨 期望 **403 不是 405**：`limit_except` 里干活的是 `deny`（同闸 6 那条，057 真跑证伪过 405）。
check "锚直写 GET 被拒" 403 "$(code -X GET "${AUTH[@]}" "$IMPORT?ticker=us:PEP")"
check "锚提交 GET 被拒" 403 "$(code -X GET "${AUTH[@]}" "$SUBMIT?ticker=us:PEP")"

# ── 8c. 市场闸 ────────────────────────────────────────────────────────────
# 🚨 与 server 侧 `anchor-import.rules.ts` 的白名单是**两份独立文本**。这几条是通道那一半
#    的护栏；服务端那一半由 optionsdesk-059 IT 里对 `cn:` 的 400 断言钉住。
#
# 🚨 **直写口上，非本人永远观察不到市场闸** —— 授权闸与市场闸都在 rewrite 阶段、按书写
#    顺序跑，授权在前 ⇒ 他人无论 ticker 写成什么都是 403。这是**刻意的顺序**：对一个根本
#    不能用这个口的人，回「你的 ticker 格式不对」会把他引向错误的修法。
#    ⇒ 直写口那组只在 `ANCHOR_ROLE=owner` 时跑；他人侧改验「坏 ticker 也仍是 403」。
#    （2026-08-16 本地 harness 首跑实测：这四条最初写成无条件 400，当场四红。）
market_gate() { # market_gate <端点> <标签前缀>
  check "$2 ticker 缺市场前缀被拒" 400 "$(code -X POST "${AUTH[@]}" "${JSON[@]}" -d "$PROBE_BODY" "$1?ticker=AOS")"
  check "$2 ticker cn 市场被拒"    400 "$(code -X POST "${AUTH[@]}" "${JSON[@]}" -d "$PROBE_BODY" "$1?ticker=cn:600519")"
  # $arg_* 不解码 ⇒ 冒号写成 %3A 撞不上 `^(us|hk):`，fail-closed 成 400（同研报那条）。
  check "$2 ticker %3A 编码被拒"   400 "$(code -X POST "${AUTH[@]}" "${JSON[@]}" -d "$PROBE_BODY" "$1?ticker=us%3AAOS")"
  # ticker 写进 body 而不是 query —— 通道看不见它 ⇒ 同样 400（这条钉的是「参数位置」本身）。
  check "$2 ticker 放 body 被拒"   400 "$(code -X POST "${AUTH[@]}" "${JSON[@]}" -d '{"ticker":"us:AOS"}' "$1")"
}

market_gate "$SUBMIT" "锚提交"
if [[ "$ANCHOR_ROLE" == "owner" ]]; then
  market_gate "$IMPORT" "锚直写"
else
  check "他人打直写口坏 ticker 仍 403" 403 "$(code -X POST "${AUTH[@]}" "${JSON[@]}" -d "$PROBE_BODY" "$IMPORT?ticker=cn:600519")"
fi

# ── 8d. 🚨 授权分流（本组的核心，也是整条链上唯一验它的地方）─────────────────
# 直写是**本人独有**的能力：其他访客认证得过（他们有自己的 bearer），到直写口被 403，
# 而提交口对他们照常可用。漏了 `$anchor_write_allowed` 闸时，这条会红 —— 而那种错
# **不会表现成 401**，只会表现成「谁都能改锚」。
# 🚨 059 收口把 mono 侧两把 token 合成一把之后，服务端对直写 / 提交**没有可判之据**
#    ⇒ 「只有本人可直写」这条需求在**别处一律测不出来**，本组是它唯一的回归钉。
#    ⚠️ 因此这两条**必须两种角色都真跑过**（ANCHOR_ROLE 默认 other，本人那侧要显式带
#    `ANCHOR_ROLE=owner` 再跑一遍）—— 只跑一侧等于只验了半条判据。
if [[ "$ANCHOR_ROLE" == "owner" ]]; then
  # 本人：过得了授权闸 ⇒ 落到 app，被 DTO 校验拒成 400。**不是 403** 才是这条要证的。
  check "本人打直写口不被 403（过授权闸）" 400 "$(code -X POST "${AUTH[@]}" "${JSON[@]}" -d "$PROBE_BODY" "$IMPORT?ticker=us:PEP")"
else
  check "他人打直写口 403（授权分流）" 403 "$(code -X POST "${AUTH[@]}" "${JSON[@]}" -d "$PROBE_BODY" "$IMPORT?ticker=us:PEP")"
fi

# ── 8e. 提交口对谁都开，且**请求真的到了 app** ────────────────────────────
# 🚨 价值不在「空 body 被拒」，在于证明 `proxy_pass` 的路径没写错：上面所有 4xx 都是
#    nginx 自己 return 的，只有它们的话，路径写成 `/anchors/submission`（少个 s）也全绿，
#    直到有人真提交才炸。⇒ 连**谁返的**一起验：JSON 体 = app，HTML = nginx。
submit_body="$(curl -s -m 60 -X POST "${AUTH[@]}" "${JSON[@]}" -d "$PROBE_BODY" "$SUBMIT?ticker=us:PEP")"
if grep -q '"status":400\|"status": 400' <<<"$submit_body"; then
  printf '  ✅ %-46s\n' "锚提交 400 由 app 返（非 nginx）"; pass=$((pass+1))
else
  printf '  ❌ %-46s 实得 %s\n' "锚提交 400 由 app 返（非 nginx）" "${submit_body:0:100}"; fail=$((fail+1))
fi

echo "== 闸 9 标的注册表（本代理上唯一的读 mono 端点）=="
CODES="$BASE/instrument-codes"
BASICS="$BASE/instrument-basics"

# ── 9a. 无凭证：两个口各拒一次 ────────────────────────────────────────────
check "枚举口无 token 被拒" 401 "$(code "$CODES?market=us")"
check "批量口无 token 被拒" 401 "$(code "$BASICS?market=us&codes=AOS")"

# ── 9b. 只放 GET（两个口各写一份 —— 闸是逐 location 写的）──────────────────
# 🚨 期望 **403 不是 405**（同闸 6 / 闸 8b：干活的是 `limit_except` 里的 `deny`）。
# 🚨 **必须带合法 market** —— 市场闸是 rewrite 阶段的 `if`，跑在 `limit_except` 所在的
#    access 阶段**之前**；不带 market 会先撞 400，这条就验不到方法闸了（同 8b 带合法
#    ticker 的理由）。
check "枚举口 POST 被拒" 403 "$(code -X POST "${AUTH[@]}" "$CODES?market=us")"
check "批量口 POST 被拒" 403 "$(code -X POST "${AUTH[@]}" "$BASICS?market=us&codes=AOS")"

# ── 9c. 市场闸 ────────────────────────────────────────────────────────────
# 🚨 与 server 侧 `instrument-query.rules.ts` 的 `QUERYABLE_MARKETS` 是**两份独立文本**。
#    这几条是通道那一半；服务端那一半由 marketdata-instrument-guest-query IT 的三市场断言钉住。
# 🚨 形态与本仓其它市场闸都不同：这里是 `^(cn|hk|us)$` **全值匹配**，不是前缀匹配 ——
#    所以 `usx` / `us:AOS` 这两条反例是本组独有的，抄 8c 抄不到。
market_query_gate() { # market_query_gate <端点> <额外参数> <标签前缀>
  check "$3 缺 market 被拒"      400 "$(code "${AUTH[@]}" "$1?$2")"
  check "$3 market 大写被拒"     400 "$(code "${AUTH[@]}" "$1?market=US&$2")"
  check "$3 market 越界被拒"     400 "$(code "${AUTH[@]}" "$1?market=jp&$2")"
  # 全值匹配的证据：少写尾锚 `$` 时下面两条会放行。
  check "$3 market 尾缀被拒"     400 "$(code "${AUTH[@]}" "$1?market=usx&$2")"
  check "$3 market 带冒号被拒"   400 "$(code "${AUTH[@]}" "$1?market=us:AOS&$2")"
}
market_query_gate "$CODES"  "type=stock"  "枚举口"
market_query_gate "$BASICS" "codes=AOS"   "批量口"

# ── 9d. codes 字符集闸（只批量口有）────────────────────────────────────────
# `$arg_*` 不解码 ⇒ 逗号写成 `%2C` 撞不上字符集白名单，fail-closed 成 400。
check "批量口 codes %2C 编码被拒" 400 "$(code "${AUTH[@]}" "$BASICS?market=us&codes=AOS%2CPEP")"
check "批量口 codes 带冒号被拒"   400 "$(code "${AUTH[@]}" "$BASICS?market=us&codes=us:AOS")"
# 🚨 **反向反例：合法但「看着不像 code」的那些必须放行。** registry 美股侧实测 112 条含
#    `_` / `*` / `/` / `-`。照抄 /option-snapshot 那道窄字符集会把它们拒掉，而那是
#    **枚举口自己刚发出去的串** —— 只写上面两条拒例的话，抄窄了也全绿。
check "批量口 codes 含 _ * / . 放行" 200 "$(code "${AUTH[@]}" "$BASICS?market=us&codes=WFC_Z,BHVN*,PSUS/PS,BRK.B")"

# ── 9e. 请求**真的到了 app**（同 8e 的手法）────────────────────────────────
# 🚨 价值不在「200」，在于证明 `proxy_pass` 的路径没写错：上面所有 4xx 都是 nginx 自己
#    return 的，只有它们的话，路径写成 `/instrument-code`（少个 s）也全绿，直到访客真用才炸。
#    ⇒ 连**谁返的**一起验：body 里有 `count` = app 的枚举响应；HTML / Nest 的 404 体都不是。
codes_body="$(curl -s -m 100 "${AUTH[@]}" "$CODES?market=hk")"
if grep -q '"count"' <<<"$codes_body"; then
  printf '  ✅ %-46s\n' "枚举口 200 由 app 返（非 nginx）"; pass=$((pass+1))
else
  printf '  ❌ %-46s 实得 %s\n' "枚举口 200 由 app 返（非 nginx）" "${codes_body:0:120}"; fail=$((fail+1))
fi
basics_body="$(curl -s -m 100 "${AUTH[@]}" "$BASICS?market=us&codes=NOSUCHCODE")"
if grep -q '"missing"' <<<"$basics_body"; then
  printf '  ✅ %-46s\n' "批量口 200 由 app 返（非 nginx）"; pass=$((pass+1))
else
  printf '  ❌ %-46s 实得 %s\n' "批量口 200 由 app 返（非 nginx）" "${basics_body:0:120}"; fail=$((fail+1))
fi

# ── 9f. gzip 真的开着 ──────────────────────────────────────────────────────
# 🚨 **这条是本组唯一能抓到「压缩静默失效」的断言。** nginx 的 `gzip` 默认 off、
#    `gzip_types` 默认只有 text/html ⇒ 漏写任一条，枚举口就退化成约 137 KB 明文过隧道，
#    而**两侧都不会报错**，访客只会觉得慢。
# ⚠️ 必须用 `--compressed`（发 Accept-Encoding）—— 不发就本来也不该压缩，那时这条恒红
#    是对的，不是误报。
gz_hdr="$(curl -s -m 100 -D - -o /dev/null --compressed "${AUTH[@]}" "$CODES?market=us")"
if grep -qi '^content-encoding:.*gzip' <<<"$gz_hdr"; then
  printf '  ✅ %-46s\n' "枚举口带 --compressed 真回 gzip"; pass=$((pass+1))
else
  printf '  ❌ %-46s 响应头无 Content-Encoding: gzip\n' "枚举口带 --compressed 真回 gzip"; fail=$((fail+1))
fi

# 📌 **本组刻意不验限频**（枚举 6r/m / 批量 30r/m），说明写在这里而不是让人自己发现:
#    那两条护的是本机 PG 与出口体量，不是 vendor 限额、也不是「两个口互不牵连」这类
#    有明确需求的判据 ⇒ 打满它需要 9+ 发真请求，代价换不来相应的回归价值。
#    要验就照 --include-429 那段的写法补，别默认加进主路径。

echo "== 闸 7 能力目录（薄壳 skill 的端点清单唯一来源）=="
# 访客手里的 skill 不含端点清单,全靠 `/capabilities` 下发 ⇒ 这份目录取不到、或它列的端点
# 打不通,访客侧就**整体不可用**,而症状会表现成「agent 说这个通道没这个能力」——
# 一个看着像业务判断、实际是基础设施坏了的形态。所以它要有自己的闸。
#
# 🚨 **本闸只验一个方向：目录说有的,通道上真的有。** 反方向(通道上有、目录没列 = 新能力
#    访客永远看不到)**黑盒验不了** —— 访客侧看不到 nginx 的 location 集。那一半由
#    `deploy/install.sh` 的 Gate A 在部署时把住。两条合起来才是集合相等,
#    **单看任何一条都只是一半**,别把其中一条当成全部。
#
# 🚨 **刻意放在闸 6 之后。** 下面的循环会打 `/research-report`,它进 `guest_upload` 桶
#    (2r/m + burst 1)。放在闸 6 之前会偷走闸 6 那三发精心排过序的探针的槽位;放在之后,
#    本闸拿到 429 反而**照样通过** —— 因为判据是「不是 404」,而 429 只可能来自白名单内的
#    location(未注册路径走 `location /` 直接 return 404,根本到不了 limit_req 所在的
#    preaccess 阶段)。⇒ 429 本身就是「这条路由存在」的证据。
cap_code="$(code "${AUTH[@]}" "$BASE/capabilities")"
check "/capabilities 可取" 200 "$cap_code"
cap_body="$(curl -s -m 20 "${AUTH[@]}" "$BASE/capabilities")"

# 解析规则与 install.sh 的 Gate A 逐字同源(POSIX ERE,不用 -oP —— 本脚本随包发到访客机上,
# 那里的 grep 实现不可控)。研报参数表里的 `symbol` 之类同样带反引号,靠 `/` 这一位排除。
cap_eps="$(grep -oE '^\| `/[a-z-]+`' <<<"$cap_body" | sed -E 's/^\| `//; s/`$//' | sort -u)"

# 🚨 反空转闸:目录取到了但解析出 0 条时,下面的 for 循环一次都不跑、整段静默全绿 ——
#    正是本脚本文件头反对的那种病。
if [[ -z "$cap_eps" ]]; then
  printf '  ❌ %-46s 取到了正文但解析出 0 个端点\n' "目录端点解析（本闸自己坏了）"; fail=$((fail+1))
else
  printf '  ✅ %-46s %s 个\n' "目录端点解析" "$(wc -l <<<"$cap_eps")"; pass=$((pass+1))
  while read -r ep; do
    [[ -n "$ep" ]] || continue
    st="$(code "${AUTH[@]}" "$BASE$ep")"
    # 判据只有「不是 404 / 不是 000」。**刻意不断言具体码** —— 不带参数打各端点时,
    # 期望值各不相同(/healthz 200、行情几条被闸 3 拒成 400、/research-report 被
    # limit_except 拒成 403 或撞限频 429),写死一张期望表等于把闸 3 的实现细节抄进这里,
    # 那张表会漂。而本闸要问的只有一件事：**这条路由存在吗**。
    if [[ "$st" == "404" || "$st" == "000" ]]; then
      printf '  ❌ %-46s %s\n' "目录声明的 $ep 确实存在" "$st"; fail=$((fail+1))
    else
      printf '  ✅ %-46s %s\n' "目录声明的 $ep 确实存在" "$st"; pass=$((pass+1))
    fi
  done <<<"$cap_eps"
fi

if [[ " $* " == *" --from-guest "* ]]; then
  # ── 闸 0：接口级包过滤（只有从访客机跑才有意义）─────────────────────────
  # WireGuard 把包直接交给 77 的 IP 栈，且**安全组管不到隧道内流量** ⇒ 若 wg2 上
  # 没有 PostUp 那两条 iptables 规则，访客能打到 77 上任何绑 0.0.0.0 的服务:
  # sshd 22、prod nginx 80/443……「AllowedIPs 只有 10.90.0.1/32」限的是地址不是端口。
  # ⚠️ 在 77 本机跑这几条会假红（那些端口在本机本来就通），故只在 --from-guest 下测。
  echo "== 闸 0 接口级包过滤（除 8811 外应全部不可达）=="
  host="$(printf '%s' "$BASE" | sed -E 's#^https?://##; s#[:/].*$##')"
  # 🚨 **3001 是 057 给 mono app 开的 loopback 端口**，它必须从 wg2 这一侧够不到。
  #    推理是三条：DNAT 规则带 `-d 127.0.0.1` 匹配 ⇒ 访客打 10.90.0.1:3001 落 INPUT 被
  #    wg2 catch-all REJECT；即便日后误绑 0.0.0.0，`DOCKER-USER -i wg2 -j REJECT` 仍在
  #    FORWARD 前拦；而 guest-proxy 连 loopback 是**本机发起、无 input interface**，
  #    不匹配 `-i wg2` 故不受影响。**这条断言就是那三条推理的落地护栏** ——
  #    没有它，将来有人把 3001 加进 ACCEPT 规则时不会有任何东西红。
  for port in 22 80 443 3001; do
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

  # 059 锚直写口：6r/m + burst 2 ⇒ 连打 10 发必见 429。
  # 🚨 **必须用合法 ticker + 坏 body**：市场闸的 `if` 在 rewrite 阶段、早于 limit_req 所在的
  #    preaccess ⇒ 被 400 拒掉的请求**根本不进桶**（同本闸开头那句），拿坏 ticker 打一万发
  #    也永远见不到 429。合法 ticker + 空 body 则：过得了通道所有闸、进得了桶，而 app 侧
  #    400 ⇒ **不会写任何数据**。
  last_anchor=""
  for _ in $(seq 1 10); do
    last_anchor=$(code -X POST "${AUTH[@]}" -H 'Content-Type: application/json' -d '{}' "$BASE/anchor-import?ticker=us:PEP")
  done
  check "锚直写突发后触发限频" 429 "$last_anchor"

  # 🚨 **两个口各自独立的 zone（FR-017）**：直写口刚打满，提交口**仍应放行**（到 app 被
  #    400）。共用一个 zone 时这条会拿到 429 —— 这是「独立限频」唯一的黑盒判据。
  check "直写打满不牵连提交口" 400 "$(code -X POST "${AUTH[@]}" -H 'Content-Type: application/json' -d '{}' "$BASE/anchor-submit?ticker=us:PEP")"

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
