"""OpenD process lifecycle + the long-lived `OpenQuoteContext`.

**Resident by default, windowed if configured.** `FUTU_OPEND_IDLE_STOP_S <= 0`
(the default) means the shim never reaps OpenD; a positive value restores the
old demand-driven window, where OpenD is started by the first request that needs
it and stopped again after that much quiet. Both modes branch off that one knob
— see `config.opend_idle_stop_s`.

**Why the default flipped (2026-08-04).** The original "windowed, not resident"
rule rested on a single claim: a running OpenD seizes the account's top-tier
quote entitlement and degrades the owner's phone app. That claim was never
measured, and it misread the vendor docs — the official behaviour is to grab the
entitlement *back after being pre-empted*, not to seize it on startup. Two
experiments then falsified it outright: V9 (2026-08-03, US session) and V10
(2026-08-04, HK session — the one market whose downgrade the vendor actually
documents) both had the phone contend hard against a live OpenD subscription,
and **both sides kept their top tier throughout**. p3b 4.3 requirement 5 was
re-decided accordingly; the evidence and its stated boundaries live in p3b
7.3-V9 / V10.

The shim itself was always resident and still is — it is cheap and keeps
`/healthz` answerable when OpenD is not.

**Concurrency.** `OpenQuoteContext` is internally guarded by an `RLock`
(`futu/common/open_context_base.py`), so calls from multiple worker threads are
safe but serialise. There is therefore nothing to gain from an async server; the
lock here only guards start/stop transitions, not the data calls themselves.
"""

from __future__ import annotations

import logging
import socket
import subprocess
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager

from futu import RET_OK, OpenQuoteContext

from . import config

log = logging.getLogger(__name__)


class OpenDUnavailable(RuntimeError):
    """OpenD could not be brought to a logged-in state within the budget."""


class OpenDSupervisor:
    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._ctx: OpenQuoteContext | None = None
        self._last_used = 0.0
        self._stopping = threading.Event()
        self._idle_thread: threading.Thread | None = None

    # ---- public API ----------------------------------------------------

    def reclaim(self) -> None:
        """Assert the configured baseline state at startup.

        **Resident mode: nothing to assert.** A running OpenD that this
        supervisor has no handle on is the desired steady state, not an orphan —
        systemd owns its lifetime (`Restart=always` + enabled), and the next
        request simply reconnects to it.

        **Windowed mode: assert "off".** If the shim restarts while OpenD is
        running, the fresh supervisor holds no context, and the idle watcher
        only ever stops a unit it has a context for — so the orphan would run
        until someone noticed. Asserting "off" here costs at most one cold start
        and removes that failure mode entirely.
        """
        if config.opend_idle_stop_s() <= 0:
            return
        if self._unit_is_active():
            log.info(
                "%s was running with no owner at startup; stopping it", config.opend_unit()
            )
            self._systemctl("stop")

    def start_idle_watcher(self) -> None:
        """Launch the background thread that stops OpenD once it goes idle.

        Started unconditionally: each tick re-reads the mode, so under the
        resident default the thread simply does nothing. Gating the thread here
        as well would put the same decision in two places.
        """
        if self._idle_thread is not None:
            return
        self._idle_thread = threading.Thread(
            target=self._idle_loop, name="opend-idle-watcher", daemon=True
        )
        self._idle_thread.start()

    @contextmanager
    def session(self) -> Iterator[OpenQuoteContext]:
        """Yield a logged-in quote context, starting OpenD if it is down.

        The idle deadline is refreshed on both entry and exit so a long call
        cannot be reaped mid-flight.
        """
        ctx = self._ensure_ready()
        try:
            yield ctx
        finally:
            with self._lock:
                self._last_used = time.monotonic()

    def status(self) -> dict[str, object]:
        """Snapshot for `/healthz`. Never starts OpenD — a health probe must be
        side-effect free, or monitoring becomes indistinguishable from load.
        (This predates and outlives the resident/windowed question: it holds in
        both modes, and it is what keeps `/healthz` honest about OpenD being
        down rather than papering over it by starting one.)

        🚨 **The probe must not be able to hang, and until 2026-08-01 it could.**
        Observed: OpenD was stopped out-of-band (`systemctl stop`, which the
        runbook documents as an operational action — a crash or OOM looks the
        same). The supervisor kept its context, whose SDK then retried forever
        (`_connect_sync: Connect fail ... ECONNREFUSED` every 6s), and this
        method's `get_global_state()` call blocked against that dead gateway.
        Waitress has four threads, so a handful of probes wedged the whole shim
        — including `/healthz`, the one endpoint whose entire contract is being
        answerable when things are broken. The `try/except` below guards
        *exceptions*; a hang is not an exception.

        Two rules encode the fix:
        1. **Unit down ⇒ the held context is dead by definition** — discard it
           without calling into it. This is the mirror of `reclaim()`, which
           handles the opposite skew (OpenD up with no owner).
        2. **Unit up is not proof the gateway answers** — bound the probe, and
           treat a timeout as evidence the context is wedged, so the next probe
           starts clean instead of queueing behind the same dead handle.
        """
        unit_active = self._unit_is_active()
        if not unit_active:
            # Rule 1. Ordering matters: read the unit *before* touching the ctx.
            self._discard_ctx("OpenD unit is not active")
        with self._lock:
            ctx = self._ctx
            last_used = self._last_used
        qot_logined: bool | None = None
        trd_logined: bool | None = None
        if ctx is not None:
            data = self._probe_global_state(ctx)
            if data is None:
                # Rule 2: timed out. Nothing to report, and the handle is proven
                # unusable — drop it so we do not re-block on it next time.
                self._discard_ctx("health probe timed out")
            else:
                qot_logined = bool(data.get("qot_logined"))
                trd_logined = bool(data.get("trd_logined"))
        return {
            "opend_unit": config.opend_unit(),
            "opend_unit_active": unit_active,
            "opend_connected": ctx is not None,
            "qot_logined": qot_logined,
            "trd_logined": trd_logined,
            "idle_seconds": None if last_used == 0.0 else round(time.monotonic() - last_used, 1),
            "idle_stop_seconds": config.opend_idle_stop_s(),
        }

    def shutdown(self) -> None:
        self._stopping.set()
        self._stop_opend()

    # ---- internals -----------------------------------------------------

    def _ensure_ready(self) -> OpenQuoteContext:
        # 🚨 Same invariant as `status()`: if the unit is down, the held context
        # is dead and `_is_logged_in` (which calls `get_global_state`) would
        # block against it. Check the unit first, outside the lock, so the data
        # path cannot wedge either.
        if not self._unit_is_active():
            self._discard_ctx("OpenD unit is not active")
        with self._lock:
            if self._ctx is not None and self._is_logged_in(self._ctx):
                self._last_used = time.monotonic()
                return self._ctx
            # Either never started, or the context went stale (OpenD restarted /
            # gateway dropped). Drop it and rebuild rather than hand back a
            # half-dead handle.
            self._drop_ctx()
            self._systemctl("start")
            deadline = time.monotonic() + config.opend_ready_timeout_s()
            ctx = self._connect_when_ready(deadline)
            self._ctx = ctx
            self._last_used = time.monotonic()
            return ctx

    def _connect_when_ready(self, deadline: float) -> OpenQuoteContext:
        host, port = config.opend_host(), config.opend_port()
        last_err: Exception | None = None

        # Phase 1: wait for the API port to accept a TCP connection.
        while time.monotonic() < deadline:
            try:
                with socket.create_connection((host, port), timeout=2.0):
                    break
            except OSError as exc:
                last_err = exc
                time.sleep(1.0)
        else:
            raise OpenDUnavailable(f"OpenD API port {host}:{port} never opened: {last_err}")

        # Phase 2: connect and wait for the gateway login to complete. The port
        # opens well before `qot_logined` flips, so both phases are required.
        ctx = OpenQuoteContext(host=host, port=port)
        while time.monotonic() < deadline:
            try:
                if self._is_logged_in(ctx):
                    log.info("OpenD ready (qot_logined)")
                    return ctx
            except Exception as exc:  # noqa: BLE001 - retried until deadline
                last_err = exc
            time.sleep(1.0)

        ctx.close()
        raise OpenDUnavailable(f"OpenD did not reach qot_logined in time: {last_err}")

    @staticmethod
    def _is_logged_in(ctx: OpenQuoteContext) -> bool:
        ret, data = ctx.get_global_state()
        return ret == RET_OK and isinstance(data, dict) and bool(data.get("qot_logined"))

    def _idle_loop(self) -> None:
        while not self._stopping.wait(timeout=15.0):
            self._reap_if_idle()

    def _reap_if_idle(self) -> None:
        """One tick of the idle watcher.

        Split out of the loop so the decision is testable without driving a
        thread. The mode is re-read every tick rather than captured at startup,
        so the knob has exactly one reader and there is no second place where
        "resident vs windowed" could drift.
        """
        idle_stop_s = config.opend_idle_stop_s()
        if idle_stop_s <= 0:
            return  # resident — never reap
        with self._lock:
            idle_for = time.monotonic() - self._last_used
            should_stop = self._ctx is not None and idle_for >= idle_stop_s
        if should_stop:
            log.info("OpenD idle for %.0fs, stopping (windowed mode)", idle_for)
            self._stop_opend()

    def _stop_opend(self) -> None:
        with self._lock:
            self._drop_ctx()
            self._systemctl("stop")

    def _drop_ctx(self) -> None:
        """Caller must hold the lock.

        🚨 `close()` runs on a daemon thread rather than inline: closing a
        context whose gateway is gone can block, and this is called from the
        request path (`_ensure_ready`) and from the idle watcher. Clearing the
        reference first means the caller is never held up by a dead handle, and
        the thread is a daemon so a stuck close cannot keep the process alive.
        """
        ctx = self._ctx
        self._ctx = None
        if ctx is None:
            return

        def _close() -> None:
            try:
                ctx.close()
            except Exception as exc:  # noqa: BLE001 - teardown must not mask callers
                log.warning("closing OpenQuoteContext failed: %s", exc)

        threading.Thread(target=_close, name="futu-shim-ctx-close", daemon=True).start()

    def _discard_ctx(self, reason: str) -> None:
        """Drop a context we have proven unusable. Lock-safe, idempotent."""
        with self._lock:
            if self._ctx is None:
                return
            log.warning("discarding OpenQuoteContext: %s", reason)
            self._drop_ctx()

    def _probe_global_state(self, ctx: OpenQuoteContext) -> dict | None:
        """`get_global_state()` bounded by a deadline. `None` = did not answer.

        A plain call cannot be interrupted, so it runs on a daemon thread we
        simply stop waiting on. The thread may linger against a dead gateway,
        but it is bounded: the caller discards the context on timeout, so no
        later probe targets that same handle.
        """
        box: dict[str, dict] = {}

        def _run() -> None:
            try:
                ret, data = ctx.get_global_state()
                if ret == RET_OK and isinstance(data, dict):
                    box["data"] = data
            except Exception as exc:  # noqa: BLE001 - health must never raise
                log.warning("get_global_state failed during health probe: %s", exc)

        worker = threading.Thread(target=_run, name="futu-shim-health-probe", daemon=True)
        worker.start()
        worker.join(config.health_probe_timeout_s())
        if worker.is_alive():
            return None
        return box.get("data", {})

    def _systemctl(self, verb: str) -> None:
        cmd = [*config.systemctl_cmd(), verb, config.opend_unit()]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            raise OpenDUnavailable(
                f"`{' '.join(cmd)}` failed rc={result.returncode}: {result.stderr.strip()}"
            )

    def _unit_is_active(self) -> bool:
        cmd = [*config.systemctl_cmd(), "is-active", config.opend_unit()]
        try:
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        except Exception as exc:  # noqa: BLE001 - health must never raise
            log.warning("is-active probe failed: %s", exc)
            return False
        return result.stdout.strip() == "active"
