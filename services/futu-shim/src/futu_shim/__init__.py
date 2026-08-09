"""futu-shim — thin HTTP front for a local Futu OpenD gateway.

Deployed alongside OpenD on the HK box; consumed by the mono server over the
B<->C WireGuard tunnel. Design and hard requirements live in
`docs/private/plans/2026-07/07-30-sellput-viz-p3b-data-architecture.md` §4.2 / §4.3;
deployment lives in `ops/runbook/futu-opend-hk.md`.
"""

__all__ = ["__version__"]

__version__ = "0.1.0"
