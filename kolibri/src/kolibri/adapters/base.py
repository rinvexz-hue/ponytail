"""Exchange adapter contract shared by the SimBroker (backtest + paper) and the live Kraken adapter.

Adapters report order state asynchronously through the listener; the Executioner never assumes a
call's effect until the matching OrderUpdate arrives."""

from __future__ import annotations

from collections.abc import Callable
from decimal import Decimal
from typing import Protocol

from kolibri.core.config import VenueCfg
from kolibri.core.models import Order, OrderUpdate


class ExchangeAdapter(Protocol):
    caps: VenueCfg

    def set_listener(self, fn: Callable[[OrderUpdate], None]) -> None: ...

    async def place(self, order: Order, now: int) -> None: ...

    async def cancel(self, client_id: str, symbol: str, now: int) -> None: ...

    async def positions(self) -> dict[str, Decimal]:
        """Signed base-asset quantity per symbol (net of any configured baseline holdings)."""
        ...

    async def open_orders(self) -> dict[str, str]:
        """client_id -> symbol for every order the venue considers open."""
        ...

    def equity(self, marks: dict[str, Decimal]) -> Decimal:
        """Quote balance + base holdings marked at `marks` (cached; refreshed on reconcile)."""
        ...
