"""`kolibri optimize`: a deliberately boring, overfitting-resistant parameter search + calibration.

1. The last 25 % of history is a holdout that the search never sees.
2. On the first 75 %, a coarse 3x3x3 grid (3 parameters that move the top-down logic most) is run;
   each combo is scored per time fold: median fold expectancy minus half its spread.
3. Scores are smoothed over grid neighbours, so an isolated lucky peak loses to a stable plateau.
4. The winner must beat the current config by a margin on the research data AND not lose on the
   holdout; otherwise the advice is "keep the current values". No change is a valid outcome.
5. Win probabilities per setup are calibrated from the research trades (shrunk toward 50 %),
   replacing the hand-set prior in the expected-R gate.
The result is only a proposal: `--apply` writes config/local.yaml, and graduation must then pass
again because the config fingerprint changes."""

from __future__ import annotations

import json
import math
import statistics
from collections import defaultdict
from concurrent.futures import ProcessPoolExecutor
from decimal import Decimal
from itertools import product
from pathlib import Path
from typing import Any

import yaml

from kolibri.backtest.engine import run
from kolibri.backtest.metrics import summarize
from kolibri.core.config import CONFIG_DIR, Config, get_path, with_overrides
from kolibri.core.journal import Journal
from kolibri.core.models import MINUTE_MS, Bar, ClosedTrade

DAY_MS = 1440 * MINUTE_MS
GRID: dict[str, list[Any]] = {
    "gates.min_room_r": ["1.2", "1.5", "2.0"],
    "strategy.stop_atr_min": ["0.5", "0.75", "1.0"],
    "gates.score_threshold": [65, 70, 75],
}
MIN_CALIB_TRADES = 30  # fewer trades for a setup: keep the configured prior
SHRINK_TRADES = 20  # calibration pseudo-trades at 50 %: small samples stay near the prior
MARGIN_R = 0.05  # the winner must beat the current config by this much (robust score, in R)

_BARS: dict[str, list[Bar]] = {}


def _init(bars: dict[str, list[Bar]]) -> None:
    global _BARS
    _BARS = bars


def _run(cfg: Config) -> tuple[list[ClosedTrade], dict[str, list[float]]]:
    j = Journal(":memory:", commit_every=5000)
    res = run(cfg, _BARS, j)
    scores: dict[str, list[float]] = defaultdict(list)
    for ev in j.query("intent"):
        scores[str(ev.data["setup"])].append(float(ev.data["score"]))
    return res.trades, dict(scores)


def _slice(bars: dict[str, list[Bar]], start: int, end: int) -> dict[str, list[Bar]]:
    return {s: [b for b in v if start <= b.open_ts < end] for s, v in bars.items()}


def _robust(trades: list[ClosedTrade], bounds: list[tuple[int, int]], min_fold: int) -> tuple[float, list[float]]:
    folds = [[t for t in trades if a <= t.opened_ts < b] for a, b in bounds]
    exps = [float(summarize(f)["expectancy_r"]) if f else 0.0 for f in folds]
    if min(len(f) for f in folds) < min_fold:
        return -math.inf, exps
    spread = statistics.pstdev(exps) if len(exps) > 1 else 0.0
    return statistics.median(exps) - 0.5 * spread, exps


def calibrate(cfg: Config, trades: list[ClosedTrade], scores: dict[str, list[float]]) -> dict[str, str]:
    g = cfg.gates
    out = {}
    for setup in sorted({t.setup for t in trades}):
        ts = [t for t in trades if t.setup == setup]
        if len(ts) < MIN_CALIB_TRADES:
            continue
        wins = sum(1 for t in ts if t.pnl > 0)
        shrunk = (wins + SHRINK_TRADES * 0.5) / (len(ts) + SHRINK_TRADES)
        avg_score = statistics.mean(scores.get(setup) or [float(g.score_threshold)])
        prior = shrunk - float(g.win_prob_per_score_pt) * (avg_score - float(g.score_threshold))
        out[setup] = f"{min(0.85, max(0.15, prior)):.3f}"
    return out


def optimize(cfg: Config, bars: dict[str, list[Bar]], folds: int = 4, holdout_frac: float = 0.25,
             workers: int | None = None, min_fold_trades: int = 5) -> dict[str, Any]:
    ts = sorted({b.open_ts for v in bars.values() for b in v})
    if not ts:
        raise ValueError("no history: run `kolibri download` first")
    t0, t1 = ts[0], ts[-1] + MINUTE_MS
    split = t0 + int((t1 - t0) * (1 - holdout_frac))
    warm = cfg.warmup_days * DAY_MS
    research_start = t0 + warm  # trades before this are warm-up noise
    step = (split - research_start) // folds
    if step <= 0:
        raise ValueError(f"need more than {cfg.warmup_days} days of history before the holdout")
    bounds = [(research_start + i * step, research_start + (i + 1) * step) for i in range(folds)]

    keys = list(GRID)
    current = {k: str(get_path(cfg, k)).removesuffix(".0") for k in keys}
    combos = [{k: str(v) for k, v in zip(keys, vals, strict=True)} for vals in product(*GRID.values())]
    cfgs = [with_overrides(cfg, c) for c in combos] + [cfg]
    with ProcessPoolExecutor(workers, initializer=_init, initargs=(_slice(bars, t0, split),)) as pool:
        results = list(pool.map(_run, cfgs))

    scored = [_robust(tr, bounds, min_fold_trades) for tr, _ in results]
    shape = [len(v) for v in GRID.values()]
    idx = list(product(*[range(n) for n in shape]))

    def smooth(i: int) -> float:  # mean over the 3x3x3 neighbourhood: plateaus beat spikes
        vals = [scored[j][0] for j, p in enumerate(idx) if max(abs(a - b) for a, b in zip(p, idx[i], strict=True)) <= 1]
        return statistics.mean(v if math.isfinite(v) else -1.0 for v in vals)

    smoothed = [smooth(i) for i in range(len(combos))]
    best = max(range(len(combos)), key=lambda i: smoothed[i])
    cur_score, cur_folds = scored[-1]

    def holdout_exp(c: Config) -> tuple[float, int]:
        _init(_slice(bars, split - warm, t1))
        tr = [t for t in _run(c)[0] if t.opened_ts >= split]
        return (float(summarize(tr)["expectancy_r"]) if tr else 0.0), len(tr)

    best_cfg = cfgs[best]
    h_best, n_best = holdout_exp(best_cfg)
    h_cur, n_cur = holdout_exp(cfg)
    accept = (combos[best] != current and math.isfinite(scored[best][0])
              and scored[best][0] >= (cur_score if math.isfinite(cur_score) else -math.inf) + MARGIN_R
              and h_best > 0 and h_best >= h_cur)
    chosen_cfg = best_cfg if accept else cfg
    chosen_trades, chosen_scores = results[best] if accept else results[-1]
    calib = calibrate(chosen_cfg, chosen_trades, chosen_scores)

    return {
        "research": {"start": t0, "end": split, "folds": bounds},
        "holdout": {"start": split, "end": t1},
        "current": {"params": current, "robust_score": cur_score, "fold_expectancy": cur_folds,
                    "holdout_expectancy": h_cur, "holdout_trades": n_cur},
        "best": {"params": combos[best], "robust_score": scored[best][0], "smoothed": smoothed[best],
                 "fold_expectancy": scored[best][1], "holdout_expectancy": h_best, "holdout_trades": n_best},
        "accepted": accept,
        "enough_data": math.isfinite(cur_score) or any(math.isfinite(s[0]) for s in scored),
        "advice": ("apply the new parameters" if accept else
                   "keep the current parameters (no robust improvement)"),
        "grid": [{"params": c, "robust": s[0], "smoothed": sm, "trades": len(r[0])}
                 for c, s, sm, r in zip(combos, scored, smoothed, results, strict=False)],
        "calibration": calib,
        "overrides": (dict(combos[best]) if accept else {}) | ({"gates.win_prob_by_setup": calib} if calib else {}),
    }


def _fmt(x: Any) -> str:
    return f"{x:+.3f}" if isinstance(x, float) and math.isfinite(x) else str(x)


def write_optimize_report(rep: dict[str, Any], path: str | Path) -> None:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(rep, indent=2, default=str))
    c, b = rep["current"], rep["best"]
    lines = [
        "# KOLIBRI optimize report\n",
        f"**Advies: {'nieuwe parameters toepassen' if rep['accepted'] else 'huidige parameters houden'}**\n",
        *([] if rep["enough_data"] else [
            "> Te weinig trades per tijdvak om iets te kiezen: meer historie downloaden (>= 120 dagen).\n"]),
        "| | huidig | beste kandidaat |", "|---|---|---|",
        f"| parameters | `{c['params']}` | `{b['params']}` |",
        f"| robuuste score (R, onderzoeksdata) | {_fmt(c['robust_score'])} | {_fmt(b['robust_score'])} |",
        f"| verwachting per tijdvak (R) | {[round(x, 3) for x in c['fold_expectancy']]} |"
        f" {[round(x, 3) for x in b['fold_expectancy']]} |",
        f"| holdout verwachting (R, nooit gezien) | {_fmt(c['holdout_expectancy'])} ({c['holdout_trades']} trades)"
        f" | {_fmt(b['holdout_expectancy'])} ({b['holdout_trades']} trades) |",
        "\n## Gekalibreerde winkans per setup\n",
        *([f"- {k}: {v}" for k, v in rep["calibration"].items()]
          or [f"- nog geen setup met >= {MIN_CALIB_TRADES} trades: standaard-aanname blijft staan"]),
        "\nToepassen: `kolibri optimize ... --apply` schrijft `config/local.yaml`; draai daarna opnieuw "
        "`kolibri graduate` (de config-vingerafdruk verandert).",
    ]
    p.with_suffix(".md").write_text("\n".join(lines) + "\n")


def apply_overrides(overrides: dict[str, Any], config_dir: Path = CONFIG_DIR) -> Path:
    """Merge dotted-path overrides into config/local.yaml (your file; default.yaml stays untouched)."""
    path = config_dir / "local.yaml"
    data: dict[str, Any] = (yaml.safe_load(path.read_text()) or {}) if path.exists() else {}
    for dotted, value in overrides.items():
        node = data
        *parents, leaf = dotted.split(".")
        for k in parents:
            node = node.setdefault(k, {})
        node[leaf] = {k: str(v) for k, v in value.items()} if isinstance(value, dict) else (
            str(value) if isinstance(value, Decimal) else value)
    path.write_text("# Written by `kolibri optimize --apply`. Overrides config/default.yaml.\n"
                    + yaml.safe_dump(data, sort_keys=True))
    return path
