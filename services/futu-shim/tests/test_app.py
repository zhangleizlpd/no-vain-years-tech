import gzip
import json
import logging
import re
from contextlib import contextmanager
from pathlib import Path

import pandas as pd
import pytest
from futu import RET_OK

from futu_shim.app import GZIP_MIN_BYTES, create_app
from futu_shim.ratelimit import RateGate

TOKEN = "test-token"
AUTH = {"Authorization": f"Bearer {TOKEN}"}


class FakeCtx:
    """Stands in for OpenQuoteContext. Records calls so tests can assert the
    shim fans out the way it claims to."""

    def __init__(
        self,
        basicinfo=None,
        trading_days=None,
        ret=RET_OK,
        kline_pages=None,
        overview=None,
        his_vol_pages=None,
        expirations=None,
        chain=None,
        snapshot=None,
        earnings=None,
    ):
        self._basicinfo = basicinfo if basicinfo is not None else pd.DataFrame()
        self._trading_days = trading_days if trading_days is not None else []
        self._ret = ret
        # [(frame, next_page_key), ...] — mirrors the real paging contract: the
        # vendor hands back a key while more rows remain, None on the last page.
        self._kline_pages = kline_pages if kline_pages is not None else []
        self._overview = overview if overview is not None else pd.DataFrame()
        self._his_vol_pages = his_vol_pages if his_vol_pages is not None else []
        self._expirations = expirations if expirations is not None else pd.DataFrame()
        self._chain = chain if chain is not None else pd.DataFrame()
        self._snapshot = snapshot if snapshot is not None else pd.DataFrame()
        self._earnings = earnings if earnings is not None else pd.DataFrame()
        self.basicinfo_calls: list[tuple[str, str]] = []
        self.trading_days_calls: list[tuple] = []
        self.kline_calls: list[dict] = []
        self.overview_calls: list[list[str]] = []
        self.his_vol_calls: list[dict] = []
        self.expiration_calls: list[dict] = []
        self.chain_calls: list[dict] = []
        self.snapshot_calls: list[list[str]] = []
        self.earnings_calls: list[dict] = []

    def get_stock_basicinfo(self, market, stock_type):
        self.basicinfo_calls.append((market, stock_type))
        if self._ret != RET_OK:
            return self._ret, "vendor said no"
        return RET_OK, self._basicinfo

    def request_trading_days(self, market, start, end):
        self.trading_days_calls.append((market, start, end))
        if self._ret != RET_OK:
            return self._ret, "vendor said no"
        return RET_OK, self._trading_days

    def request_history_kline(
        self, code, start, end, ktype, autype, max_count, page_req_key
    ):
        self.kline_calls.append(
            {
                "code": code,
                "start": start,
                "end": end,
                "ktype": ktype,
                "autype": autype,
                "max_count": max_count,
                "page_req_key": page_req_key,
            }
        )
        if self._ret != RET_OK:
            return self._ret, "vendor said no", None
        idx = len(self.kline_calls) - 1
        if idx >= len(self._kline_pages):
            return RET_OK, pd.DataFrame(), None
        frame, next_key = self._kline_pages[idx]
        return RET_OK, frame, next_key

    def get_option_underlying_overview(self, code_list):
        self.overview_calls.append(code_list)
        if self._ret != RET_OK:
            return self._ret, "vendor said no"
        return RET_OK, self._overview

    def get_option_underlying_his_volatility(
        self, code, begin_time=None, end_time=None, page_req_key=None
    ):
        self.his_vol_calls.append(
            {
                "code": code,
                "begin_time": begin_time,
                "end_time": end_time,
                "page_req_key": page_req_key,
            }
        )
        if self._ret != RET_OK:
            return self._ret, "vendor said no", None
        idx = len(self.his_vol_calls) - 1
        if idx >= len(self._his_vol_pages):
            return RET_OK, pd.DataFrame(), None
        frame, next_key = self._his_vol_pages[idx]
        return RET_OK, frame, next_key

    def get_option_expiration_date(self, code, index_option_type=None):
        self.expiration_calls.append({"code": code, "index_option_type": index_option_type})
        if self._ret != RET_OK:
            return self._ret, "vendor said no"
        return RET_OK, self._expirations

    # Keyword names mirror the SDK's own signature, so a route that passes the
    # wrong slot (option_type into option_cond_type, say) shows up here.
    def get_option_chain(
        self,
        code,
        index_option_type=None,
        start=None,
        end=None,
        option_type=None,
        option_cond_type=None,
        data_filter=None,
    ):
        self.chain_calls.append(
            {
                "code": code,
                "index_option_type": index_option_type,
                "start": start,
                "end": end,
                "option_type": option_type,
                "option_cond_type": option_cond_type,
                "data_filter": data_filter,
            }
        )
        if self._ret != RET_OK:
            return self._ret, "vendor said no"
        return RET_OK, self._chain

    def get_market_snapshot(self, code_list):
        self.snapshot_calls.append(list(code_list))
        if self._ret != RET_OK:
            return self._ret, "vendor said no"
        return RET_OK, self._snapshot

    def get_earnings_calendar(
        self, market, sort_type=None, begin_date=None, end_date=None, filter_list=None
    ):
        self.earnings_calls.append(
            {
                "market": market,
                "sort_type": sort_type,
                "begin_date": begin_date,
                "end_date": end_date,
                "filter_list": filter_list,
            }
        )
        if self._ret != RET_OK:
            return self._ret, "vendor said no"
        return RET_OK, self._earnings


class FakeSupervisor:
    def __init__(self, ctx: FakeCtx):
        self.ctx = ctx
        self.sessions = 0

    @contextmanager
    def session(self):
        self.sessions += 1
        yield self.ctx

    def status(self):
        return {"opend_unit_active": True, "opend_connected": True, "qot_logined": True}


@pytest.fixture(autouse=True)
def _token(monkeypatch):
    monkeypatch.setenv("FUTU_SHIM_TOKEN", TOKEN)


def build(ctx: FakeCtx, gate: RateGate | None = None):
    supervisor = FakeSupervisor(ctx)
    app = create_app(supervisor, gate)
    app.config.update(TESTING=True)
    return app.test_client(), supervisor


SHIM_ROOT = Path(__file__).resolve().parents[1]
DEPLOY_SCRIPT = SHIM_ROOT / "deploy" / "remote-deploy.sh"
APP_SOURCE = SHIM_ROOT / "src" / "futu_shim" / "app.py"


def registered_routes():
    app = create_app(FakeSupervisor(FakeCtx()))
    return {rule.rule for rule in app.url_map.iter_rules() if rule.endpoint != "static"}


def test_healthz_is_public_and_does_not_start_opend():
    """A health probe must be side-effect free — and it has to stay honest about
    OpenD being down rather than paper over it by starting one."""
    client, supervisor = build(FakeCtx())
    resp = client.get("/healthz")  # no Authorization header
    assert resp.status_code == 200
    assert resp.json["ok"] is True
    assert supervisor.sessions == 0


def test_healthz_reports_the_in_memory_route_set():
    """`routes` 是 `deploy/remote-deploy.sh` ② 的判据来源，必须取自 url_map。

    与 `version` 的分工：version 现读**磁盘上的 VERSION 文件**，所以证明不了进程真的重启
    并加载了新代码（铺完新树没重启时，旧进程照样报新 SHA）；url_map 是**已加载代码的内存
    状态**，磁盘文件伪造不了它。
    """
    client, supervisor = build(FakeCtx())
    routes = client.get("/healthz").json["routes"]  # 无 Authorization
    assert routes == sorted(registered_routes())
    assert routes, "空集合会让 ② 的子集比较恒真"
    assert supervisor.sessions == 0


def test_deploy_probe_pattern_sees_every_registered_route():
    """守住 ② 的**提取端**，防它被静默削弱。

    ② 断言「源码里声明的 route」⊆「url_map 里注册的 route」。若有人用那条 grep 抓不到的
    写法新增 route（如 `@app.post` / `@app.route`），declared 会**变小**而不是变错 ——
    子集比较照样通过，检查悄悄退化且无人知晓。这条测试把那种退化变成 CI 红。

    模式从 shell 脚本里现取，不在此处复抄一份（复抄 = 又一处要手动同步的清单）。
    """
    script = DEPLOY_SCRIPT.read_text(encoding="utf-8")
    match = re.search(r"""grep -oP '([^']+)' "\$workdir/src/futu_shim/app\.py""", script)
    assert match, "remote-deploy.sh ② 里找不到抽取 route 的 grep -oP 模式"

    declared = set(re.findall(match.group(1), APP_SOURCE.read_text(encoding="utf-8")))
    assert declared, "模式没从 app.py 抽出任何 route —— 提取端已失效"
    assert declared == registered_routes()


@pytest.mark.parametrize(
    "path",
    [
        "/universe?market=US",
        "/trading-days?market=US",
        "/kline?code=US.PEP",
        "/overview?codes=US.PEP",
        "/his-vol?code=US.PEP",
        "/option-expirations?code=US.PEP",
        "/option-chain?code=US.PEP",
        "/option-snapshot?codes=US.PEP260807P145000",
        "/earnings-calendar?market=US",
        # 裸路径（无 token 且无参数）：鉴权是 before_request 钩子，必须**先于**各 view
        # 自己的参数校验生效，否则「缺参」会盖过「没鉴权」，把 401 降级成 400 —— 未鉴权
        # 的调用方就能从错误码里读出参数形状。
        #
        # ⚠️ 这组用例**不再**是部署探针的判据镜像：探针曾按「401 = 路由存在」判断，而
        # 未注册路径同样返回 401（钩子先于路由 404），故该判据恒真、已于 2026-08-03 换成
        # url_map 集合比较，见 test_deploy_probe_pattern_sees_every_registered_route。
        "/universe",
        "/trading-days",
        "/kline",
        "/overview",
        "/his-vol",
        "/option-expirations",
        "/option-chain",
        "/option-snapshot",
        "/earnings-calendar",
    ],
)
def test_data_routes_reject_missing_or_wrong_token(path):
    client, supervisor = build(FakeCtx())
    assert client.get(path).status_code == 401
    assert client.get(path, headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.get(path, headers={"Authorization": TOKEN}).status_code == 401  # no scheme
    assert supervisor.sessions == 0  # never reached OpenD


def test_universe_unions_security_types_and_dedupes():
    frame = pd.DataFrame([{"code": "US.VICI", "stock_type": "X"}])
    ctx = FakeCtx(basicinfo=frame)
    client, _ = build(ctx)
    resp = client.get("/universe?market=US", headers=AUTH)
    assert resp.status_code == 200
    # default types=STOCK,ETF -> two vendor calls, one deduped row
    assert [t for _, t in ctx.basicinfo_calls] == ["STOCK", "ETF"]
    assert resp.json["count"] == 1
    assert resp.json["rows"][0]["code"] == "US.VICI"
    assert resp.json["as_of"].endswith("+00:00")


def test_universe_honours_explicit_types():
    ctx = FakeCtx(basicinfo=pd.DataFrame())
    client, _ = build(ctx)
    client.get("/universe?market=US&types=STOCK", headers=AUTH)
    assert [t for _, t in ctx.basicinfo_calls] == ["STOCK"]


def test_trading_days_passes_the_window_through():
    ctx = FakeCtx(trading_days=[{"time": "2026-07-31", "trade_date_type": "WHOLE"}])
    client, _ = build(ctx)
    resp = client.get("/trading-days?market=US&start=2026-07-01&end=2026-07-31", headers=AUTH)
    assert resp.status_code == 200
    assert ctx.trading_days_calls == [("US", "2026-07-01", "2026-07-31")]
    assert resp.json["rows"][0]["time"] == "2026-07-31"


def _bar(day, close):
    return {"time_key": f"{day} 00:00:00", "close": close, "last_close": close - 1}


def test_kline_defaults_to_unadjusted_daily():
    """The NONE default is load-bearing: the server stores raw prices at
    adjust='none' and adjusts at read time. An adjusted default would silently
    land pre-adjusted values in that slot."""
    ctx = FakeCtx(kline_pages=[(pd.DataFrame([_bar("2026-07-30", 140.2)]), None)])
    client, _ = build(ctx)
    resp = client.get("/kline?code=US.PEP&start=2026-07-01&end=2026-07-31", headers=AUTH)

    assert resp.status_code == 200
    call = ctx.kline_calls[0]
    assert call["autype"] == "None"  # AuType.NONE
    assert call["ktype"] == "K_DAY"
    assert (call["code"], call["start"], call["end"]) == ("US.PEP", "2026-07-01", "2026-07-31")
    assert resp.json["rows"][0]["close"] == 140.2


def test_kline_honours_explicit_ktype_and_autype():
    ctx = FakeCtx(kline_pages=[(pd.DataFrame([_bar("2026-07-30", 1.0)]), None)])
    client, _ = build(ctx)
    client.get("/kline?code=US.PEP&ktype=K_WEEK&autype=QFQ", headers=AUTH)
    assert (ctx.kline_calls[0]["ktype"], ctx.kline_calls[0]["autype"]) == ("K_WEEK", "qfq")


def test_kline_follows_page_key_to_exhaustion():
    """🚨 The vendor hands back a page key while more rows remain. Stopping at
    the first page is a silent truncation — the shape this repo keeps getting
    burnt by (eastmoney F1)."""
    ctx = FakeCtx(
        kline_pages=[
            (pd.DataFrame([_bar("2026-07-28", 1.0)]), "KEY-1"),
            (pd.DataFrame([_bar("2026-07-29", 2.0)]), "KEY-2"),
            (pd.DataFrame([_bar("2026-07-30", 3.0)]), None),
        ]
    )
    client, _ = build(ctx)
    resp = client.get("/kline?code=US.PEP", headers=AUTH)

    assert resp.json["count"] == 3
    assert [r["close"] for r in resp.json["rows"]] == [1.0, 2.0, 3.0]
    # the key from page N must be fed into page N+1, else the vendor restarts
    assert [c["page_req_key"] for c in ctx.kline_calls] == [None, "KEY-1", "KEY-2"]


def test_kline_refuses_rather_than_truncates_when_pages_run_out():
    """🚨 Overflow must be a permanent 400, and must fire before the rate gate.

    A 429 here would be classified transient by the server's transport and
    retried; each retry restarts pagination from page one and refills the gate,
    so the request could never succeed while looking like a temporary blip. A
    short 200 would be worse still — indistinguishable from "that is all the
    history there is".
    """
    # Gate left at the shipped 60/30s, and metered once per request (not per
    # page) — so the page cap (8) is the only thing that can stop this loop.
    ctx = FakeCtx(kline_pages=[(pd.DataFrame([_bar("2026-07-30", 1.0)]), "MORE")] * 40)
    client, _ = build(ctx)
    resp = client.get("/kline?code=US.PEP", headers=AUTH)

    assert resp.status_code == 400
    assert resp.json["error"] == "bad_request"
    assert "window too wide" in resp.json["detail"]
    assert len(ctx.kline_calls) == 8  # capped by KLINE_MAX_PAGES, not by the gate


def test_kline_missing_or_bad_params_rejected_before_touching_opend():
    client, supervisor = build(FakeCtx())
    assert client.get("/kline", headers=AUTH).status_code == 400
    assert client.get("/kline?code=%20", headers=AUTH).status_code == 400
    assert client.get("/kline?code=US.PEP&autype=SIDEWAYS", headers=AUTH).status_code == 400
    assert client.get("/kline?code=US.PEP&ktype=K_CENTURY", headers=AUTH).status_code == 400
    assert supervisor.sessions == 0


def test_kline_meters_only_the_first_page_per_the_vendor_rule():
    """🚨 官方原文:「如果您是分页获取数据, 此限频规则仅适用于每只股票的首页,
    后续页请求不受限频规则的限制」(2026-08-01 于 futunn / moomoo 两个官方镜像逐字复核)。

    这里**曾经断言相反的行为**(每页都计数) —— 那不是保守, 是漏读文档得出的错误假设,
    代价是一次真实事故: 10 年回填每票 3 页, 叠加当时 6x 过严的 fallback 限额, 第三只票
    即 429, 并连坐 server 侧 ConsecutiveBreaker 让剩余四票全失败
    (prod 2026-08-01, `SyncRun` partial ok=2 fail=5)。
    """
    gate = RateGate(limits={"history_kline": (2, 30)})
    # 一发请求 4 页; 三发请求共 12 次 vendor 调用, 每发只应占 1 个限频槽。
    ctx = FakeCtx(
        kline_pages=([(pd.DataFrame([_bar("2026-07-30", 1.0)]), "MORE")] * 3
                     + [(pd.DataFrame([_bar("2026-07-31", 2.0)]), None)]) * 3
    )
    client, _ = build(ctx, gate)

    first = client.get("/kline?code=US.PEP", headers=AUTH)
    assert first.status_code == 200
    assert len(ctx.kline_calls) == 4  # 后续 3 页不被闸拦

    # 首页各计 1 次 ⇒ 限额 2 意味着第二发仍通过、第三发才 429。
    assert client.get("/kline?code=US.PEP", headers=AUTH).status_code == 200
    refused = client.get("/kline?code=US.PEP", headers=AUTH)
    assert refused.status_code == 429
    assert refused.json["capability"] == "history_kline"
    assert len(ctx.kline_calls) == 8  # 第三发在首页前就被拒, 零 vendor 调用


def test_rate_limited_is_logged_because_nothing_else_records_it(caplog):
    """🚨 A 429 must leave a trace here or it leaves none at all.

    waitress emits no access log, and the server side absorbs 429 silently
    (VendorHttpClient sleeps Retry-After and retries without logging). On
    2026-08-09, verifying the option_chain rate-limit fix, "did that run hit the
    gate?" could only be argued from pacing arithmetic — this assertion exists so
    the next person can just read it.
    """
    gate = RateGate(limits={"history_kline": (1, 30)})
    ctx = FakeCtx(kline_pages=[(pd.DataFrame([_bar("2026-07-30", 1.0)]), None)])
    client, _ = build(ctx, gate)

    assert client.get("/kline?code=US.PEP", headers=AUTH).status_code == 200
    with caplog.at_level(logging.WARNING, logger="futu_shim.app"):
        refused = client.get("/kline?code=US.PEP", headers=AUTH)

    assert refused.status_code == 429
    logged = [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]
    assert any("rate limited" in m and "history_kline" in m for m in logged), logged


def _overview_row(code, iv_percentile):
    return {
        "code": code,
        "name": code.split(".")[-1],
        "iv": 24.8,
        "iv_rank": 51.5,
        "iv_percentile": iv_percentile,
        "hv_30d": 20.1,
    }


def test_overview_passes_the_whole_code_list_through_as_one_batch():
    """This is the only endpoint in the option surface that takes a code list,
    which is why the daily pass over 12 anchors is one call and not 12."""
    ctx = FakeCtx(overview=pd.DataFrame([_overview_row("US.PEP", 63.5)]))
    client, _ = build(ctx)
    resp = client.get("/overview?codes=US.PEP,US.VICI", headers=AUTH)

    assert resp.status_code == 200
    assert ctx.overview_calls == [["US.PEP", "US.VICI"]]  # one call, not two
    assert resp.json["count"] == 1
    assert resp.json["rows"][0]["iv_percentile"] == 63.5
    assert resp.json["as_of"].endswith("+00:00")


def test_overview_missing_codes_rejected_before_touching_opend():
    client, supervisor = build(FakeCtx())
    assert client.get("/overview", headers=AUTH).status_code == 400
    assert client.get("/overview?codes=", headers=AUTH).status_code == 400
    assert client.get("/overview?codes=%20,%20", headers=AUTH).status_code == 400
    assert supervisor.sessions == 0


def test_overview_refuses_more_codes_than_the_vendor_batch_cap():
    """🚨 400, not a silent slice. A dropped tail reads downstream as "those
    underlyings have no IV" — indistinguishable from a real data gap."""
    ctx = FakeCtx()
    client, supervisor = build(ctx)
    codes = ",".join(f"US.S{i}" for i in range(501))
    resp = client.get(f"/overview?codes={codes}", headers=AUTH)

    assert resp.status_code == 400
    assert "500" in resp.json["detail"]
    assert ctx.overview_calls == []
    assert supervisor.sessions == 0


def test_overview_is_metered_on_its_own_official_limit_not_the_fallback():
    """🚨 Guardrail: the endpoint's own doc page says 60/30 s. Parking it on the
    strict fallback (10/30 s) is what turned the 08-01 backfill into a 429
    cascade for `history_kline`."""
    gate = RateGate(limits={"underlying_overview": (1, 30)})
    client, _ = build(FakeCtx(), gate)
    assert client.get("/overview?codes=US.PEP", headers=AUTH).status_code == 200
    refused = client.get("/overview?codes=US.PEP", headers=AUTH)
    assert refused.status_code == 429
    assert refused.json["capability"] == "underlying_overview"
    assert int(refused.headers["Retry-After"]) >= 1


def _vol(day, iv, hv):
    return {"code": "US.PEP", "time": day, "iv": iv, "hv": hv, "underlying_price": 140.2}


def test_his_vol_passes_the_window_through():
    ctx = FakeCtx(his_vol_pages=[(pd.DataFrame([_vol("2026-07-30", 24.8, 19.3)]), None)])
    client, _ = build(ctx)
    resp = client.get("/his-vol?code=US.PEP&start=2026-01-01&end=2026-06-01", headers=AUTH)

    assert resp.status_code == 200
    assert ctx.his_vol_calls[0]["code"] == "US.PEP"
    assert ctx.his_vol_calls[0]["begin_time"] == "2026-01-01"
    assert ctx.his_vol_calls[0]["end_time"] == "2026-06-01"
    assert resp.json["rows"][0]["hv"] == 19.3


def test_his_vol_omitted_window_is_left_to_the_sdk_defaults():
    ctx = FakeCtx(his_vol_pages=[(pd.DataFrame([_vol("2026-07-30", 1.0, 2.0)]), None)])
    client, _ = build(ctx)
    assert client.get("/his-vol?code=US.PEP", headers=AUTH).status_code == 200
    assert (ctx.his_vol_calls[0]["begin_time"], ctx.his_vol_calls[0]["end_time"]) == (None, None)


def test_his_vol_follows_page_key_to_exhaustion():
    ctx = FakeCtx(
        his_vol_pages=[
            (pd.DataFrame([_vol("2026-07-28", 1.0, 1.1)]), "KEY-1"),
            (pd.DataFrame([_vol("2026-07-29", 2.0, 2.1)]), None),
        ]
    )
    client, _ = build(ctx)
    resp = client.get("/his-vol?code=US.PEP", headers=AUTH)

    assert resp.json["count"] == 2
    assert [c["page_req_key"] for c in ctx.his_vol_calls] == [None, "KEY-1"]


def test_his_vol_refuses_a_span_wider_than_the_vendor_cap_instead_of_truncating():
    """🚨 The vendor caps one call at a 364-day span, and the SDK does **not**
    enforce it on an explicit window — `normalize_start_end_date(..., 364)` only
    uses that number to derive a *missing* side. So a 3-year request comes back
    quietly clipped, and the caller cannot tell a clip from "that is all the
    history there is". Chunking belongs to the caller; the shim says so once.
    """
    ctx = FakeCtx(his_vol_pages=[(pd.DataFrame([_vol("2026-07-30", 1.0, 1.1)]), None)])
    client, supervisor = build(ctx)

    resp = client.get("/his-vol?code=US.PEP&start=2023-08-01&end=2026-08-01", headers=AUTH)
    assert resp.status_code == 400
    assert resp.json["error"] == "bad_request"
    assert "364" in resp.json["detail"]
    assert ctx.his_vol_calls == []  # refused, not truncated
    assert supervisor.sessions == 0

    # boundary: exactly 364 days apart is the widest legal window
    ok = client.get("/his-vol?code=US.PEP&start=2026-01-01&end=2026-12-31", headers=AUTH)
    assert ok.status_code == 200
    assert len(ctx.his_vol_calls) == 1


def test_his_vol_bad_params_rejected_before_touching_opend():
    client, supervisor = build(FakeCtx())
    assert client.get("/his-vol", headers=AUTH).status_code == 400
    assert client.get("/his-vol?code=%20", headers=AUTH).status_code == 400
    assert client.get("/his-vol?code=US.PEP&start=01/02/2026", headers=AUTH).status_code == 400
    assert client.get("/his-vol?code=US.PEP&end=not-a-date", headers=AUTH).status_code == 400
    reversed_window = client.get(
        "/his-vol?code=US.PEP&start=2026-06-01&end=2026-01-01", headers=AUTH
    )
    assert reversed_window.status_code == 400
    assert supervisor.sessions == 0


def test_his_vol_refuses_rather_than_truncates_when_pages_run_out():
    """Same class as /kline: a short 200 is indistinguishable from "no more
    history". Permanent 400, so a retry cannot loop forever."""
    ctx = FakeCtx(his_vol_pages=[(pd.DataFrame([_vol("2026-07-30", 1.0, 1.1)]), "MORE")] * 40)
    client, _ = build(ctx)
    resp = client.get("/his-vol?code=US.PEP", headers=AUTH)

    assert resp.status_code == 400
    assert len(ctx.his_vol_calls) == 8


def test_his_vol_meters_once_per_request_not_per_page():
    """🚨 Metering每页 is exactly what made the 08-01 backfill unrecoverable: a
    gate 429 raised mid-pagination is classified transient server-side, and each
    retry restarts from page one and refills the gate, so the request can never
    succeed while looking like a temporary blip."""
    gate = RateGate(limits={"his_volatility": (2, 30)})
    ctx = FakeCtx(
        his_vol_pages=([(pd.DataFrame([_vol("2026-07-30", 1.0, 1.1)]), "MORE")] * 2
                       + [(pd.DataFrame([_vol("2026-07-31", 2.0, 2.1)]), None)]) * 3
    )
    client, _ = build(ctx, gate)

    assert client.get("/his-vol?code=US.PEP", headers=AUTH).status_code == 200
    assert len(ctx.his_vol_calls) == 3  # pages 2 and 3 are not charged
    assert client.get("/his-vol?code=US.PEP", headers=AUTH).status_code == 200
    refused = client.get("/his-vol?code=US.PEP", headers=AUTH)
    assert refused.status_code == 429
    assert refused.json["capability"] == "his_volatility"
    assert len(ctx.his_vol_calls) == 6  # third request never reached the vendor


def _expiry(day, distance, cycle="WEEK"):
    return {
        "strike_time": day,
        "option_expiry_date_distance": distance,
        "expiration_cycle": cycle,
    }


def test_option_expirations_returns_every_available_expiry_including_leaps():
    """到期日列表是链发现的**唯一入口**，shim 不做任何裁剪。

    远月 LEAPS 被截掉不会报错，只会让那一整批腿永远采不到 —— 而期权快照**漏采即永久
    缺口**（vendor 不提供历史交易日的链快照）。分窗（≤30 天/次）是调用方的事。
    """
    ctx = FakeCtx(
        expirations=pd.DataFrame(
            [_expiry("2026-08-07", 3), _expiry("2028-01-21", 900, cycle="MONTH")]
        )
    )
    client, _ = build(ctx)
    resp = client.get("/option-expirations?code=US.PEP", headers=AUTH)

    assert resp.status_code == 200
    assert [c["code"] for c in ctx.expiration_calls] == ["US.PEP"]
    assert resp.json["count"] == 2
    assert [r["strike_time"] for r in resp.json["rows"]] == ["2026-08-07", "2028-01-21"]


def test_option_expirations_missing_code_rejected_before_touching_opend():
    client, supervisor = build(FakeCtx())
    assert client.get("/option-expirations", headers=AUTH).status_code == 400
    assert client.get("/option-expirations?code=%20", headers=AUTH).status_code == 400
    assert supervisor.sessions == 0


def test_option_expirations_is_metered_on_its_own_official_limit():
    gate = RateGate(limits={"expiration_date": (1, 30)})
    client, _ = build(FakeCtx(), gate)
    assert client.get("/option-expirations?code=US.PEP", headers=AUTH).status_code == 200
    refused = client.get("/option-expirations?code=US.PEP", headers=AUTH)
    assert refused.status_code == 429
    assert refused.json["capability"] == "expiration_date"


def _chain_row(code, strike, option_type="PUT", **extra):
    row = {
        "code": code,
        "name": "PEP 260807 145.00 PUT",
        "lot_size": 100,
        "stock_type": "DRVT",
        "option_type": option_type,
        "stock_owner": "US.PEP",
        "strike_time": "2026-08-07",
        "strike_price": strike,
        "suspension": False,
        "stock_id": 9001,
        "index_option_type": "N/A",
        "expiration_cycle": "WEEK",
        "option_standard_type": "STANDARD",
        "option_settlement_mode": "PM",
    }
    row.update(extra)
    return row


def test_option_chain_asks_for_both_sides_not_puts_only():
    """🚨 采集端 `option_type` MUST 为 `ALL`（含 CALL）。

    「本片只含认沽」是**呈现面**的话。在采集端就滤成 PUT 不会红，但快照**漏采即永久
    缺口** —— 后续要 CALL（wheel / covered call）时买不回来。而链接口一次返双边，
    调用数不变，滤掉一分钱都不省。同理 `data_filter` 恒为 None：任何 greeks / OI /
    IV 过滤都是在采集端丢证据。
    """
    ctx = FakeCtx(
        chain=pd.DataFrame(
            [
                _chain_row("US.PEP260807P145000", 145.0),
                _chain_row("US.PEP260807C145000", 145.0, option_type="CALL"),
            ]
        )
    )
    client, _ = build(ctx)
    resp = client.get("/option-chain?code=US.PEP&start=2026-08-01&end=2026-08-07", headers=AUTH)

    assert resp.status_code == 200
    call = ctx.chain_calls[0]
    assert call["option_type"] == "ALL"
    assert call["data_filter"] is None
    assert (call["code"], call["start"], call["end"]) == ("US.PEP", "2026-08-01", "2026-08-07")
    assert {r["option_type"] for r in resp.json["rows"]} == {"PUT", "CALL"}


def test_option_chain_honours_an_explicit_option_type_and_rejects_junk():
    ctx = FakeCtx(chain=pd.DataFrame([_chain_row("US.PEP260807P145000", 145.0)]))
    client, _ = build(ctx)
    assert client.get("/option-chain?code=US.PEP&option_type=PUT", headers=AUTH).status_code == 200
    assert ctx.chain_calls[0]["option_type"] == "PUT"
    assert client.get("/option-chain?code=US.PEP&option_type=SIDEWAYS", headers=AUTH).status_code == 400


def test_option_chain_refuses_a_window_wider_than_the_vendor_cap_instead_of_truncating():
    """🚨 400（永久），不是截断、也不是 429。

    照 `/kline` 超 8 页那条的先例：429 会被 server 侧 transport 判为 transient 并重试，
    而窗宽是永久事实，重试永远成功不了却一直长得像临时抖动。截断更糟 —— 少掉的到期日
    与「那段没有合约」无法区分。分窗是调用方的事
    （server 侧 `planOptionChainWindows`，同样按含首尾 ≤30 天切）。
    """
    ctx = FakeCtx(chain=pd.DataFrame([_chain_row("US.PEP260807P145000", 145.0)]))
    client, supervisor = build(ctx)

    # 含首尾 31 天
    resp = client.get("/option-chain?code=US.PEP&start=2026-08-01&end=2026-08-31", headers=AUTH)
    assert resp.status_code == 400
    assert resp.json["error"] == "bad_request"
    assert "30" in resp.json["detail"]
    assert ctx.chain_calls == []  # 拒绝，不是截断
    assert supervisor.sessions == 0

    # 边界：含首尾恰好 30 天合法 —— 这正是 server 侧分窗产出的最宽窗，钉死两侧同口径
    ok = client.get("/option-chain?code=US.PEP&start=2026-08-01&end=2026-08-30", headers=AUTH)
    assert ok.status_code == 200
    assert len(ctx.chain_calls) == 1


def test_option_chain_bad_params_rejected_before_touching_opend():
    client, supervisor = build(FakeCtx())
    assert client.get("/option-chain", headers=AUTH).status_code == 400
    assert client.get("/option-chain?code=%20", headers=AUTH).status_code == 400
    assert client.get("/option-chain?code=US.PEP&start=08/01/2026", headers=AUTH).status_code == 400
    reversed_window = client.get(
        "/option-chain?code=US.PEP&start=2026-08-30&end=2026-08-01", headers=AUTH
    )
    assert reversed_window.status_code == 400
    assert supervisor.sessions == 0


def test_option_chain_is_metered_on_the_official_10_per_30s_limit():
    """🚨 `option_chain` 的 **10 次/30s 是官方真值**，不是「没查到就挂最严兜底」。

    2026-08-04 直取 `openapi.futunn.com` 复核，原文「每 30 秒内最多请求 10 次获取期权链
    接口」。与 `history_kline` 那次（有官方 60/30s 却被挂在 10/30s 兜底，08-01 回填事故）
    是**相反方向**的事 —— 谁把它「顺手修正」成 60，这条就红。
    ⇒ 本用例故意用**出厂 LIMITS**（不注入自定义闸）。
    """
    ctx = FakeCtx(chain=pd.DataFrame([_chain_row("US.PEP260807P145000", 145.0)]))
    client, _ = build(ctx)

    for _ in range(10):
        assert client.get("/option-chain?code=US.PEP", headers=AUTH).status_code == 200
    refused = client.get("/option-chain?code=US.PEP", headers=AUTH)

    assert refused.status_code == 429
    assert refused.json["capability"] == "option_chain"
    assert int(refused.headers["Retry-After"]) >= 1
    assert len(ctx.chain_calls) == 10  # 第 11 发在 vendor 前就被拒


def test_option_chain_keeps_every_field_of_a_non_standard_contract():
    """🚨 非标合约（并购等公司行为产生的调整后 root，如 `VICI1`）**照常全字段返回**。

    排除只发生在下游选约层（那里它不可交易）。在 shim 侧滤掉 = 证据没了且**不可回补** ——
    非标 root 的出现本身就是「某只白名单票发生了公司行为」的信号源。
    """
    row = _chain_row(
        "US.VICI1260918P30000",
        30.0,
        name="VICI1 260918 30.00 PUT",
        stock_owner="US.VICI",
        strike_time="2026-09-18",
        expiration_cycle="MONTH",
        option_standard_type="NON_STANDARD",
        option_settlement_mode="AM",
        lot_size=113,
    )
    ctx = FakeCtx(chain=pd.DataFrame([row]))
    client, _ = build(ctx)
    resp = client.get("/option-chain?code=US.VICI", headers=AUTH)

    assert resp.status_code == 200
    assert resp.json["count"] == 1
    assert resp.json["rows"][0] == row  # 一个字段不少、不改名、不解释


GREEK_COLUMNS = (
    "option_implied_volatility",
    "option_delta",
    "option_gamma",
    "option_vega",
    "option_theta",
    "option_rho",
)


def _option_snapshot_row(code, greeks=True, **extra):
    row = {
        "code": code,
        "update_time": "2026-08-04 16:00:00",  # vendor 时间戳，与 envelope 的 as_of 不同物
        "last_price": 2.35,
        "volume": 1204,
        "turnover": 283940.0,
        "bid_price": 2.30,
        "ask_price": 2.40,
        "bid_vol": 45,
        "ask_vol": 60,
        "suspension": False,
        "option_valid": True,
        "option_type": "PUT",
        "strike_time": "2026-08-07",
        "option_strike_price": 145.0,
        "option_contract_size": 100,
        "option_open_interest": 3120,
        "option_net_open_interest": -410,
        "option_premium": 1.62,
        "option_implied_volatility": 21.4,
        "option_delta": -0.31,
        "option_gamma": 0.041,
        "option_vega": 0.092,
        "option_theta": -0.058,
        "option_rho": 0.011,
        "stock_owner": "US.PEP",
    }
    if not greeks:
        row.update({column: None for column in GREEK_COLUMNS})
    row.update(extra)
    return row


def test_option_snapshot_returns_the_whole_batch_in_one_vendor_call():
    """报价 + 全 greeks + IV + OI/净OI + Vol/成交额 + vendor 时间戳，一发一批。

    标的 spot **不是**另取一发：把标的自己的 code 放进同一批 `codes` 即可，它的
    `last_price` 与期权行一起回来，期权行的 `stock_owner` 就是关联键。多一个 code 的成本
    远低于多一次调用，也免得 shim 替调用方决定「谁是标的」。
    """
    ctx = FakeCtx(
        snapshot=pd.DataFrame(
            [
                _option_snapshot_row("US.PEP260807P145000"),
                {
                    "code": "US.PEP",
                    "update_time": "2026-08-04 16:00:00",
                    "last_price": 148.21,
                    "option_valid": False,
                },
            ]
        )
    )
    client, _ = build(ctx)
    resp = client.get("/option-snapshot?codes=US.PEP260807P145000,US.PEP", headers=AUTH)

    assert resp.status_code == 200
    assert ctx.snapshot_calls == [["US.PEP260807P145000", "US.PEP"]]  # 一发，不是两发
    leg, underlying = resp.json["rows"]
    assert (leg["bid_price"], leg["ask_price"], leg["bid_vol"], leg["ask_vol"]) == (
        2.30,
        2.40,
        45,
        60,
    )
    assert (leg["option_open_interest"], leg["option_net_open_interest"]) == (3120, -410)
    assert (leg["volume"], leg["turnover"]) == (1204, 283940.0)
    assert leg["option_delta"] == -0.31 and leg["option_implied_volatility"] == 21.4
    assert leg["update_time"] == "2026-08-04 16:00:00"  # vendor 时间戳原样带出
    assert leg["stock_owner"] == "US.PEP" and underlying["last_price"] == 148.21
    assert resp.json["as_of"].endswith("+00:00")  # 采集时刻，与 update_time 是两回事


def test_option_snapshot_keeps_rows_whose_greeks_block_is_missing_and_flags_them():
    """🚨 greeks 整块缺失的行 **MUST 照常返回**，只是带上完整性标记。

    这是 FR-007「缺 greeks 的腿仍留在表内」的**上游保证** —— 在 shim 侧丢弃，下游连
    「这条腿存在但算不出档」都无从知道。该现象是数学固有的、不是脏数据：实测 227/2150 行，
    其中 99.5% 是深实值腿（bid 跌破内在价值 ⇒ IV 无解 ⇒ 五个 greeks 与 IV 一起没有）。
    """
    ctx = FakeCtx(
        snapshot=pd.DataFrame(
            [
                _option_snapshot_row("US.PEP260807P145000"),
                _option_snapshot_row(
                    "US.PEP260807P190000",  # 深实值腿
                    greeks=False,
                    bid_price=41.30,
                    ask_price=43.10,
                    option_strike_price=190.0,
                ),
            ]
        )
    )
    client, _ = build(ctx)
    resp = client.get(
        "/option-snapshot?codes=US.PEP260807P145000,US.PEP260807P190000", headers=AUTH
    )

    assert resp.json["count"] == 2  # 一行不少
    healthy, incomplete = resp.json["rows"]
    assert healthy["greeks_complete"] is True
    assert incomplete["greeks_complete"] is False
    assert incomplete["option_delta"] is None
    # 报价 / OI 侧照常可用 —— 缺的只是 greeks，不是整行
    assert (incomplete["bid_price"], incomplete["ask_price"]) == (41.30, 43.10)
    assert incomplete["option_open_interest"] == 3120


def test_option_snapshot_marks_a_non_option_row_as_not_applicable():
    ctx = FakeCtx(
        snapshot=pd.DataFrame([{"code": "US.PEP", "last_price": 148.21, "option_valid": False}])
    )
    client, _ = build(ctx)
    resp = client.get("/option-snapshot?codes=US.PEP", headers=AUTH)
    assert resp.json["rows"][0]["greeks_complete"] is None


def test_option_snapshot_refuses_more_codes_than_the_vendor_batch_cap():
    """🚨 400，不是静默切片。丢掉的尾巴在下游读作「那些合约今天没数据」——
    与完整性核对要抓的真缺口无法区分。分批是调用方的事。"""
    ctx = FakeCtx()
    client, supervisor = build(ctx)
    codes = ",".join(f"US.PEP2608{i:04d}" for i in range(401))
    resp = client.get(f"/option-snapshot?codes={codes}", headers=AUTH)

    assert resp.status_code == 400
    assert "400" in resp.json["detail"]
    assert ctx.snapshot_calls == []
    assert supervisor.sessions == 0


def test_option_snapshot_missing_codes_rejected_before_touching_opend():
    client, supervisor = build(FakeCtx())
    assert client.get("/option-snapshot", headers=AUTH).status_code == 400
    assert client.get("/option-snapshot?codes=", headers=AUTH).status_code == 400
    assert client.get("/option-snapshot?codes=%20,%20", headers=AUTH).status_code == 400
    assert supervisor.sessions == 0


def test_option_snapshot_is_metered_on_its_own_official_limit_not_the_fallback():
    gate = RateGate(limits={"snapshot": (1, 30)})
    client, _ = build(FakeCtx(), gate)
    assert client.get("/option-snapshot?codes=US.PEP", headers=AUTH).status_code == 200
    refused = client.get("/option-snapshot?codes=US.PEP", headers=AUTH)
    assert refused.status_code == 429
    assert refused.json["capability"] == "snapshot"
    assert int(refused.headers["Retry-After"]) >= 1


def _earnings_row(security, day, pub_type="BEFORE_MARKET", **extra):
    row = {
        "security": security,
        "name": "PepsiCo",
        "earnings_date": day,
        "earnings_timestamp": f"{day} 07:00:00",
        "pub_type": pub_type,
        "period_text": "Q3 2026",
        "eps_actual": None,
        "eps_predict": 2.31,
        "revenue_actual": None,
        "revenue_predict": 2.4e10,
    }
    row.update(extra)
    return row


def test_earnings_calendar_is_market_wide_and_unfiltered():
    """🚨 市场级接口：一发返**全市场**，不接受任何标的收窄。

    白名单过滤放在下游 —— 在这里滤掉，PIT 三件套（首见 / 改期 / 改期前日期）就只对当前
    白名单成立，日后加票时它的历史无从回补。`filter_list` 恒不传是同一件事。
    """
    ctx = FakeCtx(
        earnings=pd.DataFrame(
            [_earnings_row("US.PEP", "2026-08-06"), _earnings_row("US.NOBODY", "2026-08-07")]
        )
    )
    client, _ = build(ctx)
    resp = client.get("/earnings-calendar?market=US&start=2026-08-04&end=2026-08-10", headers=AUTH)

    assert resp.status_code == 200
    call = ctx.earnings_calls[0]
    assert (call["market"], call["begin_date"], call["end_date"]) == (
        "US",
        "2026-08-04",
        "2026-08-10",
    )
    assert call["filter_list"] is None
    assert [r["security"] for r in resp.json["rows"]] == ["US.PEP", "US.NOBODY"]
    assert resp.json["rows"][0]["pub_type"] == "BEFORE_MARKET"
    assert resp.json["rows"][0]["eps_actual"] is None  # 未公布 = None, 不是 0


def test_earnings_calendar_refuses_a_window_wider_than_the_vendor_cap():
    """官方原文「与 beginDate 间隔不超过 7 天」= **含首尾的 7 天窗** = 端点差 ≤ 6
    （2026-08-08 真端实测：差 6 → 200、差 7 → vendor 502，US 3/3 + HK 一致）。
    超窗 400（永久），不截断 —— 悄悄被裁掉的那几天在下游读作「那几天全市场没有财报」。"""
    ctx = FakeCtx(earnings=pd.DataFrame([_earnings_row("US.PEP", "2026-08-06")]))
    client, supervisor = build(ctx)

    # 端点差 7：**曾经在这里被放行**，于是漏到 vendor 变 502（且 502 会被读成瞬时错误反复重试，
    # 永远不以「参数错」的形状说出来）。现在它必须死在本闸门上。
    resp = client.get("/earnings-calendar?market=US&start=2026-08-04&end=2026-08-11", headers=AUTH)
    assert resp.status_code == 400
    assert resp.json["error"] == "bad_request"
    assert "cap of 6 days" in resp.json["detail"]
    assert ctx.earnings_calls == []
    assert supervisor.sessions == 0

    # 边界：端点差恰好 6 合法
    ok = client.get("/earnings-calendar?market=US&start=2026-08-04&end=2026-08-10", headers=AUTH)
    assert ok.status_code == 200
    assert len(ctx.earnings_calls) == 1


def test_earnings_calendar_bad_params_rejected_before_touching_opend():
    client, supervisor = build(FakeCtx())
    assert client.get("/earnings-calendar", headers=AUTH).status_code == 400
    assert client.get("/earnings-calendar?market=MARS", headers=AUTH).status_code == 400
    assert client.get("/earnings-calendar?market=US&start=08/04/2026", headers=AUTH).status_code == 400
    reversed_window = client.get(
        "/earnings-calendar?market=US&start=2026-08-11&end=2026-08-04", headers=AUTH
    )
    assert reversed_window.status_code == 400
    # `end` 单给：起点由 vendor 取「今天」，跨度就无从校验 —— 宁可 400 也不放一个
    # 可能被悄悄裁掉的窗过去。
    end_only = client.get("/earnings-calendar?market=US&end=2026-08-11", headers=AUTH)
    assert end_only.status_code == 400
    assert supervisor.sessions == 0


def test_earnings_calendar_omitted_window_is_left_to_the_sdk_default():
    """两侧都不给 = vendor 默认「仅当天」，这是合法且够窄的用法。"""
    ctx = FakeCtx(earnings=pd.DataFrame([_earnings_row("US.PEP", "2026-08-04")]))
    client, _ = build(ctx)
    assert client.get("/earnings-calendar?market=US", headers=AUTH).status_code == 200
    assert (ctx.earnings_calls[0]["begin_date"], ctx.earnings_calls[0]["end_date"]) == (None, None)


def test_earnings_calendar_is_metered_under_its_own_capability():
    gate = RateGate(limits={"earnings_calendar": (1, 30)})
    client, _ = build(FakeCtx(), gate)
    assert client.get("/earnings-calendar?market=US", headers=AUTH).status_code == 200
    refused = client.get("/earnings-calendar?market=US", headers=AUTH)
    assert refused.status_code == 429
    assert refused.json["capability"] == "earnings_calendar"
    assert int(refused.headers["Retry-After"]) >= 1


def test_earnings_calendar_default_gate_admits_the_official_sixty_per_window():
    """🚨 走**默认 gate**（不注入档位）⇒ 量的是真 `LIMITS` 表: 官方 60/30 s。

    补登前该 capability 不在表内、落兜底 10/30 s, 这条会在第 11 发就 429。前一条测试
    (`..._is_metered_under_its_own_capability`) 注入了自定义档位, 因此**照不到**这个差别 ——
    默认档位的守卫必须由本条来出。
    """
    ctx = FakeCtx(earnings=pd.DataFrame([_earnings_row("US.PEP", "2026-08-04")]))
    client, _ = build(ctx)
    for shot in range(1, 61):
        resp = client.get("/earnings-calendar?market=US", headers=AUTH)
        assert resp.status_code == 200, f"第 {shot} 发就被拒 = 档位不是官方 60/30 s"
    refused = client.get("/earnings-calendar?market=US", headers=AUTH)
    assert refused.status_code == 429
    assert refused.json["capability"] == "earnings_calendar"
    assert int(refused.headers["Retry-After"]) >= 1


def test_unsupported_market_is_rejected_before_touching_opend():
    client, supervisor = build(FakeCtx())
    resp = client.get("/universe?market=MARS", headers=AUTH)
    assert resp.status_code == 400
    assert "unsupported" in resp.json["detail"]
    assert supervisor.sessions == 0


def test_missing_market_is_rejected():
    client, _ = build(FakeCtx())
    assert client.get("/universe", headers=AUTH).status_code == 400


def test_rate_limited_returns_429_with_retry_after():
    gate = RateGate(limits={"trading_days": (1, 30)})
    client, _ = build(FakeCtx(trading_days=[]), gate)
    assert client.get("/trading-days?market=US", headers=AUTH).status_code == 200
    resp = client.get("/trading-days?market=US", headers=AUTH)
    assert resp.status_code == 429
    assert resp.json["capability"] == "trading_days"
    assert int(resp.headers["Retry-After"]) >= 1


def test_vendor_error_surfaces_as_502_not_a_success_with_empty_rows():
    """A failed vendor call must never look like 'no data' — that is exactly how
    a silent stall gets mistaken for an empty market."""
    client, _ = build(FakeCtx(ret=-1))
    resp = client.get("/trading-days?market=US", headers=AUTH)
    assert resp.status_code == 502
    assert resp.json["error"] == "vendor_error"


def test_healthz_reports_deployed_version(tmp_path):
    """部署后自检的判据: 「跑着的 SHA == 刚部署的 SHA」。缺了它, 静默回退无法被发现
    (2026-08-01 实测过一次: /kline 被落后分支的部署抹掉, 故障隔了好几层才显形)。"""
    from futu_shim import app as app_module

    stamp = tmp_path / "VERSION"
    stamp.write_text("deadbeefcafe\n", encoding="utf-8")
    assert app_module.read_version(stamp) == "deadbeefcafe"

    client, _ = build(FakeCtx())
    body = client.get("/healthz").json  # public, 无鉴权
    assert "version" in body, "healthz 必须带 version, 否则部署自检没有判据"


def test_version_missing_reads_unknown_not_crash(tmp_path):
    """版本戳缺失**不是**存活条件 —— 探针不该因此变红; 但也不得伪装成某个具体版本。
    `unknown` 是刺眼且能被自检判死的值。"""
    from futu_shim import app as app_module

    assert app_module.read_version(tmp_path / "does-not-exist") == "unknown"
    empty = tmp_path / "VERSION"
    empty.write_text("   \n", encoding="utf-8")
    assert app_module.read_version(empty) == "unknown"


def _bulky_snapshot(rows: int = 200) -> pd.DataFrame:
    """形状照着真快照来: 列多、且绝大多数是同一个 `N/A` 哨兵。

    真行是 143 列 / 约 3.7 KB, 其中只有约 54 列非空 —— 重复键叠重复哨兵正是 DEFLATE
    的理想形态 (真实 285 行响应实测 976 KB → 34.5 KB)。这里只要越过 `GZIP_MIN_BYTES`
    并保住那个形状即可, 不必复刻全部 143 列。
    """
    return pd.DataFrame(
        [
            {
                "code": f"US.PEP260821P{i:06d}",
                "option_valid": True,
                "last_price": 1.23,
                **{f"wrt_{n}": "N/A" for n in range(20)},
            }
            for i in range(rows)
        ]
    )


def test_responses_are_untouched_without_accept_encoding():
    """压缩是**协商**出来的, 不是强加的 —— 这条是「纯加法」这个说法的兑现处。

    不声明 gzip 的客户端拿到的字节必须与本 hook 存在之前一模一样。它守的是既有 EOD
    采集路径: 那条路径一旦被静默改变编码, 症状会出现在下游解析而不是这里。
    """
    client, _ = build(FakeCtx(snapshot=_bulky_snapshot()))
    resp = client.get("/option-snapshot?codes=US.AAA", headers=AUTH)

    assert resp.status_code == 200
    assert "Content-Encoding" not in resp.headers
    assert len(resp.data) > GZIP_MIN_BYTES, "样本没越过阈值, 这条测试会恒真"
    # Vary 无条件带上 —— 没压也要带, 否则共享缓存会把压过的体喂给没要过的客户端。
    assert "Accept-Encoding" in resp.headers["Vary"]


def test_large_responses_are_gzipped_when_the_client_asks():
    """协商命中时压, 且解压回来与不压时**逐行等价**。

    比 `rows` 而不比整个 body: envelope 的 `as_of` 是采集时刻, 两次请求本就不同 ——
    拿它比会得到一条为了绿而绿的断言。
    """
    client, _ = build(FakeCtx(snapshot=_bulky_snapshot()))
    plain = client.get("/option-snapshot?codes=US.AAA", headers=AUTH).data
    resp = client.get(
        "/option-snapshot?codes=US.AAA", headers={**AUTH, "Accept-Encoding": "gzip"}
    )

    assert resp.status_code == 200
    assert resp.headers["Content-Encoding"] == "gzip"
    assert resp.headers["Content-Length"] == str(len(resp.data))
    assert json.loads(gzip.decompress(resp.data))["rows"] == json.loads(plain)["rows"]
    assert len(resp.data) < len(plain)


def test_small_responses_stay_uncompressed_even_when_asked():
    """一个 MTU 以内的体压了也是一个来回, 白费 CPU 且可能变大。/healthz (约 430 B)
    是探针路径, 每次部署自检都要打, 更没有理由为它做无用功。"""
    client, _ = build(FakeCtx())
    resp = client.get("/healthz", headers={"Accept-Encoding": "gzip"})

    assert resp.status_code == 200
    assert len(resp.data) < GZIP_MIN_BYTES
    assert "Content-Encoding" not in resp.headers
