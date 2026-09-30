"""Executioner: order state machine, post-only entries, protective stops, TP1/runner, time stop,
flatten, reconciliation. The exchange is the source of truth; anything we cannot explain is
raised through `on_alarm`, and the Desk answers with flatten + halt + alert."""

from __future__ import annotations

from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from decimal import Decimal

from kolibri.adapters.base import ExchangeAdapter
from kolibri.core.config import Config
from kolibri.core.journal import Journal
from kolibri.core.models import (
    D0,
    TERMINAL,
    ClosedTrade,
    Direction,
    InconsistencyError,
    Intent,
    Order,
    OrderStatus,
    OrderType,
    OrderUpdate,
    Position,
    ceil_to,
    floor_to,
)
from kolibri.risk.officer import Approval


@dataclass(slots=True)
class EntryState:
    intent: Intent
    approval: Approval
    order_id: str
    placed_ts: int
    ref_price: Decimal
    repriced: bool = False
    reprice_pending: bool = False


class Executioner:
    def __init__(self, cfg: Config, adapter: ExchangeAdapter, journal: Journal,
                 on_closed: Callable[[ClosedTrade], None], on_alarm: Callable[[str, int], None],
                 equity: Callable[[], Decimal]) -> None:
        self.cfg, self.ex, self.j = cfg, adapter, journal
        self.on_closed, self.on_alarm, self.equity = on_closed, on_alarm, equity
        self.orders: dict[str, Order] = {}
        self.positions: dict[str, Position] = {}
        self.entries: dict[str, EntryState] = {}
        self.entry_intents: dict[str, Intent] = {}  # kept for late fills after cancel
        self.aborted: dict[str, str] = {}  # entry order id -> flatten reason (late fills get flattened too)
        self.stop_id: dict[str, str] = {}
        self.canceling: set[str] = set()
        self.exiting: set[str] = set()
        self.marks: dict[str, Decimal] = {}
        self.consecutive_rejects = 0
        self.seq = 0
        self.placed_ts: deque[int] = deque(maxlen=10_000)
        self._updates: deque[OrderUpdate] = deque()
        self._seen: set[str] = set()
        self._seen_q: deque[str] = deque(maxlen=50_000)
        self._mismatch: set[str] = set()
        self._equity_before: dict[str, Decimal] = {}
        adapter.set_listener(self._updates.append)

    # ---- helpers ---------------------------------------------------------------------------
    def _new_id(self, symbol: str, purpose: str, now: int) -> str:
        self.seq += 1
        return f"K{purpose[0]}{symbol[:6]}{now % 10**10}{self.seq:04d}"

    async def _place(self, symbol: str, purpose: str, side_dir: Direction, entry: bool, otype: OrderType,
                     qty: Decimal, now: int, price: Decimal | None = None,
                     stop_price: Decimal | None = None) -> Order:
        side = side_dir.entry_side if entry else side_dir.exit_side
        o = Order(client_id=self._new_id(symbol, purpose, now), symbol=symbol, side=side, type=otype, qty=qty,
                  price=price, stop_price=stop_price, reduce_only=not entry, created_ts=now, purpose=purpose)
        self.orders[o.client_id] = o
        self.placed_ts.append(now)
        self.j.emit("order", now, symbol, id=o.client_id, purpose=purpose, side=side.value, type=otype.value,
                    qty=qty, price=price, stop=stop_price)
        await self.ex.place(o, now)
        return o

    async def _cancel(self, cid: str, now: int) -> None:
        o = self.orders.get(cid)
        if o is None or not o.open or cid in self.canceling:
            return
        self.canceling.add(cid)
        await self.ex.cancel(cid, o.symbol, now)

    def open_orders(self, symbol: str) -> list[Order]:
        return [o for o in self.orders.values() if o.symbol == symbol and o.open]

    def orders_last_minute(self, now: int) -> int:
        while self.placed_ts and now - self.placed_ts[0] > 60_000:
            self.placed_ts.popleft()
        return len(self.placed_ts)

    def busy(self) -> dict[str, tuple[int, Decimal]]:
        return {s: (e.intent.candidate.direction.sign, e.approval.risk_amount) for s, e in self.entries.items()}

    # ---- entries ---------------------------------------------------------------------------
    async def open(self, intent: Intent, approval: Approval, touch: Decimal, now: int) -> None:
        c = intent.candidate
        spec = self.cfg.symbol_specs[c.symbol]
        # at/inside the touch, never worse than the analysed entry
        px = min(touch, c.entry) if c.direction is Direction.LONG else max(touch, c.entry)
        px = floor_to(px, spec.tick) if c.direction is Direction.LONG else ceil_to(px, spec.tick)
        self._equity_before[c.symbol] = self.equity()
        o = await self._place(c.symbol, "entry", c.direction, True, OrderType.LIMIT_MAKER, approval.qty, now,
                              price=px)
        self.entry_intents[o.client_id] = intent
        self.entries[c.symbol] = EntryState(intent, approval, o.client_id, now, self.marks.get(c.symbol, px))

    # ---- updates ---------------------------------------------------------------------------
    async def pump(self, now: int) -> None:
        while self._updates:
            u = self._updates.popleft()
            try:
                await self._apply(u, now)
            except InconsistencyError as e:
                self.on_alarm(str(e), now)

    async def _apply(self, u: OrderUpdate, now: int) -> None:
        o = self.orders.get(u.client_id)
        if o is None:
            raise InconsistencyError(f"update for unknown order {u.client_id}")
        if u.exec_id:
            if u.exec_id in self._seen:
                return  # duplicate delivery
            if len(self._seen_q) == self._seen_q.maxlen:
                self._seen.discard(self._seen_q[0])
            self._seen_q.append(u.exec_id)
            self._seen.add(u.exec_id)
        was = o.status
        if u.fill_qty > 0:
            if o.filled + u.fill_qty > o.qty:
                raise InconsistencyError(f"overfill on {o.client_id}")
            o.avg_price = (o.avg_price * o.filled + u.fill_price * u.fill_qty) / (o.filled + u.fill_qty)
            o.filled += u.fill_qty
            o.fee += u.fee
            o.transition(OrderStatus.FILLED if o.filled >= o.qty else OrderStatus.PARTIAL)
            self.j.emit("fill", u.ts, o.symbol, id=o.client_id, purpose=o.purpose, qty=u.fill_qty,
                        price=u.fill_price, fee=u.fee)
        elif was in TERMINAL:
            return  # stale ack/cancel arriving after a terminal state (out-of-order delivery)
        elif u.status is not was:
            o.transition(u.status)
        if u.status is OrderStatus.ACKED:
            self.consecutive_rejects = 0
        if u.status is OrderStatus.REJECTED:
            self.j.emit("order_reject", u.ts, o.symbol, id=o.client_id, purpose=o.purpose, reason=u.reason)
            if u.reason != "post_only_would_take":
                self.consecutive_rejects += 1
                if self.consecutive_rejects >= self.cfg.kill.max_consecutive_rejects:
                    self.on_alarm(f"{self.consecutive_rejects} consecutive order rejects", now)
        if o.status in TERMINAL:
            self.canceling.discard(o.client_id)
        handler = {"entry": self._on_entry, "stop": self._on_exit, "tp1": self._on_exit, "tp2": self._on_exit,
                   "exit": self._on_exit}[o.purpose]
        await handler(o, u, now)

    async def _on_entry(self, o: Order, u: OrderUpdate, now: int) -> None:
        sym = o.symbol
        if u.fill_qty > 0:
            c = self.entry_intents[o.client_id].candidate
            pos = self.positions.get(sym)
            if pos is None:
                pos = Position(symbol=sym, direction=c.direction, setup=c.setup, qty=D0, entry=u.fill_price,
                               stop=c.stop, initial_stop=c.stop, tp1=c.tp1, tp2=c.tp2, atr=c.atr, opened_ts=u.ts,
                               full_exit=c.full_exit, extreme=u.fill_price)
                self.positions[sym] = pos
                self.j.emit("position_open", u.ts, sym, setup=c.setup, direction=c.direction.value)
            pos.entry = (pos.entry * pos.qty + u.fill_price * u.fill_qty) / (pos.qty + u.fill_qty)
            pos.qty += u.fill_qty
            pos.initial_qty += u.fill_qty
            pos.fees += u.fee
            pos.realized -= u.fee
            await self._sync_stop(sym, now)  # no stop = no position
            if o.client_id in self.aborted:  # filled after we flattened / killed: exit it too
                self.exiting.discard(sym)
                await self.flatten(sym, self.aborted[o.client_id], now)
                return
        st = self.entries.get(sym)
        if st is None or st.order_id != o.client_id:
            if u.fill_qty > 0 and sym in self.positions:  # late fill (fill-after-cancel race)
                await self._place_targets(sym, now)
            return
        if o.status not in TERMINAL:
            return
        if o.status is OrderStatus.CANCELED and st.reprice_pending and sym not in self.positions:
            price = self.marks.get(sym)
            if price is not None:
                spec = self.cfg.symbol_specs[sym]
                c = st.intent.candidate
                touch = price - spec.tick if c.direction is Direction.LONG else price + spec.tick
                n = await self._place(sym, "entry", c.direction, True, OrderType.LIMIT_MAKER, st.approval.qty, now,
                                      price=touch)
                self.entry_intents[n.client_id] = st.intent
                st.order_id, st.placed_ts, st.repriced, st.reprice_pending = n.client_id, now, True, False
                return
        del self.entries[sym]
        if sym in self.positions:
            await self._place_targets(sym, now)
        else:
            self.j.emit("entry_abandoned", now, sym, status=o.status.value)

    async def _place_targets(self, sym: str, now: int) -> None:
        pos = self.positions[sym]
        if pos.tp1_done or sym in self.exiting:
            return
        for o in self.open_orders(sym):
            if o.purpose == "tp1":
                await self._cancel(o.client_id, now)
        spec = self.cfg.symbol_specs[sym]
        qty = pos.qty if pos.full_exit else floor_to(pos.qty * self.cfg.strategy.tp1_fraction, spec.step)
        rest = pos.qty - qty
        if qty * pos.tp1 < spec.min_notional or (rest > 0 and rest * pos.tp1 < spec.min_notional):
            qty = pos.qty  # too small to split: exit everything at TP1
        if self.cfg.venue_cfg.supports_reduce_only:
            await self._place(sym, "tp1", pos.direction, False, OrderType.LIMIT, qty, now, price=pos.tp1)
        else:
            pos.tp_qty = qty  # synthetic: fired from on_tick when price trades through TP1

    async def _on_exit(self, o: Order, u: OrderUpdate, now: int) -> None:
        sym = o.symbol
        pos = self.positions.get(sym)
        if u.status is OrderStatus.REJECTED and o.purpose in ("stop", "exit") and pos is not None:
            if o.purpose == "stop":
                self.on_alarm(f"protective stop rejected on {sym}: {u.reason}", now)
            else:
                self.exiting.discard(sym)  # retried on next tick
            return
        if u.status is OrderStatus.CANCELED and o.purpose == "stop" and pos is not None \
                and self.stop_id.get(sym) == o.client_id:
            self.stop_id.pop(sym, None)  # venue canceled our live stop: restore protection now
            await self._sync_stop(sym, now)
            return
        if u.fill_qty <= 0 or pos is None:
            return
        s = pos.direction.sign
        pos.qty -= u.fill_qty
        pos.realized += s * (u.fill_price - pos.entry) * u.fill_qty - u.fee
        pos.fees += u.fee
        if pos.qty < 0:
            raise InconsistencyError(f"position went negative on {sym}")
        if pos.qty == 0:
            reason = pos.exit_reason or {"stop": "trail" if pos.tp1_done else "stop", "tp1": "tp1", "tp2": "tp2",
                                         "exit": "exit"}[o.purpose]
            await self._close(pos, reason, u.ts, now)
            return
        if o.purpose == "tp1" and o.status is OrderStatus.FILLED and not pos.tp1_done:
            pos.tp1_done = True
            v = self.cfg.venue_cfg
            spec = self.cfg.symbol_specs[sym]
            be = pos.entry * (1 + s * (v.maker + v.taker))
            be = ceil_to(be, spec.tick) if s > 0 else floor_to(be, spec.tick)
            if (be - pos.stop) * s > 0:  # only ever tighten
                pos.stop = be
            await self._sync_stop(sym, now)
            if pos.tp2 is not None and self.cfg.venue_cfg.supports_reduce_only:
                await self._place(sym, "tp2", pos.direction, False, OrderType.LIMIT, pos.qty, now, price=pos.tp2)
        elif o.purpose in ("stop", "tp1", "tp2"):
            await self._sync_stop(sym, now)  # stop qty follows position size

    async def _close(self, pos: Position, reason: str, ts: int, now: int) -> None:
        sym = pos.symbol
        for o in self.open_orders(sym):
            await self._cancel(o.client_id, now)
        del self.positions[sym]
        self.stop_id.pop(sym, None)
        self.exiting.discard(sym)
        risk_money = pos.initial_qty * pos.risk_per_unit
        t = ClosedTrade(symbol=sym, setup=pos.setup, direction=pos.direction, opened_ts=pos.opened_ts, closed_ts=ts,
                        entry=pos.entry, qty=pos.initial_qty, pnl=pos.realized, fees=pos.fees,
                        r=pos.realized / risk_money if risk_money > 0 else D0, exit_reason=reason,
                        equity_before=self._equity_before.pop(sym, self.equity()))
        self.j.emit("trade", ts, sym, trade=t)
        self.on_closed(t)

    async def _sync_stop(self, sym: str, now: int) -> None:
        pos = self.positions.get(sym)
        if pos is None or sym in self.exiting:
            return
        cur = self.orders.get(self.stop_id.get(sym, ""))
        if cur is not None and cur.open and cur.stop_price == pos.stop and cur.remaining == pos.qty:
            return
        if cur is not None and cur.open:
            await self._cancel(cur.client_id, now)
        o = await self._place(sym, "stop", pos.direction, False, OrderType.STOP_MARKET, pos.qty, now,
                              stop_price=pos.stop)
        self.stop_id[sym] = o.client_id

    # ---- time-driven -----------------------------------------------------------------------
    async def on_tick(self, sym: str, price: Decimal, now: int) -> None:
        self.marks[sym] = price
        st = self.entries.get(sym)
        ex = self.cfg.execution
        if st is not None:
            o = self.orders[st.order_id]
            if o.open and o.client_id not in self.canceling and now - st.placed_ts >= ex.entry_timeout_s * 1000:
                c = st.intent.candidate
                near = abs(price - st.ref_price) <= ex.max_chase_atr * c.atr
                st.reprice_pending = not st.repriced and near and o.filled == 0
                await self._cancel(o.client_id, now)
        pos = self.positions.get(sym)
        if pos is None:
            return
        s = pos.direction.sign
        if (price - pos.extreme) * s > 0:
            pos.extreme = price
        if sym in self.exiting:
            if not any(o.purpose == "exit" for o in self.open_orders(sym)):
                await self._place(sym, "exit", pos.direction, False, OrderType.MARKET, pos.qty, now)
            return
        if not self.cfg.venue_cfg.supports_reduce_only:
            await self._synthetic_targets(pos, price, now)
            if sym not in self.positions or sym in self.exiting:
                return
        st_cfg = self.cfg.strategy
        if (not pos.tp1_done and now - pos.opened_ts >= st_cfg.time_stop_s * 1000
                and pos.r_multiple(pos.extreme) < st_cfg.time_stop_min_r):
            await self.flatten(sym, "time_stop", now)

    async def _synthetic_targets(self, pos: Position, price: Decimal, now: int) -> None:
        """Spot venues: a resting TP would lock balance the stop needs, so the TP is a market exit fired
        once price trades through the level. ponytail: pays taker + slippage instead of maker, and the
        remainder is unprotected for one cancel/replace round trip; upgrade path is OCO order legs."""
        s, sym = pos.direction.sign, pos.symbol
        if any(o.purpose in ("tp1", "tp2") and o.open for o in self.open_orders(sym)):
            return  # a synthetic exit is already in flight
        if not pos.tp1_done and pos.tp_qty > 0 and (price - pos.tp1) * s > 0:
            qty, pos.tp_qty, purpose = pos.tp_qty, D0, "tp1"
        elif pos.tp1_done and pos.tp2 is not None and (price - pos.tp2) * s > 0:
            qty, purpose = pos.qty, "tp2"
        else:
            return
        sid = self.stop_id.get(sym)
        if sid:
            await self._cancel(sid, now)
        await self._place(sym, purpose, pos.direction, False, OrderType.MARKET, qty, now)

    async def on_bar(self, sym: str, atr: Decimal, now: int) -> None:
        """Runner trail on bar close: 1.5 ATR from the best price; ratchets only."""
        pos = self.positions.get(sym)
        if pos is None or not pos.tp1_done or pos.tp2 is not None or sym in self.exiting:
            return
        st, spec, s = self.cfg.strategy, self.cfg.symbol_specs[sym], pos.direction.sign
        trail = pos.extreme - s * st.trail_atr * atr
        trail = floor_to(trail, spec.tick) if s > 0 else ceil_to(trail, spec.tick)
        if (trail - pos.stop) * s >= st.trail_step_atr * atr:
            pos.stop = trail
            await self._sync_stop(sym, now)

    async def flatten(self, sym: str, reason: str, now: int) -> None:
        st = self.entries.pop(sym, None)
        if st is not None:
            self.aborted[st.order_id] = reason
            await self._cancel(st.order_id, now)
        pos = self.positions.get(sym)
        for o in self.open_orders(sym):
            await self._cancel(o.client_id, now)
        if pos is None or sym in self.exiting:
            return
        pos.exit_reason = pos.exit_reason or reason
        self.exiting.add(sym)
        self.j.emit("flatten", now, sym, reason=reason)
        await self._place(sym, "exit", pos.direction, False, OrderType.MARKET, pos.qty, now)

    async def flatten_all(self, reason: str, now: int) -> None:
        for sym in sorted(set(self.positions) | set(self.entries)):
            await self.flatten(sym, reason, now)

    # ---- reconciliation --------------------------------------------------------------------
    async def reconcile(self, now: int) -> list[str]:
        """Exchange is truth. Returns problems that persisted across two consecutive checks."""
        await self.pump(now)
        ex_pos = await self.ex.positions()
        ex_orders = await self.ex.open_orders()
        problems: list[str] = []
        seen: set[str] = set()
        for sym in sorted(set(ex_pos) | set(self.positions)):
            spec = self.cfg.symbol_specs.get(sym)
            step = spec.step if spec else D0
            pos = self.positions.get(sym)
            local = pos.direction.sign * pos.qty if pos else D0
            ex_qty = ex_pos.get(sym, D0)
            if abs(ex_qty - local) > step:
                seen.add(sym)
                if sym in self._mismatch:
                    kind = "unexpected position" if pos is None else "position mismatch"
                    problems.append(f"{kind} {sym}: exchange={ex_qty} local={local}")
                    if pos is None and spec is not None:  # adopt the orphan so the kill switch flattens it
                        mark = self.marks.get(sym, D0)
                        d = Direction.LONG if ex_qty > 0 else Direction.SHORT
                        self.positions[sym] = Position(
                            symbol=sym, direction=d, setup="orphan", qty=abs(ex_qty), entry=mark, stop=mark,
                            initial_stop=mark, tp1=mark, tp2=None, atr=D0, opened_ts=now, initial_qty=abs(ex_qty),
                            exit_reason="orphan")
                        await self.flatten(sym, "orphan", now)
        self._mismatch = seen
        for cid, sym in ex_orders.items():
            if cid not in self.orders:
                self.j.emit("risk", now, sym, event="foreign_order_canceled", id=cid)
                await self.ex.cancel(cid, sym, now)
        for sym in list(self.positions):
            sid = self.stop_id.get(sym, "")
            stop = self.orders.get(sid)
            lost = stop is not None and stop.open and sid not in ex_orders and now - stop.created_ts > 5_000
            if lost and stop is not None:
                stop.status = OrderStatus.CANCELED  # venue no longer has it: treat as gone
            if sym not in self.exiting and (stop is None or not stop.open):
                self.stop_id.pop(sym, None)
                self.j.emit("risk", now, sym, event="stop_restored")
                await self._sync_stop(sym, now)
        # bounded memory: forget terminal orders older than an hour
        for cid in [c for c, o in self.orders.items() if o.status in TERMINAL and now - o.created_ts > 3_600_000]:
            del self.orders[cid]
            self.entry_intents.pop(cid, None)
            self.aborted.pop(cid, None)
        return problems
