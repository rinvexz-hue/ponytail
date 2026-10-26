"""Every streaming indicator vs the `ta` reference library (pandas), after warm-up convergence."""

from __future__ import annotations

import math
import random

import pandas as pd
import pytest
import ta

from kolibri.analyst.indicators import ADX, ATR, EMA, MACD, RSI, Bollinger, RollingPercentile, StochRSI, corr_beta


@pytest.fixture(scope="module")
def ohlc() -> tuple[list[float], list[float], list[float]]:
    rng = random.Random(1)
    px, H, L, C = 100.0, [], [], []
    for _ in range(1500):
        o = px
        px *= math.exp(rng.gauss(0.0002, 0.004))
        H.append(max(o, px) * (1 + abs(rng.gauss(0, 0.002))))
        L.append(min(o, px) * (1 - abs(rng.gauss(0, 0.002))))
        C.append(px)
    return H, L, C


def _close(mine: list[float | None], ref: pd.Series, tail: int = 300) -> None:
    for a, b in zip(mine[-tail:], list(ref)[-tail:], strict=True):
        assert a is not None
        assert a == pytest.approx(b, rel=1e-9, abs=1e-9)


def test_ema_rsi_macd_stochrsi(ohlc: tuple[list[float], list[float], list[float]]) -> None:
    _, _, C = ohlc
    c = pd.Series(C)
    ema, rsi, stoch, macd = EMA(21), RSI(14), StochRSI(), MACD()
    e, r, s, m = [], [], [], []
    for x in C:
        e.append(ema.update(x))
        r.append(rsi.update(x))
        s.append(stoch.update(x))
        macd.update(x)
        m.append(macd.hist)
    _close(e, ta.trend.EMAIndicator(c, 21).ema_indicator())
    _close(r, ta.momentum.RSIIndicator(c, 14).rsi())
    _close(s, ta.momentum.StochRSIIndicator(c, 14, 3, 3).stochrsi_k())
    _close(m, ta.trend.MACD(c).macd_diff())


def test_atr_adx_bollinger(ohlc: tuple[list[float], list[float], list[float]]) -> None:
    H, L, C = ohlc
    h, lo, c = pd.Series(H), pd.Series(L), pd.Series(C)
    atr, adx, bb = ATR(14), ADX(14), Bollinger(20, 2)
    a, d, u = [], [], []
    for hi, low, cl in zip(H, L, C, strict=True):
        a.append(atr.update(hi, low, cl))
        d.append(adx.update(hi, low, cl))
        bb.update(cl)
        u.append(bb.upper)
    _close(a, ta.volatility.AverageTrueRange(h, lo, c, 14).average_true_range())
    _close(d, ta.trend.ADXIndicator(h, lo, c, 14).adx())
    _close(u, ta.volatility.BollingerBands(c, 20, 2).bollinger_hband())


def test_rolling_percentile_matches_bruteforce() -> None:
    rng = random.Random(3)
    rp, window = RollingPercentile(50), []
    for _ in range(400):
        x = rng.random()
        window = ([*window, x])[-50:]
        assert rp.update(x) == sum(v <= x for v in window) / len(window)


def test_corr_beta() -> None:
    xs = [math.sin(i) for i in range(60)]
    corr, beta = corr_beta(xs, [2 * x for x in xs])
    assert corr == pytest.approx(1.0) and beta == pytest.approx(2.0)
    assert corr_beta([1, 1, 1], [1, 2, 3]) == (0.0, 0.0)
