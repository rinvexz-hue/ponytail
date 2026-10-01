"""Replay determinism, backtest/paper parity, realism rules, Desk kill path, graduation gatekeeping."""

from __future__ import annotations

import asyncio
import json
import time
from decimal import Decimal as D
from pathlib import Path

import pytest
from conftest import T0, cheap, intent

from kolibri.adapters.sim import SimBroker
from kolibri.auditor.graduation import build_report, check_graduation, write_report
from kolibri.backtest.data import load_bars, save_bars, synthetic
from kolibri.backtest.engine import bar_path, run
from kolibri.backtest.metrics import max_drawdown_pct, monte_carlo_dd, summarize
from kolibri.core.config import Config, with_overrides
from kolibri.core.journal import Journal
from kolibri.core.models import Bar
from kolibri.desk import Desk
from kolibri.risk.officer import DAY_MS, Approval
from kolibri.runtime import LIVE_CONFIRM, LiveRefused, assert_mode_allowed
from kolibri.scout.scout import BarBuilder


def loose(cfg: Config) -> Config:
    """Permissive config purely to exercise the machinery on synthetic data."""
    return cheap(cfg, **{"gates.score_threshold": 55, "gates.min_net_r": "0", "gates.cost_multiple": "1",
                         "venues.kraken.supports_short": True})


@pytest.fixture(scope="module")
def market() -> dict[str, list[Bar]]:
    from kolibri.core.config import load_config

    return synthetic(load_config(), T0, 1440 * 14, seed=3)  # 4h EMA50 needs ~8.5 days before signals


def _events(j: Journal, kind: str) -> list[tuple[int, str, str]]:
    return [(e.ts, e.symbol, json.dumps(e.data, sort_keys=True)) for e in j.query(kind)]


def test_replay_is_deterministic(cfg: Config, market: dict[str, list[Bar]]) -> None:
    c = loose(cfg)
    j1, j2 = Journal(), Journal()
    r1, r2 = run(c, market, j1), run(c, market, j2)
    assert r1.intents > 0
    for kind in ("intent", "rejection", "order", "fill", "trade"):
        assert _events(j1, kind) == _events(j2, kind), kind
    assert r1.stats == r2.stats


def test_backtest_and_paper_paths_produce_identical_intents(cfg: Config, market: dict[str, list[Bar]]) -> None:
    """Same market -> same intents, whether fed as bars (backtest) or as trades through the live bar builder."""
    c = loose(cfg)
    jb = Journal()
    run(c, market, jb)

    async def paper() -> Journal:
        j = Journal()
        broker = SimBroker(c, c.paper_equity)
        desk = Desk(c, broker, j, c.paper_equity)
        builder = BarBuilder(tuple(c.symbols))
        by_ts: dict[int, dict[str, Bar]] = {}
        for s, series in market.items():
            for b in series:
                by_ts.setdefault(b.open_ts, {})[s] = b
        for ts in sorted(by_ts):
            batch = by_ts[ts]
            paths = {s: bar_path(batch[s]) for s in sorted(batch)}
            for k in range(4):
                for s, path in paths.items():
                    pts, px = path[k]
                    b = batch[s]
                    qty, buy = [(b.taker_buy_volume, True), (b.volume - b.taker_buy_volume, False),
                                (D(0), False), (D(0), False)][k]
                    builder.on_trade(s, pts, px, qty, buy)
                    broker.on_price(s, pts, px)
                    await desk.on_price(s, px, pts)
            bars = builder.close_minute(ts)
            assert bars == batch  # the trade-built bar is bit-identical to the recorded bar
            await desk.on_bars(bars, ts + 60_000)
        return j

    jp = asyncio.run(paper())
    assert _events(jb, "intent") == _events(jp, "intent")
    assert _events(jb, "intent")


def test_signal_never_fills_on_its_own_bar() -> None:
    b = Bar("BTCEUR", T0, 60_000, D(100), D(101), D(99), D("100.5"), D(1), D("0.5"))
    path = bar_path(b)
    assert path[-1][0] < b.close_ts  # all intrabar points precede the close where signals fire
    assert [p for _, p in path] == [D(100), D(99), D(101), D("100.5")]  # adverse extreme first


def test_bar_storage_roundtrip(tmp_path: Path, market: dict[str, list[Bar]]) -> None:
    bars = market["ETHEUR"][:3000]
    save_bars(tmp_path, bars)
    assert load_bars(tmp_path, "ETHEUR") == bars
    assert load_bars(tmp_path, "ETHEUR", bars[10].open_ts, bars[20].open_ts) == bars[10:20]


def test_metrics_and_monte_carlo() -> None:
    assert max_drawdown_pct([100, 120, 90, 130]) == pytest.approx(25.0)
    assert summarize([])["trades"] == 0
    assert monte_carlo_dd([], 10) == 0.0


def test_desk_daily_loss_kill_flattens_and_halts(cfg: Config) -> None:
    async def go() -> Desk:
        j = Journal()
        broker = SimBroker(cfg, D("10000"))
        desk = Desk(cfg, broker, j, D("10000"))
        for ts, px in ((T0, "100.05"), (T0 + 10, "100.05")):
            broker.on_price("BTCEUR", ts, D(px))
            await desk.on_price("BTCEUR", D(px), ts)
        await desk.exe.open(intent(stop="90", tp1="110"), Approval(D("90"), D("900")), D("100"), T0 + 20)
        for ts, px in ((T0 + 300, "99.99"), (T0 + 600, "99.99"), (T0 + 900, "97.70"), (T0 + 1200, "97.70")):
            broker.on_price("BTCEUR", ts, D(px))
            await desk.on_price("BTCEUR", D(px), ts)
        return desk

    desk = asyncio.run(go())
    assert desk.killed and desk.killed.startswith("daily_loss")
    assert not desk.exe.positions and desk.trades[0].exit_reason.startswith("daily_loss")
    assert desk.risk.halted(T0 + 2000) and not desk.risk.halted(T0 + DAY_MS + 1)


def test_graduation_refuses_on_weak_evidence(cfg: Config, tmp_path: Path, market: dict[str, list[Bar]]) -> None:
    c = with_overrides(cfg, {"tunable": ["gates.score_threshold"], "graduation.report_path": str(tmp_path / "g.json")})
    rep = build_report(c, market)
    assert rep["passed"] is False and rep["verdict"] == "DO NOT GO LIVE"
    assert {ch["name"] for ch in rep["checks"]} >= {"oos.trades", "oos.profit_factor", "oos.mc_p95_max_dd_pct",
                                                     "stability.min_expectancy_r", "paper.days", "paper.trades"}
    write_report(rep, c.graduation.report_path)
    assert (tmp_path / "g.md").exists()
    ok, why = check_graduation(c)
    assert not ok and "DO NOT GO LIVE" in why


def test_live_mode_refuses_without_every_condition(cfg: Config, tmp_path: Path,
                                                   monkeypatch: pytest.MonkeyPatch) -> None:
    rp = tmp_path / "g.json"
    live = with_overrides(cfg, {"mode": "live", "graduation.report_path": str(rp)})
    assert_mode_allowed(cfg)  # paper: always allowed
    monkeypatch.delenv("LIVE_CONFIRM", raising=False)
    with pytest.raises(LiveRefused, match="LIVE_CONFIRM"):
        assert_mode_allowed(live)
    monkeypatch.setenv("LIVE_CONFIRM", LIVE_CONFIRM)
    with pytest.raises(LiveRefused, match="no graduation report"):
        assert_mode_allowed(live)
    good = {"passed": True, "config_fingerprint": live.fingerprint(), "generated_ms": int(time.time() * 1000)}
    rp.write_text(json.dumps(good | {"passed": False}))
    with pytest.raises(LiveRefused, match="DO NOT GO LIVE"):
        assert_mode_allowed(live)
    rp.write_text(json.dumps(good | {"config_fingerprint": "tampered"}))
    with pytest.raises(LiveRefused, match="fingerprint"):
        assert_mode_allowed(live)
    rp.write_text(json.dumps(good | {"generated_ms": 0}))
    with pytest.raises(LiveRefused, match="days old"):
        assert_mode_allowed(live)
    rp.write_text(json.dumps(good))
    assert_mode_allowed(live)  # only now
    monkeypatch.setenv("LIVE_CONFIRM", "yes")
    with pytest.raises(LiveRefused):
        assert_mode_allowed(live)


def test_touch_falls_back_to_bar_close_before_first_print(cfg: Config) -> None:
    desk = Desk(cfg, SimBroker(cfg, D("1000")), Journal(), D("1000"))
    from kolibri.core.models import Direction

    assert desk._touch("XRPEUR", Direction.LONG, D("0.50000")) == D("0.49999")
