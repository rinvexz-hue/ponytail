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
from collections.abc import Awaitable, Callable
from decimal import Decimal
from typing import Any

from kolibri.core.config import Config
from kolibri.core.models import D0, Order, OrderStatus, OrderType, OrderUpdate
from kolibri.scout.scout import ccxt_symbol

log = logging.getLogger(__name__)
LOCATE_DELAY_S = 1.0  # give Kraken a moment to book an order whose create call timed out


async def withdraw_problems(ex: Any, asset: str) -> list[str]:
    """The key must NOT be able to withdraw. Kraken has no "show my key's rights" call, so probe a
    read-only withdraw endpoint: only "Permission denied" proves the right is off. Fail closed."""
    try:
        await ex.privatePostWithdrawMethods({"asset": asset})
    except Exception as e:
        if type(e).__name__ == "PermissionDenied":
            return []
        return [f"could not prove the API key lacks withdraw rights ({type(e).__name__})"]
    return ["API key has WITHDRAW permission: make a new key without 'Withdraw Funds'"]


def _is_network(e: Exception) -> bool:
    """ccxt NetworkError family (timeouts, 5xx, maintenance): the request may or may not have landed."""
    return isinstance(e, TimeoutError) or any(c.__name__ == "NetworkError" for c in type(e).__mro__)


def earn_assets(total: dict[str, Any], assets: set[str]) -> list[str]:
    """Kraken books Auto Earn / staking as suffixed assets (BTC.F, EUR.M, ...) that the plain balance omits:
    the desk would see too little equity and positions "vanish". Only .HOLD (fiat in transit) is harmless."""
    out = []
    for k, v in total.items():
        base, _, suffix = k.partition(".")
        if suffix and suffix != "HOLD" and base in assets and Decimal(str(v or 0)) > 0:
            out.append(k)
    return sorted(out)


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
        self._seen_trades: deque[str] = deque(maxlen=5000)  # the executions snapshot replays on every reconnect
        self.down_since_ms: int | None = None  # private stream outage start; the watchdog kills if it lasts
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
        problems += await withdraw_problems(self.ex, self.cfg.quote)
        try:
            await self.refresh_balances()
        except RuntimeError as e:  # Auto Earn balances: refuse with the reason, not a traceback
            problems.append(str(e))
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
            if _is_network(e) and await self._locate(order, cs):  # timed out but it did reach Kraken
                self._listener(OrderUpdate(order.client_id, OrderStatus.ACKED, now))
                return
            reason = "post_only_would_take" if "Post only" in str(e) else type(e).__name__
            self._listener(OrderUpdate(order.client_id, OrderStatus.REJECTED, now, reason=reason))

    async def _locate(self, order: Order, cs: str) -> bool:
        """Find an order whose create call failed in transit, by client id. A failed lookup reports a reject;
        if the order did land after all, its fill then hits a rejected order and the desk kills (fail closed)."""
        await asyncio.sleep(LOCATE_DELAY_S)
        try:
            found = [*await self.ex.fetch_open_orders(cs), *await self.ex.fetch_closed_orders(cs, None, 50)]
        except Exception:
            return False
        for o in found:
            if o.get("clientOrderId") == order.client_id:
                self._by_exchange_id[str(o["id"])] = order
                return True
        return False

    async def amend(self, client_id: str, symbol: str, qty: Decimal, stop_price: Decimal, now: int) -> bool:
        """Kraken AmendOrder keeps the stop resting while it changes: no unprotected gap, no cancel penalty."""
        o = self._by_client.get(client_id)
        if o is None or o.type is not OrderType.STOP_MARKET:
            return False
        try:
            await self.ex.edit_order(None, ccxt_symbol(self.cfg, symbol), "market", o.side.value, str(qty), None,
                                     {"clientOrderId": client_id, "stopLossPrice": str(stop_price)})
        except Exception:  # unknown outcome is fine: the fallback cancels by client id either way
            self.calls.append((time.time(), True))
            return False
        self.calls.append((time.time(), False))
        return True

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
        assets = {self.cfg.quote, *(self.cfg.symbol_specs[s].base for s in self.cfg.symbols)}
        if earning := earn_assets(bal["total"], assets):
            raise RuntimeError(f"Kraken Auto Earn/staking holds {earning}: switch Auto Earn off on this sub-account")
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
                cid = str(o.get("clientOrderId") or o["id"])
                if cid in self._by_client:  # safety net: an ack we never saw still maps fills to the order
                    self._by_exchange_id.setdefault(str(o["id"]), self._by_client[cid])
                out[cid] = sym
        self.calls.append((time.time(), False))
        return out

    def equity(self, marks: dict[str, Decimal]) -> Decimal:
        return self.quote + sum((q * marks.get(s, D0) for s, q in self.base.items()), D0)

    async def stream_fills(self) -> None:
        """Private websocket: my trades -> fill updates (exec_id = trade id); orders -> cancels/rejects."""
        await asyncio.gather(self._forever(self._trades_once), self._forever(self._orders_once))

    async def _trades_once(self) -> None:
        for t in await self.ex.watch_my_trades():
            tid = str(t["id"])
            cl = str((t.get("info") or {}).get("cl_ord_id"))
            o = self._by_exchange_id.get(str(t["order"])) or self._by_client.get(cl)
            if o is None or tid in self._seen_trades:
                continue
            self._seen_trades.append(tid)
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
            self._listener(OrderUpdate(o.client_id, st, int(t["timestamp"]), exec_id=tid,
                                       fill_qty=qty, fill_price=px, fee=fee_q))

    async def _orders_once(self) -> None:
        for o in await self.ex.watch_orders():
            cid = str(o.get("clientOrderId"))
            if cid in self._by_client and o["status"] in ("canceled", "expired", "rejected"):
                st = OrderStatus.REJECTED if o["status"] == "rejected" else OrderStatus.CANCELED
                ts = int(o.get("lastUpdateTimestamp") or o.get("timestamp") or time.time() * 1000)
                self._listener(OrderUpdate(cid, st, ts))

    async def _forever(self, once: Callable[[], Awaitable[None]]) -> None:
        """ccxt.pro raises on a dropped socket and resubscribes on the next call: retry, and mark the outage
        so the watchdog can kill if it lasts. Stops are exchange-side meanwhile."""
        backoff = 1.0
        while True:
            try:
                await once()
                self.down_since_ms, backoff = None, 1.0
            except asyncio.CancelledError:
                raise
            except Exception as e:
                self.down_since_ms = self.down_since_ms or int(time.time() * 1000)
                log.warning("private stream error %s; retry in %.0fs", type(e).__name__, backoff)
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30.0)

    async def close(self) -> None:
        await self.ex.close()
