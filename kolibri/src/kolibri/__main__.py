"""KOLIBRI command line.

  kolibri run                      # paper by default; live needs MODE=live + LIVE_CONFIRM + graduation
  kolibri download --days 90       # Kraken public trades -> 1m bars in data/history (slow, resumable)
  kolibri check-live               # read-only: Kraken keys, balances, filters and YOUR fee tier vs config
  kolibri backtest [--days N | --synthetic N]
  kolibri optimize --days 120 [--apply]   # robust parameter search + win-rate calibration (holdout-checked)
  kolibri graduate --days 120      # OOS + paper (+ canary) evidence -> stage: none / canary / live
  kolibri preflight                # checklist: where am I on the way to live, what is the next step
  kolibri dashboard                # progress dashboard only (no trading): http://127.0.0.1:8080
  kolibri rearm                    # clear a manual halt (after you know why it tripped)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import time
from pathlib import Path

from kolibri.core.config import load_config
from kolibri.core.models import MINUTE_MS, Bar

DAY_MS = 1440 * MINUTE_MS


def _bars(cfg_days: int | None, synthetic: int | None) -> dict[str, list[Bar]]:
    from kolibri.backtest.data import load_bars
    from kolibri.backtest.data import synthetic as synth

    cfg = load_config()
    if synthetic:
        start = (int(time.time() * 1000) // DAY_MS - synthetic) * DAY_MS
        return synth(cfg, start, synthetic * 1440)
    start = int(time.time() * 1000) - (cfg_days or 3650) * DAY_MS
    return {s: load_bars(cfg.data_dir, s, start) for s in cfg.symbols}


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="kolibri", description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run")
    d = sub.add_parser("download")
    d.add_argument("--days", type=int, default=180)
    for name in ("backtest", "graduate", "optimize"):
        b = sub.add_parser(name)
        b.add_argument("--days", type=int)
        b.add_argument("--synthetic", type=int, help="use N days of synthetic data (demo only, no edge)")
        if name == "graduate":
            b.add_argument("--paper-journal", help="default: the paper journal of this config")
            b.add_argument("--live-journal", help="default: the live (canary) journal of this config")
            b.add_argument("--optimize", action="store_true")
        if name == "optimize":
            b.add_argument("--apply", action="store_true", help="write accepted values to config/local.yaml")
    sub.add_parser("preflight")
    sub.add_parser("dashboard")
    sub.add_parser("rearm")
    sub.add_parser("check-live")
    a = p.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    cfg = load_config()

    if a.cmd == "run":
        from kolibri.runtime import Runtime

        asyncio.run(Runtime(cfg).run_forever())
    elif a.cmd == "download":
        from kolibri.backtest.data import download

        end = int(time.time() * 1000)
        end -= end % MINUTE_MS
        for s in cfg.symbols:
            n = download(cfg, s, end - a.days * DAY_MS, end)
            print(f"{s}: {n} bars")
    elif a.cmd == "check-live":
        from kolibri.adapters.kraken import KrakenAdapter

        async def check() -> list[str]:
            ad = KrakenAdapter(cfg)
            try:
                problems = await ad.verify_filters()
                print(f"balances: {ad.quote} {cfg.quote}, " + ", ".join(f"{s}={q}" for s, q in ad.base.items()))
                return problems
            finally:
                await ad.close()

        problems = asyncio.run(check())
        print("\n".join(problems) if problems else "OK: filters and fee tier match config (no orders placed)")
    elif a.cmd == "backtest":
        from kolibri.backtest.engine import run

        res = run(cfg, _bars(a.days, a.synthetic))
        print(json.dumps({"stats": res.stats, "rejections": res.rejections, "intents": res.intents}, indent=2,
                         default=str))
    elif a.cmd == "graduate":
        from kolibri.auditor.graduation import build_report, write_report
        from kolibri.core.config import with_overrides

        paper = a.paper_journal or with_overrides(cfg, {"mode": "paper"}).state_path
        live = a.live_journal or with_overrides(cfg, {"mode": "live"}).state_path
        rep = build_report(cfg, _bars(a.days, a.synthetic), paper, a.optimize, live)
        write_report(rep, cfg.graduation.report_path)
        for c in rep["checks"]:
            print(f"{'PASS' if c['pass'] else 'FAIL'}  [{c['stage']:<6}] {c['name']:<34} {c['value']} {c['op']} "
                  f"{c['threshold']}")
        print(f"\nVERDICT: {rep['verdict']}  -> {cfg.graduation.report_path}")
    elif a.cmd == "optimize":
        from kolibri.auditor.optimize import apply_overrides, optimize, write_optimize_report

        rep = optimize(cfg, _bars(a.days, a.synthetic))
        write_optimize_report(rep, "data/optimize_report.json")
        print(Path("data/optimize_report.md").read_text())
        if a.apply and rep["overrides"]:
            print(f"written: {apply_overrides(rep['overrides'])}  -> now re-run: kolibri graduate")
    elif a.cmd == "preflight":
        from kolibri.auditor.preflight import checklist, render

        print(render(checklist(cfg)))
    elif a.cmd == "dashboard":
        import os

        import uvicorn

        from kolibri.dashboard.app import create_app

        host = os.environ.get("DASHBOARD_HOST", cfg.dashboard.host)
        print(f"progress dashboard on http://{cfg.dashboard.host}:{cfg.dashboard.port}  (desk is not trading)")
        uvicorn.run(create_app(None, cfg), host=host, port=cfg.dashboard.port, log_level="warning")
    elif a.cmd == "rearm":
        from kolibri.core.journal import Journal

        j = Journal(cfg.state_path)
        print("previous halt:", j.get_state("halt"))
        for key in ("halt", "peak_equity", "week_anchor"):  # drawdown / week re-anchor at current equity
            j.set_state(key, None)
        j.emit("risk", int(time.time() * 1000), event="rearmed_cli")
        j.close()


if __name__ == "__main__":
    main()
