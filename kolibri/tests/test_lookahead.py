"""No lookahead / no repainting: features at bar t depend only on bars <= t."""

from __future__ import annotations

from dataclasses import replace

from conftest import T0

from kolibri.analyst.features import FeatureEngine
from kolibri.backtest.data import synthetic
from kolibri.core.config import Config


def _run(bars: list, n: int) -> object:
    eng = FeatureEngine("BTCEUR")
    out = None
    for b in bars[:n]:
        out = eng.on_bar(b)
    return out


def test_incremental_equals_from_scratch(cfg: Config) -> None:
    bars = synthetic(cfg, T0, (1440 + 400) * 15, seed=11, bar_minutes=15)["BTCEUR"]
    eng = FeatureEngine("BTCEUR")
    stream = [eng.on_bar(b) for b in bars]
    checked = 0
    for t in range(300, len(bars), 97):  # recompute from scratch on bars[:t+1]
        assert stream[t] == _run(bars, t + 1), f"feature mismatch at bar {t}"
        checked += stream[t] is not None
    assert checked > 5  # we actually compared warm features


def test_future_bars_cannot_change_the_past(cfg: Config) -> None:
    bars = synthetic(cfg, T0, 1400 * 15, seed=5, bar_minutes=15)["BTCEUR"]
    t = 1300
    base = _run(bars, t + 1)
    mutated = bars[: t + 1] + [replace(b, close=b.close * 3, high=b.high * 3) for b in bars[t + 1:]]
    eng = FeatureEngine("BTCEUR")
    seen = [eng.on_bar(b) for b in mutated]
    assert seen[t] == base


def test_4h_context_only_updates_on_closed_4h_bar(cfg: Config) -> None:
    bars = synthetic(cfg, T0, 1400 * 15, seed=9, bar_minutes=15)["BTCEUR"]
    eng = FeatureEngine("BTCEUR")
    prev, changed = None, 0
    for b in bars:
        eng.on_bar(b)
        now = (eng.ctx.ema50.value, eng.ctx.adx.value, tuple(eng.ctx.highs))
        if prev is not None and b.close_ts % (240 * 60_000) != 0:
            assert now == prev, "4h context moved on a 15m bar that does not close a 4h bar"
        else:
            changed += now != prev
        prev = now
    assert changed > 50


def test_duplicate_and_out_of_order_bars_ignored(cfg: Config) -> None:
    bars = synthetic(cfg, T0, 1400 * 15, seed=2, bar_minutes=15)["BTCEUR"]
    eng = FeatureEngine("BTCEUR")
    for b in bars:
        eng.on_bar(b)
    last = eng.last
    assert eng.on_bar(bars[-1]) is last
    assert eng.on_bar(bars[-5]) is last


def test_aggregator_is_causal_and_flags_gaps() -> None:
    from decimal import Decimal as D

    from kolibri.analyst.features import Aggregator
    from kolibri.core.models import Bar

    def m(i: int, px: int) -> Bar:
        return Bar("BTCEUR", T0 + i * 60_000, 60_000, D(px), D(px + 1), D(px - 1), D(px), D(1), D(1))

    agg = Aggregator("BTCEUR", 15 * 60_000)
    out = [r for i in range(15) for r in agg.update(m(i, 100 + i))]
    assert len(out) == 1 and out[0][1] is True  # emitted only on the 15th minute
    bar = out[0][0]
    assert (bar.open, bar.high, bar.low, bar.close, bar.volume) == (100, 115, 99, 114, 15)
    gap = [r for i in range(15, 29) for r in agg.update(m(i, 100))]  # last minute of the window missing
    assert gap == []
    nxt = agg.update(m(30, 100))  # next window starts: the gapped one is released, flagged incomplete
    assert len(nxt) == 1 and nxt[0][1] is False and nxt[0][0].open_ts == T0 + 15 * 60_000
    assert agg.update(m(30, 100)) == []  # duplicate ignored
