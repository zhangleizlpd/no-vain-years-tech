"""`TradeEventBuffer` 的不变量（084 T001，FR-003）。

每条臂对应 tasks.md T001 的一个编号。并发臂带超时断言（死锁必须与失败可区分，同
`test_trade.py` / `test_opend.py` 的做法）。

定向变异留档（2026-09-16，逐条临时改坏 `trade_events.py` → 跑本文件 → 还原 → 全绿）：
  a. `read` 去掉 `dropped` 判定（恒 `False`）  → ③ test_wrapped_buffer_reports_dropped_for_an_evicted_cursor 红
  b. `_epoch` 改为固定常量                       → ⑤ test_each_instance_gets_its_own_epoch 红
复跑：services/futu-shim/venv/bin/python -m pytest -q services/futu-shim/tests/test_trade_events.py

🚨 fixture 一律合成值：事件行只用 `US.FAKE` 这类明显假代码与小序号，与任何真实成交无关。
"""

import json
import threading
from contextlib import contextmanager

import pandas as pd
import pytest
from futu import RET_ERROR, RET_OK, ComboLeg, TradeDealHandlerBase, TradeOrderHandlerBase

from futu_shim import config, mappers
from futu_shim.trade import (
    TradeDealPushHandler,
    TradeOrderPushHandler,
    TradeSupervisor,
    _ids_as_digit_strings,
    _strip_account_ids,
    push_frame_to_events,
)
from futu_shim.trade_events import TradeEventBuffer


def _row(n: int) -> dict:
    """一条形态足够的合成事件行（字段映射是 T002 的事，本模块只搬运）。"""
    return {"event_type": "order", "code": "US.FAKE", "order_id": f"fake-{n}"}


# ① 顺序 append 后全量读
def test_reading_from_zero_returns_every_row_in_order():
    buffer = TradeEventBuffer(maxlen=10)
    for n in range(3):
        buffer.append(_row(n))

    result = buffer.read(after_seq=0)

    assert [row["order_id"] for row in result["rows"]] == ["fake-0", "fake-1", "fake-2"]
    assert [row["seq"] for row in result["rows"]] == [1, 2, 3]
    assert result["next_seq"] == 3
    assert result["dropped"] is False
    assert result["epoch"] == buffer.epoch


def test_append_returns_the_assigned_seq():
    buffer = TradeEventBuffer(maxlen=10)
    assert [buffer.append(_row(n)) for n in range(3)] == [1, 2, 3]


# ② 中间游标只回其后的行
def test_reading_from_a_mid_cursor_returns_only_later_rows():
    buffer = TradeEventBuffer(maxlen=10)
    for n in range(5):
        buffer.append(_row(n))

    result = buffer.read(after_seq=3)

    assert [row["seq"] for row in result["rows"]] == [4, 5]
    assert result["next_seq"] == 5
    assert result["dropped"] is False


def test_reading_at_the_head_returns_no_rows_and_holds_the_cursor():
    """无新事件的那一拍：不回行、游标原样回传（server 侧据此判「没动过」）。"""
    buffer = TradeEventBuffer(maxlen=10)
    for n in range(2):
        buffer.append(_row(n))

    result = buffer.read(after_seq=2)

    assert result["rows"] == []
    assert result["next_seq"] == 2
    assert result["dropped"] is False


# ③ 绕回后旧游标 ⇒ dropped
def test_wrapped_buffer_reports_dropped_for_an_evicted_cursor():
    buffer = TradeEventBuffer(maxlen=3)
    for n in range(5):  # seq 1..5，容量 3 ⇒ 只剩 3,4,5
        buffer.append(_row(n))

    result = buffer.read(after_seq=1)  # 2 已被覆盖

    assert [row["seq"] for row in result["rows"]] == [3, 4, 5]
    assert result["dropped"] is True, "最旧一条被覆盖后旧游标必须报断档，否则丢失的事件永远不出现且不报错"
    assert result["next_seq"] == 5


def test_wrapped_buffer_does_not_report_dropped_when_the_cursor_is_still_retained():
    """对照臂：绕回**不等于**断档 —— 游标仍在缓冲内时 `dropped` 必须为假。

    缺这条，「绕回过就恒报 dropped」的实现同样能过 ③，而那会让每次绕回都触发一次补偿。
    """
    buffer = TradeEventBuffer(maxlen=3)
    for n in range(5):
        buffer.append(_row(n))

    assert buffer.read(after_seq=3)["dropped"] is False


# ④ 未超容量的连续读
def test_successive_reads_within_capacity_never_report_dropped():
    buffer = TradeEventBuffer(maxlen=10)
    cursor = 0
    for n in range(6):
        buffer.append(_row(n))
        result = buffer.read(after_seq=cursor)
        assert result["dropped"] is False
        assert [row["seq"] for row in result["rows"]] == [n + 1]
        cursor = result["next_seq"]
    assert cursor == 6


def test_empty_buffer_reads_clean():
    buffer = TradeEventBuffer(maxlen=10)
    assert buffer.read(after_seq=0) == {
        "epoch": buffer.epoch,
        "rows": [],
        "next_seq": 0,
        "dropped": False,
    }


# ⑤ 进程代次
def test_each_instance_gets_its_own_epoch():
    """`epoch` 承担「序号回到起点 ≠ 序号断档」的区分（FR-003），重启必变。"""
    first = TradeEventBuffer(maxlen=10)
    second = TradeEventBuffer(maxlen=10)

    assert first.epoch != second.epoch
    assert first.epoch and isinstance(first.epoch, str)


def test_seq_restarts_at_one_in_a_new_instance():
    """序号确实回到起点 ⇒ ⑤ 的 `epoch` 不是装饰，是唯一的区分手段。"""
    first = TradeEventBuffer(maxlen=10)
    first.append(_row(0))
    first.append(_row(1))

    second = TradeEventBuffer(maxlen=10)
    assert second.append(_row(0)) == 1


# ⑥ 并发
def test_concurrent_appends_and_reads_never_duplicate_or_skip_a_seq():
    """写在 SDK 回调线程、读在 waitress 工作线程 ⇒ 两侧都必须在同一把锁内。"""
    writers, per_writer = 8, 200
    buffer = TradeEventBuffer(maxlen=writers * per_writer)
    assigned: list[int] = []
    assigned_lock = threading.Lock()
    errors: list[BaseException] = []
    start = threading.Event()

    def write() -> None:
        start.wait()
        try:
            local = [buffer.append(_row(n)) for n in range(per_writer)]
        except BaseException as exc:  # noqa: BLE001 - 汇总到主线程断言
            errors.append(exc)
            return
        with assigned_lock:
            assigned.extend(local)

    def read() -> None:
        start.wait()
        try:
            for _ in range(per_writer):
                result = buffer.read(after_seq=0)
                seqs = [row["seq"] for row in result["rows"]]
                assert seqs == sorted(seqs), "读到的行必须按序号单调 —— 读期间被写穿了"
        except BaseException as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=write) for _ in range(writers)]
    threads += [threading.Thread(target=read) for _ in range(2)]
    for thread in threads:
        thread.start()
    start.set()
    for thread in threads:
        thread.join(timeout=30)
        assert not thread.is_alive(), "线程未在 30 s 内结束 —— 多半是锁用错了"

    assert errors == []
    assert sorted(assigned) == list(range(1, writers * per_writer + 1))


# 容量走 env（D9）
def test_capacity_comes_from_env_when_not_passed(monkeypatch):
    monkeypatch.setenv("FUTU_TRADE_EVENT_BUFFER_SIZE", "4")
    buffer = TradeEventBuffer()
    for n in range(6):
        buffer.append(_row(n))

    assert [row["seq"] for row in buffer.read(after_seq=0)["rows"]] == [3, 4, 5, 6]


@pytest.mark.parametrize("raw", ["", "   "])
def test_capacity_falls_back_to_the_default_on_a_blank_env(monkeypatch, raw):
    monkeypatch.setenv("FUTU_TRADE_EVENT_BUFFER_SIZE", raw)
    assert config.trade_event_buffer_size() == 2000


# ── T002 推送行映射 + handler 挂载 ────────────────────────────────────────────
#
# 定向变异留档（2026-09-16，逐条临时改坏 `trade.py` → 跑本文件 → 还原 → 全绿）：
#   a. `combo_legs` 改走 `mappers.clean_value`  → ① test_combo_legs_are_expanded_from_objects_not_stringified 红
#   b. `deal_id` 原样透传（不转数字串）          → ③ test_deal_id_is_carried_as_a_digit_string_without_precision_loss 红
#   c. 去掉 `pop("acc_id")`                      → ④ test_acc_id_is_dropped_unconditionally 红
#
# 🚨 夹具一律合成值：`US.FAKE*` 代码、`fake-order-*` 订单号、明显假的 10 位账户号，
# 成交号是一个 19 位的合成大整数（唯一的真实性要求是**量级**：必须 > 2**53-1，否则
# 「转字符串」与「原样透传」两种实现都绿 —— 见 plan「本片额外的反例臂」）。

#: 19 位合成成交号，大于 JS `Number.MAX_SAFE_INTEGER`（即 `2**53 - 1`）且在 int64 内。
FAKE_DEAL_ID = 7180000000000000123
FAKE_ACC_ID = 9000001001


def _leg(code, trd_side, qty_ratio=1.0, position_id=0):
    """券商组件给的腿是 `ComboLeg` **对象**（`futu.common.constant:367`），不是文本。"""
    leg = ComboLeg()
    leg.code = code
    leg.trd_side = trd_side
    leg.qty_ratio = qty_ratio
    leg.position_id = position_id
    return leg


def _order_push_frame(**overrides):
    """照 SDK `TradeOrderHandlerBase.on_recv_rsp` 的列集取要害子集
    （`futu/trade/trade_response_handler.py:16-22`）：市场字段是 `trd_market`，
    **没有** `order_market` 那一列 —— 后者只存在于历史订单查询路径。"""
    row = {
        "trd_env": "REAL",
        "code": "US.FAKE",
        "stock_name": "FAKE INC",
        "order_id": "fake-order-1",
        "order_status": "SUBMITTED",
        "trd_side": "BUY",
        "qty": 1.0,
        "price": 1.23,
        "create_time": "2026-09-16 10:00:00",
        "updated_time": "2026-09-16 10:00:01",
        "trd_market": "US",
        "combo_legs": [],
    }
    row.update(overrides)
    return pd.DataFrame([row], columns=list(row))


def _deal_push_frame(**overrides):
    """同上，照 `TradeDealHandlerBase.on_recv_rsp` 的列集（同文件 `:37-41`）。"""
    row = {
        "trd_env": "REAL",
        "code": "US.FAKE",
        "stock_name": "FAKE INC",
        "deal_id": FAKE_DEAL_ID,
        "order_id": "fake-order-1",
        "qty": 1.0,
        "price": 1.23,
        "trd_side": "BUY",
        "create_time": "2026-09-16 10:00:02",
        "trd_market": "US",
        "status": "OK",
    }
    row.update(overrides)
    return pd.DataFrame([row], columns=list(row))


# ① 腿是对象 ⇒ 展开
def test_combo_legs_are_expanded_from_objects_not_stringified():
    """🚨 喂**对象**而不是文本：server 侧的腿解析只收文本元素，喂对象会静默得空数组。

    走 `mappers.clean_value` 的实现在这里红 —— 它末行 `return str(value)`（`mappers.py:52`）
    会把整列表压成 `ComboLeg(code=…, …)` 的 repr 串。
    """
    frame = _order_push_frame(
        combo_legs=[
            _leg("US.FAKE260116C100000", "BUY", qty_ratio=1.0, position_id=1),
            _leg("US.FAKE260116C110000", "SELL", qty_ratio=1.0, position_id=2),
        ]
    )

    [row] = push_frame_to_events(frame, event_type="order")

    assert row["combo_legs"] == [
        {"code": "US.FAKE260116C100000", "trd_side": "BUY", "qty_ratio": 1.0, "position_id": 1},
        {"code": "US.FAKE260116C110000", "trd_side": "SELL", "qty_ratio": 1.0, "position_id": 2},
    ]
    assert "ComboLeg(" not in json.dumps(row), "腿被 str() 兜底压成了 repr 串"


# ② 空腿
def test_empty_combo_legs_map_to_an_empty_array():
    [row] = push_frame_to_events(_order_push_frame(combo_legs=[]), event_type="order")
    assert row["combo_legs"] == []


def test_a_missing_combo_legs_cell_maps_to_an_empty_array():
    """列在、值缺（`pd.DataFrame(..., columns=...)` 补的 NaN）⇒ 空数组，不抛。"""
    [row] = push_frame_to_events(
        _order_push_frame(combo_legs=float("nan")), event_type="order"
    )
    assert row["combo_legs"] == []


# ③ 成交号
def test_deal_id_is_carried_as_a_digit_string_without_precision_loss():
    [row] = push_frame_to_events(_deal_push_frame(), event_type="deal")

    assert row["deal_id"] == str(FAKE_DEAL_ID)
    assert int(row["deal_id"]) == FAKE_DEAL_ID, "数字串必须能无损还原成原成交号"
    assert len(row["deal_id"]) == 19


def test_other_unsafe_integers_are_carried_as_digit_strings_too():
    """`deal_id` 之外，任一 `abs > 2**53-1` 的整数列同样转串（同查询路径口径）。"""
    [row] = push_frame_to_events(
        _deal_push_frame(counter_broker_id=9007199254740993), event_type="deal"
    )
    assert row["counter_broker_id"] == "9007199254740993"


def test_small_integers_keep_their_type():
    """对照臂：防「所有 int 一律转串」的过度实现 —— 数量 / 比例列必须仍是数字。"""
    [row] = push_frame_to_events(_deal_push_frame(qty=3), event_type="deal")
    assert row["qty"] == 3
    assert not isinstance(row["qty"], str)


# ④ 账户号
def test_acc_id_is_dropped_unconditionally():
    """实测推送行不含该字段，但剔除仍 MUST 无条件执行（FR-019）—— 不把正确性押在 vendor 的实现细节上。"""
    [row] = push_frame_to_events(_deal_push_frame(acc_id=FAKE_ACC_ID), event_type="deal")

    assert "acc_id" not in row
    assert str(FAKE_ACC_ID) not in json.dumps(row)


# ⑤ 市场字段两路分别映射
def test_push_rows_take_trd_market_while_query_rows_take_order_market():
    """branch 13 的 shim 半：两路字段名不同、市场取值必须落到同一个值。"""
    [push_row] = push_frame_to_events(_order_push_frame(trd_market="US"), event_type="order")

    # 查询路径（历史订单）原样：`TradeSupervisor.call` 的三步管线。
    query_frame = pd.DataFrame(
        [{"code": "US.FAKE", "order_id": "fake-order-1", "order_market": "US"}]
    )
    [query_row] = _ids_as_digit_strings(
        _strip_account_ids(mappers.dataframe_to_records(query_frame))
    )

    assert push_row["trd_market"] == query_row["order_market"] == "US"
    assert "order_market" not in push_row, "推送帧里根本没有这一列，读它只会得到空值"


# ⑥ 两类事件字段集不串
def test_order_and_deal_events_keep_their_own_field_sets():
    [order_row] = push_frame_to_events(_order_push_frame(), event_type="order")
    [deal_row] = push_frame_to_events(_deal_push_frame(), event_type="deal")

    assert order_row["event_type"] == "order"
    assert deal_row["event_type"] == "deal"
    assert "deal_id" not in order_row
    assert "combo_legs" not in deal_row
    assert "order_status" not in deal_row


def test_an_empty_push_frame_yields_no_events():
    assert push_frame_to_events(pd.DataFrame(), event_type="order") == []


# handler：收到推送 ⇒ 映射后进缓冲
def test_order_handler_appends_a_mapped_event(monkeypatch):
    """只替换 SDK 基类的解包那一步（protobuf 帧造不出来），被测的是「解包之后」的全部逻辑。"""
    buffer = TradeEventBuffer(maxlen=10)
    frame = _order_push_frame(combo_legs=[_leg("US.FAKE260116C100000", "BUY")])
    monkeypatch.setattr(
        TradeOrderHandlerBase, "on_recv_rsp", lambda self, rsp_pb: (RET_OK, frame)
    )

    TradeOrderPushHandler(buffer).on_recv_rsp(object())

    [row] = buffer.read()["rows"]
    assert row["event_type"] == "order"
    assert row["combo_legs"][0]["code"] == "US.FAKE260116C100000"


def test_deal_handler_appends_a_mapped_event(monkeypatch):
    buffer = TradeEventBuffer(maxlen=10)
    monkeypatch.setattr(
        TradeDealHandlerBase, "on_recv_rsp", lambda self, rsp_pb: (RET_OK, _deal_push_frame())
    )

    TradeDealPushHandler(buffer).on_recv_rsp(object())

    [row] = buffer.read()["rows"]
    assert row["event_type"] == "deal"
    assert row["deal_id"] == str(FAKE_DEAL_ID)


def test_a_vendor_error_frame_is_swallowed_rather_than_buffered(monkeypatch):
    """回调线程里抛异常会被 SDK 吞掉且看不见 ⇒ 错误帧只留痕、不写缓冲、不上抛。"""
    buffer = TradeEventBuffer(maxlen=10)
    monkeypatch.setattr(
        TradeOrderHandlerBase, "on_recv_rsp", lambda self, rsp_pb: (RET_ERROR, "vendor said no")
    )

    TradeOrderPushHandler(buffer).on_recv_rsp(object())

    assert buffer.read()["rows"] == []


# handler 挂载：context 建立时挂、重建时重挂
class _RecordingTradeCtx:
    def __init__(self):
        self.handlers = []
        self.closed = threading.Event()

    def set_handler(self, handler):
        self.handlers.append(handler)
        return RET_OK

    def close(self):
        self.closed.set()


class _FakeOpenD:
    @contextmanager
    def session(self):
        yield None


def _handler_types(ctx):
    return {type(handler) for handler in ctx.handlers}


def test_push_handlers_are_attached_when_the_trade_context_is_built():
    ctx = _RecordingTradeCtx()
    supervisor = TradeSupervisor(_FakeOpenD(), ctx_factory=lambda: ctx)

    supervisor._ensure_ctx()  # noqa: SLF001

    assert _handler_types(ctx) == {TradeOrderPushHandler, TradeDealPushHandler}


def test_push_handlers_are_reattached_when_the_trade_context_is_rebuilt():
    """重建不重挂 ⇒ 推送在一次超时 / 断连之后**永久静默**，且没有任何断言会红。"""
    first, second = _RecordingTradeCtx(), _RecordingTradeCtx()
    contexts = iter([first, second])
    supervisor = TradeSupervisor(_FakeOpenD(), ctx_factory=lambda: next(contexts))

    ctx = supervisor._ensure_ctx()  # noqa: SLF001
    supervisor._discard_ctx(ctx, "rebuild for test")  # noqa: SLF001
    supervisor._ensure_ctx()  # noqa: SLF001

    assert _handler_types(second) == {TradeOrderPushHandler, TradeDealPushHandler}


def test_the_supervisor_exposes_one_event_buffer():
    """路由从这里读事件（T003）；缓冲与交易 context 同生命周期无关，重建不清空。"""
    supervisor = TradeSupervisor(_FakeOpenD(), ctx_factory=_RecordingTradeCtx)

    assert isinstance(supervisor.events, TradeEventBuffer)
    assert supervisor.events is supervisor.events


def test_handlers_write_into_the_supervisors_own_buffer():
    ctx = _RecordingTradeCtx()
    supervisor = TradeSupervisor(_FakeOpenD(), ctx_factory=lambda: ctx)
    supervisor._ensure_ctx()  # noqa: SLF001

    for handler in ctx.handlers:
        assert handler._buffer is supervisor.events  # noqa: SLF001
