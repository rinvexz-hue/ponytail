"""Every gate is tested in both directions (can pass, can fail) so none is dead or a no-op."""

from __future__ import annotations

from datetime import UTC, datetime
from decimal import Decimal as D

import pytest
from conftest import T0, cheap, feat

from kolibri.analyst.analyst import (
    SETUPS,
    Analyst,
    Health,
    build_candidate,
    classify,
    in_blackout,
    setup_a,
    setup_b,
    setup_c,
    setup_d,
)
from kolibri.core.config import Config, with_overrides
from kolibri.core.models import Book, Direction, Intent, Regime, Rejection

LONG, SHORT = Direction.LONG, Direction.SHORT
EQ = D("10000")


def _eval(cfg: Config, f=None, regime=Regime.TREND_UP, health=Health(), book=None, setup="A_pullback", d=LONG):
    f = f or feat()
    trig = SETUPS[setup](f, d, cfg) or (f.low5 - 0.03, None, False)
    c = build_candidate(f, setup, d, trig, cfg.symbol_specs[f.symbol], cfg)
    return Analyst(cfg)._gates(f, c, regime, EQ, health, book, cfg.symbol_specs[f.symbol])


def gate_of(res: Intent | Rejection) -> str:
    return "PASS" if isinstance(res, Intent) else res.gate


def test_baseline_passes_every_gate_with_default_risk_config(cfg: Config) -> None:
    # default config except venue fees: proves no hard gate is dead under the shipped thresholds
    assert gate_of(_eval(cheap(cfg))) == "PASS"


def test_default_fees_block_small_targets(cfg: Config) -> None:
    res = _eval(cfg)  # 0.075 % per side after BNB discount vs a 33 bps target
    assert gate_of(res) == "4_cost"


@pytest.mark.parametrize(
    ("kw", "regime", "health", "gate"),
    [
        ({}, Regime.RANGE, Health(), "1_regime"),
        ({}, Regime.CHAOS, Health(), "1_regime"),
        ({"low5": 98.0}, Regime.TREND_UP, Health(), "1_stop_distance"),
        ({"bias_15m": -1}, Regime.TREND_UP, Health(), "2_htf"),
        ({"bias_4h": -1}, Regime.TREND_UP, Health(), "2_htf"),
        ({"stack_4h": -1}, Regime.TREND_UP, Health(), "2_htf"),
        ({"ema50_4h": 101.0}, Regime.TREND_UP, Health(), "2_htf"),  # trend pullback below the 4h EMA50
        ({"hi_4h": 100.6}, Regime.TREND_UP, Health(), "2_4h_room"),  # 4h resistance right overhead
        ({"symbol": "ETHEUR", "leader_mom5_atr": -1.5}, Regime.TREND_UP, Health(), "2_leader"),
        ({"spread_bps": 9.0}, Regime.TREND_UP, Health(), "3_spread"),
        ({"gap": True}, Regime.TREND_UP, Health(), "5_data_gap"),
        ({}, Regime.TREND_UP, Health(connected=False), "5_data_gap"),
        ({}, Regime.TREND_UP, Health(tick_age_s=2.5), "5_stale"),
        ({}, Regime.TREND_UP, Health(clock_drift_ms=300), "5_clock"),
        ({"volz": 0.1, "taker_ratio": 0.5, "bar_delta": -1.0, "macd_slope": -1.0, "leader_mom5_atr": -0.5},
         Regime.TREND_UP, Health(), "score"),
    ],
)
def test_each_gate_fails(cfg: Config, kw: dict, regime: Regime, health: Health, gate: str) -> None:
    assert gate_of(_eval(cheap(cfg), feat(**kw), regime, health)) == gate


def test_slippage_gate_walks_the_book(cfg: Config) -> None:
    c = cheap(cfg)
    thin = Book(T0, D("100.19"), D("100.21"), 0.5, 0.5, D(10**6), D(10**6), bids=((D("100.19"), D("0.001")),),
                asks=((D("100.21"), D("0.001")),))
    assert gate_of(_eval(c, book=thin)) == "3_slippage"
    deep = Book(T0, D("100.19"), D("100.21"), 0.5, 0.5, D(10**6), D(10**6), bids=((D("100.19"), D("1000")),),
                asks=((D("100.21"), D("1000")),))
    assert gate_of(_eval(c, book=deep)) == "PASS"


def test_net_r_gate(cfg: Config) -> None:
    assert gate_of(_eval(cheap(cfg, **{"gates.min_net_r": "9"}))) == "4_net_r"


def test_blackouts(cfg: Config) -> None:
    ev_ts = int(datetime(2026, 10, 14, 12, 30, tzinfo=UTC).timestamp() * 1000)
    assert in_blackout(ev_ts + 9 * 60_000, cfg) == "event:US CPI"
    assert in_blackout(ev_ts + 11 * 60_000, cfg) is None
    c = with_overrides(cfg, {"gates.funding_blackout_enabled": True})
    assert in_blackout(T0 + 8 * 3_600_000 + 60_000, c) == "funding"
    assert in_blackout(T0 + 8 * 3_600_000 + 3 * 60_000, c) is None
    c2 = with_overrides(cfg, {"gates.sessions_allowed": ["london"]})
    assert in_blackout(T0 + 3_600_000, c2) == "session:asia"
    assert gate_of(_eval(cheap(c2))) == "6_blackout"


def test_no_short_on_spot_and_dedup(cfg: Config) -> None:
    c = cheap(cfg)
    assert gate_of(_eval(c, regime=Regime.TREND_DOWN, d=SHORT)) == "0_venue_no_short"
    a = Analyst(c)
    f = feat()
    first = a.evaluate(f, "BTCEUR", EQ, Health(), None)
    assert any(isinstance(r, Intent) for r in first)
    again = a.evaluate(f, "BTCEUR", EQ, Health(), None)
    assert [r.gate for r in again if isinstance(r, Rejection) and r.setup == "A_pullback"] == ["0_dedup"]


def test_regime_classifier(cfg: Config) -> None:
    assert classify(None, cfg) is Regime.WARMUP
    assert classify(feat(), cfg) is Regime.TREND_UP
    assert classify(feat(rv_pct=0.99), cfg) is Regime.CHAOS
    assert classify(feat(spread_bps=50.0), cfg) is Regime.CHAOS
    assert classify(feat(depth_usd=1000.0), cfg) is Regime.CHAOS
    assert classify(feat(bw_pct=0.1), cfg) is Regime.SQUEEZE
    assert classify(feat(ema9=99.0, ema21=99.5, ema50=100.0, bias_15m=-1), cfg) is Regime.TREND_DOWN
    assert classify(feat(adx=15.0, bw_pct=0.3, vwap_crosses=4), cfg) is Regime.RANGE
    assert classify(feat(adx=20.0), cfg) is Regime.NEUTRAL


def test_setup_triggers_both_ways(cfg: Config) -> None:
    assert setup_a(feat(), LONG, cfg) is not None
    assert setup_a(feat(rsi7_min3=20.0), LONG, cfg) is None  # no reset
    assert setup_a(feat(cvd_div=-1), LONG, cfg) is None  # CVD diverging
    mr = feat(low=98.9, low5=98.9, close=99.2, open=99.0, rsi7_min3=20.0, cvd_div=1, vwap=100.0)
    assert setup_b(mr, LONG, cfg) is not None
    assert setup_b(feat(), LONG, cfg) is None
    bo = feat(close=101.2, bb_upper=101.0, bars_since_squeeze=3)
    assert setup_c(bo, LONG, cfg) is not None
    assert setup_c(feat(close=101.2, bars_since_squeeze=50), LONG, cfg) is None
    sw = feat(low=99.4, swing_low=99.5, close=99.8, open=99.6, prev_day_low=None)
    assert setup_d(sw, LONG, cfg) is not None
    assert setup_d(feat(low=99.6, swing_low=99.5, prev_day_low=None), LONG, cfg) is None
    short = feat(high=100.6, swing_high=100.5, close=100.2, open=100.4, bar_delta=-10.0, prev_bar_delta=5.0,
                 prev_day_high=None)
    assert setup_d(short, SHORT, cfg) is not None


def test_candidate_rounding_is_conservative(cfg: Config) -> None:
    f = feat(close=100.237, low5=99.9)
    c = build_candidate(f, "A_pullback", LONG, (99.873, None, False), cfg.symbol_specs["ETHEUR"], cfg)
    assert c.entry == D("100.23") and c.stop == D("99.87")  # entry down, stop down (further away)
    assert c.tp1 == c.entry + (c.entry - c.stop)
    tight = build_candidate(f, "A_pullback", LONG, (100.2, None, False), cfg.symbol_specs["ETHEUR"], cfg)
    assert tight.entry - tight.stop >= D("0.6") * D("0.3") - D("0.01")  # widened to stop_atr_min


def test_mean_reversion_target_inside_1r_exits_fully(cfg: Config) -> None:
    f = feat(close=99.2, vwap=99.4)
    c = build_candidate(f, "B_meanrev", LONG, (98.8, 99.4, False), cfg.symbol_specs["BTCEUR"], cfg)
    assert c.full_exit and c.tp1 == D("99.4") and c.tp2 is None


def test_4h_level_sets_the_final_target(cfg: Config) -> None:
    f = feat()
    c = build_candidate(f, "A_pullback", LONG, (99.87, None, False), cfg.symbol_specs["ETHEUR"], cfg)
    assert c.tp2 == D("102.97")  # 4h high 103 minus 0.1 ATR, rounded toward entry
    beyond = feat(hi_4h=100.0)  # price already above the whole 4h range: no cap, the runner trails
    c2 = build_candidate(beyond, "C_breakout", LONG, (99.87, None, False), cfg.symbol_specs["ETHEUR"], cfg)
    assert c2.tp2 is None
    mr = feat(close=99.2, vwap=101.0, hi_4h=100.5)  # mean reversion: the nearer of VWAP and the 4h level
    c3 = build_candidate(mr, "B_meanrev", LONG, (98.6, 101.0, False), cfg.symbol_specs["ETHEUR"], cfg)
    assert c3.tp2 == D("100.47")
