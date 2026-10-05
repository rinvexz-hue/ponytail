"""Progress view: direction verdict, metric progress, standalone dashboard."""

from __future__ import annotations

from pathlib import Path

import pytest
from conftest import T0
from fastapi.testclient import TestClient

from kolibri.auditor.progress import MIN_JUDGE, _check_progress, build_progress, judge
from kolibri.core.config import Config, with_overrides
from kolibri.core.journal import Journal
from kolibri.dashboard.app import create_app


def test_judge_levels() -> None:
    assert judge([1.0] * (MIN_JUDGE - 1), 0.3)["level"] == "wait"
    assert judge([0.5, -0.2] * 10, 0.3)["level"] == "good"  # +0.15 R vs 0.3 baseline: >= half
    assert judge([0.1, -0.05] * 10, 0.3)["level"] == "warn"  # positive but < half of the backtest
    assert judge([-0.5, 0.3] * 10, 0.3)["level"] == "bad"  # negative over >= 20 trades
    assert judge([-0.5, 0.3] * 6, 0.3)["level"] == "warn"  # negative but still few trades
    fading = [1.0] * 20 + [0.3, -0.3] * 10  # strong start, flat last 20 trades
    assert judge(fading, 0.3)["title"].startswith("Let op")


def test_check_progress_direction() -> None:
    assert _check_progress({"pass": True, "value": 1, "op": ">=", "threshold": 2}) == 1.0
    assert _check_progress({"pass": False, "value": 150, "op": ">=", "threshold": 300}) == pytest.approx(0.5)
    assert _check_progress({"pass": False, "value": 16, "op": "<=", "threshold": 8}) == pytest.approx(0.5)
    assert _check_progress({"pass": False, "value": "inf", "op": "<", "threshold": 0.4}) == 0.0


def _journal(path: str, rs: list[float]) -> None:
    j = Journal(path)
    for i, r in enumerate(rs):
        ts = T0 + i * 3_600_000
        j.emit("trade", ts, "BTCEUR", trade={"r": str(r), "closed_ts": ts, "opened_ts": ts - 600_000, "pnl": str(r)})
    j.close()


def test_build_progress_and_standalone_dashboard(cfg: Config, tmp_path: Path,
                                                 monkeypatch: pytest.MonkeyPatch) -> None:
    c = with_overrides(cfg, {"state_db": str(tmp_path / "k-{mode}.sqlite"), "data_dir": str(tmp_path / "h"),
                             "graduation.report_path": str(tmp_path / "g.json")})
    _journal(str(tmp_path / "k-paper.sqlite"), [0.4, -0.2] * 8)
    p = build_progress(c)
    assert [x["cum_r"] for x in p["paper"]][-1] == pytest.approx(1.6) and p["live"] == []
    assert p["direction"]["level"] == "good" and p["direction"]["source"] == "paper"
    assert p["phases"][0]["status"] == "todo" and p["next_step"].startswith("kolibri download")
    monkeypatch.setenv("DASHBOARD_TOKEN", "x" * 32)
    client = TestClient(create_app(None, c))
    ok = {"Authorization": "Bearer " + "x" * 32}
    assert client.get("/api/progress").status_code == 401
    assert client.get("/api/progress", headers=ok).json()["direction"]["level"] == "good"
    assert client.get("/api/state", headers=ok).status_code == 409  # no desk running
    assert client.post("/api/kill", headers=ok).status_code == 409
