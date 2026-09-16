"""`TradeEventBuffer` 的不变量（084 T001，FR-003）。

每条臂对应 tasks.md T001 的一个编号。并发臂带超时断言（死锁必须与失败可区分，同
`test_trade.py` / `test_opend.py` 的做法）。

定向变异留档（2026-09-16，逐条临时改坏 `trade_events.py` → 跑本文件 → 还原 → 全绿）：
  a. `read` 去掉 `dropped` 判定（恒 `False`）  → ③ test_wrapped_buffer_reports_dropped_for_an_evicted_cursor 红
  b. `_epoch` 改为固定常量                       → ⑤ test_each_instance_gets_its_own_epoch 红
复跑：services/futu-shim/venv/bin/python -m pytest -q services/futu-shim/tests/test_trade_events.py

🚨 fixture 一律合成值：事件行只用 `US.FAKE` 这类明显假代码与小序号，与任何真实成交无关。
"""

import threading

import pytest

from futu_shim import config
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
