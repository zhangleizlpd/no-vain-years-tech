"""HTTP surface.

Endpoints are deliberately few. p3b 4.2 pins the shim's job to "fetch +
protocol-translate + hard rate gate + healthz"; every capability added here has
to earn its place by having a consumer on the server side, otherwise the shim
drifts into being a second system.

Response envelope is uniform:

    {"as_of": "<ISO-8601 UTC>", "count": <n>, "rows": [...]}

`as_of` is the **collection instant**, not any vendor-reported timestamp. That
is p3b E33 made structural: Futu's `update_time` is the last *trade* time, not
the last quote time, so a contract whose price is actively moving can carry a
stale-looking stamp. Freshness must therefore be measured by when we asked.

Field names inside `rows` are passed through exactly as the SDK reports them
(snake_case). No renaming — see `mappers`.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

from flask import Flask, jsonify, request
from futu import RET_OK, AuType, KLType, Market, OptionType, SecurityType, TradeDateMarket

from . import config, mappers
from .auth import extract_token, is_authorized
from .opend import OpenDSupervisor, OpenDUnavailable
from .ratelimit import RateGate, RateLimitExceeded

log = logging.getLogger(__name__)

PUBLIC_PATHS = frozenset({"/healthz"})

# `request_history_kline` pages at `max_count` rows and hands back a
# `page_req_key` when more remain. Ignoring that key is a silent truncation, so
# /kline follows the key to exhaustion; this cap only exists so a pathological
# request fails loudly instead of looping forever. 8 x 1000 is ~31 years of
# daily bars — far past any legitimate call.
#
# 🚨 The cap must stay **below** the rate gate's strictest window (10/30s), and
# the overflow must be a 400, not a 429 or 502. Both halves are load-bearing:
# a caller that trips the gate mid-pagination gets 429, which the server's
# transport classifies as *transient* and retries — and every retry restarts
# pagination from page one and refills the gate, so the request can never
# succeed while looking like a temporary blip. Failing at 8 pages with a
# permanent 400 makes "your window is too wide" say exactly that, once.
KLINE_MAX_PAGES = 8
KLINE_PAGE_ROWS = 1000

# `get_option_underlying_overview` accepts at most 500 codes per call (official,
# p3b E9). Over the cap the shim refuses instead of slicing: a dropped tail
# reads downstream as "those underlyings have no IV", which is indistinguishable
# from a real data gap. Batching is the caller's job.
OVERVIEW_MAX_CODES = 500

# `get_option_underlying_his_volatility` accepts at most a 364-day span per call.
#
# 🚨 The SDK does **not** enforce that on an explicit window — its
# `normalize_start_end_date(begin, end, 364, ...)` only uses 364 to derive a
# *missing* side, so a 3-year request is passed straight to the vendor and comes
# back quietly clipped. Validating here turns "your window is too wide" into a
# permanent 400 said once, instead of a short series nobody can distinguish from
# the end of history. Chunking belongs to the caller (server-side splitter).
HIS_VOL_MAX_SPAN_DAYS = 364

# Page cap, same shape and same reason as KLINE_MAX_PAGES. A 364-day window is
# ~253 sessions and the measured page is ~260 rows (p3 2026-07-29: 776 rows over
# 3 pages for ~3 years), so one legal window is 1-2 pages; 8 is pure headroom so
# a pathological response fails loudly instead of looping.
HIS_VOL_MAX_PAGES = 8

# `get_option_chain` 的到期日窗跨度上限（自然日，**含首尾**）。
#
# 官方原文是「传入的时间跨度上限为 30 天」，没说 30 算的是含首尾天数还是端点日期差。这里取
# **更严的那种读法**（含首尾 ≤30 ⇒ 端点差 ≤29），与 server 侧分窗纯函数
# `option-chain-window.rules.ts` 的 `OPTION_CHAIN_MAX_WINDOW_SPAN_DAYS` **必须同口径** ——
# 两侧读法不一致，server 切出来的合法窗会在这里被 400 拒掉。
#
# 🚨 超窗一律 400（永久），不截断、也不 429：截断后少掉的到期日与「那段本来就没有合约」
# 无法区分，而 429 会被 server 侧 transport 判为 transient 反复重试 —— 窗宽是永久事实。
# 同 `/kline` 超 8 页那条的先例。分窗是调用方的事。
OPTION_CHAIN_MAX_SPAN_DAYS = 30

# `get_market_snapshot` 单次最多 400 个 code（官方，p3b E9）。同 `/overview` 的 500 一样，
# 超出**拒绝而非切片**：被丢掉的尾巴在下游读作「那些合约今天没数据」，与完整性核对要抓的
# 真缺口无法区分。分批是调用方的事。
SNAPSHOT_MAX_CODES = 400

# `get_earnings_calendar` 的 `begin_date` / `end_date` 间隔上限（自然日，**端点差**）。
#
# 🚨 **6，不是官方原文那个 7。** 原文「与 beginDate 间隔不超过 7 天」的「间隔」二字比期权链那句
# 「时间跨度」明确，曾据此读作端点差 —— 但实测证明它说的是**含首尾的 7 天窗**，即端点差 ≤ 6。
# 按 7 读宽了整一天，而多出的那一天**不由本闸门拒绝、落到 vendor 手里变 502**：本闸门存在的
# 全部意义就是别让这种事发生。
#
# 实测（2026-08-08，经 77 → wg1 打本服务；端点差 0–8 全扫 × 3 个相隔一个多月的 start）：
#
#   端点差 0…6 → 200，且 count 随窗宽单调递增（⇒ 窄窗没有被静默裁剪，上限是真上限）
#   端点差 7   → **502 `NN_ProtoRet_SvrFailed`**；US 3/3 复现，**HK 同样 502** ⇒ 与市场无关
#   端点差 8   → 本闸门的 400
#   吃完 502 后回打端点差 6 → 200 且 count 与首发**完全一致** ⇒ 该 502 是**确定性的参数拒绝**，
#   不是瞬时故障。这点承重：调用方把 502 当 transient 就会永远重试、永远不显形为「参数错」。
#
# SDK 侧**不做**这个校验（`pack_req` 原样透传两个日期字符串），所以不在这里拦就只能等 vendor
# 报错或悄悄裁窗。server 侧同口径常量 = `marketdata/earnings-calendar.port.ts` 的
# `EARNINGS_CALENDAR_MAX_WINDOW_SPAN_DAYS`（两侧同值，各自独立成立：那边是「不发出非法窗」，
# 这边是「不放行非法窗」）。
EARNINGS_MAX_SPAN_DAYS = 6

DATE_FORMAT = "%Y-%m-%d"

# 部署产物里的版本戳 (`deploy/install.sh` 写入)。dev / 直接跑源码时该文件不存在。
VERSION_FILE = Path(__file__).resolve().parents[2] / "VERSION"


def read_version(path: Path = VERSION_FILE) -> str:
    """已部署代码的 git SHA, 供 `/healthz` 暴露。

    🚨 **为什么要有**: `install.sh` 铺的是调用者的工作树、没有版本闸 —— 从落后的分支装
    一次就会静默回退已 ship 的改动 (实际发生过, 表现为 server 侧全量 404, 隔好几层才
    显形)。把版本做成可观测, 部署后自检才能断言"跑着的 == 刚部署的"。

    读不到时返回 `"unknown"` 而**不是**抛错或空串: 版本戳缺失不该让健康探针变红 (它不是
    存活条件), 但也不能伪装成某个具体版本 —— `unknown` 是个刺眼的、能被自检判死的值。
    """
    try:
        return path.read_text(encoding="utf-8").strip() or "unknown"
    except OSError:
        return "unknown"


class VendorError(RuntimeError):
    """Futu returned a non-OK ret_code; `content` is its error string."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _envelope(rows: list[dict[str, Any]]):
    return jsonify({"as_of": _now_iso(), "count": len(rows), "rows": rows})


def _unwrap(ret: int, content: Any, what: str) -> Any:
    if ret != RET_OK:
        raise VendorError(f"{what}: {content}")
    return content


def _require_enum(raw: str | None, holder: type, param: str) -> str:
    """Validate a query param against the SDK's own constant set.

    Whitelisting off the SDK (rather than a hand-copied list) means the accepted
    values cannot drift from the vendor's when the SDK is upgraded.
    """
    allowed = {
        key: value
        for key, value in vars(holder).items()
        if not key.startswith("_") and isinstance(value, str) and value != "N/A"
    }
    if raw is None:
        raise ValueError(f"missing required query param `{param}`")
    candidate = raw.strip().upper()
    if candidate not in allowed:
        raise ValueError(
            f"unsupported {param}={raw!r}; allowed: {','.join(sorted(allowed))}"
        )
    return allowed[candidate]


def _optional_date(raw: str | None, param: str) -> date | None:
    """Parse an optional `YYYY-MM-DD` query param, or raise -> 400.

    Absent stays absent: the SDK derives the missing side of the window itself,
    and re-deriving it here would be a second, drifting implementation of that
    rule.
    """
    if raw is None or not raw.strip():
        return None
    try:
        return datetime.strptime(raw.strip(), DATE_FORMAT).date()
    except ValueError:
        raise ValueError(f"query param `{param}` must be YYYY-MM-DD, got {raw!r}") from None


def create_app(supervisor: OpenDSupervisor | None = None, gate: RateGate | None = None) -> Flask:
    app = Flask(__name__)
    opend = supervisor if supervisor is not None else OpenDSupervisor()
    rate_gate = gate if gate is not None else RateGate()
    app.config["OPEND"] = opend
    app.config["RATE_GATE"] = rate_gate

    @app.before_request
    def _authenticate():
        if request.path in PUBLIC_PATHS:
            return None
        if is_authorized(extract_token(request.headers.get("Authorization"))):
            return None
        # No detail in the body: a caller that cannot authenticate gets no help
        # distinguishing "no token configured" from "wrong token".
        return jsonify({"error": "unauthorized"}), 401

    @app.errorhandler(RateLimitExceeded)
    def _on_rate_limited(exc: RateLimitExceeded):
        retry_after = max(1, int(exc.retry_after_s + 0.999))
        body = jsonify(
            {
                "error": "rate_limited",
                "capability": exc.capability,
                "retry_after_s": round(exc.retry_after_s, 2),
            }
        )
        return body, 429, {"Retry-After": str(retry_after)}

    @app.errorhandler(OpenDUnavailable)
    def _on_opend_down(exc: OpenDUnavailable):
        log.warning("OpenD unavailable: %s", exc)
        return jsonify({"error": "opend_unavailable", "detail": str(exc)}), 503

    @app.errorhandler(VendorError)
    def _on_vendor_error(exc: VendorError):
        log.warning("vendor error: %s", exc)
        return jsonify({"error": "vendor_error", "detail": str(exc)}), 502

    @app.errorhandler(ValueError)
    def _on_bad_request(exc: ValueError):
        return jsonify({"error": "bad_request", "detail": str(exc)}), 400

    @app.get("/healthz")
    def healthz():
        """Liveness + OpenD state + **deployed version** + **registered routes**.
        Never starts OpenD — probing must not seize the account's quote
        entitlement as a side effect.

        `version` 每次请求现读 (不缓存): 部署会重启本服务, 但缓存会让"重启前的探针"
        与"重启后的自检"读到不同来源, 而这个字段存在的全部意义就是被自检当判据。

        🚨 `routes` 为什么必须存在, 且必须取自 `url_map` 而不是任何清单:
        `version` 读的是**磁盘上的 VERSION 文件**, 所以它证明不了「进程真的重启并加载了
        新代码」—— install.sh 铺完新树但服务没起来时, 内存里的旧代码照样会读到新文件、
        报出新 SHA, 版本闸就这么被绕过去。`url_map` 是**已加载代码的内存状态**, 磁盘文件
        伪造不了它。⇒ 版本闸管「装的是不是那棵树」, 本字段管「跑的是不是那棵树」,
        两者缺一不可。判据实现在 `deploy/remote-deploy.sh` ②。
        """
        return jsonify(
            {
                "ok": True,
                "as_of": _now_iso(),
                "version": read_version(),
                "routes": sorted(
                    rule.rule for rule in app.url_map.iter_rules() if rule.endpoint != "static"
                ),
                **opend.status(),
            }
        )

    @app.get("/universe")
    def universe():
        """Tradable universe for a market, unioned across security types.

        `types` defaults to STOCK+ETF because Futu classifies some REITs (VICI,
        for one) as ETF — querying STOCK alone silently loses them. The server
        may override; the shim does not filter rows on their contents.
        """
        market = _require_enum(request.args.get("market"), Market, "market")
        raw_types = request.args.get("types", "STOCK,ETF")
        wanted = [part for part in (t.strip() for t in raw_types.split(",")) if part]
        if not wanted:
            raise ValueError("query param `types` must list at least one security type")
        security_types = [_require_enum(t, SecurityType, "types") for t in wanted]

        rows: list[dict[str, Any]] = []
        with opend.session() as ctx:
            for security_type in security_types:
                rate_gate.check("stock_basicinfo")
                ret, content = ctx.get_stock_basicinfo(market, security_type)
                frame = _unwrap(ret, content, f"get_stock_basicinfo({market},{security_type})")
                rows.extend(mappers.dataframe_to_records(frame))
        return _envelope(mappers.dedupe_by(rows, "code"))

    @app.get("/kline")
    def kline():
        """Historical candles for one security. Backs the `us_equity_bar` dimension.

        `autype` defaults to **NONE (unadjusted)** and that default is
        load-bearing, not a convenience. The server stores exactly one row per
        (instrument, date) at `adjust='none'` and derives forward/backward at
        read time from per-event factors (server feature 020). Adjusted prices
        would land in that raw slot and be adjusted a second time on read.

        Measured 2026-07-31 (US.PEP, 144 sessions), so the above is not theory:
        NONE's last close matched the live snapshot exactly, while QFQ differed
        on 106 of 144 sessions — by 2.73 (1.9%) six months back, shrinking to 0
        at the most recent bar. That shape is inherent to forward adjustment:
        it anchors on the latest price, so every new dividend rewrites the whole
        history. Storing it would make a row's value depend on the day it was
        fetched.

        Quota note (measured, same session): history-kline quota is charged per
        **security per rolling window**, not per call — querying a security
        already in the window is free and only refreshes its timestamp. A fixed
        watchlist polled daily therefore holds a constant number of slots rather
        than draining the balance.
        """
        code = (request.args.get("code") or "").strip()
        if not code:
            raise ValueError("missing required query param `code`")
        ktype = _require_enum(request.args.get("ktype", "K_DAY"), KLType, "ktype")
        autype = _require_enum(request.args.get("autype", "NONE"), AuType, "autype")
        start = request.args.get("start") or None
        end = request.args.get("end") or None

        rows: list[dict[str, Any]] = []
        with opend.session() as ctx:
            page_key = None
            # 🚨 限频**只计首页** —— 官方原文:「如果您是分页获取数据, 此限频规则仅适用于
            # 每只股票的首页, 后续页请求不受限频规则的限制」(见 ratelimit.LIMITS 注释)。
            # 早先把 check() 放在循环内 = 一票 10 年算 3 次, 与 6x 过严的 fallback 叠加,
            # 第三只票就 429 并连坐熔断 (prod 2026-08-01 实测 ok=2/fail=5)。
            rate_gate.check("history_kline")
            for _ in range(KLINE_MAX_PAGES):
                ret, content, page_key = ctx.request_history_kline(
                    code,
                    start=start,
                    end=end,
                    ktype=ktype,
                    autype=autype,
                    max_count=KLINE_PAGE_ROWS,
                    page_req_key=page_key,
                )
                frame = _unwrap(ret, content, f"request_history_kline({code},{ktype},{autype})")
                rows.extend(mappers.dataframe_to_records(frame))
                if page_key is None:
                    break
            else:
                # Loop ran to completion with a key still pending: more data
                # exists than the cap allows. ValueError -> 400 (permanent) on
                # purpose; see KLINE_MAX_PAGES. Refusing beats returning a
                # silently short series.
                raise ValueError(
                    f"window too wide for one request: {code} exceeded "
                    f"{KLINE_MAX_PAGES} pages ({len(rows)} rows) with more remaining; "
                    f"narrow start/end (the caller should chunk, not the shim)"
                )
        return _envelope(rows)

    @app.get("/overview")
    def overview():
        """Per-underlying option overview. Backs the `underlying_iv_daily` dimension.

        Carries `iv` / `iv_rank` / `iv_percentile` plus the HV ladder
        (30/60/90/120/365d, each with its own percentile). This is the only
        endpoint in the option surface that takes a **code list**, so the daily
        pass over the anchor set is one call rather than one per underlying.

        The IV here is Futu's *aggregated underlying* IV, not a 30d-ATM lock —
        Futu does not document the tenor/moneyness aggregation (p3 §9-1). The
        shim passes it through unnamed and uninterpreted; labelling is the
        consumer's problem and the adopted label is "富途标的聚合 IV".
        """
        raw_codes = request.args.get("codes") or ""
        codes = [part for part in (c.strip() for c in raw_codes.split(",")) if part]
        if not codes:
            raise ValueError("missing required query param `codes`")
        if len(codes) > OVERVIEW_MAX_CODES:
            raise ValueError(
                f"too many codes: {len(codes)} exceeds the vendor batch cap of "
                f"{OVERVIEW_MAX_CODES}; the caller must batch — the shim refuses "
                f"rather than silently dropping the tail"
            )

        with opend.session() as ctx:
            rate_gate.check("underlying_overview")
            ret, content = ctx.get_option_underlying_overview(codes)
            frame = _unwrap(ret, content, f"get_option_underlying_overview({len(codes)} codes)")
        return _envelope(mappers.dataframe_to_records(frame))

    @app.get("/his-vol")
    def his_vol():
        """Daily IV / HV / underlying-price series for one underlying. Backs the
        `underlying_iv_history` backfill and the IVP self-computation.

        Depth is ~3 years and it is a **sliding** window (measured 2026-07-29 on
        US.PEP: 776 rows back to 2023-06-26), which is why the first backfill
        pulls the whole thing — a year not fetched today is gone next year.

        🚨 A window wider than `HIS_VOL_MAX_SPAN_DAYS` is refused, never clipped;
        see that constant for why the SDK will not do it for us.
        """
        code = (request.args.get("code") or "").strip()
        if not code:
            raise ValueError("missing required query param `code`")
        start = _optional_date(request.args.get("start"), "start")
        end = _optional_date(request.args.get("end"), "end")
        if start is not None and end is not None:
            if end < start:
                raise ValueError(f"`end` ({end}) is before `start` ({start})")
            span_days = (end - start).days
            if span_days > HIS_VOL_MAX_SPAN_DAYS:
                raise ValueError(
                    f"window too wide: {span_days} days exceeds the vendor cap of "
                    f"{HIS_VOL_MAX_SPAN_DAYS} days per call; split the window "
                    f"caller-side (the shim refuses rather than returning a "
                    f"silently clipped series)"
                )

        rows: list[dict[str, Any]] = []
        with opend.session() as ctx:
            page_key = None
            # 🚨 限频**只计首页**, 同 `/kline` 的理由 (见该 route 注释): 闸在分页中途抛
            # 429 会被 server 侧 transport 判为 transient 并重试, 而每次重试都从第一页
            # 重来并再次填满窗口 —— 请求永远成功不了, 却一直长得像临时抖动。
            # ⚠️ 与 `history_kline` 不同: 那条的分页豁免是官方明文, 本端点的文档页只给了
            # 60/30s 这个值、未就分页表态。真撞上 vendor 侧限频会是 502 vendor_error
            # (诚实可见), 而逐页自计数换来的是自伤式 429 —— 两害取前者。
            rate_gate.check("his_volatility")
            for _ in range(HIS_VOL_MAX_PAGES):
                ret, content, page_key = ctx.get_option_underlying_his_volatility(
                    code,
                    begin_time=start.isoformat() if start is not None else None,
                    end_time=end.isoformat() if end is not None else None,
                    page_req_key=page_key,
                )
                frame = _unwrap(ret, content, f"get_option_underlying_his_volatility({code})")
                rows.extend(mappers.dataframe_to_records(frame))
                if page_key is None:
                    break
            else:
                # A <=364-day window that needs more than 8 pages means the page
                # size collapsed or the vendor changed shape. 400 (permanent) for
                # the same reason as /kline: a retry would restart from page one.
                raise ValueError(
                    f"unexpected page count: {code} exceeded {HIS_VOL_MAX_PAGES} pages "
                    f"({len(rows)} rows) with more remaining for a window of at most "
                    f"{HIS_VOL_MAX_SPAN_DAYS} days; refusing a partial series"
                )
        return _envelope(rows)

    @app.get("/option-expirations")
    def option_expirations():
        """One underlying's full expiry ladder. Entry point of chain discovery.

        没有任何裁剪 —— 远月 LEAPS 照常返回。截掉远端不会报错，只会让那一整批腿永远采不到，
        而**期权快照漏采即永久缺口**（vendor 不提供历史交易日的链快照，今天没取的明天补不回来）。

        返回的到期日随后由调用方切成 ≤30 天的窗喂给 `/option-chain`（server 侧
        `planOptionChainWindows`）—— 分窗是调用方的事，shim 不代劳。
        """
        code = (request.args.get("code") or "").strip()
        if not code:
            raise ValueError("missing required query param `code`")

        with opend.session() as ctx:
            rate_gate.check("expiration_date")
            ret, content = ctx.get_option_expiration_date(code)
            frame = _unwrap(ret, content, f"get_option_expiration_date({code})")
        return _envelope(mappers.dataframe_to_records(frame))

    @app.get("/option-chain")
    def option_chain():
        """Contract statics for one underlying over one expiry window.

        🚨 `option_type` 默认 **ALL（含 CALL）**，且这个默认是承重的。「只要认沽」是**呈现面**
        的话，不是采集面的：链接口一次返双边、调用数完全不变，在这里滤掉一分钱不省，却会让
        CALL 侧留下**不可回补**的永久缺口。同理 `data_filter` 恒不传 —— 任何 greeks / OI / IV
        过滤都是在采集端丢证据；筛选是消费端的事。

        窗跨度上限见 `OPTION_CHAIN_MAX_SPAN_DAYS`：超窗 **400**，绝不截断。

        限频 **10 次/30 s，这是官方真值不是兜底**（2026-08-04 直取 openapi.futunn.com 复核，
        原文「每 30 秒内最多请求 10 次获取期权链接口」）。它与 `history_kline` 那次
        （有官方 60/30 s 却被挂在最严兜底、酿成 08-01 回填事故）是**相反方向**的事 ——
        看到这个数字比别的端点严 6 倍时，不要「顺手修正」。
        """
        code = (request.args.get("code") or "").strip()
        if not code:
            raise ValueError("missing required query param `code`")
        start = _optional_date(request.args.get("start"), "start")
        end = _optional_date(request.args.get("end"), "end")
        if start is not None and end is not None:
            if end < start:
                raise ValueError(f"`end` ({end}) is before `start` ({start})")
            span_days = (end - start).days + 1  # 含首尾
            if span_days > OPTION_CHAIN_MAX_SPAN_DAYS:
                raise ValueError(
                    f"expiry window too wide: {span_days} days (inclusive) exceeds the "
                    f"vendor cap of {OPTION_CHAIN_MAX_SPAN_DAYS} days per call; split the "
                    f"window caller-side (the shim refuses rather than returning a "
                    f"silently partial chain)"
                )
        option_type = _require_enum(
            request.args.get("option_type", "ALL"), OptionType, "option_type"
        )

        with opend.session() as ctx:
            rate_gate.check("option_chain")
            ret, content = ctx.get_option_chain(
                code,
                start=start.isoformat() if start is not None else None,
                end=end.isoformat() if end is not None else None,
                option_type=option_type,
            )
            frame = _unwrap(ret, content, f"get_option_chain({code},{start},{end})")
        return _envelope(mappers.dataframe_to_records(frame))

    @app.get("/option-snapshot")
    def option_snapshot():
        """Batched quote + greeks + open interest for option contracts.

        一发返回：双边报价与档位量（`bid_price` / `ask_price` / `bid_vol` / `ask_vol`）·
        全 greeks 与 IV · OI 与净OI · Vol 与成交额 · **vendor 时间戳 `update_time`**。

        **标的 spot 不另取一发**：把标的自己的 code 放进同一批 `codes`，它的 `last_price`
        与期权行一起回来，期权行的 `stock_owner` 就是关联键。多一个 code 远比多一次调用便宜，
        也免得 shim 替调用方决定「谁是标的」。

        🚨 `update_time` 是 vendor 的**最后成交时刻**，不是报价时刻（p3b E33）——
        新鲜度看 envelope 的 `as_of`（本次采集时刻），两者是两回事，别互相顶替。

        🚨 **greeks 整块缺失的行照常返回**，只带上 `greeks_complete=false`
        （见 `mappers.mark_greeks_completeness`）。在这里丢弃会让下游无法区分
        「腿在但算不出档」与「腿今天没采到」—— 后者是真缺口，前者是数学固有现象。
        """
        raw_codes = request.args.get("codes") or ""
        codes = [part for part in (c.strip() for c in raw_codes.split(",")) if part]
        if not codes:
            raise ValueError("missing required query param `codes`")
        if len(codes) > SNAPSHOT_MAX_CODES:
            raise ValueError(
                f"too many codes: {len(codes)} exceeds the vendor batch cap of "
                f"{SNAPSHOT_MAX_CODES}; the caller must batch — the shim refuses "
                f"rather than silently dropping the tail"
            )

        with opend.session() as ctx:
            rate_gate.check("snapshot")
            ret, content = ctx.get_market_snapshot(codes)
            frame = _unwrap(ret, content, f"get_market_snapshot({len(codes)} codes)")
        return _envelope(mappers.mark_greeks_completeness(mappers.dataframe_to_records(frame)))

    @app.get("/earnings-calendar")
    def earnings_calendar():
        """Market-wide earnings calendar for one window. Backs the earnings PIT trail.

        **市场级接口**：一发返回该市场窗内**全部**标的，与白名单无关，`filter_list` 恒不传。
        在这里按白名单收窄看着省事，但 PIT 三件套（首见 / 改期 / 改期前日期）只有连续观察
        全市场才成立 —— 日后加一只票时，它此前的改期史无从回补。过滤是消费端的事。

        窗跨度上限见 `EARNINGS_MAX_SPAN_DAYS`：超窗 **400**，绝不截断（被悄悄裁掉的那几天
        在下游读作「那几天全市场没有财报」）。

        限频 capability = `earnings_calendar`，档位 **60 次/30 s = 官方值**（2026-08-04 直取
        `openapi.futunn.com` 复核，原文「接口限制：30 秒内最多 60 次请求；分页请求仅首页计入
        限频统计」）。它曾因不在 `ratelimit.py` 的 `LIMITS` 表内而落最严兜底 10 次/30 s（6x
        偏严，与 `history_kline` 08-01 那次同形状、反方向），已补登 —— 别再调回兜底。
        """
        market = _require_enum(request.args.get("market"), Market, "market")
        start = _optional_date(request.args.get("start"), "start")
        end = _optional_date(request.args.get("end"), "end")
        if end is not None:
            if start is None:
                raise ValueError(
                    "query param `end` requires `start`: without it the vendor derives the "
                    "window start itself (today), which leaves the span unvalidatable — and "
                    "an over-wide window comes back silently clipped"
                )
            if end < start:
                raise ValueError(f"`end` ({end}) is before `start` ({start})")
            span_days = (end - start).days
            if span_days > EARNINGS_MAX_SPAN_DAYS:
                raise ValueError(
                    f"window too wide: {span_days} days exceeds the vendor cap of "
                    f"{EARNINGS_MAX_SPAN_DAYS} days between `start` and `end`; split the "
                    f"window caller-side (the shim refuses rather than returning a "
                    f"silently clipped calendar)"
                )

        with opend.session() as ctx:
            rate_gate.check("earnings_calendar")
            ret, content = ctx.get_earnings_calendar(
                market,
                begin_date=start.isoformat() if start is not None else None,
                end_date=end.isoformat() if end is not None else None,
            )
            frame = _unwrap(ret, content, f"get_earnings_calendar({market},{start},{end})")
        return _envelope(mappers.dataframe_to_records(frame))

    @app.get("/trading-days")
    def trading_days():
        """Exchange trading days. Backs the US calendar L1 source."""
        market = _require_enum(request.args.get("market"), TradeDateMarket, "market")
        start = request.args.get("start") or None
        end = request.args.get("end") or None

        with opend.session() as ctx:
            rate_gate.check("trading_days")
            ret, content = ctx.request_trading_days(market=market, start=start, end=end)
            days = _unwrap(ret, content, f"request_trading_days({market})")
        return _envelope(mappers.rows_to_records(days))

    return app


def main() -> None:
    logging.basicConfig(
        level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
    )
    if not config.service_token():
        raise SystemExit("FUTU_SHIM_TOKEN is unset — refusing to start (fail-closed)")

    from waitress import serve

    supervisor = OpenDSupervisor()
    supervisor.reclaim()
    supervisor.start_idle_watcher()
    app = create_app(supervisor)
    host, port = config.bind_host(), config.bind_port()
    log.info("futu-shim listening on %s:%s (OpenD unit %s)", host, port, config.opend_unit())
    # Few callers, and every data call serialises on the SDK's internal RLock
    # anyway, so a small thread pool is the right size.
    serve(app, host=host, port=port, threads=4, ident="futu-shim")


if __name__ == "__main__":
    main()
