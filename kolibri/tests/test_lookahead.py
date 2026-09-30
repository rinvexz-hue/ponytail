"""No lookahead / no repainting: features at bar t depend only on bars <= t."""

from __future__ import annotations

from dataclasses import replace

from conftest import T0

from kolibri.analyst.features import FeatureEngine
from kolibri.backtest.data import synthetic
from kolibri.core.config import Config


def _run(bars: list, n: int) -> object:
    eng = FeatureEngine("BTCUSDT")
    out = None
    for b in bars[:n]:
        out = eng.on_bar(b)
    return out


def test_incremental_equals_from_scratch(cfg: Config) -> None:
    bars = synthetic(cfg, T0, 1440 + 400, seed=11)["BTCUSDT"]
    eng = FeatureEngine("BTCUSDT")
    stream = [eng.on_bar(b) for b in bars]
    checked = 0
    for t in range(300, len(bars), 97):  # recompute from scratch on bars[:t+1]
        assert stream[t] == _run(bars, t + 1), f"feature mismatch at bar {t}"
        checked += stream[t] is not None
    assert checked > 5  # we actually compared warm features


def test_future_bars_cannot_change_the_past(cfg: Config) -> None:
    bars = synthetic(cfg, T0, 1400, seed=5)["BTCUSDT"]
    t = 1300
    base = _run(bars, t + 1)
    mutated = bars[: t + 1] + [replace(b, close=b.close * 3, high=b.high * 3) for b in bars[t + 1:]]
    eng = FeatureEngine("BTCUSDT")
    seen = [eng.on_bar(b) for b in mutated]
    assert seen[t] == base


def test_htf_bias_only_updates_on_closed_htf_bar(cfg: Config) -> None:
    bars = synthetic(cfg, T0, 1400, seed=9)["BTCUSDT"]
    eng = FeatureEngine("BTCUSDT")
    prev = None
    for b in bars:
        eng.on_bar(b)
        if prev is not None and b.close_ts % (15 * 60_000) != 0:
            assert eng.ema15.value == prev, "15m EMA moved on a bar that does not close a 15m bar"
        prev = eng.ema15.value


def test_duplicate_and_out_of_order_bars_ignored(cfg: Config) -> None:
    bars = synthetic(cfg, T0, 1400, seed=2)["BTCUSDT"]
    eng = FeatureEngine("BTCUSDT")
    for b in bars:
        eng.on_bar(b)
    last = eng.last
    assert eng.on_bar(bars[-1]) is last
    assert eng.on_bar(bars[-5]) is last
