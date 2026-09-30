"""Scout: live market data. Builds closed 1m bars from the trade stream (exact taker-buy volume),
summarises the L2 book, tracks per-symbol health and exchange clock drift.

Bars close on a timer at minute boundary + grace, using exchange timestamps for bucketing;
trades that arrive after their minute was closed are counted as `late` and dropped (no repaint)."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from kolibri.core.config import Config
from kolibri.core.models import MINUTE_MS, Bar, Book

log = logging.getLogger(__name__)


def now_ms() -> int:
    return int(time.time() * 1000)


@dataclass(slots=True)
class SymbolHealth:
    last_msg_ms: int = 0
    connected: bool = False
    disconnected_since: int | None = None
    ever_connected: bool = False
    late_trades: int = 0
    reconnects: int = 0


@dataclass(slots=True)
class _Acc:
    open_ts: int
    o: Decimal
    h: Decimal
    lo: Decimal
    c: Decimal
    v: Decimal = Decimal(0)
    tb: Decimal = Decimal(0)


@dataclass
class BarBuilder:
    """Trade prints -> closed 1m bars. Deterministic given the trade sequence and close calls."""

    symbols: tuple[str, ...]
    acc: dict[tuple[str, int], _Acc] = field(default_factory=dict)
    last_close: dict[str, Decimal] = field(default_factory=dict)
    closed_until: int = 0  # every minute < this has been emitted
    late: int = 0

    def on_trade(self, sym: str, ts: int, price: Decimal, qty: Decimal, taker_buy: bool) -> None:
        start = ts - ts % MINUTE_MS
        if start < self.closed_until:
            self.late += 1  # its minute is already closed: never repaint
            return
        a = self.acc.get((sym, start))
        if a is None:
            a = self.acc[(sym, start)] = _Acc(start, price, price, price, price)
        a.h, a.lo, a.c = max(a.h, price), min(a.lo, price), price
        a.v += qty
        if taker_buy:
            a.tb += qty

    def close_minute(self, minute_start: int) -> dict[str, Bar]:
        """Emit bars for [minute_start, +1m). Symbols without trades get a flat zero-volume bar."""
        out: dict[str, Bar] = {}
        for sym in self.symbols:
            a = self.acc.pop((sym, minute_start), None)
            if a is not None:
                out[sym] = Bar(sym, minute_start, MINUTE_MS, a.o, a.h, a.lo, a.c, a.v, a.tb)
                self.last_close[sym] = a.c
            elif sym in self.last_close:
                p = self.last_close[sym]
                out[sym] = Bar(sym, minute_start, MINUTE_MS, p, p, p, p, Decimal(0), Decimal(0))
        for key in [k for k in self.acc if k[1] < minute_start]:  # stragglers from skipped minutes
            del self.acc[key]
        self.closed_until = minute_start + MINUTE_MS
        return out


def book_summary(ob: dict[str, Any], ts: int) -> Book | None:
    bids = [(Decimal(str(p)), Decimal(str(q))) for p, q, *_ in ob.get("bids", [])[:20]]
    asks = [(Decimal(str(p)), Decimal(str(q))) for p, q, *_ in ob.get("asks", [])[:20]]
    if not bids or not asks:
        return None

    def imb(n: int) -> float:
        b = sum((q for _, q in bids[:n]), Decimal(0))
        a = sum((q for _, q in asks[:n]), Decimal(0))
        return float(b / (a + b)) if a + b > 0 else 0.5

    return Book(ts=ts, bid=bids[0][0], ask=asks[0][0], imbalance5=imb(5), imbalance10=imb(10),
                depth10_bid_usd=sum((p * q for p, q in bids[:10]), Decimal(0)),
                depth10_ask_usd=sum((p * q for p, q in asks[:10]), Decimal(0)),
                bids=tuple(bids), asks=tuple(asks))


def ccxt_symbol(cfg: Config, sym: str) -> str:
    base = cfg.symbol_specs[sym].base
    return f"{base}/{sym[len(base):]}"


class Scout:
    """Owns the ccxt.pro public client. Calls back into the runtime; never trades."""

    def __init__(self, cfg: Config, exchange: Any,
                 on_trade: Callable[[str, int, Decimal, Decimal, bool], Awaitable[None]],
                 on_book: Callable[[str, Book], None]) -> None:
        self.cfg, self.ex = cfg, exchange
        self.on_trade_cb, self.on_book_cb = on_trade, on_book
        self.health = {s: SymbolHealth() for s in cfg.symbols}
        self.clock_drift_ms = 0.0
        self.running = True

    def _mark(self, sym: str, ok: bool) -> None:
        h, now = self.health[sym], now_ms()
        if ok:
            h.last_msg_ms, h.ever_connected = now, True
            if not h.connected:
                h.connected, h.disconnected_since = True, None
        elif h.connected:
            h.connected, h.disconnected_since, h.reconnects = False, now, h.reconnects + 1

    async def _loop(self, sym: str, fn: Callable[[], Awaitable[None]]) -> None:
        backoff = 1.0
        while self.running:
            try:
                await fn()
                backoff = 1.0
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self._mark(sym, False)
                log.warning("stream %s error %s; reconnect in %.0fs", sym, type(e).__name__, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    async def trades(self, sym: str) -> None:
        cs = ccxt_symbol(self.cfg, sym)

        async def once() -> None:
            for t in await self.ex.watch_trades(cs):
                self._mark(sym, True)
                await self.on_trade_cb(sym, int(t["timestamp"]), Decimal(str(t["price"])),
                                       Decimal(str(t["amount"])), t.get("side") == "buy")

        await self._loop(sym, once)

    async def book(self, sym: str) -> None:
        cs = ccxt_symbol(self.cfg, sym)

        async def once() -> None:
            ob = await self.ex.watch_order_book(cs, 25)  # Kraken depths: 10, 25, 100, 500, 1000
            self._mark(sym, True)
            b = book_summary(ob, int(ob.get("timestamp") or now_ms()))
            if b is not None:
                self.on_book_cb(sym, b)

        await self._loop(sym, once)

    async def clock(self) -> None:
        while self.running:
            try:
                t0 = now_ms()
                server = int(await self.ex.fetch_time())
                t1 = now_ms()
                self.clock_drift_ms = server - (t0 + t1) / 2
            except Exception as e:
                log.warning("clock check failed: %s", type(e).__name__)
            await asyncio.sleep(60)

    async def warmup_bars(self, sym: str, days: int, data_dir: str | None = None) -> list[Bar]:
        """Closed 1m bars for warm-up: the local bar store first, then only the missing tail rebuilt
        from Kraken's public trade history (Kraken candles carry no taker-buy volume)."""
        from kolibri.backtest.data import load_bars

        end = now_ms() - now_ms() % MINUTE_MS
        start = end - days * 1440 * MINUTE_MS
        stored = load_bars(data_dir, sym, start, end) if data_dir else []
        tail_from = stored[-1].close_ts if stored else start
        return stored + await bars_from_trades(self.ex, self.cfg, sym, tail_from, end)


async def bars_from_trades(ex: Any, cfg: Config, sym: str, start_ms: int, end_ms: int,
                           progress: Callable[[int], None] | None = None) -> list[Bar]:
    """Rebuild closed 1m bars in [start_ms, end_ms) from the venue's public trades, through the same
    BarBuilder the live feed uses (so historical and live bars are built identically)."""
    start_ms -= start_ms % MINUTE_MS
    builder = BarBuilder((sym,))
    out: list[Bar] = []
    minute, since, seen = start_ms, start_ms, set[str]()
    cs = ccxt_symbol(cfg, sym)

    def close_until(ts: int) -> None:
        nonlocal minute
        while minute + MINUTE_MS <= min(ts, end_ms):
            bar = builder.close_minute(minute).get(sym)
            if bar is not None:
                out.append(bar)
            minute += MINUTE_MS

    while since < end_ms:
        page = await ex.fetch_trades(cs, since=since, limit=1000)
        fresh = [t for t in page if str(t["id"]) not in seen and start_ms <= int(t["timestamp"]) < end_ms]
        if not fresh:
            if not page or int(page[-1]["timestamp"]) >= end_ms:
                break
            since = int(page[-1]["timestamp"]) + 1  # a full page inside one millisecond
            continue
        for t in fresh:
            seen.add(str(t["id"]))
            ts = int(t["timestamp"])
            close_until(ts)
            builder.on_trade(sym, ts, Decimal(str(t["price"])), Decimal(str(t["amount"])), t.get("side") == "buy")
        since = int(fresh[-1]["timestamp"])
        if len(seen) > 200_000:
            seen = {str(t["id"]) for t in fresh}  # ids only need to cover the page boundary
        if progress:
            progress(since)
    close_until(end_ms)
    return out
