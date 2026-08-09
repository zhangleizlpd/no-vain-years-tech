"""Vendor payload -> plain JSON.

Rule from p3b 4.2: the shim **translates, it does not interpret**. Column names
are passed through exactly as the SDK reports them — no renaming, no derived
values, no business filtering. Whatever the server wants to reshape, it reshapes
on its side, because the day a second source (Schwab / IBKR) implements the same
port, only the shim gets replaced.

The one real job here is making pandas output JSON-safe: `to_dict` hands back
numpy scalars and NaN/NaT, none of which survive `json.dumps`.
"""

from __future__ import annotations

import math
from typing import Any

import pandas as pd


def _is_missing(value: Any) -> bool:
    """True for None / NaN / NaT. Guarded because `pd.isna` raises on
    array-likes and returns arrays for containers."""
    if value is None:
        return True
    if isinstance(value, (list, dict, tuple, set)):
        return False
    try:
        return bool(pd.isna(value))
    except (TypeError, ValueError):
        return False


def clean_value(value: Any) -> Any:
    """Coerce one cell into something `json.dumps` accepts."""
    if _is_missing(value):
        return None
    unwrap = getattr(value, "item", None)  # numpy scalar -> Python scalar
    if callable(unwrap):
        try:
            value = unwrap()
        except (ValueError, TypeError):
            return str(value)
    if isinstance(value, bool):
        return value
    if isinstance(value, float):
        # inf survives .item() but not JSON; treat as missing rather than emit
        # a value the server would have to special-case.
        return None if math.isinf(value) or math.isnan(value) else value
    if isinstance(value, (str, int)):
        return value
    return str(value)


def dataframe_to_records(frame: pd.DataFrame | None) -> list[dict[str, Any]]:
    """DataFrame -> list of JSON-safe dicts. Empty/None -> []."""
    if frame is None or len(frame) == 0:
        return []
    return [
        {str(key): clean_value(value) for key, value in row.items()}
        for row in frame.to_dict(orient="records")
    ]


def rows_to_records(rows: Any) -> list[dict[str, Any]]:
    """Normalise an SDK return that is already a list of dicts.

    `request_trading_days` returns `[{'time': ..., 'trade_date_type': ...}]`
    rather than a DataFrame, so it needs its own (trivial) path.
    """
    if not rows:
        return []
    return [
        {str(key): clean_value(value) for key, value in row.items()}
        for row in rows
        if isinstance(row, dict)
    ]


# `get_market_snapshot` 期权行的 greeks 块。IV 算在内不是凑数: 实值腿的 bid 跌破内在价值时
# IV 无解, 五个 greeks 与 IV 是**一起**没有的 —— 实测 2150 行里 227 行如此, 其中 99.5% 是
# 深实值腿。少列一个字段, 该字段单独缺失时行会被标成「完整」。
GREEK_FIELDS: tuple[str, ...] = (
    "option_implied_volatility",
    "option_delta",
    "option_gamma",
    "option_vega",
    "option_theta",
    "option_rho",
)


def mark_greeks_completeness(
    records: list[dict[str, Any]], fields: tuple[str, ...] = GREEK_FIELDS
) -> list[dict[str, Any]]:
    """就地给每行加 `greeks_complete`，**一行都不丢**。

    🚨 缺 greeks 的行**必须照常返回**：在这里丢掉，下游连「这条腿存在但算不出档」都无从
    知道，而那正是消费端要显式标注的状态（缺 Δ ⇒ 无法定档，行被筛没且无人发现）。缺失是
    数学固有现象、不是脏数据，见 `GREEK_FIELDS` 的实测数字。

    这是本模块唯一一处「加字段」，且它**不算 interpretation**：判的是字段在不在，不看值代表
    什么。存在的理由是「greeks 缺了」必须能与「这条腿今天整行没采到」区分开 —— 后者是真缺口，
    前者不是，而两者在下游长得一模一样（都是没有 Δ 可用）。

    非期权行（标的自身那行，spot 的来源）标 `None` = 不适用：标 `False` 会被读作
    「这只票 greeks 缺失」。

    就地改：入参是 `dataframe_to_records` 刚构造出来的记录，复制一份只是徒增一次全表拷贝。
    复杂度 O(n × |fields|)，`fields` 是常量长度 ⇒ 实为 O(n)。
    """
    for record in records:
        if record.get("option_valid") is not True:
            record["greeks_complete"] = None
            continue
        record["greeks_complete"] = all(record.get(field) is not None for field in fields)
    return records


def dedupe_by(records: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    """Stable de-dupe, first occurrence wins.

    Needed because the universe endpoint unions several security types and Futu
    can report the same code under more than one (a REIT such as VICI shows up
    as ETF, and codes have been observed in overlapping buckets). De-duping is
    mechanical, not a business filter — no row is dropped on its contents.
    """
    seen: set[Any] = set()
    out: list[dict[str, Any]] = []
    for record in records:
        identity = record.get(key)
        if identity in seen:
            continue
        seen.add(identity)
        out.append(record)
    return out
