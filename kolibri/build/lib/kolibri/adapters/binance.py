"""Live Binance spot adapter (ccxt.pro). Only constructed after every live gate has passed.

Spot semantics: no reduce-only flag exists, so exits are plain sells sized to the position;
protective stops are exchange-side STOP_LOSS orders. Fees paid in BNB are converted with the
venue's configured rate (approximation, see KNOWN_LIMITATIONS). Verify on the spot testnet
(`live.testnet`) before real capital: this module cannot be exercised without the venue."""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections import deque
from collections.abc import Callable
from decimal import Decimal
from typing import Any

from kolibri.core.config import Config
from kolibri.core.models import D0, Order, OrderStatus, OrderType, OrderUpdate
from kolibri.scout.scout import ccxt_symbol

log = logging.getLogger(__name__)


class BinanceAdapter:
    def __init__(self, cfg: Config, testnet: bool = False) -> None:
        import ccxt.pro as ccxtpro  # optional dependency, only needed live

        key, secret = os.environ.get("BINANCE_API_KEY"), os.environ.get("BINANCE_API_SECRET")
        if not key or not secret:
            raise RuntimeError("BINANCE_API_KEY / BINANCE_API_SECRET not set")
        self.cfg, self.caps = cfg, cfg.venue_cfg
        self.ex = ccxtpro.binance({"apiKey": key, "secret": secret, "enableRateLimit": True,
                                   "options": {"defaultType": "spot"}})
        if testnet:
            self.ex.set_sandbox_mode(True)
        self._listener: Callable[[OrderUpdate], None] = lambda u: None
        self._by_exchange_id: dict[str, Order] = {}
        self._by_client: dict[str, Order] = {}
        self._filled: dict[str, Decimal] = {}
        self.quote = self.bnb = D0
        self.base: dict[str, Decimal] = {}
        self.calls: deque[tuple[float, bool]] = deque(maxlen=1000)  # (ts, error) for the kill switch

    def set_listener(self, fn: Callable[[OrderUpdate], None]) -> None:
        self._listener = fn

    def error_rate(self, window_s: float = 60) -> tuple[float, int]:
        now = time.time()
        recent = [e for t, e in self.calls if now - t <= window_s]
        return (sum(recent) / len(recent) if recent else 0.0), len(recent)

    async def verify_filters(self) -> list[str]:
        """Exchange filters must match config, otherwise sizing/rounding is wrong -> refuse to start."""
        markets = await self.ex.load_markets()
        problems = []
        for sym in self.cfg.symbols:
            m = markets[ccxt_symbol(self.cfg, sym)]
            spec = self.cfg.symbol_specs[sym]
            tick, step = Decimal(str(m["precision"]["price"])), Decimal(str(m["precision"]["amount"]))
            if tick != spec.tick or step != spec.step:
                problems.append(f"{sym}: exchange tick/step {tick}/{step} != config {spec.tick}/{spec.step}")
        await self.refresh_balances()
        if self.caps.fee_discount > 0 and self.bnb <= 0:
            # without BNB, fees come out of the base asset and every fill leaves local != exchange qty
            problems.append("fee_discount configured but no BNB balance to pay fees")
        return problems

    async def place(self, order: Order, now: int) -> None:
        cs = ccxt_symbol(self.cfg, order.symbol)
        params: dict[str, Any] = {"newClientOrderId": order.client_id}
        self._by_client[order.client_id] = order
        try:
            if order.type is OrderType.LIMIT_MAKER:
                res = await self.ex.create_order(cs, "LIMIT_MAKER", order.side.value, str(order.qty),
                                                 str(order.price), params)
            elif order.type is OrderType.LIMIT:
                res = await self.ex.create_order(cs, "limit", order.side.value, str(order.qty),
                                                 str(order.price), params | {"timeInForce": "GTC"})
            elif order.type is OrderType.STOP_MARKET:
                res = await self.ex.create_order(cs, "STOP_LOSS", order.side.value, str(order.qty), None,
                                                 params | {"stopPrice": str(order.stop_price)})
            else:
                res = await self.ex.create_order(cs, "market", order.side.value, str(order.qty), None, params)
            self.calls.append((time.time(), False))
            self._by_exchange_id[str(res["id"])] = order
            self._listener(OrderUpdate(order.client_id, OrderStatus.ACKED, now))
        except Exception as e:
            self.calls.append((time.time(), True))
            reason = "post_only_would_take" if "LIMIT_MAKER" in str(e) or "immediately match" in str(e) \
                else type(e).__name__
            self._listener(OrderUpdate(order.client_id, OrderStatus.REJECTED, now, reason=reason))

    async def cancel(self, client_id: str, symbol: str, now: int) -> None:
        try:
            await self.ex.cancel_order(None, ccxt_symbol(self.cfg, symbol), {"origClientOrderId": client_id})
            self.calls.append((time.time(), False))
        except Exception as e:  # already filled/canceled is fine; the stream tells the truth
            self.calls.append((time.time(), "OrderNotFound" not in type(e).__name__))

    async def refresh_balances(self) -> None:
        bal = await self.ex.fetch_balance()
        self.calls.append((time.time(), False))
        quote_ccy = self.cfg.leader[len(self.cfg.symbol_specs[self.cfg.leader].base):]
        self.quote = Decimal(str(bal["total"].get(quote_ccy, 0)))
        self.base = {s: Decimal(str(bal["total"].get(self.cfg.symbol_specs[s].base, 0))) for s in self.cfg.symbols}
        self.bnb = Decimal(str(bal["total"].get("BNB", 0)))

    async def positions(self) -> dict[str, Decimal]:
        await self.refresh_balances()
        dust = {s: self.cfg.symbol_specs[s].step for s in self.cfg.symbols}
        return {s: q for s, q in self.base.items() if q > dust[s]}

    async def open_orders(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for sym in self.cfg.symbols:
            for o in await self.ex.fetch_open_orders(ccxt_symbol(self.cfg, sym)):
                out[str(o.get("clientOrderId") or o["id"])] = sym
        self.calls.append((time.time(), False))
        return out

    def equity(self, marks: dict[str, Decimal]) -> Decimal:
        return self.quote + sum((q * marks.get(s, D0) for s, q in self.base.items()), D0)

    async def stream_fills(self) -> None:
        """User-data stream: my trades -> fill updates (exec_id = trade id), orders -> cancels/rejects."""
        async def trades() -> None:
            while True:
                for t in await self.ex.watch_my_trades():
                    o = self._by_exchange_id.get(str(t["order"]))
                    if o is None:
                        continue
                    qty, px = Decimal(str(t["amount"])), Decimal(str(t["price"]))
                    fee = t.get("fee") or {}
                    rate = self.caps.maker if t.get("takerOrMaker") == "maker" else self.caps.taker
                    fee_q = Decimal(str(fee.get("cost", 0))) if fee.get("currency") == "USDT" else qty * px * rate
                    done = self._filled.get(o.client_id, D0) + qty
                    self._filled[o.client_id] = done
                    side = 1 if o.side.value == "buy" else -1
                    self.base[o.symbol] = self.base.get(o.symbol, D0) + side * qty
                    self.quote -= side * qty * px + fee_q
                    st = OrderStatus.FILLED if done >= o.qty else OrderStatus.PARTIAL
                    self._listener(OrderUpdate(o.client_id, st, int(t["timestamp"]), exec_id=str(t["id"]),
                                               fill_qty=qty, fill_price=px, fee=fee_q))

        async def orders() -> None:
            while True:
                for o in await self.ex.watch_orders():
                    cid = str(o.get("clientOrderId"))
                    if cid in self._by_client and o["status"] in ("canceled", "expired", "rejected"):
                        st = OrderStatus.REJECTED if o["status"] == "rejected" else OrderStatus.CANCELED
                        self._listener(OrderUpdate(cid, st, int(o.get("lastUpdateTimestamp") or o["timestamp"])))

        await asyncio.gather(trades(), orders())

    async def close(self) -> None:
        await self.ex.close()
