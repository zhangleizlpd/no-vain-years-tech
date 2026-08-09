import pytest

from futu_shim.ratelimit import FALLBACK_LIMIT, LIMITS, RateGate, RateLimitExceeded


class FakeClock:
    """Injected clock so window behaviour is tested without sleeping."""

    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


def test_allows_calls_up_to_the_limit():
    clock = FakeClock()
    gate = RateGate(limits={"cap": (3, 30)}, clock=clock)
    for _ in range(3):
        gate.check("cap")


def test_blocks_the_call_that_would_exceed_the_window():
    clock = FakeClock()
    gate = RateGate(limits={"cap": (3, 30)}, clock=clock)
    for _ in range(3):
        gate.check("cap")
    with pytest.raises(RateLimitExceeded) as excinfo:
        gate.check("cap")
    assert excinfo.value.capability == "cap"
    assert excinfo.value.retry_after_s == pytest.approx(30.0)


def test_window_slides_so_capacity_returns():
    clock = FakeClock()
    gate = RateGate(limits={"cap": (2, 30)}, clock=clock)
    gate.check("cap")
    clock.advance(10)
    gate.check("cap")
    with pytest.raises(RateLimitExceeded):
        gate.check("cap")

    clock.advance(21)  # first stamp (t=1000) now outside the 30s window
    gate.check("cap")
    with pytest.raises(RateLimitExceeded):
        gate.check("cap")  # second stamp (t=1010) still inside


def test_retry_after_reflects_time_until_oldest_stamp_expires():
    clock = FakeClock()
    gate = RateGate(limits={"cap": (1, 30)}, clock=clock)
    gate.check("cap")
    clock.advance(12)
    with pytest.raises(RateLimitExceeded) as excinfo:
        gate.check("cap")
    assert excinfo.value.retry_after_s == pytest.approx(18.0)


def test_capabilities_are_metered_independently():
    clock = FakeClock()
    gate = RateGate(limits={"a": (1, 30), "b": (1, 30)}, clock=clock)
    gate.check("a")
    gate.check("b")  # must not be charged against "a"
    with pytest.raises(RateLimitExceeded):
        gate.check("a")


def test_unknown_capability_falls_back_to_strictest_limit():
    """A capability nobody registered must not ship ungated — it inherits the
    tightest known window instead of running free."""
    clock = FakeClock()
    gate = RateGate(clock=clock)
    assert gate.limit_for("never_registered") == (10, 30)
    for _ in range(10):
        gate.check("never_registered")
    with pytest.raises(RateLimitExceeded):
        gate.check("never_registered")


def test_shipped_limits_match_the_measured_evidence():
    """Guards the E9 values against a careless edit."""
    assert LIMITS["option_chain"] == (10, 30)
    assert LIMITS["trading_days"] == (30, 30)
    assert LIMITS["option_quote"] == (120, 30)
    # 官方 60/30s (2026-08-01 复核)。**不得为"保守"调低**: 每票 10 年 = 3 页, 调低会让
    # 多票回填在中途 429 并连坐 server 侧熔断 —— 这正是它当初落在 fallback 上时出的事。
    assert LIMITS["history_kline"] == (60, 30)


def test_option_underlying_capabilities_have_their_own_profile_not_the_fallback():
    """🚨 `/overview` 与 `/his-vol` 的官方值各是 60/30s (E9)。把它们留在最严兜底
    (10/30s) 上就是 `history_kline` 08-01 那次事故的复刻: 兜底不是"保守", 它是**没查
    文档**的默认值, 而代价由回填在中途 429 + server 侧熔断连坐来付。
    """
    assert LIMITS["underlying_overview"] == (60, 30)
    assert LIMITS["his_volatility"] == (60, 30)
    assert LIMITS["underlying_overview"] != FALLBACK_LIMIT
    assert LIMITS["his_volatility"] != FALLBACK_LIMIT
    # 路由拿到的必须是这条 profile 本身, 不是查表未命中后的兜底
    gate = RateGate()
    assert gate.limit_for("underlying_overview") == (60, 30)
    assert gate.limit_for("his_volatility") == (60, 30)


def test_earnings_calendar_uses_its_official_limit_not_the_strict_fallback():
    """官方原文 (2026-08-04 直取 `openapi.futunn.com` 复核):「接口限制：30 秒内最多 60 次
    请求；分页请求仅首页计入限频统计」。

    补登前它不在 LIMITS 内 ⇒ 落兜底 10/30 s = **6x 偏严**, 与 `history_kline` 08-01 那次
    是同形状、反方向的同一个病灶: 有官方值却挂兜底。兜底是"没查文档"的默认值, 不是"保守"。
    """
    assert LIMITS["earnings_calendar"] == (60, 30)
    assert LIMITS["earnings_calendar"] != FALLBACK_LIMIT
    # 路由拿到的必须是这条 profile 本身, 不是查表未命中后的兜底
    assert RateGate().limit_for("earnings_calendar") == (60, 30)
