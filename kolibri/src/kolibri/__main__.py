"""KOLIBRI command line.

  kolibri run                      # paper by default; live needs MODE=live + LIVE_CONFIRM + graduation
  kolibri download --days 180      # Binance public 1m klines -> data/history
  kolibri backtest [--days N | --synthetic N]
  kolibri graduate [--paper-journal data/kolibri.sqlite] [--optimize] [--synthetic N]
  kolibri rearm                    # clear a manual halt (after you know why it tripped)
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import time

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
    for name in ("backtest", "graduate"):
        b = sub.add_parser(name)
        b.add_argument("--days", type=int)
        b.add_argument("--synthetic", type=int, help="use N days of synthetic data (demo only, no edge)")
        if name == "graduate":
            b.add_argument("--paper-journal")
            b.add_argument("--optimize", action="store_true")
    sub.add_parser("rearm")
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
            n = download(s, end - a.days * DAY_MS, end, cfg.data_dir)
            print(f"{s}: {n} bars")
    elif a.cmd == "backtest":
        from kolibri.backtest.engine import run

        res = run(cfg, _bars(a.days, a.synthetic))
        print(json.dumps({"stats": res.stats, "rejections": res.rejections, "intents": res.intents}, indent=2,
                         default=str))
    elif a.cmd == "graduate":
        from kolibri.auditor.graduation import build_report, write_report

        rep = build_report(cfg, _bars(a.days, a.synthetic), a.paper_journal, a.optimize)
        write_report(rep, cfg.graduation.report_path)
        for c in rep["checks"]:
            print(f"{'PASS' if c['pass'] else 'FAIL'}  {c['name']:<32} {c['value']} {c['op']} {c['threshold']}")
        print(f"\nVERDICT: {rep['verdict']}  -> {cfg.graduation.report_path}")
    elif a.cmd == "rearm":
        from kolibri.core.journal import Journal

        j = Journal(cfg.state_db)
        print("previous halt:", j.get_state("halt"))
        for key in ("halt", "peak_equity", "week_anchor"):  # drawdown / week re-anchor at current equity
            j.set_state(key, None)
        j.emit("risk", int(time.time() * 1000), event="rearmed_cli")
        j.close()


if __name__ == "__main__":
    main()
