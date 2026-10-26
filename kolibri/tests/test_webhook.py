"""TradingView webhook: auth, parsing, fast acknowledgement, and the signal's path through the desk."""

from __future__ import annotations

import asyncio
from decimal import Decimal as D
from typing import Any

import pytest
from conftest import T0, feat
from fastapi.testclient import TestClient

from kolibri.adapters.sim import SimBroker
from kolibri.core.config import Config, with_overrides
from kolibri.core.journal import Journal
from kolibri.core.models import Intent, Rejection
from kolibri.desk import Desk
from kolibri.webhook import create_webhook_app, parse_signal

SECRET = "s3cret-s3cret-s3cret"


class FakeRuntime:
    def __init__(self, cfg: Config) -> None:
        self.cfg = cfg
        self.calls: list[tuple[Any, ...]] = []

    async def on_signal(self, *a: Any) -> None:
        self.calls.append(a)


def _client(cfg: Config, monkeypatch: pytest.MonkeyPatch, secret: str = SECRET) -> tuple[TestClient, FakeRuntime]:
    monkeypatch.setenv("TV_WEBHOOK_SECRET", secret)
    rt = FakeRuntime(cfg)
    return TestClient(create_webhook_app(rt)), rt


def test_webhook_rejects_bad_secret_bad_symbol_and_missing_config(cfg: Config, monkeypatch: pytest.MonkeyPatch) -> None:
    c, rt = _client(cfg, monkeypatch)
    assert c.post("/tv", json={"secret": "nope", "symbol": "BTCEUR", "side": "buy"}).status_code == 401
    assert c.post("/tv", json={"secret": SECRET, "symbol": "OANDA:XAUUSD", "side": "buy"}).status_code == 400
    assert c.post("/tv", content=b"BUY BTCEUR").status_code == 400  # not JSON
    assert c.post("/tv", json={"secret": SECRET, "symbol": "BTCEUR", "side": "buy", "sl": "-1"}).status_code == 400
    assert rt.calls == []
    c2, _ = _client(cfg, monkeypatch, secret="short")
    assert c2.post("/tv", json={"secret": "short", "symbol": "BTCEUR", "side": "buy"}).status_code == 503


def test_webhook_accepts_tradingview_ticker_formats(cfg: Config, monkeypatch: pytest.MonkeyPatch) -> None:
    c, _ = _client(cfg, monkeypatch)
    r = c.post("/tv", json={"secret": SECRET, "symbol": "KRAKEN:XBTEUR", "side": "BUY", "sl": "99.5", "tp": ""})
    assert r.status_code == 202 and r.json() == {"accepted": True, "symbol": "BTCEUR", "side": "buy"}
    assert parse_signal({"symbol": "eth/eur", "side": "sell"}, cfg) == ("ETHEUR", "sell", None, None)


def _desk(cfg: Config) -> Desk:
    d = Desk(cfg, SimBroker(cfg, D("10000")), Journal(), D("10000"))
    d.features["BTCEUR"] = feat()
    d.exe.marks["BTCEUR"] = D("100.2")
    return d


def test_signal_goes_through_gates_risk_and_execution(cfg: Config) -> None:
    gated = asyncio.run(_desk(cfg).on_signal("BTCEUR", "buy", T0))
    assert isinstance(gated, Rejection)  # Kraken fees vs a 1.5R target: KOLIBRI's edge gates say no
    raw = with_overrides(cfg, {"strategy.raw_setups": ["TV_signal"]})
    d = _desk(raw)
    res = asyncio.run(d.on_signal("BTCEUR", "buy", T0))
    assert isinstance(res, Intent)
    c = res.candidate
    assert c.setup == "TV_signal" and c.full_exit and c.tp1 == c.entry + raw.strategy.gm_rr * (c.entry - c.stop)
    assert "BTCEUR" in d.exe.entries  # an entry order is working: risk approved it
    short = asyncio.run(d.on_signal("ETHEUR", "sell", T0))
    assert isinstance(short, Rejection)  # no features yet / no shorts on spot: never an order


def test_signal_with_its_own_stop_and_target(cfg: Config) -> None:
    raw = with_overrides(cfg, {"strategy.raw_setups": ["TV_signal"]})
    res = asyncio.run(_desk(raw).on_signal("BTCEUR", "buy", T0, D("99.9"), D("100.8")))
    assert isinstance(res, Intent) and res.candidate.stop == D("99.9") and res.candidate.tp1 == D("100.8")
    wrong = asyncio.run(_desk(raw).on_signal("BTCEUR", "buy", T0, D("101"), None))
    assert isinstance(wrong, Rejection) and wrong.gate == "1_stop_distance"
