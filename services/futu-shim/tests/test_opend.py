import threading
import time

from futu import RET_OK

from futu_shim import config
from futu_shim.opend import OpenDSupervisor


def _instrument(monkeypatch, supervisor, unit_active: bool):
    """Replace the two subprocess touchpoints so nothing real is invoked."""
    calls: list[str] = []
    monkeypatch.setattr(supervisor, "_unit_is_active", lambda: unit_active)
    monkeypatch.setattr(supervisor, "_systemctl", lambda verb: calls.append(verb))
    return calls


def test_reclaim_stops_an_orphaned_opend_in_windowed_mode(monkeypatch):
    """The failure this guards: shim restarts while OpenD is up, the fresh
    supervisor holds no context, the idle watcher (which only stops units it has
    a context for) never fires, and OpenD outlives every owner.

    Windowed mode is pinned explicitly — under the resident default this
    reclaim is deliberately a no-op (see the resident block at the bottom)."""
    monkeypatch.setattr(config, "opend_idle_stop_s", lambda: 600.0)
    supervisor = OpenDSupervisor()
    calls = _instrument(monkeypatch, supervisor, unit_active=True)
    supervisor.reclaim()
    assert calls == ["stop"]


def test_reclaim_is_a_noop_when_opend_is_already_down(monkeypatch):
    monkeypatch.setattr(config, "opend_idle_stop_s", lambda: 600.0)
    supervisor = OpenDSupervisor()
    calls = _instrument(monkeypatch, supervisor, unit_active=False)
    supervisor.reclaim()
    assert calls == []


def test_status_never_starts_opend(monkeypatch):
    """/healthz must be side-effect free — a probe that starts what it measures
    turns monitoring into load, and papers over the very outage it exists to
    report."""
    supervisor = OpenDSupervisor()
    calls = _instrument(monkeypatch, supervisor, unit_active=False)
    status = supervisor.status()
    assert calls == []
    assert status["opend_connected"] is False
    assert status["qot_logined"] is None


# ── 死 context 回收 (2026-08-01 事故) ────────────────────────────────────────
#
# 事故形态: 带外停掉 OpenD (`systemctl stop` —— runbook 把它写成运维动作; 崩溃 / OOM
# 同形) 之后, supervisor 仍攥着那个 OpenQuoteContext。SDK 对已死网关**永久重连**
# (每 6s 一条 ECONNREFUSED), 而 `status()` 会去调 `get_global_state()` → 阻塞。
# waitress 只有 4 个线程 ⇒ 几个探针就把整个 shim 堵死, **包括 /healthz** —— 而
# /healthz 的全部立意就是"坏掉的时候还能答"。
#
# 下面每条测试对应一条不变量, 都用"会永远阻塞的假 ctx"来施压: 若实现退回去直接调用
# 它, 测试会**卡住而不是失败**, 所以每条都带超时断言。


class _HangingCtx:
    """A context whose every call blocks forever — i.e. a dead OpenD gateway."""

    def __init__(self) -> None:
        self.calls = 0
        self.closed = threading.Event()

    def get_global_state(self):
        self.calls += 1
        threading.Event().wait()  # 永不返回

    def close(self):
        self.closed.set()


class _LiveCtx:
    def __init__(self, qot=True, trd=False, **extra):
        self._payload = {"qot_logined": qot, "trd_logined": trd, **extra}
        self.calls = 0

    def get_global_state(self):
        self.calls += 1
        return RET_OK, self._payload

    def close(self):
        pass


def _run_with_deadline(fn, seconds: float):
    """跑 fn, 超时即判失败 —— 挂起和失败必须可区分。"""
    box = {}
    t = threading.Thread(target=lambda: box.update(v=fn()), daemon=True)
    t.start()
    t.join(seconds)
    assert not t.is_alive(), f"调用未在 {seconds}s 内返回 —— 实现又会挂住 /healthz 了"
    return box.get("v")


def test_status_does_not_touch_a_context_whose_unit_is_dead(monkeypatch):
    """🚨 不变量 1: 单元不 active ⇒ 手里的 ctx 按定义已死, 一次都不许调它。"""
    supervisor = OpenDSupervisor()
    _instrument(monkeypatch, supervisor, unit_active=False)
    hanging = _HangingCtx()
    supervisor._ctx = hanging

    status = _run_with_deadline(supervisor.status, 5.0)

    assert hanging.calls == 0  # 一次都没碰 —— 碰了就会永久阻塞
    assert status["opend_connected"] is False
    assert status["qot_logined"] is None
    assert hanging.closed.wait(2.0)  # 死 ctx 被回收 (daemon 线程里 close)
    assert supervisor._ctx is None


def test_status_bounds_the_probe_when_the_unit_is_up_but_wedged(monkeypatch):
    """🚨 不变量 2: 单元 active 不等于网关会应答 —— 探针必须限时, 且超时后丢弃该 ctx。"""
    supervisor = OpenDSupervisor()
    _instrument(monkeypatch, supervisor, unit_active=True)
    monkeypatch.setattr(config, "health_probe_timeout_s", lambda: 0.3)
    hanging = _HangingCtx()
    supervisor._ctx = hanging

    status = _run_with_deadline(supervisor.status, 5.0)

    assert status["qot_logined"] is None
    assert supervisor._ctx is None, "探针超时 = 该 handle 已被证明不可用, 必须丢弃"


def test_status_still_reports_login_state_when_healthy(monkeypatch):
    """回归护栏: 修完之后正常路径的返回值一字不变。"""
    supervisor = OpenDSupervisor()
    _instrument(monkeypatch, supervisor, unit_active=True)
    supervisor._ctx = _LiveCtx(qot=True, trd=False)

    status = _run_with_deadline(supervisor.status, 5.0)

    assert status["opend_connected"] is True
    assert status["qot_logined"] is True
    assert status["trd_logined"] is False
    assert supervisor._ctx is not None  # 健康的 ctx 不该被丢


def test_ensure_ready_does_not_probe_a_context_whose_unit_is_dead(monkeypatch):
    """🚨 数据路径同样受害: _is_logged_in 也调 get_global_state。单元死了就别问它,
    直接丢弃重建 —— 否则 /kline /universe 也会一起挂住。"""
    supervisor = OpenDSupervisor()
    calls = _instrument(monkeypatch, supervisor, unit_active=False)
    hanging = _HangingCtx()
    supervisor._ctx = hanging
    monkeypatch.setattr(
        supervisor, "_connect_when_ready", lambda deadline: _LiveCtx()
    )

    ctx = _run_with_deadline(supervisor._ensure_ready, 5.0)

    assert hanging.calls == 0
    assert isinstance(ctx, _LiveCtx)
    assert calls == ["start"]  # 走了重建, 而不是把死 handle 递出去


def test_global_state_takes_the_data_path_and_brings_opend_up(monkeypatch):
    """🚨 与 `status()` **刻意相反**: 判据端必须拿到确定答案。

    同样的前置条件 (单元不 active) 下, `status()` 一个 systemctl 都不发、市场状态报
    `None` (见 `test_status_never_starts_opend`); 而本方法走 `session()` →
    `_ensure_ready()`, 该起就起。差别是承重的: 上游把「状态不可得」当 fail-closed 信号
    停采, 若这里也返回含糊的 `None`, 盘中投影会在 OpenD 空闲后**永久**停在停采态,
    而看上去像是"行情源坏了"。

    并且 payload **整块**带出 —— `status()` 只取 `qot_logined` / `trd_logined` 就把
    `market_us` / `market_hk` 扔了, 那恰恰是这个端点唯一要的东西。
    """
    supervisor = OpenDSupervisor()
    calls = _instrument(monkeypatch, supervisor, unit_active=False)
    live = _LiveCtx(market_us="MORNING", market_hk="CLOSED")
    monkeypatch.setattr(supervisor, "_connect_when_ready", lambda deadline: live)

    ret, data = _run_with_deadline(supervisor.global_state, 5.0)

    assert calls == ["start"]  # status() 在同样条件下是 []
    assert ret == RET_OK
    assert data["market_us"] == "MORNING"
    assert data["market_hk"] == "CLOSED"
    assert data["qot_logined"] is True  # 原有字段一个不少


def test_drop_ctx_never_blocks_the_caller(monkeypatch):
    """🚨 close() 对死连接也可能阻塞, 而它在请求路径与空闲回收里都会被调用。"""
    supervisor = OpenDSupervisor()
    _instrument(monkeypatch, supervisor, unit_active=True)

    class _BlockingClose:
        def close(self):
            threading.Event().wait()

    supervisor._ctx = _BlockingClose()
    _run_with_deadline(lambda: supervisor._discard_ctx("test"), 3.0)
    assert supervisor._ctx is None


# ── 常驻 (2026-08-04 改判, V9 + V10 双市场实测放行) ──────────────────────────
#
# `FUTU_OPEND_IDLE_STOP_S <= 0` = 常驻: shim 永不回收 OpenD。
#
# 改判依据: 「不常驻」这条要求此前唯一的理由是「常驻 OpenD 会让手机富途 App 行情
# 降级」, 而该断言从未实测过 —— V9 (08-03 美股盘中) 与 V10 (08-04 港股早市) 两次
# 实测均为: 手机主动争用下两侧同时保持最高档, 权限事件只在启动播报 1 次。
# SoT = p3b §4.3 要求 5 / §7.3-V9 · V10。
#
# 下面三条: 前两条各钉一个「常驻」的必要条件 (启动时不杀 / 空闲时不杀) —— 少任何
# 一条, OpenD 都会在 shim 重启后或空闲后消失, 常驻名存实亡; 第三条是反向对照,
# 防止「常驻」被实现成「把回收功能删掉」而不是「按 knob 分支」。


def test_reclaim_leaves_a_running_opend_alone_when_resident(monkeypatch):
    """常驻下「无主的 OpenD」正是期望态, 不是孤儿 —— reclaim 必须放它过去。"""
    monkeypatch.setattr(config, "opend_idle_stop_s", lambda: 0.0)
    supervisor = OpenDSupervisor()
    calls = _instrument(monkeypatch, supervisor, unit_active=True)

    supervisor.reclaim()

    assert calls == []


def test_idle_watcher_never_reaps_when_resident(monkeypatch):
    """空闲多久都不回收。用「远超任何窗口的空闲时长」施压, 免得断言只是碰巧没到点。"""
    monkeypatch.setattr(config, "opend_idle_stop_s", lambda: 0.0)
    supervisor = OpenDSupervisor()
    calls = _instrument(monkeypatch, supervisor, unit_active=True)
    supervisor._ctx = _LiveCtx()
    supervisor._last_used = time.monotonic() - 86_400  # 空闲整整一天

    supervisor._reap_if_idle()

    assert calls == []
    assert supervisor._ctx is not None, "常驻下 ctx 也不该被丢"


def test_idle_watcher_still_reaps_in_windowed_mode(monkeypatch):
    """反向对照: knob > 0 时回收行为一字不变。"""
    monkeypatch.setattr(config, "opend_idle_stop_s", lambda: 600.0)
    supervisor = OpenDSupervisor()
    calls = _instrument(monkeypatch, supervisor, unit_active=True)
    supervisor._ctx = _LiveCtx()
    supervisor._last_used = time.monotonic() - 601

    supervisor._reap_if_idle()

    assert calls == ["stop"]
    assert supervisor._ctx is None
