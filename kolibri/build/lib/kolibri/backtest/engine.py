"""Event-driven backtester. Drives the exact same Desk/Executioner/SimBroker used in paper mode.

Each 1m bar is replayed as a 4-point price path (open, first extreme, second extreme, close) spread
across the minute, with the adverse-to-close extreme first; signals only fire at bar close and
orders become active after the configured latency, so a signal can never trade its own bar."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from kolibri.adapters.sim import SimBroker
from kolibri.backtest.metrics import summarize
from kolibri.core.config import Config
from kolibri.core.journal import Journal
from kolibri.core.models import Bar, ClosedTrade
from kolibri.desk import Desk


def bar_path(b: Bar) -> list[tuple[int, Decimal]]:
    first, second = (b.low, b.high) if b.close >= b.open else (b.high, b.low)
    return [(b.open_ts, b.open), (b.open_ts + 20_000, first), (b.open_ts + 40_000, second), (b.close_ts - 1, b.close)]


@dataclass
class BacktestResult:
    trades: list[ClosedTrade]
    curve: list[tuple[int, Decimal]]
    stats: dict[str, Any]
    rejections: dict[str, int] = field(default_factory=dict)
    intents: int = 0


async def run_async(cfg: Config, bars: dict[str, list[Bar]], journal: Journal | None = None) -> BacktestResult:
    j = journal or Journal(":memory:", commit_every=5000)
    broker = SimBroker(cfg, cfg.paper_equity)
    desk = Desk(cfg, broker, j, cfg.paper_equity)
    by_ts: dict[int, dict[str, Bar]] = {}
    for sym, series in bars.items():
        for b in series:
            by_ts.setdefault(b.open_ts, {})[sym] = b
    syms = sorted(bars)
    for ts in sorted(by_ts):
        batch = by_ts[ts]
        paths = {s: bar_path(batch[s]) for s in syms if s in batch}
        for k in range(4):
            for s, path in paths.items():
                pts, px = path[k]
                broker.on_price(s, pts, px)
                await desk.on_price(s, px, pts)
        await desk.on_bars(batch, ts + 60_000)
    # close anything still open at the last price so results are complete
    end = max(by_ts) + 60_000 if by_ts else 0
    await desk.exe.flatten_all("backtest_end", end)
    for s in syms:
        if s in broker.last:
            broker.on_price(s, end + 1_000, broker.last[s])
            await desk.on_price(s, broker.last[s], end + 1_000)
    curve = list(desk.equity_curve)
    rej: dict[str, int] = {}
    for ev in j.query("rejection"):
        g = str(ev.data["gate"])
        rej[g] = rej.get(g, 0) + 1
    return BacktestResult(desk.trades, curve, summarize(desk.trades, curve), rej, len(desk.intents))


def run(cfg: Config, bars: dict[str, list[Bar]], journal: Journal | None = None) -> BacktestResult:
    return asyncio.run(run_async(cfg, bars, journal))
