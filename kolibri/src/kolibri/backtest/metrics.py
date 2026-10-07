"""Trade statistics shared by the backtester, the Auditor and the graduation report."""

from __future__ import annotations

import itertools
import math
import random
from collections import defaultdict
from collections.abc import Iterable
from decimal import Decimal
from typing import Any

from kolibri.core.models import MINUTE_MS, ClosedTrade

DAY_MS = 1440 * MINUTE_MS


def max_drawdown_pct(equity: Iterable[Decimal | float]) -> float:
    peak, worst = -math.inf, 0.0
    for e in equity:
        x = float(e)
        peak = max(peak, x)
        if peak > 0:
            worst = max(worst, (peak - x) / peak * 100)
    return worst


def daily_sharpe(curve: list[tuple[int, Decimal]]) -> float:
    by_day: dict[int, float] = {}
    for ts, eq in curve:
        by_day[ts // DAY_MS] = float(eq)  # last equity of each UTC day
    vals = [by_day[d] for d in sorted(by_day)]
    rets = [b / a - 1 for a, b in itertools.pairwise(vals) if a > 0]
    if len(rets) < 2:
        return 0.0
    m = sum(rets) / len(rets)
    sd = math.sqrt(sum((r - m) ** 2 for r in rets) / (len(rets) - 1))
    return 0.0 if sd == 0 else m / sd * math.sqrt(365)


def summarize(trades: list[ClosedTrade], curve: list[tuple[int, Decimal]] | None = None) -> dict[str, Any]:
    n = len(trades)
    wins = [t for t in trades if t.pnl > 0]
    gp = sum((t.pnl for t in wins), Decimal(0))
    gl = -sum((t.pnl for t in trades if t.pnl <= 0), Decimal(0))
    fees = sum((t.fees for t in trades), Decimal(0))
    gross = sum((t.pnl + t.fees for t in trades), Decimal(0))  # pnl before fees
    out: dict[str, Any] = {
        "trades": n,
        "win_rate": len(wins) / n if n else 0.0,
        "profit_factor": float(gp / gl) if gl > 0 else (math.inf if gp > 0 else 0.0),
        "expectancy_r": float(sum((t.r for t in trades), Decimal(0)) / n) if n else 0.0,
        "net_pnl": float(sum((t.pnl for t in trades), Decimal(0))),
        "fees": float(fees),
        "fee_ratio": float(fees / gross) if gross > 0 else math.inf,
        "max_dd_pct": max_drawdown_pct(e for _, e in curve) if curve else 0.0,
        "sharpe_daily": daily_sharpe(curve) if curve else 0.0,
    }
    for key in ("symbol", "setup", "exit_reason"):
        groups: dict[str, list[ClosedTrade]] = defaultdict(list)
        for t in trades:
            groups[str(getattr(t, key))].append(t)
        out[f"by_{key}"] = {k: {"trades": len(v), "expectancy_r": float(sum((t.r for t in v), Decimal(0)) / len(v))}
                            for k, v in sorted(groups.items())}
    return out


def monte_carlo_dd(trades: list[ClosedTrade], runs: int, seed: int = 1) -> float:
    """5th-percentile-worst (i.e. 95th percentile) max drawdown % over shuffled trade orders."""
    if not trades:
        return 0.0
    rng = random.Random(seed)
    rets = [float(t.pnl / t.equity_before) if t.equity_before > 0 else 0.0 for t in trades]
    dds = []
    for _ in range(runs):
        rng.shuffle(rets)
        eq, curve = 1.0, [1.0]
        for r in rets:
            eq *= 1 + r
            curve.append(eq)
        dds.append(max_drawdown_pct(curve))
    dds.sort()
    return dds[min(len(dds) - 1, int(0.95 * len(dds)))]
