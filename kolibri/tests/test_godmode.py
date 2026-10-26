"""E_gm: the rebuilt GOD-MODE-style breakout, its single RR target, and the raw (paper-only) mode."""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal as D

import pytest
from conftest import T0, Harness, feat

from kolibri.analyst.analyst import Analyst, Health, build_candidate, setup_e
from kolibri.analyst.indicators import EMA, ZLEMA
from kolibri.core.config import Config, with_overrides
from kolibri.core.models import Candidate, Direction, Intent, Regime, Rejection
from kolibri.runtime import LiveRefused, assert_mode_allowed

LONG, SHORT = Direction.LONG, Direction.SHORT
GM = {"close": 101.2, "open": 100.6, "high": 101.3, "swing_high": 101.0, "ema_trend": 99.0, "zlema": 100.8,
      "zlema_prev": 100.5}


def test_zlema_is_an_ema_of_the_lag_corrected_price() -> None:
    xs = [100 + (i % 7) - 0.3 * i for i in range(40)]
    z, ref = ZLEMA(9), EMA(9)  # lag (9-1)//2 = 4
    for i, x in enumerate(xs):
        got = z.update(x)
        want = ref.update(2 * x - xs[i - 4]) if i >= 4 else None
        assert got == want


def test_setup_e_fires_only_on_a_trend_aligned_breakout(cfg: Config) -> None:
    f = feat(**GM)
    assert setup_e(f, LONG, cfg) is not None
    for kw in ({"ema_trend": 102.0}, {"zlema_prev": 101.0}, {"swing_high": 101.5}, {"open": 101.25}):
        assert setup_e(replace(f, **kw), LONG, cfg) is None, kw  # type: ignore[arg-type]
    assert setup_e(f, SHORT, cfg) is None
    assert setup_e(feat(), LONG, cfg) is None  # trend line not warm yet (needs 200 bars)


def test_gm_trade_has_one_target_at_rr_times_risk(cfg: Config) -> None:
    f = feat(**GM)
    trig = setup_e(f, LONG, cfg)
    assert trig is not None
    c = build_candidate(f, "E_gm", LONG, trig, cfg.symbol_specs["BTCEUR"], cfg)
    risk = c.entry - c.stop  # 1.2 ATR = 0.36, stop rounded down to the 0.1 tick -> 0.4
    assert risk == D("0.4") and c.tp1 == c.entry + cfg.strategy.gm_rr * risk
    assert c.full_exit and c.tp2 is None


def _gm_gate(cfg: Config, regime: Regime = Regime.RANGE) -> Intent | Rejection:
    f = feat(**GM)
    trig = setup_e(f, LONG, cfg)
    assert trig is not None
    c = build_candidate(f, "E_gm", LONG, trig, cfg.symbol_specs["BTCEUR"], cfg)
    return Analyst(cfg)._gates(f, c, regime, D("10000"), Health(), None, cfg.symbol_specs["BTCEUR"])


def test_raw_mode_trades_the_rules_kolibri_filters_them(cfg: Config) -> None:
    res = _gm_gate(cfg)  # Kraken fees, wrong regime: KOLIBRI's filters say no
    assert isinstance(res, Rejection)
    raw = with_overrides(cfg, {"strategy.raw_setups": ["E_gm"]})
    assert isinstance(_gm_gate(raw), Intent)  # raw: its own rules, risk + health still apply


def test_live_refuses_raw_setups(cfg: Config, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("LIVE_CONFIRM", "I_ACCEPT_THE_RISK")
    with pytest.raises(LiveRefused, match="raw_setups"):
        assert_mode_allowed(with_overrides(cfg, {"mode": "live", "strategy.raw_setups": ["E_gm"]}))


def test_raw_setups_hold_to_target_or_stop_no_time_stop(cfg: Config) -> None:
    raw = with_overrides(cfg, {"strategy.raw_setups": ["E_gm"]})
    for c_cfg, expect_open in ((raw, True), (cfg, False)):
        h = Harness(c_cfg)
        h.tick("BTCEUR", T0 - 1000, "100.05")
        c = Candidate("BTCEUR", "E_gm", LONG, T0, D("100"), D("99"), D("101.5"), None, D("1"), full_exit=True)
        h.open(Intent(c, 80.0, D("0.3"), D("0.05"), {}), touch="100.00")
        h.tick("BTCEUR", T0 + 200, "99.99")
        limit = cfg.strategy.time_stop_s * 1000
        h.tick("BTCEUR", T0 + limit + 1_000, "100.20")
        h.tick("BTCEUR", T0 + limit + 2_000, "100.20")
        assert ("BTCEUR" in h.exe.positions) is expect_open
