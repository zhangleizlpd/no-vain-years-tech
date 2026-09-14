"""Read-only trade-query surface: the long-lived `OpenSecTradeContext` (082 D2).

🚨 **Read-only, structurally.** This module queries accounts / positions / deals /
orders and nothing else; `tests/test_readonly_guard.py` fails the build if any
order-placing or unlocking call name appears under `src/`.

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

from futu import RET_OK, OpenSecTradeContext, TrdAccStatus, TrdEnv, TrdMarket
from futu.common.err import Err

from . import config, mappers
from .opend import OpenDSupervisor, OpenDUnavailable

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
    ) -> None:
        self._opend = opend_supervisor
        self._timeout_s = config.trade_call_timeout_s() if timeout_s is None else timeout_s
        self._slots = threading.BoundedSemaphore(max_concurrency)
        self._ctx_factory = ctx_factory
        self._lock = threading.Lock()
        self._ctx: Any = None
        self._account: dict[str, Any] | None = None
        self._known_acc_ids: set[str] = set()

    # ---- public API ----------------------------------------------------

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
        with self._lock:
            if self._ctx is None:
                self._ctx = ctx
                return ctx
            winner = self._ctx
        self._close_async(ctx)
        return winner

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
