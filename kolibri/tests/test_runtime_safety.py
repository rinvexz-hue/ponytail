"""Runtime, dashboard auth, alerts, secrets, Scout bar builder."""

from __future__ import annotations

import asyncio
import logging
import time
import urllib.request
from decimal import Decimal as D
from pathlib import Path
from typing import Any

import pytest
from conftest import T0
from fastapi.testclient import TestClient

from kolibri.alerts.telegram import Alert, AlertManager, format_event, telegram_sender
from kolibri.backtest.data import synthetic
from kolibri.core.config import Config, with_overrides
from kolibri.core.models import DeskEvent
from kolibri.dashboard.app import create_app
from kolibri.runtime import Runtime
from kolibri.scout.scout import BarBuilder, book_summary


# ---- scout ------------------------------------------------------------------------------------
def test_bar_builder_late_trades_and_flat_bars() -> None:
    b = BarBuilder(("BTCUSDT", "XRPUSDT"))
    b.on_trade("BTCUSDT", T0 + 1_000, D(100), D(1), True)
    b.on_trade("BTCUSDT", T0 + 2_000, D(102), D(2), False)
    b.on_trade("BTCUSDT", T0 + 61_000, D(103), D(1), True)  # next minute, arrives before the close timer
    b.on_trade("XRPUSDT", T0 + 5_000, D("0.5"), D(10), False)
    bars = b.close_minute(T0)
    btc = bars["BTCUSDT"]
    assert (btc.open, btc.high, btc.low, btc.close, btc.volume, btc.taker_buy_volume) == (100, 102, 100, 102, 3, 1)
    b.on_trade("BTCUSDT", T0 + 59_000, D(99), D(1), True)  # minute already closed: dropped, never repaint
    assert b.late == 1
    nxt = b.close_minute(T0 + 60_000)
    assert nxt["BTCUSDT"].close == 103
    assert nxt["XRPUSDT"].volume == 0 and nxt["XRPUSDT"].close == D("0.5")  # quiet minute -> flat bar


def test_book_summary() -> None:
    ob = {"bids": [[100.0, 3.0], [99.9, 1.0]], "asks": [[100.1, 1.0], [100.2, 1.0]]}
    bk = book_summary(ob, T0)
    assert bk is not None and bk.imbalance5 == pytest.approx(4 / 6)
    assert float(bk.spread_bps) == pytest.approx(9.995, rel=1e-3)
    assert bk.bid < bk.microprice < bk.ask
    assert book_summary({"bids": [], "asks": []}, T0) is None


# ---- alerts -------------------------------------------------------------------------------------
def test_alerts_rate_limit_dedupe_and_critical_repeat(cfg: Config) -> None:
    sent: list[str] = []

    async def sender(t: str) -> None:
        sent.append(t)

    am = AlertManager(cfg, sender)
    for i in range(30):
        am.push(Alert("INFO", f"info {i}", 0))
    am.push(Alert("INFO", "info 0", 0))  # duplicate
    am.push(Alert("CRITICAL", "kill", 0))
    asyncio.run(am.flush(now=1000.0))
    assert sum("info" in s for s in sent) == cfg.alerts.max_per_min
    assert any("kill" in s for s in sent)  # CRITICAL is never rate-limited away
    n = len(sent)
    asyncio.run(am.flush(now=1000.0 + cfg.alerts.critical_repeat_s))
    assert len(sent) == n + 1 and "unacked" in sent[-1]  # repeats until acknowledged
    assert am.ack() == 1
    asyncio.run(am.flush(now=1000.0 + 5 * cfg.alerts.critical_repeat_s))
    assert len(sent) == n + 1


def test_event_formatting(cfg: Config) -> None:
    kill = format_event(DeskEvent("kill", T0, data={"reason": "stale", "manual_rearm": True}), cfg)
    assert kill is not None and kill.severity == "CRITICAL" and "manual re-arm" in kill.text
    trade = format_event(DeskEvent("trade", T0, "BTCUSDT", {"trade": {"r": "1.5", "pnl": "10", "exit_reason": "tp1"}}),
                         cfg)
    assert trade is not None and "+1.50R" in trade.text
    assert format_event(DeskEvent("order_reject", T0, "X", {"purpose": "entry", "reason": "post_only_would_take"}),
                        cfg) is None


def test_telegram_token_never_logged(monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture) -> None:
    secret = "123456:SECRET-TOKEN-abc"

    def boom(*a: Any, **k: Any) -> Any:
        raise OSError(f"failed https://api.telegram.org/bot{secret}/sendMessage")

    monkeypatch.setattr(urllib.request, "urlopen", boom)
    with caplog.at_level(logging.DEBUG):
        asyncio.run(telegram_sender(secret, "1")("hello"))
    assert "telegram send failed" in caplog.text and secret not in caplog.text


# ---- dashboard ----------------------------------------------------------------------------------
class _FakeRt:
    def __init__(self) -> None:
        self.killed: list[str] = []

        class Alerts:
            def ack(self) -> int:
                return 2

        self.alerts = Alerts()

    async def kill(self, reason: str) -> None:
        self.killed.append(reason)

    async def rearm(self) -> None:
        self.killed.append("rearm")

    def snapshot(self) -> dict[str, Any]:
        return {"mode": "paper"}


def test_dashboard_requires_token(monkeypatch: pytest.MonkeyPatch) -> None:
    rt = _FakeRt()
    client = TestClient(create_app(rt))
    assert client.get("/").status_code == 200  # static shell only
    monkeypatch.delenv("DASHBOARD_TOKEN", raising=False)
    assert client.get("/api/state").status_code == 503
    monkeypatch.setenv("DASHBOARD_TOKEN", "short")
    assert client.get("/api/state").status_code == 503  # weak token = disabled
    monkeypatch.setenv("DASHBOARD_TOKEN", "x" * 32)
    assert client.get("/api/state").status_code == 401
    assert client.post("/api/kill", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert not rt.killed
    ok = {"Authorization": "Bearer " + "x" * 32}
    assert client.get("/api/state", headers=ok).json() == {"mode": "paper"}
    assert client.post("/api/kill", headers=ok).status_code == 200 and rt.killed
    assert client.post("/api/ack", headers=ok).json() == {"acked": 2}
    assert client.post("/api/rearm", headers=ok).status_code == 200 and rt.killed[-1] == "rearm"
    assert client.get("/docs").status_code == 404  # no public API surface


# ---- paper runtime end to end (fake exchange) ---------------------------------------------------
class FakeExchange:
    """Minimal ccxt.pro stand-in: warm-up klines, a live trade/book stream that can be cut."""

    def __init__(self, cfg: Config) -> None:
        now = int(time.time() * 1000)
        start = (now // 60_000 - 2 * 1440) * 60_000
        self.hist = synthetic(cfg, start, 2 * 1440, seed=4)
        self.px = {s: float(v[-1].close) for s, v in self.hist.items()}
        self.live = True

    async def publicGetKlines(self, p: dict[str, Any]) -> list[list[str]]:
        rows = [b for b in self.hist[p["symbol"]] if p["startTime"] <= b.open_ts <= p["endTime"]][:1000]
        return [[str(b.open_ts), str(b.open), str(b.high), str(b.low), str(b.close), str(b.volume), "0", "0", "0",
                 str(b.taker_buy_volume), "0", "0"] for b in rows]

    async def watch_trades(self, sym: str) -> list[dict[str, Any]]:
        await asyncio.sleep(0.02)
        if not self.live:
            await asyncio.sleep(3600)
        key = sym.replace("/", "")
        return [{"timestamp": int(time.time() * 1000), "price": self.px[key], "amount": 0.01, "side": "buy"}]

    async def watch_order_book(self, sym: str, limit: int) -> dict[str, Any]:
        await asyncio.sleep(0.05)
        if not self.live:
            await asyncio.sleep(3600)
        p = self.px[sym.replace("/", "")]
        return {"bids": [[p * 0.9999, 50.0]], "asks": [[p * 1.0001, 50.0]], "timestamp": int(time.time() * 1000)}

    async def fetch_time(self) -> int:
        return int(time.time() * 1000)

    async def close(self) -> None:
        pass


def test_paper_runtime_streams_and_kills_on_stale_data(cfg: Config, tmp_path: Path) -> None:
    c = with_overrides(cfg, {"state_db": str(tmp_path / "s.sqlite"), "warmup_days": 2, "kill.stale_data_s": 0.5})

    async def go() -> tuple[dict[str, Any], dict[str, Any]]:
        ex = FakeExchange(c)
        rt = Runtime(c, exchange=ex)
        await rt.start(serve_dashboard=False)
        await asyncio.sleep(1.0)
        healthy = rt.snapshot()
        ex.live = False  # feed goes silent
        await asyncio.sleep(2.0)
        after = rt.snapshot()
        await rt.shutdown()
        return healthy, after

    healthy, after = asyncio.run(go())
    assert healthy["halted"] is None
    assert all(h["connected"] for h in healthy["health"].values())
    assert after["halted"] and "stale data" in after["halted"]
    assert any(a["sev"] == "CRITICAL" for a in after["alerts"])


def test_runtime_serialises_desk_mutations(cfg: Config, tmp_path: Path) -> None:
    """Concurrent trades + reconcile + kill against a slow venue: never two order calls in flight."""
    from conftest import intent

    from kolibri.adapters.sim import SimBroker
    from kolibri.risk.officer import Approval

    class SlowBroker(SimBroker):
        inflight = peak = 0

        async def _slow(self) -> None:
            SlowBroker.inflight += 1
            SlowBroker.peak = max(SlowBroker.peak, SlowBroker.inflight)
            await asyncio.sleep(0.003)
            SlowBroker.inflight -= 1

        async def place(self, order: Any, now: int) -> None:
            await self._slow()
            await super().place(order, now)

        async def cancel(self, cid: str, sym: str, now: int) -> None:
            await self._slow()
            await super().cancel(cid, sym, now)

    c = with_overrides(cfg, {"state_db": str(tmp_path / "s.sqlite"), "execution.latency_ms": 0})

    async def go() -> Runtime:
        rt = Runtime(c, exchange=FakeExchange(c), adapter=SlowBroker(c, D("100000")))
        await rt.on_trade("BTCUSDT", T0, D("100.05"), D(1), True)
        async with rt.lock:
            await rt.desk.exe.open(intent(), Approval(D(1), D(1)), D(100), T0)
        prices = ["99.9", "100.5", "101.2", "99.5", "98.9", "100.2"] * 5
        jobs = [rt.on_trade("BTCUSDT", T0 + 10 * (i + 1), D(p), D(1), False) for i, p in enumerate(prices)]
        await asyncio.gather(*jobs, rt.reconcile_once(), rt.kill("test kill"))
        for i in range(5):
            await rt.on_trade("BTCUSDT", T0 + 10_000 + i, D("100"), D(1), False)
        return rt

    rt = asyncio.run(go())
    assert SlowBroker.peak == 1
    assert not rt.desk.exe.positions and rt.adapter.base["BTCUSDT"] == 0  # type: ignore[attr-defined]
    rt.j.close()


def test_paper_restart_mid_position_is_flattened_and_halted(cfg: Config, tmp_path: Path) -> None:
    c = with_overrides(cfg, {"state_db": str(tmp_path / "s.sqlite"), "warmup_days": 2})
    from kolibri.core.journal import Journal

    j = Journal(c.state_db)  # a previous paper session died holding 0.5 BTC
    j.set_state("paper_account", {"quote": "9000", "base": {"BTCUSDT": "0.5"}})
    j.close()

    async def go() -> dict[str, Any]:
        rt = Runtime(c, exchange=FakeExchange(c))
        await rt.start(serve_dashboard=False)
        await asyncio.sleep(0.5)
        snap = rt.snapshot()
        base = rt.adapter.base["BTCUSDT"]  # type: ignore[attr-defined]
        await rt.shutdown()
        return snap | {"base": base}

    snap = asyncio.run(go())
    assert snap["halted"] and "unexpected position" in snap["halted"]
    assert snap["base"] == 0
