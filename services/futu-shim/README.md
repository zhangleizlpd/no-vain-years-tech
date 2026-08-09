# futu-shim

Thin HTTP front for a local Futu **OpenD** gateway. Runs on the HK box next to
OpenD; consumed by the mono server over the B↔C WireGuard tunnel.

- **Design + hard requirements**: [p3b §4.2 / §4.3](../../docs/private/plans/2026-07/07-30-sellput-viz-p3b-data-architecture.md)
- **Host, tunnel, OpenD deployment**: [`ops/runbook/futu-opend-hk.md`](../../ops/runbook/futu-opend-hk.md)

## Why it exists

Futu's only maintained SDK is Python, and OpenD speaks private protobuf over
TCP — so the server cannot talk to it directly. (There _is_ an official
`futu-api-js` on npm, but it stopped at 2021 and is four major versions behind;
p3b §4.2 records why it is unusable.) The shim is the translation boundary, kept
deliberately narrow so it never grows into a second system:

| Does                                   | Does not                      |
| -------------------------------------- | ----------------------------- |
| Hold the long-lived `OpenQuoteContext` | Write to any database         |
| protobuf/DataFrame → JSON              | Compute derived values        |
| Hard per-capability rate gate          | Filter rows on business rules |
| `/healthz` reporting OpenD state       | Keep state across requests    |

## Endpoints

All routes except `/healthz` require `Authorization: Bearer <FUTU_SHIM_TOKEN>`.

| Route                                                        | Capability            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /healthz`                                               | —                     | Public. **Never starts OpenD** — a health probe must be side-effect free, and it has to stay honest about OpenD being down rather than paper over it by starting one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /universe?market=US&types=STOCK,ETF`                    | `stock_basicinfo`     | Unions the security types and de-dupes by `code`. `types` defaults to `STOCK,ETF` because Futu classifies some REITs as ETF — VICI is the live example, and a STOCK-only query silently loses it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `GET /trading-days?market=US&start=&end=`                    | `trading_days`        | Backs the US calendar L1 source. `start`/`end` optional; SDK defaults apply.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /kline?code=US.PEP&start=&end=&ktype=K_DAY&autype=NONE` | `history_kline`       | Backs the `us_equity_bar` dimension. **`autype` defaults to `NONE` (unadjusted) and that default is load-bearing** — the server stores one raw row per (instrument, date) at `adjust='none'` and adjusts at read time, so an adjusted series would be adjusted twice. Follows `page_req_key` to exhaustion; a window needing more than 8 pages is refused with **400**, never truncated. Rate-gated **once per request** (the vendor exempts pages after the first — see below), so a 10-year window costs one slot out of 60/30 s.                                                                                                                                                                                                                                                                                                                                              |
| `GET /overview?codes=US.PEP,US.VICI`                         | `underlying_overview` | Backs the `underlying_iv_daily` dimension. Batched: `iv` / `iv_rank` / `iv_percentile` + the HV ladder for up to **500 codes** in one call (vendor cap). More codes is a **400**, never a silent slice — a dropped tail is indistinguishable from "those underlyings have no IV". The IV is Futu's _aggregated underlying_ IV, not a 30d-ATM lock (p3 §9-1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /his-vol?code=US.PEP&start=&end=`                       | `his_volatility`      | Backs the `underlying_iv_history` backfill. Daily `iv` / `hv` / `underlying_price`, depth ≈3 years on a **sliding** window. Single-call span capped at **364 days**; wider is a **400**, never a clipped series — the SDK's `normalize_start_end_date(..., 364)` only derives a _missing_ side and will not reject an explicit over-wide window. Follows `page_req_key` to exhaustion; rate-gated once per request.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /option-expirations?code=US.PEP`                        | `expiration_date`     | Entry point of chain discovery: one underlying's **full** expiry ladder, no trimming — far-dated LEAPS included. Trimming here would not error, it would just make those legs unfetchable forever (**an option snapshot missed is a permanent hole** — the vendor serves no historical chain snapshots). Splitting the ladder into ≤30-day windows is the caller's job.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `GET /option-chain?code=US.PEP&start=&end=&option_type=ALL`  | `option_chain`        | Contract statics for one underlying over one expiry window. **`option_type` defaults to `ALL` (calls included) and that default is load-bearing** — "puts only" is a presentation-side statement; the chain call returns both sides for the same cost, so filtering here buys nothing and leaves an unfillable hole on the call side. `data_filter` is never sent, for the same reason. Window wider than **30 days (inclusive of both endpoints)** is a **400**, never a truncated chain — same reasoning as `/kline`'s page cap. Rate limit **10 per 30 s is the official value, not a fallback** (verified 2026-08-04 on openapi.futunn.com: 「每 30 秒内最多请求 10 次获取期权链接口」) — do not "correct" it upwards.                                                                                                                                                       |
| `GET /option-snapshot?codes=US.PEP260807P145000,US.PEP`      | `snapshot`            | Batched quote + full greeks + IV + OI/net OI + volume/turnover + the vendor's `update_time`, for up to **400 codes** per call (vendor cap; more is a **400**, never a slice). **The underlying's spot is not a second call** — put the underlying's own code in the same batch and its `last_price` comes back alongside; option rows carry `stock_owner` as the join key. Rows whose **greeks block is missing are returned as usual**, flagged `greeks_complete: false` — dropping them here would make "leg exists but cannot be graded" indistinguishable from "leg was not collected at all" (the missing block is inherent maths, not dirty data: in-the-money bid below intrinsic ⇒ IV unsolvable; measured 227 of 2150 rows, 99.5% deep ITM). Non-option rows get `greeks_complete: null` (not applicable).                                                              |
| `GET /earnings-calendar?market=US&start=&end=`               | `earnings_calendar`   | Market-wide earnings calendar for one window — returns **every** security in that window, `filter_list` is never sent. Narrowing to a watchlist here would break the point-in-time trail (first-seen / date-changed only hold under continuous whole-market observation, and a security added later has no recoverable history). Span between `start` and `end` capped at **6 days between the endpoints** — the official 「与 beginDate 间隔不超过 7 天」 turned out to mean a 7-day window **inclusive of both ends** (measured 2026-08-08: endpoint diff 0–6 → 200, **diff 7 → vendor 502**, US 3/3 and HK alike); wider is a **400**, never a clipped calendar. `end` without `start` is refused — the vendor would derive the start itself and the span could not be validated. Rate limit **60 per 30 s is the official value** and is registered in `LIMITS` — see below. |

Uniform envelope:

```json
{ "as_of": "2026-07-31T05:19:48+00:00", "count": 19203, "rows": [ ... ] }
```

`as_of` is the **collection instant**, never a vendor timestamp — p3b E33 found
Futu's `update_time` is the last _trade_ time, so an actively-quoted contract can
look stale. Field names inside `rows` are passed through exactly as the SDK
reports them (snake_case, including literal `"N/A"` strings where Futu emits
them); reshaping is the consumer's job.

### Rate limit vs quota — two meters, do not conflate

`ratelimit.py` meters **calls** per capability, from each interface's own doc
page. For `history_kline` that is **60 per 30 s**, and the vendor exempts
pagination: _"如果您是分页获取数据，此限频规则仅适用于每只股票的首页，后续页请求不受
限频规则的限制"_ — so `/kline` checks the gate **once per request**, not once per
page. Metering every page against a 6x-too-strict fallback is exactly what broke
a 10-year backfill on 2026-08-01 (3 pages per security → 429 on the third
security → server-side breaker failed the remaining four).

`earnings_calendar` is registered at its own official **60 per 30 s** —
「接口限制：30 秒内最多 60 次请求；分页请求仅首页计入限频统计」 (verified 2026-08-04 on
openapi.futunn.com). It previously sat on the strict 10/30 s fallback: the same shape
as the 08-01 miss, only 6x _too strict_ rather than too loose. **Read a capability's
own doc page before parking it on the fallback** — that omission is the recurring
failure here, and it has now bitten in both directions.

Futu separately charges a **history-kline quota per security per rolling window**
(officially released after 7 days). Measured 2026-07-31:
querying a security absent from the window moved `used` 8 → 9; an immediate
re-query of the same security moved nothing, only refreshing its timestamp. So a
fixed watchlist polled daily holds a constant number of slots rather than
draining the balance — but adding many new securities at once consumes one slot
each. `get_history_kl_quota(get_detail=True)` lists the securities currently
occupying slots, which is the fastest way to see where the balance went.

## Configuration

Environment only (systemd `EnvironmentFile=/etc/futu-shim.env`, `0600 root:root`).

| Var                          | Default               |                                                                                                                                  |
| ---------------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `FUTU_SHIM_TOKEN`            | —                     | **Required.** Unset ⇒ the process refuses to start, and auth denies everything (fail-closed).                                    |
| `FUTU_SHIM_HOST`             | `10.89.0.1`           | Tunnel virtual IP. Binding here (not `0.0.0.0`) keeps the shim unreachable off-tunnel even if a security-group rule is loosened. |
| `FUTU_SHIM_PORT`             | `8811`                |                                                                                                                                  |
| `FUTU_OPEND_HOST` / `_PORT`  | `127.0.0.1` / `11111` |                                                                                                                                  |
| `FUTU_OPEND_UNIT`            | `futu-opend.service`  | Resident unit; the shim connects to it and (by default) never stops it.                                                          |
| `FUTU_OPEND_READY_TIMEOUT_S` | `60`                  | Cold start measured ~13 s end-to-end.                                                                                            |
| `FUTU_OPEND_IDLE_STOP_S`     | `0`                   | **`<= 0` = resident.** A positive value restores windowed mode; the watcher polls every 15 s, so a stop lands within that.       |

## OpenD lifecycle

Both the shim and OpenD are **resident**. OpenD is `enable`d with
`Restart=always`, so systemd owns its lifetime; the shim just connects to it, and
under the default `FUTU_OPEND_IDLE_STOP_S=0` it never stops it.

**This flipped on 2026-08-04.** OpenD used to be demand-driven, on the strength
of one claim: a resident OpenD holds the account's top-tier quote entitlement
(`auto_hold_quote_right=1`) and degrades the owner's phone app. That claim was
never measured, and it misread the vendor docs — OpenD grabs the entitlement back
_after_ being pre-empted, it does not seize it at startup. Two experiments then
falsified it: **V9** (2026-08-03, US session) and **V10** (2026-08-04, HK session
— the one market whose LV2→BMP downgrade the vendor documents). In both, the
phone contended hard against a live OpenD subscription and **both sides kept
their top tier**; the permission event fires once at startup and never again.
p3b §4.3 requirement 5 was re-decided accordingly — evidence and its stated
boundaries are in p3b §7.3-V9 / V10.

**Rollback.** Set `FUTU_OPEND_IDLE_STOP_S=600` in `/etc/futu-shim.env` and
restart `futu-shim`; the idle watcher resumes reaping (an explicit `systemctl
stop` does not trip `Restart=always`, so the two do not fight). The next deploy
resets it to `0` — that split is deliberate: the env var is the _fast_ rollback,
making it permanent is a one-line PR.

Privilege: the service runs as `futushim` with a sudoers rule scoped to exactly
three verbs on one unit (`start` / `stop` / `is-active`). `stop` is still needed
— windowed mode uses it.

On startup the supervisor **reclaims**, which is now mode-dependent: in resident
mode a running OpenD it has no handle on is the _expected_ state and is left
alone; in windowed mode it is an orphan nothing would ever stop, so the
supervisor stops it.

## Install / update

```bash
sudo services/futu-shim/deploy/install.sh   # idempotent
```

Generates `FUTU_SHIM_TOKEN` on first run and never rotates it afterwards (a live
consumer would break). Copy that value to the consuming server when its adapter
lands — same pattern as `CODE_INDEX_SERVICE_TOKEN`.

## Tests

```bash
/opt/futu-shim/venv/bin/python -m pytest      # on the host
```

Covers auth (incl. fail-closed with no token configured), the rate gate (window
slide, per-capability isolation, unknown-capability fallback), mappers
(NaN/numpy/dedupe), routes (401/400/429/502 paths), and supervisor reclaim. For
the current inventory ask the suite — `pytest --collect-only -q` — rather than
trusting a number written here.

**Wired into CI** as the `futu-shim (pytest)` job. `services/` sits outside the
Nx graph, so `nx affected` structurally cannot see it; that job exists to close
exactly that gap. It runs on every PR and decides _internally_ (by path diff)
whether to install deps — deliberately not a workflow-level `paths:` filter,
because a filtered check goes unreported on unrelated PRs, and a required check
that never reports blocks auto-merge forever.

> The suite is mutation-tested, not merely green: flipping auth to fail-open,
> un-gating unknown capabilities, swallowing vendor errors, and disabling dedupe
> each turned it red (2026-07-31). Hold new tests to the same bar — **an
> assertion that cannot fail is not coverage.** The deploy self-check learned
> this the hard way: its route-existence probe asserted `401 = route present`,
> but unregistered paths answer 401 too (the auth `before_request` hook preempts
> the routing 404), so it was vacuous from the day it was written.

## Adding a capability

1. Add its measured limit to `ratelimit.LIMITS` (source: p3b E9). Anything
   missing falls back to the strictest known window rather than running ungated.
2. Add a route in `app.py`: validate params against the SDK's own constants,
   `rate_gate.check(...)`, call inside `opend.session()`, map with `mappers`.
   Declare it with a literal `@app.get("/path")` — the deploy self-check reads
   that shape out of the source and compares it against the running instance's
   `url_map`, so there is **no probe list to keep in sync**. Any other decorator
   form turns `test_deploy_probe_pattern_sees_every_registered_route` red on
   purpose: fix it by syncing the pattern in `deploy/remote-deploy.sh` ②, never
   by loosening the test.
3. Add tests, including the negative paths.
4. Re-run `install.sh`.
