"""Progress view: are we moving toward live, and is performance heading the right way? Read-only.

Combines the preflight checklist (where on the road to live), the latest graduation report (how far
each metric is from its bar) and the paper / canary journals (cumulative and rolling R vs the
backtest baseline) into one verdict a human can read in five seconds."""

from __future__ import annotations

import json
import statistics
from pathlib import Path
from typing import Any

from kolibri.auditor.preflight import checklist
from kolibri.core.config import Config, with_overrides
from kolibri.core.journal import Journal

ROLLING = 20  # trades in the rolling expectancy window
MIN_JUDGE = 10  # fewer trades than this: too early to call a direction


def _trades(path: str) -> list[dict[str, Any]]:
    if not Path(path).exists():
        return []
    j = Journal(path)
    out = [e.data["trade"] for e in j.query("trade")]
    j.close()
    return sorted(out, key=lambda t: int(t["closed_ts"]))


def _series(trades: list[dict[str, Any]]) -> list[dict[str, float | None]]:
    cum, out = 0.0, []
    rs = [float(t["r"]) for t in trades]
    for i, t in enumerate(trades):
        cum += rs[i]
        window = rs[max(0, i + 1 - ROLLING): i + 1]
        out.append({"ts": int(t["closed_ts"]), "r": rs[i], "cum_r": round(cum, 4),
                    "rolling": round(statistics.mean(window), 4) if len(window) >= min(ROLLING, 5) else None})
    return out


def judge(rs: list[float], baseline: float | None) -> dict[str, str]:
    """Plain-language direction call from closed-trade R multiples."""
    n = len(rs)
    if n < MIN_JUDGE:
        return {"level": "wait", "title": "Nog te vroeg om te oordelen",
                "text": f"{n} van minimaal {MIN_JUDGE} trades. Laat het systeem draaien en verander niets."}
    exp = statistics.mean(rs)
    recent = statistics.mean(rs[-ROLLING:])
    base = f" (backtest: {baseline:+.2f} R)" if baseline is not None else ""
    if exp <= 0 and n >= 2 * MIN_JUDGE:
        return {"level": "bad", "title": "Niet op koers",
                "text": f"Gemiddeld {exp:+.2f} R per trade over {n} trades{base}. Niet doorgaan naar de volgende fase;"
                        " zoek uit waarom (fees? slippage? andere markt?)."}
    if exp <= 0 or (baseline is not None and exp < 0.5 * baseline):
        return {"level": "warn", "title": "Twijfelachtig",
                "text": f"Gemiddeld {exp:+.2f} R per trade{base}; laatste {min(n, ROLLING)}: {recent:+.2f} R."
                        " Nog niet doorgaan; meer trades verzamelen."}
    if baseline is not None and n >= ROLLING and recent < 0.5 * baseline:
        return {"level": "warn", "title": "Let op: recente trades zwakker",
                "text": f"Over alle {n} trades gemiddeld {exp:+.2f} R{base}, maar de laatste {ROLLING} maar"
                        f" {recent:+.2f} R. Nog niet naar de volgende fase; kijk of de markt veranderd is."}
    return {"level": "good", "title": "Op koers",
            "text": f"Gemiddeld {exp:+.2f} R per trade over {n} trades{base}; laatste {min(n, ROLLING)}:"
                    f" {recent:+.2f} R. Ga door volgens het stappenplan."}


def _check_progress(c: dict[str, Any]) -> float:
    """0..1: how far a metric is toward its bar (1 = passed)."""
    if c.get("pass"):
        return 1.0
    try:
        v, t = float(c["value"]), float(c["threshold"])
    except (TypeError, ValueError):
        return 0.0
    if c["op"] in (">=", ">"):
        return max(0.0, min(0.99, v / t)) if t > 0 else 0.0
    return max(0.0, min(0.99, t / v)) if v > 0 else 0.0  # "<=" / "<": lower is better


def build_progress(cfg: Config) -> dict[str, Any]:
    phases: list[dict[str, Any]] = []
    for title, items in checklist(cfg):
        done = sum(1 for i in items if i.ok)
        blocking = [i for i in items if i.ok is False]
        phases.append({"title": title, "done": done, "total": len(items),
                       "status": "done" if not blocking else ("partial" if done else "todo"),
                       "items": [{"ok": i.ok, "text": i.text, "fix": i.fix} for i in items]})
    current = next((i for i, p in enumerate(phases) if p["status"] != "done"), len(phases))
    next_fix = next((it["fix"] for p in phases for it in p["items"] if it["ok"] is False), "")

    rp = Path(cfg.graduation.report_path)
    rep: dict[str, Any] = json.loads(rp.read_text()) if rp.exists() else {}
    baseline = rep.get("oos_stats", {}).get("expectancy_r") if rep else None
    checks = [{**c, "progress": _check_progress(c)} for c in rep.get("checks", [])]

    paper = _trades(with_overrides(cfg, {"mode": "paper"}).state_path)
    live = _trades(with_overrides(cfg, {"mode": "live"}).state_path)
    # judge on canary/live once it has enough trades; until then paper is the better evidence
    use_live = len(live) >= MIN_JUDGE or not paper
    active = live if use_live else paper
    return {
        "phases": phases,
        "current_phase": current,
        "next_step": next_fix,
        "stage": rep.get("stage", "none") if rep else "geen rapport",
        "verdict_text": rep.get("verdict", "") if rep else "",
        "fingerprint_ok": bool(rep) and rep.get("config_fingerprint") == cfg.fingerprint(),
        "baseline_expectancy_r": baseline,
        "checks": checks,
        "paper": _series(paper),
        "live": _series(live),
        "direction": judge([float(t["r"]) for t in active], baseline) | {
            "source": "canary/live" if use_live else "paper",
            "note": (f"canary/live: {len(live)} trades, oordeel volgt vanaf {MIN_JUDGE}"
                     if live and not use_live else "")},
    }
