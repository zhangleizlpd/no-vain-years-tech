"""Read-only trade-query surface: the long-lived `OpenSecTradeContext` (082 D2).

🚨 **Read-only, structurally.** This module queries accounts / positions / deals /
orders and, since 084, *receives* the broker's order / deal pushes — and nothing
else; `tests/test_readonly_guard.py` fails the build if any order-placing or
unlocking call name appears under `src/`. Subscribing takes no trade unlock
(084 FR-002): the handlers are mounted on the same long-lived context the queries
use, and they only read what arrives.

**The push path re-does the query path's cleanup, deliberately** (084 D2). Pushes
arrive on the SDK's receive thread and never pass through `call()`, so neither
`_strip_account_ids` nor `_ids_as_digit_strings` applies to them; each is rebuilt
in `push_frame_to_events`. Both routes must emit the same shape for the same
column, otherwise the server has to parse per origin.

🚨 **`acc_id` never leaves this process.** It is needed in memory to address the
queries, and nowhere else: every row handed back is stripped of the `acc_id` key
unconditionally (the SDK's position / deal / order frames carry that column), and
vendor error text is scrubbed of known account ids before it can reach a
response body or a log line.

**Why every call is bounded twice** (plan 082 D2 / D13). The shim is one waitress
process with `threads=4` shared with the quote routes, and a dead gateway makes
SDK calls block rather than fail (the 2026-08-01 incident, see `opend.py`
`status()`). So:

1. **Deadline** — the SDK call runs on a daemon thread we stop waiting on after
   `FUTU_TRADE_CALL_TIMEOUT_S`; the context is then discarded so no later call
   queues behind the same dead handle.
2. **Concurrency cap** — at most `max_concurrency` (2) trade calls at once, taken
   **non-blocking**: a caller that would wait keeps a waitress thread hostage just
   the same, so the cap would limit nothing. Over the cap ⇒ `TradeBusy` at once.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any

from futu import (
    RET_OK,
    OpenSecTradeContext,
    TradeDealHandlerBase,
    TradeOrderHandlerBase,
    TrdAccStatus,
    TrdEnv,
    TrdMarket,
)
from futu.common.err import Err

from . import config, mappers
from .opend import OpenDSupervisor, OpenDUnavailable
from .trade_events import TradeEventBuffer

log = logging.getLogger(__name__)

#: Markets an account must be authorised for to be the sync target (FR-003).
SYNC_MARKETS = frozenset({TrdMarket.HK, TrdMarket.US})

# EVIDENCE: the SDK reports a dead connection as ret != RET_OK with exactly these
# texts —— futu 10.08.6808 `futu/common/err.py:15-19`, returned from
# `common/network_manager.py:305-307` and `common/open_context_base.py:294`.
_CONNECTION_ERROR_TEXTS = frozenset(
    {Err.ConnectionLost.text, Err.NotConnected.text, Err.ConnectionClosed.text}
)


class TradeBusy(RuntimeError):
    """The concurrency cap is full; rejected without waiting."""


class TradeTimeout(RuntimeError):
    """A trade SDK call did not return within the deadline."""


class TradeVendorError(RuntimeError):
    """The SDK raised or returned ret != RET_OK. Message is already redacted."""


class AccountSelectionError(RuntimeError):
    """Not exactly one account qualifies as the sync target (FR-003)."""

    def __init__(self, matched: int) -> None:
        super().__init__(f"account selection matched {matched} accounts, expected exactly 1")
        self.matched = matched


def _default_ctx_factory() -> OpenSecTradeContext:
    # `filter_trdmarket=NONE`: one context sees HK and US accounts alike; the
    # market is chosen per query instead.
    return OpenSecTradeContext(
        filter_trdmarket=TrdMarket.NONE, host=config.opend_host(), port=config.opend_port()
    )


def _strip_account_ids(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    for record in records:
        record.pop("acc_id", None)
    return records


#: JS `Number.MAX_SAFE_INTEGER`: the largest integer a JSON consumer's `JSON.parse` keeps exact.
_MAX_SAFE_INTEGER = 2**53 - 1

#: Id columns emitted as digit strings whatever their size, so one column never mixes int and str.
_ID_FIELDS = frozenset({"deal_id"})


def _ids_as_digit_strings(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """`deal_id`, and any int cell with `abs > 2**53 - 1` (e.g. `position_id`), -> `str`, in place.

    A rounded id is worse than a missing one: two distinct deals can collapse onto
    one unique key and the second is silently skipped as a duplicate. The server
    adapter therefore refuses unsafe JSON numbers and accepts digit strings.
    Small ints (qty-like) and floats keep their type. Trade rows only: the quote
    routes do not pass through here, `mappers.clean_value` is untouched.

    EVIDENCE: 维护者 2026-09-13 082 POC-1 原始输出 —— 成交行的 `deal_id` 全为 17–19 位 int，
    且全部大于 2^53−1（同批 `order_id` 由 SDK 直接给 18 位字符串）。2026-09-14 082 prod 首次全量
    回填因此失败：`[futu] trade/deals us 2024-09-01..2024-11-30 行缺可用的 deal_id`；同日维护者只读
    探针 `/trade/deals?market=US&start=2024-09-01&end=2024-11-30` 返回行的 `deal_id` 全为 int。

    `/trade/deals` merges today + history rows and de-dupes by `deal_id`; both sides
    come through `TradeSupervisor.call`, so the key has the same type on both sides.
    Complexity O(rows × columns).
    """
    for record in records:
        for key, value in record.items():
            if not isinstance(value, int) or isinstance(value, bool):
                continue
            if key in _ID_FIELDS or abs(value) > _MAX_SAFE_INTEGER:
                record[key] = str(value)
    return records


# ── 推送事件的映射（084 D2）──────────────────────────────────────────────────


def _push_cell(key: str, value: Any) -> Any:
    """One push cell -> JSON-safe, with the id-width rule re-applied.

    `mappers.clean_value` covers the numpy / NaN side; the digit-string rule is
    repeated here because the push path never reaches `_ids_as_digit_strings`.
    Small ints (qty-like) and floats keep their type — see that function for why
    a rounded id is worse than a missing one.
    """
    cleaned = mappers.clean_value(value)
    if isinstance(cleaned, int) and not isinstance(cleaned, bool):
        if key in _ID_FIELDS or abs(cleaned) > _MAX_SAFE_INTEGER:
            return str(cleaned)
    return cleaned


def _leg_to_fields(leg: Any) -> dict[str, Any]:
    """One combo leg -> a structured dict of `code` / `trd_side` / `qty_ratio` / `position_id`.

    EVIDENCE: the four attributes are the vendor's documented leg fields —— 官方
    ComboLeg 字段表 `openapi.futunn.com/futu-api-doc/trade/place-combo-order.html`
    （2026-09-16 核对）；SDK 侧对应 `futu.common.constant.ComboLeg`（`:367`），推送帧里
    的腿正是 `OrderListQuery.ParseComboLegs`（`futu/trade/trade_query.py:394-403`）
    构造的该对象列表。

    🚫 **Never `mappers.clean_value` for the leg list.** Its last line is
    `return str(value)` (`mappers.py:52`), which flattens the whole list into a repr
    string; the server's leg parser only accepts text elements and answers an object
    with an empty list, so a combo order's underlying attribution would vanish with
    nothing raising (084 FR-020).
    """
    code = getattr(leg, "code", None)
    return {
        # 兜底（形态未观测到，仅防丢数据）：腿若不是对象而是裸代码文本，至少保住代码。
        "code": code if code is not None else (leg if isinstance(leg, str) else None),
        "trd_side": _push_cell("trd_side", getattr(leg, "trd_side", None)),
        "qty_ratio": _push_cell("qty_ratio", getattr(leg, "qty_ratio", None)),
        "position_id": _push_cell("position_id", getattr(leg, "position_id", None)),
    }


def _expand_combo_legs(value: Any) -> list[dict[str, Any]]:
    """The `combo_legs` cell -> structured legs. Absent / NaN / non-sequence -> `[]`."""
    if not isinstance(value, (list, tuple)):
        return []
    return [_leg_to_fields(leg) for leg in value]


def push_frame_to_events(frame: Any, *, event_type: str) -> list[dict[str, Any]]:
    """An SDK push frame (a one-row DataFrame) -> rows fit for the event buffer.

    `event_type` (`"order"` / `"deal"`) is carried explicitly because the two push
    kinds have **different column sets** (the SDK's own lists live in
    `futu/trade/trade_response_handler.py:16-22` and `:37-41`); the consumer routes
    on it instead of guessing from which fields happen to be present.

    Three things this does that the query path does elsewhere:

    1. **`acc_id` dropped unconditionally** (FR-019). 维护者 2026-09-13 采集的推送样本
       （2026-09-16 分析）里没有这个字段 —— 剔除仍无条件做，因为把正确性押在 vendor
       现在不发某字段上，是在赌对方的实现细节。
    2. **`combo_legs` expanded** into structured legs (FR-020), see `_leg_to_fields`.
    3. **`deal_id` always a digit string**, and so is any int cell with
       `abs > 2**53 - 1` (FR-021). ⚠️ EVIDENCE: 券商官方接口文档把成交号声明为字符串，
       **与实拉样本不符** —— 样本里它是 17–19 位 int（维护者 2026-09-13 082 POC-1 原始
       输出），082 首次上线失败正源于按文档类型写实现 ⇒ 依据取实拉样本，不取文档声明。

    Market columns keep their own vendor names: a push carries `trd_market`, a
    history order query carries `order_market` (FR-015). 🚫 No renaming here —— the
    shim translates, it does not interpret (see `mappers`); the server maps both onto
    one market value.

    Complexity O(rows × columns).
    """
    if frame is None or len(frame) == 0:
        return []
    events: list[dict[str, Any]] = []
    for record in frame.to_dict(orient="records"):
        record.pop("acc_id", None)
        has_legs = "combo_legs" in record
        legs = record.pop("combo_legs", None)
        event = {str(key): _push_cell(str(key), value) for key, value in record.items()}
        if has_legs:
            event["combo_legs"] = _expand_combo_legs(legs)
        event["event_type"] = event_type
        events.append(event)
    return events


class _TradePushHandler:
    """Shared half of both push handlers: map the frame, append it, never raise.

    🚨 **Never raises.** The callback runs on the SDK's own receive thread, where an
    exception has no caller to reach and no visible exit — one malformed frame would
    stop the push channel with nothing saying so. A rejected or unmappable frame is
    logged and dropped instead, and the resulting sequence gap is what the server
    turns into gap compensation.

    🚨 Log lines carry neither the account id nor any order / deal detail (084 D10).
    """

    _EVENT_TYPE = ""

    def __init__(self, buffer: TradeEventBuffer) -> None:
        super().__init__()
        self._buffer = buffer

    def on_recv_rsp(self, rsp_pb: Any) -> tuple[int, Any]:
        ret, data = super().on_recv_rsp(rsp_pb)  # type: ignore[misc]
        if ret != RET_OK:
            log.warning("%s push frame rejected by the SDK", self._EVENT_TYPE)
            return ret, data
        try:
            for row in push_frame_to_events(data, event_type=self._EVENT_TYPE):
                self._buffer.append(row)
        except Exception as exc:  # noqa: BLE001 - a callback thread has nowhere to raise to
            log.warning("%s push mapping failed: %s", self._EVENT_TYPE, type(exc).__name__)
        return ret, data


class TradeOrderPushHandler(_TradePushHandler, TradeOrderHandlerBase):
    """Order pushes -> event buffer. Read-only: subscribing needs no trade unlock (FR-002)."""

    _EVENT_TYPE = "order"


class TradeDealPushHandler(_TradePushHandler, TradeDealHandlerBase):
    """Deal pushes -> event buffer. Read-only: subscribing needs no trade unlock (FR-002)."""

    _EVENT_TYPE = "deal"


def select_account(accounts: list[dict[str, Any]]) -> dict[str, Any]:
    """The unique `REAL ∧ ACTIVE ∧ trdmarket_auth ∩ {HK, US} ≠ ∅` account.

    EVIDENCE: 维护者 2026-09-13 POC-1 实跑 `get_acc_list` 原始输出 —— 实盘、模拟、停用与基金户并存；
    `acc_type` 值域只有 `MARGIN` / `CASH`（没有可判的基金值，故**不按 `acc_type` 写条件**）；
    基金户的 `trdmarket_auth` 只含 `HKFUND` 或 `USFUND`，对其查持仓返回「基金账户
    不支持查询持仓」⇒ 基金户由权限字段自然排除。

    🚨 Match count != 1 is an error, never "take the first": with two candidates
    there is no rule telling which one is the owner's real account, and syncing the
    wrong one would look exactly like a correct sync.
    """
    matched = [
        account
        for account in accounts
        if account.get("trd_env") == TrdEnv.REAL
        and account.get("acc_status") == TrdAccStatus.ACTIVE
        and SYNC_MARKETS.intersection(account.get("trdmarket_auth") or ())
    ]
    if len(matched) != 1:
        raise AccountSelectionError(matched=len(matched))
    return matched[0]


class TradeSupervisor:
    def __init__(
        self,
        opend_supervisor: OpenDSupervisor,
        timeout_s: float | None = None,
        max_concurrency: int = 2,
        ctx_factory: Callable[[], Any] = _default_ctx_factory,
        event_buffer: TradeEventBuffer | None = None,
    ) -> None:
        self._opend = opend_supervisor
        self._timeout_s = config.trade_call_timeout_s() if timeout_s is None else timeout_s
        self._slots = threading.BoundedSemaphore(max_concurrency)
        self._ctx_factory = ctx_factory
        self._lock = threading.Lock()
        self._ctx: Any = None
        self._account: dict[str, Any] | None = None
        self._known_acc_ids: set[str] = set()
        self._events = TradeEventBuffer() if event_buffer is None else event_buffer

    # ---- public API ----------------------------------------------------

    @property
    def events(self) -> TradeEventBuffer:
        """The push-event ring buffer `GET /trade/events` serves from (084 D1).

        Owned by the supervisor, not by the context: a context rebuild must not take
        buffered events with it, or the consumer's cursor would point past the end
        and the loss would be invisible.
        """
        return self._events

    def call(self, fn: Callable[..., tuple[int, Any]], **kwargs: Any) -> list[dict[str, Any]]:
        """Run `fn(ctx, **kwargs)` under the deadline and the cap; rows minus `acc_id`,
        id-like integers as digit strings (`_ids_as_digit_strings`).

        `fn` is a callable rather than a method name on purpose: the call site then
        spells the SDK method as an attribute, which the read-only AST guard can see.
        """
        return _ids_as_digit_strings(
            _strip_account_ids(mappers.dataframe_to_records(self._invoke(fn, **kwargs)))
        )

    def selected_account(self) -> dict[str, Any]:
        """The sync-target account row (incl. `acc_id`, for in-process use only).

        Cached per context: a rebuilt context re-selects.
        """
        with self._lock:
            if self._account is not None:
                return self._account
        frame = self._invoke(lambda ctx: ctx.get_acc_list())
        # Raw records, not `mappers.dataframe_to_records`: that stringifies list
        # cells, and `trdmarket_auth` is a list the selection has to intersect.
        accounts = frame.to_dict(orient="records") if frame is not None else []
        with self._lock:
            self._known_acc_ids.update(str(a["acc_id"]) for a in accounts if a.get("acc_id"))
        account = dict(select_account(accounts))
        account["acc_id"] = int(account["acc_id"])  # numpy int64 -> int for the SDK
        with self._lock:
            self._account = account
        return account

    @contextmanager
    def session(self) -> Iterator[Any]:
        """Yield the trade context, through `OpenDSupervisor.session()` first.

        Going through the quote supervisor reuses its unit liveness check and
        on-demand OpenD start: if OpenD cannot be brought up, `OpenDUnavailable`
        propagates and no trade context is ever built against a dead gateway.
        """
        with self._opend.session():
            yield self._ensure_ctx()

    # ---- internals -----------------------------------------------------

    def _invoke(self, fn: Callable[..., tuple[int, Any]], **kwargs: Any) -> Any:
        if not self._slots.acquire(blocking=False):
            raise TradeBusy("trade call concurrency cap reached")
        try:
            return self._invoke_bounded(fn, **kwargs)
        finally:
            # Released on timeout too: the lingering daemon thread holds no
            # waitress thread, and the cap exists to protect those.
            self._slots.release()

    def _invoke_bounded(self, fn: Callable[..., tuple[int, Any]], **kwargs: Any) -> Any:
        box: dict[str, Any] = {}

        def _run() -> None:
            try:
                with self.session() as ctx:
                    box["ctx"] = ctx
                    box["result"] = fn(ctx, **kwargs)
            except Exception as exc:  # noqa: BLE001 - re-raised on the caller's thread
                box["error"] = exc

        worker = threading.Thread(target=_run, name="futu-shim-trade-call", daemon=True)
        worker.start()
        worker.join(self._timeout_s)
        if worker.is_alive():
            self._discard_ctx(box.get("ctx"), "trade call timed out")
            raise TradeTimeout(f"trade call exceeded {self._timeout_s:g}s")

        error = box.get("error")
        if isinstance(error, OpenDUnavailable):
            raise error
        if error is not None:
            self._discard_ctx(box.get("ctx"), f"SDK raised {type(error).__name__}")
            raise TradeVendorError(self._redact(f"{type(error).__name__}: {error}")) from None

        ret, data = box["result"]
        if ret != RET_OK:
            if data in _CONNECTION_ERROR_TEXTS:
                self._discard_ctx(box.get("ctx"), f"connection error: {data}")
            raise TradeVendorError(self._redact(str(data)))
        return data

    def _ensure_ctx(self) -> Any:
        with self._lock:
            if self._ctx is not None:
                return self._ctx
        # Built outside the lock: construction connects, and a hang here must not
        # also wedge every later caller on the lock (they are bounded, the lock is not).
        ctx = self._ctx_factory()
        self._attach_push_handlers(ctx)
        with self._lock:
            if self._ctx is None:
                self._ctx = ctx
                return ctx
            winner = self._ctx
        self._close_async(ctx)
        return winner

    def _attach_push_handlers(self, ctx: Any) -> None:
        """Mount both push handlers on a freshly built context (084 D1).

        Called on **every** build, so a rebuilt context is re-subscribed. Missing that
        is the silent failure mode of this feature: after the first timeout or
        disconnect the buffer would simply stop growing, with nothing raising and
        every query route still answering normally.

        A handler the SDK refuses is logged, not raised: the context is still usable
        for the query routes, and losing pushes shows up downstream as a sequence gap.
        """
        for handler in (
            TradeOrderPushHandler(self._events),
            TradeDealPushHandler(self._events),
        ):
            if ctx.set_handler(handler) != RET_OK:
                log.warning("trade context refused %s", type(handler).__name__)

    def _discard_ctx(self, ctx: Any, reason: str) -> None:
        """Drop `ctx` if it is still the current one — never a fresh replacement.

        Same shape as `OpenDSupervisor._drop_ctx`: clear the reference first, then
        `close()` on a daemon thread, because closing a dead handle can block.
        """
        if ctx is None:
            return
        with self._lock:
            if self._ctx is not ctx:
                return
            self._ctx = None
            self._account = None
        log.warning("discarding OpenSecTradeContext: %s", self._redact(reason))
        self._close_async(ctx)

    @staticmethod
    def _close_async(ctx: Any) -> None:
        def _close() -> None:
            try:
                ctx.close()
            except Exception as exc:  # noqa: BLE001 - teardown must not mask callers
                log.warning("closing OpenSecTradeContext failed: %s", type(exc).__name__)

        threading.Thread(target=_close, name="futu-shim-trade-ctx-close", daemon=True).start()

    def _redact(self, text: str) -> str:
        with self._lock:
            known = tuple(self._known_acc_ids)
        for acc_id in known:
            text = text.replace(acc_id, "<acc_id>")
        return text
