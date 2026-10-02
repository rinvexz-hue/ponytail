"""Graduation report: the only path to MODE=live.

OOS evidence = walk-forward windows (fixed params, or re-fitted on the previous window with
--optimize), parameter-perturbation stability, Monte Carlo drawdown, plus the paper journal.
The report is bound to the config fingerprint: change a trading parameter and you re-graduate."""

from __future__ import annotations

import json
import math
import time
from decimal import Decimal
from itertools import product
from pathlib import Path
from typing import Any

from kolibri.backtest.engine import run
from kolibri.backtest.metrics import monte_carlo_dd, summarize
from kolibri.core.config import Config, get_path, with_overrides
from kolibri.core.journal import Journal
from kolibri.core.models import MINUTE_MS, Bar, ClosedTrade, Direction

DAY_MS = 1440 * MINUTE_MS


def _slice(bars: dict[str, list[Bar]], start: int, end: int) -> dict[str, list[Bar]]:
    return {s: [b for b in v if start <= b.open_ts < end] for s, v in bars.items()}


def _perturb(value: Any, f: float) -> Any:
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return max(1, round(value * f))
    if isinstance(value, Decimal):
        return str(value * Decimal(repr(f)))
    return value * f


def _check(name: str, value: float, op: str, threshold: float) -> dict[str, Any]:
    ok = {">=": value >= threshold, "<=": value <= threshold, "<": value < threshold, ">": value > threshold}[op]
    return {"name": name, "value": round(value, 4) if math.isfinite(value) else str(value), "op": op,
            "threshold": threshold, "pass": bool(ok)}


def _core_checks(prefix: str, st: dict[str, Any], cfg: Config, min_trades: int | None = None) -> list[dict[str, Any]]:
    g = cfg.graduation
    return [
        _check(f"{prefix}.trades", st["trades"], ">=", g.min_trades if min_trades is None else min_trades),
        _check(f"{prefix}.profit_factor", st["profit_factor"], ">=", float(g.min_profit_factor)),
        _check(f"{prefix}.expectancy_r", st["expectancy_r"], ">=", float(g.min_expectancy_r)),
        _check(f"{prefix}.max_dd_pct", st["max_dd_pct"], "<=", float(g.max_drawdown_pct)),
        _check(f"{prefix}.sharpe_daily", st["sharpe_daily"], ">=", float(g.min_sharpe)),
        _check(f"{prefix}.fee_ratio", st["fee_ratio"], "<", float(g.max_fee_ratio)),
    ]


def walk_forward(cfg: Config, bars: dict[str, list[Bar]], optimize: bool = False,
                 windows: int = 4) -> tuple[list[ClosedTrade], list[dict[str, Any]], list[tuple[int, Decimal]]]:
    """Split into windows+1 segments: segment 0 is warm-up / first fit, 1..windows are out-of-sample."""
    ts = sorted({b.open_ts for v in bars.values() for b in v})
    if not ts:
        return [], [], []
    t0, t1 = ts[0], ts[-1] + MINUTE_MS
    seg = (t1 - t0) // (windows + 1)
    warm = cfg.warmup_days * DAY_MS
    trades: list[ClosedTrade] = []
    curve: list[tuple[int, Decimal]] = []
    rows = []
    for w in range(1, windows + 1):
        ws, we = t0 + w * seg, t0 + (w + 1) * seg if w < windows else t1
        wcfg, chosen = cfg, {}
        if optimize and len(cfg.tunable) >= 2 and w > 1:  # window 1 has no prior OOS-free fit segment
            p1, p2 = cfg.tunable[0], cfg.tunable[1]  # 3x3 grid on the first two tunables only
            best = -math.inf
            for f1, f2 in product((0.8, 1.0, 1.2), repeat=2):
                ov = {p1: _perturb(get_path(cfg, p1), f1), p2: _perturb(get_path(cfg, p2), f2)}
                res = run(with_overrides(cfg, ov), _slice(bars, ws - seg - warm, ws))
                score = res.stats["expectancy_r"] if res.stats["trades"] >= 20 else -math.inf
                if score > best:
                    best, wcfg, chosen = score, with_overrides(cfg, ov), ov
        res = run(wcfg, _slice(bars, ws - warm, we))
        wt = [t for t in res.trades if t.opened_ts >= ws]
        curve += [(t, e) for t, e in res.curve if t >= ws]
        trades += wt
        st = summarize(wt)
        rows.append({"window": w, "start": ws, "end": we, "trades": st["trades"],
                     "expectancy_r": st["expectancy_r"], "params": chosen})
    return trades, rows, curve


def paper_trades(journal_path: str | Path) -> list[ClosedTrade]:
    if not Path(journal_path).exists():
        return []
    j = Journal(journal_path)
    out = []
    for ev in j.query("trade"):
        t = ev.data["trade"]
        out.append(ClosedTrade(t["symbol"], t["setup"], Direction(t["direction"]), t["opened_ts"], t["closed_ts"],
                               Decimal(t["entry"]), Decimal(t["qty"]), Decimal(t["pnl"]), Decimal(t["fees"]),
                               Decimal(t["r"]), t["exit_reason"], Decimal(t["equity_before"])))
    j.close()
    return out


def build_report(cfg: Config, bars: dict[str, list[Bar]], paper_journal: str | Path | None = None,
                 optimize: bool = False, live_journal: str | Path | None = None) -> dict[str, Any]:
    trades, windows, curve = walk_forward(cfg, bars, optimize=optimize)
    st = summarize(trades, curve)
    checks = _core_checks("oos", st, cfg)
    pos_windows = sum(1 for w in windows if w["trades"] and w["expectancy_r"] > 0)
    checks.append(_check("oos.positive_windows", pos_windows, ">=", 3))
    pos_syms = sum(1 for v in st["by_symbol"].values() if v["expectancy_r"] > 0)
    checks.append(_check("oos.positive_symbols", pos_syms, ">=", 3))
    checks.append(_check("oos.mc_p95_max_dd_pct", monte_carlo_dd(trades, cfg.graduation.mc_runs), "<=",
                         float(cfg.graduation.mc_max_dd_pct)))

    # parameter stability: +-20 % on each tunable must not flip OOS expectancy negative
    ts = sorted({b.open_ts for v in bars.values() for b in v})
    oos_start = ts[0] + (ts[-1] - ts[0]) // 5 if ts else 0
    perturb = []
    worst = math.inf if cfg.tunable else 0.0
    for path in cfg.tunable:
        for f in (0.8, 1.2):
            pc = with_overrides(cfg, {path: _perturb(get_path(cfg, path), f)})
            pt = [t for t in run(pc, bars).trades if t.opened_ts >= oos_start]
            e = summarize(pt)["expectancy_r"] if pt else 0.0
            perturb.append({"param": path, "factor": f, "trades": len(pt), "expectancy_r": e})
            worst = min(worst, float(e))
    checks.append(_check("stability.min_expectancy_r", worst, ">", 0.0))

    for c in checks:
        c["stage"] = "canary"  # out-of-sample proof gates even the tiny-order canary stage
    g = cfg.graduation

    def curve_of(ts_: list[ClosedTrade]) -> list[tuple[int, Decimal]]:
        out, eq = [], ts_[0].equity_before if ts_ else Decimal(0)
        for t in ts_:
            eq += t.pnl
            out.append((t.closed_ts, eq))
        return out

    pt = paper_trades(paper_journal) if paper_journal else []
    days = (max(t.closed_ts for t in pt) - min(t.opened_ts for t in pt)) / DAY_MS if pt else 0.0
    pst = summarize(pt, curve_of(pt))
    canary = [_check("paper.days", days, ">=", g.min_paper_days),
              _check("paper.trades_for_canary", len(pt), ">=", g.canary_min_paper_trades),
              _check("paper.expectancy_not_negative", pst["expectancy_r"], ">=", 0.0)]
    checks += [c | {"stage": "canary"} for c in canary]
    checks += [c | {"stage": "live"} for c in _core_checks("paper", pst, cfg, g.paper_min_trades)]

    lt = paper_trades(live_journal) if live_journal else []  # canary trades: tiny size, same R maths
    lst = summarize(lt)
    auto_kills = _auto_kills(live_journal) if live_journal else 0
    checks += [c | {"stage": "live"} for c in (
        _check("canary.trades", len(lt), ">=", g.canary_min_live_trades),
        _check("canary.expectancy_not_negative", lst["expectancy_r"], ">=", 0.0),
        _check("canary.automatic_kills", auto_kills, "<=", 0),
    )]

    stage = stage_of(checks)
    verdict = {"live": "GRADUATED: live-small (<= 10 % of intended capital, 1x)",
               "canary": f"CANARY ONLY: live with orders capped at {cfg.execution.canary_notional} {cfg.quote}",
               "none": "DO NOT GO LIVE"}[stage]
    return {
        "generated_ms": int(time.time() * 1000),
        "config_fingerprint": cfg.fingerprint(),
        "stage": stage,
        "passed": stage != "none",
        "verdict": verdict,
        "checks": checks,
        "oos_stats": st,
        "walk_forward": windows,
        "perturbation": perturb,
        "paper_trades": len(pt),
        "canary_trades": len(lt),
    }


def stage_of(checks: list[dict[str, Any]]) -> str:
    """"canary" needs every canary-stage check; "live" needs every check; else "none"."""
    if not all(c["pass"] for c in checks if c["stage"] == "canary"):
        return "none"
    return "live" if all(c["pass"] for c in checks) else "canary"


def _auto_kills(journal_path: str | Path) -> int:
    """Kill-switch events that were not pressed by a human (those are execution problems)."""
    if not Path(journal_path).exists():
        return 0
    j = Journal(journal_path)
    n = sum(1 for e in j.query("kill") if not str(e.data.get("reason", "")).startswith("manual"))
    j.close()
    return n


def write_report(report: dict[str, Any], path: str | Path) -> None:
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(report, indent=2, default=str))
    lines = [f"# KOLIBRI graduation report\n\n**Verdict: {report['verdict']}**\n",
             f"Config fingerprint `{report['config_fingerprint']}`\n", "| stage | check | value | rule | pass |",
             "|---|---|---|---|---|"]
    for c in report["checks"]:
        ok = "✅" if c["pass"] else "❌"
        lines.append(f"| {c['stage']} | {c['name']} | {c['value']} | {c['op']} {c['threshold']} | {ok} |")
    Path(path).with_suffix(".md").write_text("\n".join(lines) + "\n")


def check_graduation(cfg: Config, path: str | Path | None = None) -> tuple[str | None, str]:
    """Returns the unlocked live stage ("canary" | "live") or None with the reason."""
    p = Path(path or cfg.graduation.report_path)
    if not p.exists():
        return None, f"no graduation report at {p}"
    try:
        r = json.loads(p.read_text())
    except ValueError:
        return None, "graduation report unreadable"
    stage = r.get("stage", "live" if r.get("passed") else "none")
    if stage not in ("canary", "live"):
        return None, "graduation report says DO NOT GO LIVE"
    if r.get("config_fingerprint") != cfg.fingerprint():
        return None, "config changed since graduation (fingerprint mismatch)"
    age_days = (time.time() * 1000 - r.get("generated_ms", 0)) / DAY_MS
    if age_days > cfg.graduation.max_age_days:
        return None, f"graduation report is {age_days:.0f} days old"
    return stage, "ok"
