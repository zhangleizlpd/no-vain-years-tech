"""`TradeSupervisor` 的不变量（082 T001）。

每条臂对应 tasks.md T001 的一个编号；挂起类用例一律带超时断言（挂起必须与失败可区分，
同 `test_opend.py` 的做法）。

定向变异留档（2026-09-14，逐条临时改坏 `trade.py` → 跑本文件 → 还原 → 全绿）：
  a. 去掉 `_strip_account_ids` 里的 `pop("acc_id")`      → ④ test_rows_never_carry_acc_id 红
  b. 选户改为「命中即取第一个」（不数命中数）            → ③ test_two_matches_is_an_error_not_the_first 红
  c. semaphore 改阻塞获取 `acquire()`                      → ⑥ test_third_call_is_rejected_immediately 红（卡到 join 超时）
复跑：services/futu-shim/venv/bin/python -m pytest -q services/futu-shim/tests/test_trade.py

🚨 fixture 里的账户号一律是明显假值（1001–1010、`0000` 结尾），与任何真实账户无关。
"""

import threading
import time
from contextlib import contextmanager

import pandas as pd
import pytest
from futu import RET_OK
from futu.common.err import Err

from futu_shim import config
from futu_shim.opend import OpenDSupervisor, OpenDUnavailable
from futu_shim.trade import (
    AccountSelectionError,
    TradeBusy,
    TradeSupervisor,
    TradeTimeout,
    TradeVendorError,
)


def _acc(acc_id, trd_env, acc_status, auth, acc_type="MARGIN"):
    return {
        "acc_id": acc_id,
        "trd_env": trd_env,
        "acc_type": acc_type,
        "uni_card_num": f"9{acc_id}0000",
        "card_num": f"8{acc_id}0000",
        "security_firm": "FUTUSECURITIES",
        "sim_acc_type": "N/A",
        "trdmarket_auth": auth,
        "acc_status": acc_status,
    }


def poc1_shaped_accounts():
    """照 POC-1 的形态造各型账户：实盘可用 1 户 + 模拟 + 停用（含 HKFUND / USFUND 两型基金户）。"""
    return [
        _acc(1001, "REAL", "ACTIVE", ["HK", "US", "HKCC"]),
        _acc(1002, "SIMULATE", "ACTIVE", ["HK"], acc_type="CASH"),
        _acc(1005, "SIMULATE", "ACTIVE", ["US"]),
        _acc(1006, "REAL", "DISABLED", ["HK"]),
        _acc(1008, "REAL", "DISABLED", ["HK", "US"], acc_type="CASH"),
        _acc(1009, "REAL", "DISABLED", ["HKFUND"], acc_type="CASH"),
        _acc(1010, "REAL", "DISABLED", ["USFUND"], acc_type="CASH"),
    ]


class FakeTradeCtx:
    def __init__(self, accounts=None, positions=None, hang=None, ret=RET_OK, error=None):
        self._accounts = accounts if accounts is not None else poc1_shaped_accounts()
        self._positions = positions if positions is not None else []
        self._hang = hang  # threading.Event: 调用阻塞到它被 set；永不 set = 死网关
        self._ret = ret
        self._error = error
        self.closed = threading.Event()
        self.acc_list_calls = 0
        self.position_calls: list[dict] = []
        self.handlers: list = []

    def get_acc_list(self):
        self.acc_list_calls += 1
        return RET_OK, pd.DataFrame(self._accounts)

    def position_list_query(self, **kwargs):
        self.position_calls.append(kwargs)
        if self._hang is not None:
            self._hang.wait()
        if self._error is not None:
            raise self._error
        if self._ret != RET_OK:
            return self._ret, Err.ConnectionClosed.text
        return RET_OK, pd.DataFrame(self._positions)

    def set_handler(self, handler):
        """推送 handler 的挂载点（084 T002）；真 context 上由 `OpenContextBase.set_handler` 收。"""
        self.handlers.append(handler)
        return RET_OK

    def close(self):
        self.closed.set()


class FakeOpenD:
    def __init__(self, error: Exception | None = None):
        self.sessions = 0
        self._error = error

    @contextmanager
    def session(self):
        if self._error is not None:
            raise self._error
        self.sessions += 1
        yield object()


class Factory:
    """按序发放 ctx，记录创建次数（「被丢弃后重建」要靠这个计数看见）。"""

    def __init__(self, *ctxs):
        self._ctxs = list(ctxs)
        self.created = 0

    def __call__(self):
        ctx = self._ctxs[min(self.created, len(self._ctxs) - 1)]
        self.created += 1
        return ctx


def _positions(ctx, **kwargs):
    return ctx.position_list_query(**kwargs)


def _run_with_deadline(fn, seconds: float):
    box = {}

    def _target():
        try:
            box["v"] = fn()
        except BaseException as exc:  # noqa: BLE001 - surfaced to the asserting thread
            box["e"] = exc

    t = threading.Thread(target=_target, daemon=True)
    t.start()
    t.join(seconds)
    assert not t.is_alive(), f"调用未在 {seconds}s 内返回"
    if "e" in box:
        raise box["e"]
    return box.get("v")


def build(*ctxs, opend=None, timeout_s=5.0, max_concurrency=2):
    factory = Factory(*(ctxs or (FakeTradeCtx(),)))
    trade = TradeSupervisor(
        opend or FakeOpenD(), timeout_s=timeout_s, max_concurrency=max_concurrency,
        ctx_factory=factory,
    )
    return trade, factory


# ── 选户 ① ② ③ ─────────────────────────────────────────────────────────────


def test_poc1_shaped_accounts_select_the_single_real_active_account():
    """① 各型账户里恰一个 实盘 ∧ 可用 ∧ 有 HK/US 权限 ⇒ 选中它。"""
    trade, _ = build(FakeTradeCtx())
    account = trade.selected_account()
    assert account["acc_id"] == 1001


def test_active_fund_account_is_excluded_by_its_market_auth_alone():
    """基金户靠权限字段排除，不靠状态也不靠 `acc_type`：造一个**可用的实盘**基金户，
    除权限外其余条件全满足 ⇒ 仍然 0 命中。"""
    accounts = [_acc(1009, "REAL", "ACTIVE", ["HKFUND"], acc_type="CASH")]
    trade, _ = build(FakeTradeCtx(accounts=accounts))
    with pytest.raises(AccountSelectionError) as excinfo:
        trade.selected_account()
    assert excinfo.value.matched == 0


def test_zero_matches_is_an_error():
    """② 没有任何账户满足 ⇒ AccountSelectionError(matched=0)。"""
    accounts = [a for a in poc1_shaped_accounts() if a["acc_id"] != 1001]
    trade, _ = build(FakeTradeCtx(accounts=accounts))
    with pytest.raises(AccountSelectionError) as excinfo:
        trade.selected_account()
    assert excinfo.value.matched == 0


def test_two_matches_is_an_error_not_the_first():
    """③ 🚨 两户命中 ⇒ matched=2，**不取第一个**。"""
    accounts = poc1_shaped_accounts() + [_acc(1011, "REAL", "ACTIVE", ["US"])]
    trade, _ = build(FakeTradeCtx(accounts=accounts))
    with pytest.raises(AccountSelectionError) as excinfo:
        trade.selected_account()
    assert excinfo.value.matched == 2


def test_selection_is_cached_until_the_context_is_rebuilt():
    ctx = FakeTradeCtx()
    trade, _ = build(ctx)
    trade.selected_account()
    trade.selected_account()
    assert ctx.acc_list_calls == 1


# ── 剔除账户号 ④ ────────────────────────────────────────────────────────────


def test_rows_never_carry_acc_id():
    """④ FakeCtx 故意在行里放 `acc_id`（真 SDK 的持仓 DataFrame 就带这一列）。"""
    ctx = FakeTradeCtx(positions=[{"code": "US.AAPL", "qty": 1.0, "acc_id": 1001}])
    trade, _ = build(ctx)
    rows = trade.call(_positions, acc_id=1001)
    assert rows == [{"code": "US.AAPL", "qty": 1.0}]
    assert all("acc_id" not in row for row in rows)


def test_vendor_error_text_is_redacted_of_known_account_ids():
    ctx = FakeTradeCtx(error=RuntimeError("acc_id 1001 is not allowed"))
    trade, _ = build(ctx)
    trade.selected_account()
    with pytest.raises(TradeVendorError) as excinfo:
        trade.call(_positions, acc_id=1001)
    assert "1001" not in str(excinfo.value)


# ── 限时 ⑤ ─────────────────────────────────────────────────────────────────


def test_hanging_call_times_out_and_the_context_is_rebuilt_next_time():
    """⑤ 挂死的 ctx ⇒ TradeTimeout，且该 ctx 被丢弃（daemon 线程里 close），下次重建。"""
    hanging = FakeTradeCtx(hang=threading.Event())
    healthy = FakeTradeCtx(positions=[{"code": "HK.00700", "qty": 100.0}])
    trade, factory = build(hanging, healthy, timeout_s=0.3)

    with pytest.raises(TradeTimeout):
        _run_with_deadline(lambda: trade.call(_positions, acc_id=1001), 5.0)
    assert hanging.closed.wait(2.0)

    rows = _run_with_deadline(lambda: trade.call(_positions, acc_id=1001), 5.0)
    assert factory.created == 2
    assert rows == [{"code": "HK.00700", "qty": 100.0}]


def test_connection_class_vendor_error_discards_the_context():
    broken = FakeTradeCtx(ret=-1)
    healthy = FakeTradeCtx()
    trade, factory = build(broken, healthy)
    with pytest.raises(TradeVendorError):
        trade.call(_positions, acc_id=1001)
    assert broken.closed.wait(2.0)
    trade.call(_positions, acc_id=1001)
    assert factory.created == 2


def test_rebuilt_context_reselects_the_account():
    broken = FakeTradeCtx(ret=-1)
    healthy = FakeTradeCtx()
    trade, _ = build(broken, healthy)
    trade.selected_account()
    with pytest.raises(TradeVendorError):
        trade.call(_positions, acc_id=1001)
    trade.selected_account()
    assert (broken.acc_list_calls, healthy.acc_list_calls) == (1, 1)


# ── 限并发 ⑥ ───────────────────────────────────────────────────────────────


def test_third_call_is_rejected_immediately():
    """⑥ 🚨 两个调用在途时第 3 个立即 TradeBusy —— 断言**不等待**（< 100 ms）。
    阻塞获取时它会一直占着 waitress 线程，等于没限。"""
    release = threading.Event()
    trade, _ = build(FakeTradeCtx(hang=release), timeout_s=5.0)
    in_flight = [
        threading.Thread(target=lambda: trade.call(_positions, acc_id=1001), daemon=True)
        for _ in range(2)
    ]
    for t in in_flight:
        t.start()
    deadline = time.monotonic() + 2.0
    while trade._slots._value > 0 and time.monotonic() < deadline:  # noqa: SLF001
        time.sleep(0.01)

    started = time.monotonic()
    try:
        with pytest.raises(TradeBusy):
            _run_with_deadline(lambda: trade.call(_positions, acc_id=1001), 1.0)
        assert time.monotonic() - started < 0.1
    finally:
        release.set()
        for t in in_flight:
            t.join(2.0)


# ── OpenD 不活 ⑦ ────────────────────────────────────────────────────────────


def test_trade_context_is_not_created_when_the_opend_unit_is_down(monkeypatch):
    """⑦ 走真 `OpenDSupervisor`：单元不活且拉不起 ⇒ OpenDUnavailable 原样上抛，交易 ctx 一个都不建。"""
    opend = OpenDSupervisor()
    monkeypatch.setattr(opend, "_unit_is_active", lambda: False)

    def _systemctl(verb):
        raise OpenDUnavailable(f"systemctl {verb} failed")

    monkeypatch.setattr(opend, "_systemctl", _systemctl)
    trade, factory = build(FakeTradeCtx(), opend=opend)

    with pytest.raises(OpenDUnavailable):
        _run_with_deadline(lambda: trade.call(_positions, acc_id=1001), 5.0)
    assert factory.created == 0


def test_default_timeout_comes_from_config(monkeypatch):
    monkeypatch.delenv("FUTU_TRADE_CALL_TIMEOUT_S", raising=False)
    assert config.trade_call_timeout_s() == 10.0
    monkeypatch.setenv("FUTU_TRADE_CALL_TIMEOUT_S", "2.5")
    assert config.trade_call_timeout_s() == 2.5
    assert TradeSupervisor(FakeOpenD(), ctx_factory=Factory(FakeTradeCtx()))._timeout_s == 2.5  # noqa: SLF001
