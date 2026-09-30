"""Live Kraken spot adapter (ccxt.pro). Only constructed after every live gate has passed.

Spot semantics: open sells reserve balance and spot has no reduce-only, so exits are plain sells
sized to the position; protective stops are exchange-side `stop-loss` orders (market on trigger,
last-price trigger). Every order asks for fees in the quote currency (`fciq`), so base-asset
holdings always equal what the desk thinks it holds. Kraken has no spot testnet: run
`kolibri check-live` (read-only) before the first live start."""

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


class KrakenAdapter:
    def __init__(self, cfg: Config) -> None:
        import ccxt.pro as ccxtpro  # optional dependency, only needed live

        key, secret = os.environ.get("KRAKEN_API_KEY"), os.environ.get("KRAKEN_API_SECRET")
        if not key or not secret:
            raise RuntimeError("KRAKEN_API_KEY / KRAKEN_API_SECRET not set")
        self.cfg, self.caps = cfg, cfg.venue_cfg
        self.ex = ccxtpro.kraken({"apiKey": key, "secret": secret, "enableRateLimit": True})
        self._listener: Callable[[OrderUpdate], None] = lambda u: None
        self._by_exchange_id: dict[str, Order] = {}
        self._by_client: dict[str, Order] = {}
        self._filled: dict[str, Decimal] = {}
        self.quote = D0
        self.base: dict[str, Decimal] = {}
        self.calls: deque[tuple[float, bool]] = deque(maxlen=1000)  # (ts, error) for the kill switch

    def set_listener(self, fn: Callable[[OrderUpdate], None]) -> None:
        self._listener = fn

    def error_rate(self, window_s: float = 60) -> tuple[float, int]:
        now = time.time()
        recent = [e for t, e in self.calls if now - t <= window_s]
        return (sum(recent) / len(recent) if recent else 0.0), len(recent)

    async def verify_filters(self) -> list[str]:
        """Exchange filters and fee tier must match config, else sizing / cost gates are wrong."""
        markets = await self.ex.load_markets()
        problems = []
        for sym in self.cfg.symbols:
            m = markets[ccxt_symbol(self.cfg, sym)]
            spec = self.cfg.symbol_specs[sym]
            live = {"tick": m["precision"]["price"], "step": m["precision"]["amount"],
                    "min_qty": m["limits"]["amount"]["min"], "min_notional": m["limits"]["cost"]["min"]}
            for k, v in live.items():
                if v is not None and Decimal(str(v)) != getattr(spec, k):
                    problems.append(f"{sym}: Kraken {k}={v} but config says {getattr(spec, k)}")
            fee = await self.ex.fetch_trading_fee(ccxt_symbol(self.cfg, sym))
            for k in ("maker", "taker"):
                charged, cfgd = Decimal(str(fee[k])), getattr(self.caps, k)
                if charged > cfgd:  # cheaper than configured is fine (conservative); dearer is not
                    problems.append(f"{sym}: Kraken charges {k} {charged:.4%} but config assumes {cfgd:.4%}")
        await self.refresh_balances()
        return problems

    async def place(self, order: Order, now: int) -> None:
        cs = ccxt_symbol(self.cfg, order.symbol)
        params: dict[str, Any] = {"clientOrderId": order.client_id, "oflags": "fciq"}
        self._by_client[order.client_id] = order
        qty = str(order.qty)
        try:
            if order.type is OrderType.LIMIT_MAKER:
                res = await self.ex.create_order(cs, "limit", order.side.value, qty, str(order.price),
                                                 params | {"postOnly": True})
            elif order.type is OrderType.LIMIT:
                res = await self.ex.create_order(cs, "limit", order.side.value, qty, str(order.price), params)
            elif order.type is OrderType.STOP_MARKET:
                res = await self.ex.create_order(cs, "market", order.side.value, qty, None,
                                                 params | {"stopLossPrice": str(order.stop_price)})
            else:
                res = await self.ex.create_order(cs, "market", order.side.value, qty, None, params)
            self.calls.append((time.time(), False))
            self._by_exchange_id[str(res["id"])] = order
            self._listener(OrderUpdate(order.client_id, OrderStatus.ACKED, now))
        except Exception as e:
            self.calls.append((time.time(), True))
            reason = "post_only_would_take" if "Post only" in str(e) else type(e).__name__
            self._listener(OrderUpdate(order.client_id, OrderStatus.REJECTED, now, reason=reason))

    async def cancel(self, client_id: str, symbol: str, now: int) -> None:
        cs = ccxt_symbol(self.cfg, symbol)
        try:
            if client_id in self._by_client:
                await self.ex.cancel_order(None, cs, {"clientOrderId": client_id})
            else:  # foreign order found by reconciliation: keyed by its exchange id
                await self.ex.cancel_order(client_id, cs)
            self.calls.append((time.time(), False))
        except Exception as e:  # already filled/canceled is fine; the stream tells the truth
            self.calls.append((time.time(), "OrderNotFound" not in type(e).__name__))

    async def refresh_balances(self) -> None:
        bal = await self.ex.fetch_balance()
        self.calls.append((time.time(), False))
        self.quote = Decimal(str(bal["total"].get(self.cfg.quote, 0)))
        self.base = {s: Decimal(str(bal["total"].get(self.cfg.symbol_specs[s].base, 0))) for s in self.cfg.symbols}

    async def positions(self) -> dict[str, Decimal]:
        await self.refresh_balances()
        return {s: q for s, q in self.base.items() if q >= max(self.cfg.symbol_specs[s].min_qty, Decimal("1e-8"))}

    async def open_orders(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for o in await self.ex.fetch_open_orders():
            sym = str(o["symbol"]).replace("/", "")
            if sym in self.cfg.symbol_specs:
                out[str(o.get("clientOrderId") or o["id"])] = sym
        self.calls.append((time.time(), False))
        return out

    def equity(self, marks: dict[str, Decimal]) -> Decimal:
        return self.quote + sum((q * marks.get(s, D0) for s, q in self.base.items()), D0)

    async def stream_fills(self) -> None:
        """Private websocket: my trades -> fill updates (exec_id = trade id); orders -> cancels/rejects."""
        async def trades() -> None:
            while True:
                for t in await self.ex.watch_my_trades():
                    o = self._by_exchange_id.get(str(t["order"]))
                    if o is None:
                        continue
                    qty, px = Decimal(str(t["amount"])), Decimal(str(t["price"]))
                    fee = t.get("fee") or {}
                    rate = self.caps.maker if t.get("takerOrMaker") == "maker" else self.caps.taker
                    fee_q = Decimal(str(fee["cost"])) if fee.get("currency") == self.cfg.quote else qty * px * rate
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
                        ts = int(o.get("lastUpdateTimestamp") or o.get("timestamp") or time.time() * 1000)
                        self._listener(OrderUpdate(cid, st, ts))

        await asyncio.gather(trades(), orders())

    async def close(self) -> None:
        await self.ex.close()
