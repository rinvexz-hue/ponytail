from __future__ import annotations

import asyncio
from dataclasses import replace
from decimal import Decimal as D

import pytest

from kolibri.adapters.sim import SimBroker
from kolibri.analyst.features import Features
from kolibri.core.config import Config, load_config, with_overrides
from kolibri.core.journal import Journal
from kolibri.core.models import Candidate, Direction, Intent
from kolibri.executioner.executioner import Executioner
from kolibri.risk.officer import Approval

T0 = 1_780_012_800_000  # a UTC midnight


@pytest.fixture
def cfg() -> Config:
    return load_config()


def cheap(cfg: Config, **extra: object) -> Config:
    """Low-fee venue so trade mechanics can be exercised; never a statement about real costs."""
    ov: dict[str, object] = {"venues.binance.maker_fee": "0", "venues.binance.taker_fee": "0.0001"}
    ov.update(extra)
    return with_overrides(cfg, ov)


def feat(**kw: object) -> Features:
    """A clean trend-up pullback (setup A long) on a price-100 market."""
    base = Features(
        symbol="BTCUSDT", ts=T0 + 3_600_000, warm=True, close=100.2, high=100.25, low=99.9, open=100.0, atr=0.3,
        ema9=100.1, ema21=100.0, ema50=99.5, vwap=99.95, avwap=99.95, prev_day_vwap=99.0, prev_day_high=101.5,
        prev_day_low=98.0, rsi7=45.0, rsi7_prev=40.0, rsi7_min3=38.0, rsi7_max3=45.0, rsi14=55.0, stochrsi=0.3,
        macd_slope5=0.1, bb_upper=101.0, bb_lower=99.0, bb_mid=100.0, bw_pct=0.5, adx=30.0, rv_pct=0.5, volz=2.2,
        bar_delta=10.0, prev_bar_delta=-5.0, cvd_div=0, taker_ratio=0.62, bias15=1, bias60=1, vwap_crosses=0,
        bars_since_squeeze=1000, mom5_atr=0.5, swing_high=101.0, swing_low=99.5, low5=99.9, high5=100.3, gap=False,
        corr_leader=1.0, leader_mom5_atr=1.2,
    )
    return replace(base, **kw)  # type: ignore[arg-type]


def intent(sym: str = "BTCUSDT", entry: str = "100", stop: str = "99", tp1: str = "101", tp2: str | None = None,
           d: Direction = Direction.LONG, full_exit: bool = False, atr: str = "1") -> Intent:
    c = Candidate(sym, "A_pullback", d, T0, D(entry), D(stop), D(tp1), D(tp2) if tp2 else None, D(atr),
                  full_exit=full_exit)
    return Intent(c, 80.0, D("0.3"), D("0.05"), {})


class Harness:
    """Executioner + SimBroker wired together, driven by explicit price ticks."""

    def __init__(self, cfg: Config, quote: str = "100000") -> None:
        self.cfg = cfg
        self.broker = SimBroker(cfg, D(quote))
        self.j = Journal()
        self.closed: list = []
        self.alarms: list[str] = []
        self.exe = Executioner(cfg, self.broker, self.j, self.closed.append, lambda r, t: self.alarms.append(r),
                               lambda: self.broker.equity(self.exe.marks))

    def tick(self, sym: str, ts: int, px: str) -> None:
        asyncio.run(self._tick(sym, ts, D(px)))

    async def _tick(self, sym: str, ts: int, px: D) -> None:
        self.broker.on_price(sym, ts, px)
        await self.exe.pump(ts)
        await self.exe.on_tick(sym, px, ts)
        await self.exe.pump(ts)

    def open(self, it: Intent, qty: str = "1", touch: str | None = None, now: int = T0) -> None:
        asyncio.run(self.exe.open(it, Approval(D(qty), D(qty)), D(touch or str(it.candidate.entry)), now))

    def run(self, coro: object) -> object:
        return asyncio.run(coro)  # type: ignore[arg-type]

    def stop_order(self, sym: str):  # the venue-side open stop, if any
        return [lv.order for lv in self.broker.orders.values()
                if lv.order.symbol == sym and lv.order.purpose == "stop" and lv.order.open]
