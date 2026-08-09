import numpy as np
import pandas as pd

from futu_shim import mappers


def test_dataframe_records_are_json_safe():
    """pandas hands back numpy scalars and NaN; both break json.dumps."""
    frame = pd.DataFrame(
        [
            {"code": "US.AAPL", "lot_size": np.int64(1), "strike_price": np.float64(1.5)},
            {"code": "US.VICI", "lot_size": np.int64(1), "strike_price": np.nan},
        ]
    )
    rows = mappers.dataframe_to_records(frame)
    assert rows[0] == {"code": "US.AAPL", "lot_size": 1, "strike_price": 1.5}
    assert rows[1]["strike_price"] is None
    for row in rows:
        for value in row.values():
            assert value is None or isinstance(value, (str, int, float, bool))


def test_numpy_bool_survives_as_real_bool():
    frame = pd.DataFrame([{"code": "US.AAPL", "delisting": np.bool_(False)}])
    assert mappers.dataframe_to_records(frame)[0]["delisting"] is False


def test_missing_and_non_finite_values_become_none():
    assert mappers.clean_value(None) is None
    assert mappers.clean_value(np.nan) is None
    assert mappers.clean_value(pd.NaT) is None
    assert mappers.clean_value(float("inf")) is None
    assert mappers.clean_value(float("-inf")) is None


def test_empty_or_missing_frame_yields_empty_list():
    assert mappers.dataframe_to_records(None) == []
    assert mappers.dataframe_to_records(pd.DataFrame()) == []


def test_rows_to_records_handles_the_trading_days_shape():
    """request_trading_days returns a list of dicts, not a DataFrame."""
    days = [
        {"time": "2026-07-31", "trade_date_type": "WHOLE"},
        {"time": "2026-08-03", "trade_date_type": "WHOLE"},
    ]
    assert mappers.rows_to_records(days) == days
    assert mappers.rows_to_records([]) == []
    assert mappers.rows_to_records(None) == []


def test_greeks_completeness_covers_the_whole_block_including_iv():
    """标记的字段集就是「整块」的定义 —— 少列一个字段，那个字段缺失时行会被标成完整。

    IV 算在内不是凑数：实值腿 bid 跌破内在价值 ⇒ IV 无解 ⇒ 五个 greeks 与 IV **一起**没有，
    这正是实测 227/2150 行的形状。
    """
    assert set(mappers.GREEK_FIELDS) == {
        "option_implied_volatility",
        "option_delta",
        "option_gamma",
        "option_vega",
        "option_theta",
        "option_rho",
    }

    complete = {"code": "US.PEP260807P145000", "option_valid": True}
    complete.update({field: 0.1 for field in mappers.GREEK_FIELDS})
    partial = dict(complete, option_rho=None)
    whole_block_missing = {"code": "US.PEP260807P150000", "option_valid": True}
    whole_block_missing.update({field: None for field in mappers.GREEK_FIELDS})

    marked = mappers.mark_greeks_completeness([complete, partial, whole_block_missing])
    assert [row["greeks_complete"] for row in marked] == [True, False, False]
    # 🚨 一行都不许丢 —— FR-007「缺 greeks 的腿仍留在表内」的上游保证就在这里。
    assert len(marked) == 3


def test_greeks_completeness_is_not_applicable_to_non_option_rows():
    """标的自身那行（spot 来源）不是期权，标成 `False` 会读作「这只票 greeks 缺失」。
    `None` = 不适用，与「是期权但缺了」区分。"""
    rows = mappers.mark_greeks_completeness(
        [{"code": "US.PEP", "option_valid": False, "last_price": 148.2}, {"code": "US.PEP"}]
    )
    assert [row["greeks_complete"] for row in rows] == [None, None]


def test_dedupe_keeps_first_occurrence_and_preserves_order():
    """A code reported under two security types must appear once — the union
    query is why this exists."""
    records = [
        {"code": "US.VICI", "stock_type": "ETF"},
        {"code": "US.AAPL", "stock_type": "STOCK"},
        {"code": "US.VICI", "stock_type": "STOCK"},
    ]
    out = mappers.dedupe_by(records, "code")
    assert [r["code"] for r in out] == ["US.VICI", "US.AAPL"]
    assert out[0]["stock_type"] == "ETF"  # first wins
