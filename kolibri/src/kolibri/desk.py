"""The Desk wires Scout output -> Analyst -> Risk Officer -> Executioner, and owns the kill switch.

It is transport-agnostic: the backtester, paper runtime and live runtime all drive the same
`on_price` / `on_bars` / `on_book` calls, which is what makes backtest/paper/live parity testable."""

from __future__ import annotations

import logging
from collections import deque
from dataclasses import replace
from decimal import Decimal

from kolibri.adapters.base import ExchangeAdapter
from kolibri.analyst.analyst import Analyst, Health, classify
from kolibri.analyst.features import Aggregator, FeatureEngine, Features
from kolibri.core.config import Config
from kolibri.core.journal import Journal
from kolibri.core.models import MINUTE_MS, Bar, Book, ClosedTrade, Direction, Intent, Rejection
from kolibri.executioner.executioner import Executioner
from kolibri.risk.officer import RiskOfficer

log = logging.getLogger(__name__)


class Desk:
    def __init__(self, cfg: Config, adapter: ExchangeAdapter, journal: Journal, equity0: Decimal) -> None:
        self.cfg, self.ex, self.j = cfg, adapter, journal
        self.analyst = Analyst(cfg)
        self.risk = RiskOfficer(cfg, journal, equity0)
        tf = cfg.timeframes
        self.engines = {s: FeatureEngine(s, cfg.regime.squeeze_pct, tf.context_minutes) for s in cfg.symbols}
        self.signal_aggs = {s: Aggregator(s, tf.signal_minutes * MINUTE_MS) for s in cfg.symbols}
        self.features: dict[str, Features | None] = {}
        self.books: dict[str, Book] = {}
        self.health: dict[str, Health] = {s: Health() for s in cfg.symbols}
        self.exe = Executioner(cfg, adapter, journal, self._closed, self._alarm, self.equity)
        self.trades: list[ClosedTrade] = []
        self.equity_curve: deque[tuple[int, Decimal]] = deque(maxlen=200_000)
        self.intents: deque[Intent] = deque(maxlen=10_000)
        self._alarms: list[tuple[str, int]] = []
        self.killed: str | None = None

    # ---- inputs ----------------------------------------------------------------------------
    def equity(self) -> Decimal:
        return self.ex.equity(self.exe.marks)

    def on_book(self, sym: str, book: Book) -> None:
        self.books[sym] = book
        self.engines[sym].on_book(book)

    async def on_price(self, sym: str, price: Decimal, ts: int) -> None:
        await self.exe.pump(ts)
        await self.exe.on_tick(sym, price, ts)
        await self.exe.pump(ts)
        breach = self.risk.on_equity(self.equity(), ts)
        if breach:
            reason, until = breach
            h = self.risk.halt if self.risk.halted(ts) else None
            if h is None or (until is None and h.get("until") is not None):  # new, or escalate to manual
                await self.kill(reason, ts, until=until)
        await self._handle_alarms()

    def _update_features(self, bars: dict[str, Bar]) -> list[str]:
        """1m bars in; returns the symbols whose signal-timeframe (15m) bar just closed, leader first."""
        order = list(dict.fromkeys(s for s in [self.cfg.leader, *sorted(self.cfg.symbols)] if s in bars))
        lead = self.engines[self.cfg.leader]
        closed: list[str] = []
        for sym in order:
            for sig_bar, complete in self.signal_aggs[sym].update(bars[sym]):
                f = self.engines[sym].on_bar(sig_bar)
                if f is not None:
                    f = self.engines[sym].with_cross(f, lead)
                    if not complete:  # minutes missing inside the 15m bar: data-health gate blocks it
                        f = replace(f, gap=True)
                self.features[sym] = f
                closed.append(sym)
        return list(dict.fromkeys(closed))

    def warm(self, bars: dict[str, Bar]) -> None:
        """Historical warm-up: features only, never signals or orders (regime kept for the dashboard)."""
        for sym in self._update_features(bars):
            self.analyst.regimes[sym] = classify(self.features[sym], self.cfg)

    async def on_bars(self, bars: dict[str, Bar], ts: int) -> None:
        """One batch of closed 1m bars (same open_ts). Analysis runs only when a 15m bar closes."""
        order = self._update_features(bars)
        equity = self.equity()
        for sym in order:
            f = self.features[sym]
            if f is not None:
                await self.exe.on_bar(sym, Decimal(repr(f.atr)), ts)
            for res in self.analyst.evaluate(f, sym, equity, self.health[sym], self.books.get(sym)):
                if isinstance(res, Rejection):
                    self.j.emit("rejection", res.ts, sym, setup=res.setup, direction=res.direction.value,
                                gate=res.gate, detail=res.detail, score=res.score)
                    continue
                await self._consider(res, ts)
        self.equity_curve.append((ts, self.equity()))
        await self._handle_alarms()

    async def _consider(self, intent: Intent, ts: int) -> None:
        c = intent.candidate
        self.j.emit("intent", ts, c.symbol, setup=c.setup, direction=c.direction.value, entry=c.entry, stop=c.stop,
                    tp1=c.tp1, tp2=c.tp2, score=round(intent.score, 2), exp_r=intent.expected_net_r,
                    components=intent.components)
        self.intents.append(intent)
        corr = {s: (f.corr_leader if s != self.cfg.leader else 1.0)
                for s, f in self.features.items() if f is not None}
        if self.exe.orders_last_minute(ts) >= self.cfg.execution.order_rate_per_min:
            # new entries yield to the rate budget; stops / exits are never throttled
            self.j.emit("rejection", ts, c.symbol, setup=c.setup, direction=c.direction.value,
                        gate="8_risk_rate_limit", detail="order budget exhausted", score=intent.score)
            return
        verdict = self.risk.review(intent, list(self.exe.positions.values()), corr, self.exe.busy(), ts)
        if isinstance(verdict, Rejection):
            self.j.emit("rejection", ts, c.symbol, setup=c.setup, direction=c.direction.value, gate=verdict.gate,
                        detail=verdict.detail, score=verdict.score)
            return
        await self.exe.open(intent, verdict, self._touch(c.symbol, c.direction, c.entry), ts)
        self.risk.on_entry()

    def _touch(self, sym: str, d: Direction, fallback: Decimal) -> Decimal:
        book = self.books.get(sym)
        if book is not None:
            return book.bid if d is Direction.LONG else book.ask
        tick = self.cfg.symbol_specs[sym].tick
        last = self.exe.marks.get(sym, fallback)  # no print yet this session: use the bar close
        return last - tick if d is Direction.LONG else last + tick

    # ---- safety ----------------------------------------------------------------------------
    def _alarm(self, reason: str, ts: int) -> None:
        self._alarms.append((reason, ts))

    async def _handle_alarms(self) -> None:
        while self._alarms:
            reason, ts = self._alarms.pop(0)
            await self.kill(reason, ts)

    async def kill(self, reason: str, ts: int, until: int | None = None) -> None:
        """Flatten everything, halt, alert. until=None -> manual re-arm required."""
        self.killed = reason
        self.risk.set_halt(reason, ts, until)
        self.j.emit("kill", ts, reason=reason, manual_rearm=until is None, severity="CRITICAL")
        log.critical("KILL: %s", reason)
        await self.exe.flatten_all(reason, ts)

    def _closed(self, t: ClosedTrade) -> None:
        self.trades.append(t)
        self.risk.on_trade_closed(t)
