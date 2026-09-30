"""Auditor: daily report, rejection histogram, backtest-vs-live drift. Read-only over the journal."""

from __future__ import annotations

from collections import Counter
from decimal import Decimal
from typing import Any

from kolibri.core.journal import Journal
from kolibri.core.models import MINUTE_MS

DAY_MS = 1440 * MINUTE_MS


def rejection_histogram(j: Journal, since_ts: int) -> dict[str, int]:
    return dict(Counter(str(e.data["gate"]) for e in j.query("rejection", since_ts)).most_common())


def day_stats(j: Journal, since_ts: int) -> dict[str, Any]:
    trades = [e.data["trade"] for e in j.query("trade", since_ts)]
    rs = [Decimal(t["r"]) for t in trades]
    pnl = sum((Decimal(t["pnl"]) for t in trades), Decimal(0))
    return {
        "trades": len(trades),
        "wins": sum(1 for r in rs if r > 0),
        "sum_r": float(sum(rs, Decimal(0))),
        "avg_r": float(sum(rs, Decimal(0)) / len(rs)) if rs else 0.0,
        "pnl": float(pnl),
        "intents": len(j.query("intent", since_ts)),
        "kills": [e.data.get("reason") for e in j.query("kill", since_ts)],
    }


def daily_report(j: Journal, day_start_ts: int) -> str:
    s = day_stats(j, day_start_ts)
    rej = rejection_histogram(j, day_start_ts)
    top = ", ".join(f"{k}:{v}" for k, v in list(rej.items())[:5]) or "none"
    kills = "; ".join(str(k) for k in s["kills"]) or "none"
    return (f"KOLIBRI daily report\ntrades {s['trades']} (wins {s['wins']}), sum R {s['sum_r']:+.2f}, "
            f"avg R {s['avg_r']:+.2f}, PnL {s['pnl']:+.2f}\nintents {s['intents']}, top rejections: {top}\n"
            f"kills: {kills}")


def drift(j: Journal, baseline: dict[str, Any], since_ts: int = 0, min_trades: int = 30) -> list[str]:
    """Compare live/paper results with the graduation baseline; flags, never acts."""
    trades = [e.data["trade"] for e in j.query("trade", since_ts)]
    if len(trades) < min_trades or not baseline:
        return []
    rs = [float(t["r"]) for t in trades]
    live_exp = sum(rs) / len(rs)
    live_wr = sum(1 for r in rs if r > 0) / len(rs)
    flags = []
    if live_exp < baseline.get("expectancy_r", 0.0) - 0.15:
        flags.append(f"expectancy drift: live {live_exp:.3f}R vs backtest {baseline['expectancy_r']:.3f}R")
    if live_wr < baseline.get("win_rate", 0.0) - 0.10:
        flags.append(f"win-rate drift: live {live_wr:.1%} vs backtest {baseline['win_rate']:.1%}")
    return flags
