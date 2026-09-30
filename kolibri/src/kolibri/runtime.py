"""Long-running paper/live process: Scout streams -> bars -> Desk, plus the watchdogs.

Loops: trades/books per symbol, minute bar close, kill-switch watchdog (1 s), reconciliation
(30 s), alert flush/heartbeat/daily report, Telegram /ack, dashboard. Any unexpected task death is
itself a kill-switch event: we fail closed."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import signal
from decimal import Decimal
from typing import Any

from kolibri.adapters.base import ExchangeAdapter
from kolibri.adapters.sim import SimBroker
from kolibri.alerts.telegram import Alert, AlertManager
from kolibri.analyst.analyst import Health
from kolibri.auditor.auditor import daily_report, day_stats, rejection_histogram
from kolibri.auditor.graduation import check_graduation
from kolibri.backtest.metrics import max_drawdown_pct
from kolibri.core.config import Config
from kolibri.core.journal import Journal
from kolibri.core.models import MINUTE_MS, Book
from kolibri.desk import Desk
from kolibri.scout.scout import BarBuilder, Scout, now_ms

log = logging.getLogger(__name__)
DAY_MS = 1440 * MINUTE_MS
LIVE_CONFIRM = "I_ACCEPT_THE_RISK"


class LiveRefused(SystemExit):
    pass


def assert_mode_allowed(cfg: Config) -> None:
    """Hard rule 1: live needs MODE=live, LIVE_CONFIRM and a passing, current graduation report."""
    if cfg.mode != "live":
        return
    if os.environ.get("LIVE_CONFIRM") != LIVE_CONFIRM:
        raise LiveRefused(f"refusing live: set LIVE_CONFIRM={LIVE_CONFIRM}")
    ok, why = check_graduation(cfg)
    if not ok:
        raise LiveRefused(f"refusing live: {why}")


class Runtime:
    def __init__(self, cfg: Config, exchange: Any = None, adapter: ExchangeAdapter | None = None) -> None:
        assert_mode_allowed(cfg)
        self.cfg = cfg
        self.j = Journal(cfg.state_db)
        self.alerts = AlertManager(cfg)
        self.j.subscribe(self.alerts.on_event)
        if adapter is None:
            if cfg.mode == "live":
                from kolibri.adapters.binance import BinanceAdapter

                adapter = BinanceAdapter(cfg, testnet=os.environ.get("BINANCE_TESTNET") == "1")
            else:
                acct = self.j.get_state("paper_account") or {"quote": str(cfg.paper_equity), "base": {}}
                adapter = SimBroker(cfg, Decimal(acct["quote"]))
                # holdings survive restarts, so startup reconciliation sees (and flattens) them like live
                adapter.base.update({s: Decimal(q) for s, q in acct["base"].items() if s in adapter.base})
        self.adapter = adapter
        self.paper = isinstance(adapter, SimBroker)
        self.desk = Desk(cfg, adapter, self.j, adapter.equity({}) if self.paper else cfg.paper_equity)
        self.exchange = exchange
        self.builder = BarBuilder(tuple(cfg.symbols))
        self.scout: Scout | None = None
        self.tasks: list[asyncio.Task[None]] = []
        self.stopping = asyncio.Event()
        # ponytail: one lock serialises every Desk mutation (trades, bar close, watchdog, reconcile,
        # dashboard). Live adapter calls await the network, and without it two tasks could interleave
        # inside the Executioner (e.g. place two stops). Ceiling: a slow REST call delays tick handling.
        self.lock = asyncio.Lock()
        self.server: Any = None
        self.started_ms = now_ms()

    # ---- market callbacks --------------------------------------------------------------------
    async def on_trade(self, sym: str, ts: int, price: Decimal, qty: Decimal, taker_buy: bool) -> None:
        self.builder.on_trade(sym, ts, price, qty, taker_buy)
        async with self.lock:
            if self.paper:
                assert isinstance(self.adapter, SimBroker)
                self.adapter.on_price(sym, ts, price)
            await self.desk.on_price(sym, price, ts)

    def on_book(self, sym: str, book: Book) -> None:
        self.desk.on_book(sym, book)

    # ---- loops ---------------------------------------------------------------------------------
    async def bar_clock(self) -> None:
        grace = self.cfg.execution.bar_grace_ms
        while True:
            t = now_ms() + (self.scout.clock_drift_ms if self.scout else 0)
            minute = int(t - t % MINUTE_MS)
            await asyncio.sleep(max(0.0, (minute + MINUTE_MS + grace - t) / 1000))
            bars = self.builder.close_minute(minute)
            if bars:
                self._refresh_health()
                async with self.lock:
                    await self.desk.on_bars(bars, minute + MINUTE_MS)

    def _refresh_health(self) -> None:
        if self.scout is None:
            return
        now = now_ms()
        for sym, h in self.scout.health.items():
            self.desk.health[sym] = Health(tick_age_s=(now - h.last_msg_ms) / 1000 if h.last_msg_ms else 1e9,
                                           clock_drift_ms=self.scout.clock_drift_ms, connected=h.connected)

    async def watchdog(self) -> None:
        k = self.cfg.kill
        while True:
            await asyncio.sleep(1)
            now = now_ms()
            self._refresh_health()
            if self.scout is None or self.desk.risk.halted(now):
                continue
            reason = None
            for sym, h in self.scout.health.items():
                if not h.ever_connected:
                    continue
                if h.disconnected_since and now - h.disconnected_since > k.ws_gap_recover_s * 1000:
                    reason = f"websocket gap on {sym} not recovered in {k.ws_gap_recover_s}s"
                elif h.connected and now - h.last_msg_ms > k.stale_data_s * 1000:
                    reason = f"stale data on {sym}: {(now - h.last_msg_ms) / 1000:.1f}s"
            if abs(self.scout.clock_drift_ms) > k.max_clock_drift_ms:
                reason = f"clock drift {self.scout.clock_drift_ms:.0f}ms"
            rate_fn = getattr(self.adapter, "error_rate", None)
            if rate_fn is not None:
                rate, n = rate_fn()
                if n >= 10 and rate > k.api_error_rate:
                    reason = f"API error rate {rate:.0%} over {n} calls"
            if reason:
                await self.kill(reason)

    async def reconciler(self) -> None:
        while True:
            await asyncio.sleep(self.cfg.execution.reconcile_s)
            await self.reconcile_once()

    async def kill(self, reason: str) -> None:
        async with self.lock:
            await self.desk.kill(reason, now_ms())

    async def rearm(self) -> None:
        async with self.lock:
            self.desk.risk.rearm(now_ms())

    async def flatten(self, reason: str) -> None:
        async with self.lock:
            await self.desk.exe.flatten_all(reason, now_ms())

    async def reconcile_once(self) -> None:
        async with self.lock:
            now = now_ms()
            problems = await self.desk.exe.reconcile(now)
            if problems and not self.desk.risk.halted(now):
                await self.desk.kill("; ".join(problems), now)
        if self.paper:
            assert isinstance(self.adapter, SimBroker)
            self.j.set_state("paper_account", {"quote": str(self.adapter.quote),
                                               "base": {s: str(q) for s, q in self.adapter.base.items()}})

    async def alert_loop(self) -> None:
        last_hb = now_ms()
        day = now_ms() // DAY_MS
        while True:
            await asyncio.sleep(2)
            now = now_ms()
            if now - last_hb >= self.cfg.alerts.heartbeat_min * MINUTE_MS:
                last_hb = now
                s = self.snapshot()
                self.alerts.push(Alert("INFO", f"💓 Hartslag ({self.cfg.mode}): vermogen {s['equity']:.2f} USDT, "
                                               f"{len(s['positions'])} open positie(s), "
                                               f"{'GESTOPT: ' + s['halted'] if s['halted'] else 'actief'}", now / 1000))
            if now // DAY_MS != day:
                self.alerts.push(Alert("INFO", daily_report(self.j, day * DAY_MS), now / 1000))
                day = now // DAY_MS
            await self.alerts.flush()

    # ---- lifecycle -------------------------------------------------------------------------
    async def start(self, serve_dashboard: bool = True) -> None:
        if self.exchange is None:
            import ccxt.pro as ccxtpro

            self.exchange = ccxtpro.binance({"enableRateLimit": True})
        self.scout = Scout(self.cfg, self.exchange, self.on_trade, self.on_book)
        verify = getattr(self.adapter, "verify_filters", None)
        if verify is not None:
            problems = await verify()
            if problems:
                raise LiveRefused("; ".join(problems))
        # warm-up: features only, never trades on history
        per_sym = {s: await self.scout.warmup_bars(s, self.cfg.warmup_days) for s in self.cfg.symbols}
        by_ts: dict[int, dict[str, Any]] = {}
        for s, bars in per_sym.items():
            for b in bars:
                by_ts.setdefault(b.open_ts, {})[s] = b
        for ts in sorted(by_ts):
            self.desk.warm(by_ts[ts])
            self.builder.closed_until = ts + MINUTE_MS
        for s, bars in per_sym.items():
            if bars:
                self.builder.last_close[s] = bars[-1].close
        # startup reconciliation: anything on the venue we did not open -> flatten + halt
        for _ in range(2):
            await self.reconcile_once()
        coros = [self.bar_clock(), self.watchdog(), self.reconciler(), self.alert_loop(), self.scout.clock()]
        if self.alerts.token and self.alerts.chat:
            coros.append(self.alerts.poll_ack())
        for s in self.cfg.symbols:
            coros += [self.scout.trades(s), self.scout.book(s)]
        stream = getattr(self.adapter, "stream_fills", None)
        if stream is not None:
            coros.append(stream())
        if serve_dashboard:
            coros.append(self.serve_dashboard())
        self.tasks = [asyncio.create_task(c) for c in coros]
        for t in self.tasks:
            t.add_done_callback(self._task_died)
        self.j.emit("alert", now_ms(), severity="INFO", text=f"KOLIBRI gestart in {self.cfg.mode}-modus")

    def _task_died(self, t: asyncio.Task[None]) -> None:
        if t.cancelled() or self.stopping.is_set():
            return
        exc = t.exception()  # every loop is meant to run forever: even a clean return is a failure
        why = type(exc).__name__ if exc else "returned"
        log.critical("task %s died: %s", t.get_coro(), why)
        self._killer = asyncio.get_running_loop().create_task(self.kill(f"internal task died: {why}"))

    async def serve_dashboard(self) -> None:
        import uvicorn

        from kolibri.dashboard.app import create_app

        host = os.environ.get("DASHBOARD_HOST", self.cfg.dashboard.host)  # 0.0.0.0 only inside docker
        server = uvicorn.Server(uvicorn.Config(create_app(self), host=host,
                                               port=self.cfg.dashboard.port, log_level="warning"))
        self.server = server
        await server.serve()

    async def shutdown(self) -> None:
        self.stopping.set()
        if self.cfg.execution.flatten_on_shutdown:
            await self.flatten("shutdown")
            for _ in range(50):  # up to ~10 s for exits to fill
                await asyncio.sleep(0.2)
                async with self.lock:
                    await self.desk.exe.pump(now_ms())
                if not self.desk.exe.positions:
                    break
            if self.desk.exe.positions:
                log.critical("shutdown with open positions; exchange-side stops remain in place")
        if self.server is not None:
            self.server.should_exit = True  # uvicorn stops cleanly; cancelling it mid-serve can hang
        for t in self.tasks:
            if self.server is None or t.get_coro().__name__ != "serve_dashboard":  # type: ignore[union-attr]
                t.cancel()
        if self.tasks:
            await asyncio.wait(self.tasks, timeout=10)
        with contextlib.suppress(Exception):
            await self.alerts.flush()
        if self.exchange is not None:
            with contextlib.suppress(Exception):
                await self.exchange.close()
        self.j.close()

    async def run_forever(self) -> None:
        loop = asyncio.get_running_loop()
        stop = asyncio.Event()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
        await self.start()
        await stop.wait()
        await self.shutdown()

    # ---- dashboard state -----------------------------------------------------------------------
    def snapshot(self) -> dict[str, Any]:
        now = now_ms()
        d, risk = self.desk, self.desk.risk
        eq = float(d.equity())
        positions = []
        for p in d.exe.positions.values():
            mark = d.exe.marks.get(p.symbol, p.entry)
            positions.append({"symbol": p.symbol, "direction": p.direction.value, "setup": p.setup,
                              "qty": str(p.qty), "entry": str(p.entry), "stop": str(p.stop), "mark": str(mark),
                              "r": round(float(p.r_multiple(mark)), 2), "tp1_done": p.tp1_done,
                              "age_s": (now - p.opened_ts) // 1000})
        curve = list(d.equity_curve)[-1440:]
        day0 = now - now % DAY_MS
        health = {}
        if self.scout:
            for s, h in self.scout.health.items():
                health[s] = {"connected": h.connected, "tick_age_s": round((now - h.last_msg_ms) / 1000, 1)
                             if h.last_msg_ms else None, "reconnects": h.reconnects}
        return {
            "mode": self.cfg.mode, "now": now, "equity": eq, "peak": float(risk.peak),
            "drawdown_pct": round((1 - eq / float(risk.peak)) * 100, 3) if risk.peak > 0 else 0.0,
            "day_pnl_pct": round((eq / float(risk.day_start) - 1) * 100, 3) if risk.day_start > 0 else 0.0,
            "halted": risk.halted(now), "positions": positions,
            "regimes": {s: r.value for s, r in d.analyst.regimes.items()},
            "gates": dict(d.analyst.gate_status),
            "curve": [[t, float(e)] for t, e in curve[:: max(1, len(curve) // 400)]],
            "curve_max_dd_pct": round(max_drawdown_pct(e for _, e in curve), 3),
            "today": day_stats(self.j, day0), "rejections": rejection_histogram(self.j, day0),
            "health": health, "clock_drift_ms": round(self.scout.clock_drift_ms, 1) if self.scout else None,
            "late_trades": self.builder.late,
            "alerts": [{"sev": a.severity, "text": a.text, "ts": a.ts} for a in list(self.alerts.recent)[-20:]],
            "unacked": len(self.alerts.unacked),
            "limits": {  # shown next to the numbers they bound, straight from config
                "daily_loss_pct": float(self.cfg.risk.daily_loss_pct),
                "max_drawdown_pct": float(self.cfg.risk.max_drawdown_pct),
                "max_trades_per_day": self.cfg.risk.max_trades_per_day,
                "max_clock_drift_ms": self.cfg.kill.max_clock_drift_ms,
                "risk_per_trade_pct": float(self.cfg.risk.risk_per_trade_pct),
                "max_positions": self.cfg.risk.max_positions,
            },
        }
