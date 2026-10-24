"""Kraken adapter edge cases that only show up against the real venue (no network: fake ccxt client)."""

import asyncio
from decimal import Decimal as D
from typing import Any

import pytest

from kolibri.adapters import kraken
from kolibri.adapters.kraken import KrakenAdapter, earn_assets, withdraw_problems
from kolibri.core.config import Config
from kolibri.core.models import Order, OrderStatus, OrderType, OrderUpdate, Side
from kolibri.scout.scout import clock_drift_ms


class PermissionDenied(Exception):  # same class name ccxt raises for EGeneral:Permission denied
    pass


class NetworkError(Exception):  # ccxt's family name: timeouts, 5xx, maintenance
    pass


class RequestTimeout(NetworkError):
    pass


class Ex:
    def __init__(self, exc: Exception | None = None) -> None:
        self.exc = exc
        self.batches: list[Any] = []
        self.open: list[dict[str, Any]] = []

    async def privatePostWithdrawMethods(self, params: dict[str, str]) -> list[object]:
        if self.exc:
            raise self.exc
        return []

    async def watch_my_trades(self) -> list[dict[str, Any]]:
        b = self.batches.pop(0) if self.batches else asyncio.CancelledError()
        if isinstance(b, BaseException):
            raise b
        return list(b)

    async def create_order(self, *a: Any) -> dict[str, Any]:
        raise RequestTimeout()

    async def fetch_open_orders(self, *a: Any) -> list[dict[str, Any]]:
        return self.open

    async def fetch_closed_orders(self, *a: Any) -> list[dict[str, Any]]:
        return []


def _adapter(cfg: Config, monkeypatch: pytest.MonkeyPatch, ex: Ex) -> tuple[KrakenAdapter, list[OrderUpdate]]:
    monkeypatch.setenv("KRAKEN_API_KEY", "k")
    monkeypatch.setenv("KRAKEN_API_SECRET", "c2VjcmV0")
    monkeypatch.setattr(kraken, "LOCATE_DELAY_S", 0)
    ad = KrakenAdapter(cfg)
    ad.ex = ex
    got: list[OrderUpdate] = []
    ad.set_listener(got.append)
    return ad, got


def _order(cid: str) -> Order:
    return Order(cid, "BTCEUR", Side.BUY, OrderType.LIMIT_MAKER, D("0.01"), D("50000"))


def test_only_permission_denied_passes() -> None:
    assert asyncio.run(withdraw_problems(Ex(PermissionDenied("EGeneral:Permission denied")), "EUR")) == []
    assert "WITHDRAW" in asyncio.run(withdraw_problems(Ex(None), "EUR"))[0]
    assert "could not prove" in asyncio.run(withdraw_problems(Ex(TimeoutError()), "EUR"))[0]


def test_auto_earn_balances_are_detected() -> None:
    assets = {"EUR", "BTC"}
    assert earn_assets({"EUR": 500, "EUR.HOLD": 10, "ETH.F": 1}, assets) == []
    assert earn_assets({"EUR": 0, "EUR.F": "500", "BTC.S": 0}, assets) == ["EUR.F"]


def test_clock_drift_respects_whole_second_server_time() -> None:
    assert clock_drift_ms(1_000_000, 1_000_900, 1_000_950) == 0  # naive midpoint said -925 ms
    assert clock_drift_ms(1_000_000, 998_500, 998_700) == 1_300  # we are behind the server
    assert clock_drift_ms(1_000_000, 1_002_000, 1_002_100) == -1_000  # we are ahead


def test_fills_survive_reconnect_replay_and_missing_ack(cfg: Config, monkeypatch: pytest.MonkeyPatch) -> None:
    ex = Ex()
    ad, got = _adapter(cfg, monkeypatch, ex)
    ad._by_client["K1"] = _order("K1")  # create call timed out: only our client id is known
    fill = {"id": "T1", "order": "OX", "info": {"cl_ord_id": "K1"}, "amount": 0.004, "price": 50000,
            "fee": {"cost": 0.8, "currency": "EUR"}, "takerOrMaker": "maker", "timestamp": 1}
    ex.batches = [[fill], ConnectionError(), [fill, {**fill, "id": "T2", "amount": 0.006}]]
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(ad._forever(ad._trades_once))
    assert [u.exec_id for u in got] == ["T1", "T2"]  # the reconnect snapshot did not double-count T1
    assert got[-1].status is OrderStatus.FILLED and ad.base["BTCEUR"] == D("0.010")
    assert ad.down_since_ms is None  # recovered after the dropped socket


def test_timed_out_create_is_looked_up_by_client_id(cfg: Config, monkeypatch: pytest.MonkeyPatch) -> None:
    ex = Ex()
    ad, got = _adapter(cfg, monkeypatch, ex)
    ex.open = [{"id": "OX", "clientOrderId": "K2"}]
    o = _order("K2")
    asyncio.run(ad.place(o, 1))
    assert got[-1].status is OrderStatus.ACKED and ad._by_exchange_id["OX"] is o  # it did reach Kraken
    ex.open = []
    asyncio.run(ad.place(_order("K3"), 1))
    assert got[-1].status is OrderStatus.REJECTED  # truly not there
