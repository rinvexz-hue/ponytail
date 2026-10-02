"""The road to live: stages, canary sizing, config overlay, optimizer guards, pivots, preflight."""

from __future__ import annotations

import json
import shutil
import time
from decimal import Decimal as D
from pathlib import Path

import pytest
from conftest import T0, intent

from kolibri.analyst.features import Context
from kolibri.auditor.graduation import check_graduation, stage_of
from kolibri.auditor.optimize import MIN_CALIB_TRADES, _robust, apply_overrides, calibrate
from kolibri.auditor.preflight import Item, render
from kolibri.core.config import CONFIG_DIR, Config, load_config, with_overrides
from kolibri.core.journal import Journal
from kolibri.core.models import Bar, ClosedTrade, Direction
from kolibri.risk.officer import Approval, RiskOfficer
from kolibri.runtime import LIVE_CONFIRM, assert_mode_allowed


def _check(stage: str, ok: bool) -> dict:
    return {"stage": stage, "pass": ok}


def test_stage_ladder() -> None:
    assert stage_of([_check("canary", False), _check("live", True)]) == "none"
    assert stage_of([_check("canary", True), _check("live", False)]) == "canary"
    assert stage_of([_check("canary", True), _check("live", True)]) == "live"


def test_live_start_reports_canary_stage(cfg: Config, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    rp = tmp_path / "g.json"
    live = with_overrides(cfg, {"mode": "live", "graduation.report_path": str(rp)})
    monkeypatch.setenv("LIVE_CONFIRM", LIVE_CONFIRM)
    base = {"config_fingerprint": live.fingerprint(), "generated_ms": int(time.time() * 1000)}
    rp.write_text(json.dumps(base | {"stage": "canary", "passed": True}))
    assert check_graduation(live)[0] == "canary"
    assert assert_mode_allowed(live) == "canary"
    rp.write_text(json.dumps(base | {"stage": "none", "passed": False}))
    assert check_graduation(live)[0] is None


def test_canary_caps_order_value(cfg: Config) -> None:
    r = RiskOfficer(cfg, Journal(), D("100000"))
    normal = r.review(intent(entry="100", stop="99", tp1="101"), [], {}, {}, T0)
    assert isinstance(normal, Approval) and normal.qty * 100 > cfg.execution.canary_notional
    r.canary_notional = cfg.execution.canary_notional
    small = r.review(intent(entry="100", stop="99", tp1="101"), [], {}, {}, T0)
    assert isinstance(small, Approval) and small.qty * 100 <= cfg.execution.canary_notional


def test_risk_anchors_reset_to_real_equity(cfg: Config) -> None:
    j = Journal()
    r = RiskOfficer(cfg, j, D("10000"))  # e.g. paper default before the live balance is known
    r.reset_anchors(D("500"), T0)
    assert r.on_equity(D("495"), T0 + 1) is None  # -1 %: no false drawdown kill vs the 10k default
    assert RiskOfficer(cfg, j, D("10000")).peak == D("500")  # persisted


def test_local_yaml_overrides_default(tmp_path: Path) -> None:
    d = tmp_path / "config"
    shutil.copytree(CONFIG_DIR, d)
    (d / "local.yaml").unlink(missing_ok=True)
    base = load_config(d)
    path = apply_overrides({"gates.min_room_r": "2.0", "gates.win_prob_by_setup": {"A_pullback": "0.55"}}, d)
    assert path == d / "local.yaml"
    cfg = load_config(d)
    assert cfg.gates.min_room_r == D("2.0") and cfg.gates.win_prob_by_setup == {"A_pullback": D("0.55")}
    assert cfg.risk == base.risk and cfg.fingerprint() != base.fingerprint()  # re-graduation forced


def _t(setup: str, pnl: str, ts: int = T0) -> ClosedTrade:
    return ClosedTrade("BTCEUR", setup, Direction.LONG, ts, ts, D(100), D(1), D(pnl), D(0), D(pnl), "tp1", D(10000))


def test_calibration_needs_enough_trades_and_shrinks(cfg: Config) -> None:
    few = [_t("A_pullback", "1")] * (MIN_CALIB_TRADES - 1)
    assert calibrate(cfg, few, {}) == {}
    many = [_t("A_pullback", "1")] * 40 + [_t("A_pullback", "-1")] * 20  # 66.7 % raw
    p = float(calibrate(cfg, many, {"A_pullback": [70.0]})["A_pullback"])
    assert 0.5 < p < 0.667  # pulled toward 50 %


def test_robust_score_rejects_thin_folds() -> None:
    bounds = [(T0, T0 + 10), (T0 + 10, T0 + 20)]
    trades = [_t("A", "1", T0 + 1)] * 6 + [_t("A", "1", T0 + 11)] * 2
    assert _robust(trades, bounds, min_fold=5)[0] == float("-inf")
    trades += [_t("A", "-1", T0 + 12)] * 4
    score, folds = _robust(trades, bounds, min_fold=5)
    assert folds == [1.0, pytest.approx(-1 / 3)] and score < min(folds) + 1  # spread penalised


def test_4h_pivots_are_confirmed_only_after_two_closed_bars() -> None:
    ctx = Context("BTCEUR", 240)
    highs = [100, 102, 110, 103, 101, 104, 120, 105]

    def feed(i: int, h: int) -> None:
        ts = T0 + i * 4 * 3_600_000
        ctx.update(Bar("BTCEUR", ts, 4 * 3_600_000, D(h - 1), D(h), D(h - 5), D(h - 1), D(1), D(1)))

    for i, h in enumerate(highs[:4]):
        feed(i, h)
    assert list(ctx.pivot_highs) == []  # 110 has only one closed bar after it
    feed(4, highs[4])
    assert list(ctx.pivot_highs) == [110]
    for i, h in enumerate(highs[5:], start=5):
        feed(i, h)
    res, _ = ctx.levels(104.5)
    assert res == 110  # nearest confirmed swing high above price (120 is not yet confirmed)
    assert ctx.levels(130)[0] == 130  # nothing above: open air


def test_preflight_points_at_first_blocker() -> None:
    out = render([("A", [Item(True, "ok"), Item(None, "warn", "x")]), ("B", [Item(False, "bad", "doe dit")])])
    assert "Volgende stap: doe dit" in out and "✅ ok" in out
