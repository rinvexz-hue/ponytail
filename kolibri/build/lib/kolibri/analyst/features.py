"""Per-symbol feature engine. Fed one CLOSED 1m bar at a time; derives 5m/15m/1h bars itself,
so higher timeframes are only visible once they have closed."""

from __future__ import annotations

import itertools
import math
from collections import deque
from dataclasses import dataclass, replace
from decimal import Decimal

from kolibri.analyst.indicators import (
    ADX,
    ATR,
    EMA,
    MACD,
    RSI,
    Bollinger,
    Rolling,
    RollingPercentile,
    StochRSI,
    corr_beta,
)
from kolibri.core.models import MINUTE_MS, Bar, Book

DAY_MS = 1440 * MINUTE_MS
SESSION_OPENS_MIN = (0, 7 * 60, 13 * 60 + 30)  # Asia 00:00, London 07:00, NY 13:30 UTC


def session_of(ts: int) -> str:
    m = (ts % DAY_MS) // MINUTE_MS
    if 13 * 60 + 30 <= m < 20 * 60:
        return "ny"
    if 7 * 60 <= m < 13 * 60 + 30:
        return "london"
    if m < 7 * 60:
        return "asia"
    return "off"


@dataclass(frozen=True, slots=True)
class Features:
    symbol: str
    ts: int  # close_ts of the bar these features describe
    warm: bool
    close: float
    high: float
    low: float
    open: float
    atr: float
    ema9: float
    ema21: float
    ema50: float
    vwap: float
    avwap: float
    prev_day_vwap: float | None
    prev_day_high: float | None
    prev_day_low: float | None
    rsi7: float
    rsi7_prev: float
    rsi7_min3: float
    rsi7_max3: float
    rsi14: float
    stochrsi: float | None
    macd_slope5: float | None
    bb_upper: float
    bb_lower: float
    bb_mid: float
    bw_pct: float
    adx: float
    rv_pct: float
    volz: float
    bar_delta: float
    prev_bar_delta: float
    cvd_div: int  # +1 bullish divergence (price down, cvd up), -1 bearish, 0 none
    taker_ratio: float
    bias15: int
    bias60: int
    vwap_crosses: int
    bars_since_squeeze: int
    mom5_atr: float  # 5-bar return in ATR units
    swing_high: float  # highest high of bars t-20..t-2
    swing_low: float
    low5: float
    high5: float
    gap: bool  # a 1m bar was missing before this one
    imbalance5: float | None = None
    imbalance10: float | None = None
    spread_bps: float | None = None
    depth_usd: float | None = None
    # cross-asset, filled in by the Analyst (leader first)
    corr_leader: float = 0.0
    beta_leader: float = 0.0
    leadlag: float = 0.0
    leader_mom5_atr: float = 0.0


class _HTF:
    """Aggregates closed 1m bars into closed N-minute closes."""

    def __init__(self, minutes: int) -> None:
        self.ms = minutes * MINUTE_MS

    def closes(self, bar: Bar) -> bool:
        return bar.close_ts % self.ms == 0


def _sign(x: float, eps: float) -> int:
    return 1 if x > eps else -1 if x < -eps else 0


class FeatureEngine:
    def __init__(self, symbol: str, squeeze_pct: float = 0.15) -> None:
        self.symbol = symbol
        self.squeeze_pct = squeeze_pct
        self.ema9, self.ema21, self.ema50 = EMA(9), EMA(21), EMA(50)
        self.rsi7, self.rsi14, self.stoch = RSI(7), RSI(14), StochRSI()
        self.atr, self.adx, self.bb = ATR(14), ADX(14), Bollinger(20, 2.0)
        self.ret60 = Rolling(60)
        self.rv_pct, self.bw_pct = RollingPercentile(1440), RollingPercentile(1440)
        self.vol_by_minute: dict[int, deque[float]] = {}
        self.vol60 = Rolling(60)
        self.taker = EMA(5)
        self.bars: deque[Bar] = deque(maxlen=30)
        self.cvd = 0.0
        self.cvd_hist: deque[tuple[float, float]] = deque(maxlen=11)
        self.rsi7_hist: deque[float] = deque(maxlen=4)
        self.vwap_side: deque[int] = deque(maxlen=30)
        self.returns: deque[float] = deque(maxlen=61)  # 1m log returns, for cross-asset
        self.htf5, self.htf15, self.htf60 = _HTF(5), _HTF(15), _HTF(60)
        self.macd5 = MACD()
        self.ema15, self.ema60 = EMA(50), EMA(50)
        self.bias15 = self.bias60 = 0
        self.day = -1
        self.day_pv = self.day_v = 0.0
        self.day_high, self.day_low = -math.inf, math.inf
        self.prev_day: tuple[float, float, float] | None = None  # vwap, high, low
        self.sess_anchor = -1
        self.sess_pv = self.sess_v = 0.0
        self.bars_since_squeeze = 10**9
        self.book: Book | None = None
        self._imb5, self._imb10 = EMA(10), EMA(10)
        self.last: Features | None = None
        self.count = 0

    # ---- book (live only; backtests have none and gates treat it as neutral) -------------
    def on_book(self, book: Book) -> None:
        self.book = book
        self._imb5.update(book.imbalance5)
        self._imb10.update(book.imbalance10)

    # ---- bars ----------------------------------------------------------------------------
    def on_bar(self, bar: Bar) -> Features | None:
        prev = self.bars[-1] if self.bars else None
        if prev is not None and bar.open_ts <= prev.open_ts:
            return self.last  # duplicate / out-of-order bar: ignore
        gap = prev is not None and bar.open_ts != prev.close_ts
        o, h, lo, c = float(bar.open), float(bar.high), float(bar.low), float(bar.close)
        v, tb = float(bar.volume), float(bar.taker_buy_volume)
        self.count += 1

        # sessions / VWAP (anchored at UTC day and at the latest session open)
        day = bar.open_ts // DAY_MS
        if day != self.day:
            if self.day >= 0 and self.day_v > 0:
                self.prev_day = (self.day_pv / self.day_v, self.day_high, self.day_low)
            self.day, self.day_pv, self.day_v = day, 0.0, 0.0
            self.day_high, self.day_low = -math.inf, math.inf
            self.cvd = 0.0
        minute = (bar.open_ts % DAY_MS) // MINUTE_MS
        anchor = day * 1440 + max(m for m in SESSION_OPENS_MIN if m <= minute)
        if anchor != self.sess_anchor:
            self.sess_anchor, self.sess_pv, self.sess_v = anchor, 0.0, 0.0
        tp = (h + lo + c) / 3
        self.day_pv += tp * v
        self.day_v += v
        self.sess_pv += tp * v
        self.sess_v += v
        self.day_high, self.day_low = max(self.day_high, h), min(self.day_low, lo)
        vwap = self.day_pv / self.day_v if self.day_v else c
        avwap = self.sess_pv / self.sess_v if self.sess_v else c

        # trend / momentum / volatility
        e9, e21, e50 = self.ema9.update(c), self.ema21.update(c), self.ema50.update(c)
        r7, r14, srsi = self.rsi7.update(c), self.rsi14.update(c), self.stoch.update(c)
        atr, adx, bw = self.atr.update(h, lo, c), self.adx.update(h, lo, c), self.bb.update(c)
        if r7 is not None:
            self.rsi7_hist.append(r7)
        if prev is not None and float(prev.close) > 0:
            r = math.log(c / float(prev.close))
            self.ret60.update(r)
            self.returns.append(r)
        rv_pct = self.rv_pct.update(self.ret60.std()) if len(self.ret60.q) >= 10 else 0.5
        bw_pct = self.bw_pct.update(bw) if bw is not None else 0.5
        if bw is not None and bw_pct <= self.squeeze_pct and len(self.bw_pct) >= 240:
            self.bars_since_squeeze = 0
        else:
            self.bars_since_squeeze += 1

        # volume / order flow
        base = self.vol_by_minute.setdefault(minute, deque(maxlen=20))
        ref = list(base) if len(base) >= 5 else list(self.vol60.q)
        volz = 0.0
        if len(ref) >= 5:
            m = sum(ref) / len(ref)
            sd = math.sqrt(sum((x - m) ** 2 for x in ref) / len(ref))
            volz = (v - m) / sd if sd > 0 else 0.0
        base.append(v)
        self.vol60.update(v)
        delta = 2 * tb - v
        prev_delta = (2 * float(prev.taker_buy_volume) - float(prev.volume)) if prev else 0.0
        self.cvd += delta
        self.cvd_hist.append((c, self.cvd))
        cvd_div = 0
        if len(self.cvd_hist) == self.cvd_hist.maxlen:
            dp = c - self.cvd_hist[0][0]
            dc = self.cvd - self.cvd_hist[0][1]
            if dp < 0 < dc:
                cvd_div = 1
            elif dc < 0 < dp:
                cvd_div = -1
        taker_ratio = self.taker.update(tb / v if v > 0 else 0.5) or 0.5
        self.vwap_side.append(1 if c >= vwap else -1)
        sides = list(self.vwap_side)
        crosses = sum(a != b for a, b in itertools.pairwise(sides))

        # higher timeframes: only on the 1m bar that closes them
        self.bars.append(bar)
        if self.htf5.closes(bar):
            self.macd5.update(c)
        if self.htf15.closes(bar):
            p = self.ema15.value
            n = self.ema15.update(c)
            if p is not None and n is not None:
                self.bias15 = _sign(n - p, c * 1e-5)
        if self.htf60.closes(bar):
            p = self.ema60.value
            n = self.ema60.update(c)
            if p is not None and n is not None:
                self.bias60 = _sign(n - p, c * 1e-5)

        bars = list(self.bars)
        swing = bars[-21:-1] if len(bars) > 2 else bars
        last5 = bars[-5:]
        mom5 = c - float(bars[-6].close) if len(bars) >= 6 else 0.0
        warm = (
            None not in (e9, e21, e50, r7, r14, atr, adx, bw)
            and len(self.rsi7_hist) >= 4
            and len(self.rv_pct) >= 240
            and self.ema15.value is not None
        )
        if not warm:
            self.last = None
            return None
        assert e9 is not None and e21 is not None and e50 is not None and r7 is not None
        assert r14 is not None and atr is not None and adx is not None
        assert self.bb.upper is not None and self.bb.lower is not None and self.bb.mid is not None
        book = self.book
        f = Features(
            symbol=self.symbol, ts=bar.close_ts, warm=True, close=c, high=h, low=lo, open=o, atr=atr,
            ema9=e9, ema21=e21, ema50=e50, vwap=vwap, avwap=avwap,
            prev_day_vwap=self.prev_day[0] if self.prev_day else None,
            prev_day_high=self.prev_day[1] if self.prev_day else None,
            prev_day_low=self.prev_day[2] if self.prev_day else None,
            rsi7=r7, rsi7_prev=self.rsi7_hist[-2], rsi7_min3=min(list(self.rsi7_hist)[-3:]),
            rsi7_max3=max(list(self.rsi7_hist)[-3:]), rsi14=r14, stochrsi=srsi,
            macd_slope5=self.macd5.slope, bb_upper=self.bb.upper, bb_lower=self.bb.lower,
            bb_mid=self.bb.mid, bw_pct=bw_pct, adx=adx, rv_pct=rv_pct, volz=volz, bar_delta=delta,
            prev_bar_delta=prev_delta, cvd_div=cvd_div, taker_ratio=taker_ratio, bias15=self.bias15,
            bias60=self.bias60, vwap_crosses=crosses, bars_since_squeeze=self.bars_since_squeeze,
            mom5_atr=mom5 / atr if atr > 0 else 0.0,
            swing_high=max(float(b.high) for b in swing), swing_low=min(float(b.low) for b in swing),
            low5=min(float(b.low) for b in last5), high5=max(float(b.high) for b in last5), gap=gap,
            imbalance5=self._imb5.value if book else None,
            imbalance10=self._imb10.value if book else None,
            spread_bps=float(book.spread_bps) if book else None,
            depth_usd=float(min(book.depth10_bid_usd, book.depth10_ask_usd)) if book else None,
        )
        self.last = f
        return f

    def with_cross(self, f: Features, leader: FeatureEngine) -> Features:
        """Attach leader-relative stats (60 x 1m returns). Leader must be updated first."""
        n = min(len(self.returns), len(leader.returns)) - 1
        if n < 20 or leader.last is None:
            return f
        ys = list(self.returns)[-n:]
        xs = list(leader.returns)[-n:]
        corr, beta = corr_beta(xs, ys)
        lag, _ = corr_beta(xs[:-1], ys[1:])  # corr(alt_t, leader_{t-1})
        f = replace(f, corr_leader=corr, beta_leader=beta, leadlag=lag,
                    leader_mom5_atr=leader.last.mom5_atr)
        self.last = f
        return f


def to_dec(x: float) -> Decimal:
    return Decimal(repr(x))
