"""Hard per-capability rate gate.

Values come from p3b E9 (Futu's documented per-endpoint limits, cross-checked
page by page 2026-07-29). The gate lives here — not in the server — because the
shim is the only chokepoint every caller must pass through.

Two deliberate design choices:

1. **Reject, don't queue.** Exceeding a window raises, and the route turns that
   into 429 + `Retry-After`. Queueing would make the shim stateful and would
   hide backpressure from the server-side sync framework, which already owns
   retry/backoff/circuit-breaking.
2. **Unknown capability -> strictest known limit.** A capability absent from
   `LIMITS` falls back to the tightest window we know of, so a newly added
   endpoint can never accidentally ship ungated.
"""

from __future__ import annotations

import threading
import time
from collections import deque
from collections.abc import Callable, Mapping

# capability -> (max_calls, window_seconds). Source: p3b E9.
LIMITS: dict[str, tuple[int, int]] = {
    "option_chain": (10, 30),
    "snapshot": (60, 30),
    "expiration_date": (60, 30),
    "underlying_overview": (60, 30),
    "his_volatility": (60, 30),
    "trading_days": (30, 30),
    "option_quote": (120, 30),
    # 官方原文 (2026-08-01 复核, futunn + moomoo 两个镜像逐字一致):
    #   「每 30 秒内最多请求 60 次历史 K 线接口。注意：如果您是分页获取数据，
    #     此限频规则仅适用于每只股票的首页，后续页请求不受限频规则的限制。」
    # 分页豁免不是本表能表达的 → 由 `/kline` 路由只对首页 `check()` 落实 (见 app.py)。
    "history_kline": (60, 30),
    # 官方原文 (2026-08-04 直取 openapi.futunn.com 的 get_earnings_calendar 页复核):
    #   「接口限制：30 秒内最多 60 次请求；分页请求仅首页计入限频统计。」
    # 该 capability 此前不在本表内 ⇒ 落兜底 10/30 s = 官方值的 6 分之一, 与 `history_kline`
    # 08-01 那次是同形状、反方向的同一个病灶 (有官方值却挂兜底)。反方向意味着代价不同:
    # 偏严只让调用方吃 429 (server 侧映射 budgetExhausted 延迟重入队、不耗 attempts, 数据不丢
    # 只是慢), 不像 08-01 那样叠加逐页计数把回填打断 —— 但"没查文档的默认值"这个病灶同一个。
    # 分页豁免同样不是本表能表达的; 财报日历按 ≤7 天窗 (含首尾, 即**端点差 ≤6**, 见
    # `EARNINGS_MAX_SPAN_DAYS`) 逐窗单发调用, 当前无分页路径要豁免。
    "earnings_calendar": (60, 30),
    # `get_global_state` (/market-state) —— **兜底最严档, 且是「查过、确实没有」而不是
    # 「没查」**。2026-08-17 直取 openapi.futunn.com 的 get-global-state 页: 全页没有
    # 「接口限制」小节, 而该站的规矩是「每个接口的限频规则会有不同, 具体请参见每个接口
    # 页面下面的接口限制」(intro/authority.html) ⇒ 官方从未就这个接口给过数。同类先例是
    # `stock_basicinfo` (见 FALLBACK_LIMIT 注释块), 区别只在那条没有消费方要断言它的桶。
    #
    # 显式登记而不是留给查表未命中: 让"落兜底"这件事有个可读的落脚点, 否则下一个人会
    # 把它当成又一处「忘了查文档」(history_kline 08-01 那次的形状) 而顺手调宽。
    # ⚠️ 真值哪天出现就改这里, **别做等价换算** —— 本表已因等价换算踩过一次 prod 事故。
    #
    # 用量: 盘中投影 tick 每 30 秒打 1 次 ⇒ 兜底档 10 次/30 s 仍有 10 倍余量, 这个数
    # 松紧与否对本片没有任何可观测差别。
    "global_state": (10, 30),
}

# Strictest limit in LIMITS. Applied to anything not listed above.
#
# One capability lands here on purpose, because its official per-window limit is
# genuinely undocumented rather than because we forgot to look:
#
# * `stock_basicinfo` (/universe) — checked the endpoint's doc page, the SDK
#   docstring, and a web search on 2026-07-31; none state one. Universe sync
#   runs ~2 calls/day, so the strict bucket costs nothing.
#
# 🚨 `history_kline` used to land here too, and that was a **research miss, not
# an absent limit**: its own doc page states 60/30s (now in LIMITS above,
# verified 2026-08-01 on both official mirrors). The cost of that miss was not
# theoretical — a 10-year backfill of 7 securities needs 3 pages each, and the
# 6x-too-strict fallback plus per-page metering turned that into a 429 on the
# third security, which then tripped the server-side ConsecutiveBreaker and
# failed the remaining four (prod 2026-08-01, `SyncRun` partial ok=2 fail=5).
# **Before parking a capability on the fallback, read its own doc page** — the
# per-interface limit lives there, never on the shared authority page.
#
# ⚠️ Rate limit and quota are two separate meters, do not conflate them. The
# quota is charged per **security per rolling window** (official: released after
# 7 days), not per call: measured 2026-07-31, querying a security absent from
# the window moved used 8 -> 9, and an immediate re-query of the same security
# moved nothing. So paginating one security over several calls costs one quota
# slot, while the calls themselves are what this gate meters.
#
# Replace with the real value if it ever surfaces.
FALLBACK_LIMIT: tuple[int, int] = (10, 30)


class RateLimitExceeded(Exception):
    """Raised instead of blocking, so the route can answer 429 immediately."""

    def __init__(self, capability: str, retry_after_s: float) -> None:
        super().__init__(f"rate limit exceeded for capability {capability!r}")
        self.capability = capability
        self.retry_after_s = retry_after_s


class RateGate:
    """Sliding-window counter per capability.

    Complexity: O(1) amortised per `check` — each timestamp is appended once and
    popped once, so the while-loop cost is amortised constant. Memory is
    O(sum of max_calls) = a few hundred floats.
    """

    def __init__(
        self,
        limits: Mapping[str, tuple[int, int]] | None = None,
        fallback: tuple[int, int] = FALLBACK_LIMIT,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._limits = dict(LIMITS if limits is None else limits)
        self._fallback = fallback
        self._clock = clock
        self._calls: dict[str, deque[float]] = {}
        self._lock = threading.Lock()

    def limit_for(self, capability: str) -> tuple[int, int]:
        return self._limits.get(capability, self._fallback)

    def check(self, capability: str) -> None:
        """Record one call against `capability`, or raise `RateLimitExceeded`."""
        max_calls, window_s = self.limit_for(capability)
        now = self._clock()
        with self._lock:
            stamps = self._calls.setdefault(capability, deque())
            cutoff = now - window_s
            while stamps and stamps[0] <= cutoff:
                stamps.popleft()
            if len(stamps) >= max_calls:
                oldest = stamps[0]
                raise RateLimitExceeded(capability, max(oldest + window_s - now, 0.0))
            stamps.append(now)
