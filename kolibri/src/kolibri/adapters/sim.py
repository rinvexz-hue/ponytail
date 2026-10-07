"""SimBroker: the matching engine behind both backtests (bar paths) and paper trading (live trades).

Conservative by design:
- post-only / limit orders fill only when price trades THROUGH the level (queue-position unknown);
- every order and cancel becomes effective only after `latency_ms` (so fill-after-cancel happens);
- taker fills pay spread/2 + impact; a stop that gaps fills at the (worse) gapped price;
- spot semantics: cannot sell what you do not hold unless the venue supports shorts.
Fault-injection knobs exist for chaos tests."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, replace
from decimal import Decimal

from kolibri.core.config import Config
from kolibri.core.models import (
    D0,
    Order,
    OrderStatus,
    OrderType,
    OrderUpdate,
    Side,
    bps,
)


@dataclass(slots=True)
class _Live:
    order: Order
    active_ts: int
    cancel_ts: int | None = None
    fills: int = 0


class SimBroker:
    def __init__(self, cfg: Config, quote: Decimal) -> None:
        self.cfg, self.caps = cfg, cfg.venue_cfg
        self.quote = quote
        self.base: dict[str, Decimal] = {s: D0 for s in cfg.symbols}
        self.last: dict[str, Decimal] = {}
        self.orders: dict[str, _Live] = {}
        self._outbox: list[tuple[int, OrderUpdate]] = []
        self._listener: Callable[[OrderUpdate], None] = lambda u: None
        self.latency = cfg.execution.latency_ms
        # chaos knobs
        self.reject_next = 0
        self.extra_fill_delay_ms = 0
        self.duplicate_updates = False
        self.partial_fills = False
        self.reverse_delivery = False

    def set_listener(self, fn: Callable[[OrderUpdate], None]) -> None:
        self._listener = fn

    # ---- requests --------------------------------------------------------------------------
    async def place(self, order: Order, now: int) -> None:
        cid = order.client_id
        if cid in self.orders:  # idempotent: resubmitting the same client id is a no-op
            return
        o = replace(order)  # venue-side copy: the caller's object is never mutated here
        live = _Live(o, now + self.latency)
        self.orders[cid] = live
        reason = ""
        if self.reject_next > 0:
            self.reject_next -= 1
            reason = "injected_reject"
        elif o.type is OrderType.LIMIT_MAKER and o.symbol in self.last and o.price is not None:
            last = self.last[o.symbol]
            if (o.side is Side.BUY and o.price >= last) or (o.side is Side.SELL and o.price <= last):
                reason = "post_only_would_take"
        if reason:
            o.status = OrderStatus.REJECTED
            self._send(now + self.latency, OrderUpdate(cid, OrderStatus.REJECTED, now + self.latency,
                                                       reason=reason))
            return
        o.status = OrderStatus.ACKED
        self._send(now + self.latency, OrderUpdate(cid, OrderStatus.ACKED, now + self.latency))

    async def cancel(self, client_id: str, symbol: str, now: int) -> None:
        live = self.orders.get(client_id)
        if live is None or not live.order.open or live.cancel_ts is not None:
            return
        live.cancel_ts = now + self.latency

    async def positions(self) -> dict[str, Decimal]:
        return {s: q for s, q in self.base.items() if q != 0}

    async def open_orders(self) -> dict[str, str]:
        return {cid: lv.order.symbol for cid, lv in self.orders.items() if lv.order.open}

    def equity(self, marks: dict[str, Decimal]) -> Decimal:
        return self.quote + sum((q * marks.get(s, self.last.get(s, D0)) for s, q in self.base.items()), D0)

    # ---- market ----------------------------------------------------------------------------
    def on_price(self, symbol: str, ts: int, price: Decimal) -> None:
        """Advance the book for one trade print (paper) or one bar-path point (backtest)."""
        self.last[symbol] = price
        for cid, live in list(self.orders.items()):
            o = live.order
            if o.symbol != symbol or not o.open:
                continue
            if live.cancel_ts is not None and ts >= live.cancel_ts:
                o.status = OrderStatus.CANCELED
                self._send(ts, OrderUpdate(cid, OrderStatus.CANCELED, ts))
                continue
            if ts < live.active_ts:
                continue
            px = self._match(o, price)
            if px is not None:
                self._fill(live, ts, px)
        self.deliver(ts)

    def deliver(self, ts: int) -> None:
        due = [x for x in self._outbox if x[0] <= ts]
        self._outbox = [x for x in self._outbox if x[0] > ts]
        if self.reverse_delivery:
            due.reverse()
        for _, u in due:
            self._listener(u)
            if self.duplicate_updates:
                self._listener(u)

    def _send(self, ts: int, u: OrderUpdate) -> None:
        self._outbox.append((ts, u))

    def _match(self, o: Order, price: Decimal) -> Decimal | None:
        spec = self.cfg.symbol_specs[o.symbol]
        slip = bps(spec.spread_bps / 2 + spec.impact_bps)
        buy = o.side is Side.BUY
        if o.type in (OrderType.LIMIT_MAKER, OrderType.LIMIT):
            assert o.price is not None
            through = price < o.price if buy else price > o.price
            return o.price if through else None
        if o.type is OrderType.STOP_MARKET:
            assert o.stop_price is not None
            hit = price >= o.stop_price if buy else price <= o.stop_price
            if not hit:
                return None
            worst = max(price, o.stop_price) if buy else min(price, o.stop_price)
            return worst * (1 + slip) if buy else worst * (1 - slip)
        return price * (1 + slip) if buy else price * (1 - slip)  # MARKET

    def _fill(self, live: _Live, ts: int, px: Decimal) -> None:
        o = live.order
        spec = self.cfg.symbol_specs[o.symbol]
        pos = self.base[o.symbol]
        qty = o.remaining
        if self.partial_fills and live.fills == 0 and qty > spec.step:
            qty = max(spec.step, (qty / 2 // spec.step) * spec.step)
        sign = 1 if o.side is Side.BUY else -1
        if o.reduce_only:
            reducible = abs(pos) if pos * sign < 0 else D0
            qty = min(qty, reducible)
            if qty <= 0:
                o.status = OrderStatus.CANCELED
                self._send(ts, OrderUpdate(o.client_id, OrderStatus.CANCELED, ts, reason="reduce_only_nothing"))
                return
        maker = o.type in (OrderType.LIMIT_MAKER, OrderType.LIMIT)
        fee = qty * px * (self.caps.maker if maker else self.caps.taker)
        if sign > 0 and qty * px + fee > self.quote:
            o.status = OrderStatus.REJECTED
            self._send(ts, OrderUpdate(o.client_id, OrderStatus.REJECTED, ts, reason="insufficient_quote"))
            return
        if sign < 0 and not self.caps.supports_short and qty > pos:
            o.status = OrderStatus.REJECTED
            self._send(ts, OrderUpdate(o.client_id, OrderStatus.REJECTED, ts, reason="insufficient_base"))
            return
        self.base[o.symbol] = pos + sign * qty
        self.quote -= sign * qty * px + fee
        live.fills += 1
        o.filled += qty
        o.status = OrderStatus.FILLED if o.filled >= o.qty else OrderStatus.PARTIAL
        fill_ts = ts + self.extra_fill_delay_ms
        self._send(fill_ts, OrderUpdate(o.client_id, o.status, fill_ts, exec_id=f"{o.client_id}#{live.fills}",
                                        fill_qty=qty, fill_price=px, fee=fee))
        if o.open and o.reduce_only and self.base[o.symbol] == 0:  # nothing left to reduce
            o.status = OrderStatus.CANCELED
            self._send(fill_ts, OrderUpdate(o.client_id, OrderStatus.CANCELED, fill_ts, reason="reduce_only_done"))
