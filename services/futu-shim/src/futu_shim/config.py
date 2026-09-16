"""Env-driven config.

Shape mirrors `services/code-index/src/config.ts`: plain accessor functions, no
import-time side effects, fail-closed on secrets. Nothing here reads a file —
systemd supplies the environment (secrets via SOPS-rendered EnvironmentFile).
"""

from __future__ import annotations

import os


def _env(name: str, default: str | None = None) -> str | None:
    raw = os.environ.get(name)
    if raw is None:
        return default
    stripped = raw.strip()
    return stripped or default


def service_token() -> str | None:
    """Bearer token every authed route must present.

    `None` = unset. Callers must treat that as "deny everything" rather than
    "no auth required" — see `auth.is_authorized`.
    """
    return _env("FUTU_SHIM_TOKEN")


def bind_host() -> str:
    """Default = the B<->C WireGuard virtual IP.

    Binding to the tunnel address (not 0.0.0.0) means the shim stays unreachable
    off-tunnel even if a security-group rule is later loosened by mistake.
    """
    return _env("FUTU_SHIM_HOST", "10.89.0.1") or "10.89.0.1"


def bind_port() -> int:
    return int(_env("FUTU_SHIM_PORT", "8811") or "8811")


def opend_host() -> str:
    return _env("FUTU_OPEND_HOST", "127.0.0.1") or "127.0.0.1"


def opend_port() -> int:
    return int(_env("FUTU_OPEND_PORT", "11111") or "11111")


def opend_unit() -> str:
    """systemd unit the shim starts on demand and stops when idle."""
    return _env("FUTU_OPEND_UNIT", "futu-opend.service") or "futu-opend.service"


def opend_ready_timeout_s() -> float:
    """Budget for OpenD to reach `qot_logined` after an on-demand start.

    Cold start measured on the HK box is ~15-25 s (process spawn + gateway
    login). 60 s leaves headroom for a slow gateway without hanging a request
    forever.
    """
    return float(_env("FUTU_OPEND_READY_TIMEOUT_S", "60") or "60")


def opend_idle_stop_s() -> float:
    """Idle period after which OpenD is stopped. **`<= 0` means resident.**

    Default is `0` — OpenD runs permanently. Until 2026-08-04 it was `600`,
    because "a resident OpenD seizes the account's top-tier quote entitlement
    and degrades the owner's phone app" was taken as given. That premise was
    never measured, and two experiments falsified it: V9 (2026-08-03, US
    session) and V10 (2026-08-04, HK session) both had the phone actively
    contend while OpenD held a live subscription, and **both sides kept their
    top tier** — the permission event fires once at startup and never again.
    See p3b 4.3 requirement 5 and 7.3-V9 / V10.

    A positive value still restores windowed operation, and that is the
    intended rollback: V10's evidence has stated boundaries (a single 8-minute
    run; HK option/future entitlements untested), so one env var beats a code
    change if the phone ever does get degraded in practice.
    """
    return float(_env("FUTU_OPEND_IDLE_STOP_S", "0") or "0")


def health_probe_timeout_s() -> float:
    """Deadline for the `get_global_state()` call behind `/healthz`.

    A healthy gateway answers in single-digit milliseconds — this is not a
    performance budget, it is a liveness bound. `/healthz` must stay answerable
    precisely when OpenD is not, so the probe gets a few seconds and then gives
    up rather than joining the queue behind a dead handle. 3 s is comfortably
    above any healthy response and well under a monitoring scrape interval.
    """
    return float(_env("FUTU_HEALTH_PROBE_TIMEOUT_S", "3") or "3")


def trade_call_timeout_s() -> float:
    """Deadline for one trade-query SDK call (`trade.TradeSupervisor`).

    Like the health probe, this is a liveness bound, not a performance budget: a
    wedged trade context must give its waitress thread back instead of queueing
    the quote routes behind it (plan 082 D2 / D13). A timeout discards the
    context, so the next call starts clean.
    """
    return float(_env("FUTU_TRADE_CALL_TIMEOUT_S", "10") or "10")


def trade_event_buffer_size() -> int:
    """Rows kept in the push-event ring buffer (`trade_events.TradeEventBuffer`).

    Default 2000. The bound that matters is not memory (a row is one or two KB, so
    2000 rows is a few MB) but **how long a consumer may be away without losing
    events**: the server reads every 2 s, so the buffer only has to cover an
    ordinary server restart / redeploy window. 2000 rows is far more than a manually
    traded account produces in such a window, which is the point — a wrap should
    mean something actually went wrong, not that we deployed again. Sizing it too
    small makes every routine deploy emit a gap-compensation trace and drowns the
    signal FR-014 reads to judge the push channel's health.
    """
    return int(_env("FUTU_TRADE_EVENT_BUFFER_SIZE", "2000") or "2000")


def systemctl_cmd() -> list[str]:
    """Command prefix used to control the OpenD unit.

    Default routes through sudo because the shim runs as an unprivileged user
    with a narrow NOPASSWD rule for exactly start/stop/is-active on that one
    unit (see deploy/install.sh).
    """
    raw = _env("FUTU_SHIM_SYSTEMCTL", "sudo -n /usr/bin/systemctl")
    return (raw or "sudo -n /usr/bin/systemctl").split()
