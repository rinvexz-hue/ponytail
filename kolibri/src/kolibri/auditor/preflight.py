"""`kolibri preflight`: where are you on the road to live, and what is the next step? Read-only."""

from __future__ import annotations

import json
import os
import time
from dataclasses import dataclass
from decimal import Decimal
from pathlib import Path

from kolibri.backtest.data import load_bars
from kolibri.core.config import Config, with_overrides
from kolibri.core.journal import Journal
from kolibri.core.models import MINUTE_MS

DAY_MS = 1440 * MINUTE_MS


@dataclass(frozen=True)
class Item:
    ok: bool | None  # None = warning
    text: str
    fix: str = ""


def _days_of_history(cfg: Config, sym: str) -> float:
    """First and last stored minute only (cheap enough to poll from the dashboard)."""
    files = sorted(Path(cfg.data_dir).glob(f"{sym}-1m-*.csv"))
    if not files:
        return 0.0
    first = files[0].open().readline().split(",")[0]
    last = files[-1].read_bytes().rstrip().rsplit(b"\n", 1)[-1].split(b",")[0]
    try:
        return (int(last) - int(first) + MINUTE_MS) / DAY_MS
    except ValueError:
        bars = load_bars(cfg.data_dir, sym)
        return (bars[-1].close_ts - bars[0].open_ts) / DAY_MS if bars else 0.0


def _journal_trades(path: str) -> tuple[int, float]:
    if not Path(path).exists():
        return 0, 0.0
    j = Journal(path)
    trades = [e.data["trade"] for e in j.query("trade")]
    j.close()
    if not trades:
        return 0, 0.0
    span = (max(t["closed_ts"] for t in trades) - min(t["opened_ts"] for t in trades)) / DAY_MS
    return len(trades), span


def checklist(cfg: Config) -> list[tuple[str, list[Item]]]:
    g = cfg.graduation
    paper_db = with_overrides(cfg, {"mode": "paper"}).state_path
    live_db = with_overrides(cfg, {"mode": "live"}).state_path
    sections: list[tuple[str, list[Item]]] = []

    hist = {s: _days_of_history(cfg, s) for s in cfg.symbols}
    worst = min(hist.values())
    sections.append(("1. Historische data", [
        Item(worst >= cfg.warmup_days, f"minste historie: {worst:.0f} dagen (minimaal {cfg.warmup_days} om te starten)",
             "kolibri download --days 90"),
        Item(worst >= 90 or None, f"voor betrouwbare backtests/graduatie: >= 90 dagen (nu {worst:.0f})",
             "kolibri download --days 120"),
    ]))

    v = cfg.venue_cfg
    entry_tier = (v.maker_fee, v.taker_fee) == (Decimal("0.004"), Decimal("0.008"))
    sections.append(("2. Instellingen", [
        Item(None if entry_tier else True,
             f"fees in config: maker {v.maker_fee:.2%} / taker {v.taker_fee:.2%}"
             + (" (Kraken instap-niveau; klopt dat voor jou?)" if entry_tier else ""),
             "zet je echte niveau in config/local.yaml of config/symbols.yaml; controleer met kolibri check-live"),
        Item(Path("data/optimize_report.json").exists() or None, "optimalisatie gedraaid (data/optimize_report.md)",
             "kolibri optimize --days 120   (daarna eventueel --apply)"),
    ]))

    n_paper, paper_days = _journal_trades(paper_db)
    sections.append(("3. Paper trading (oefengeld, echte koersen)", [
        Item(paper_days >= g.min_paper_days, f"paper looptijd: {paper_days:.1f} dagen (minimaal {g.min_paper_days})",
             "MODE=paper kolibri run   (laat het minstens 2 weken draaien)"),
        Item(n_paper >= g.canary_min_paper_trades,
             f"paper trades: {n_paper} (canary vanaf {g.canary_min_paper_trades}, live vanaf {g.paper_min_trades})",
             "laat paper langer draaien"),
    ]))

    rp = Path(g.report_path)
    rep = json.loads(rp.read_text()) if rp.exists() else {}
    stage = rep.get("stage", "none") if rep else "geen rapport"
    fp_ok = rep.get("config_fingerprint") == cfg.fingerprint()
    age = (time.time() * 1000 - rep.get("generated_ms", 0)) / DAY_MS if rep else 999
    sections.append(("4. Graduatierapport", [
        Item(bool(rep), f"rapport: {rp}", f"kolibri graduate --days 120 --paper-journal {paper_db}"),
        Item(stage in ("canary", "live"), f"vrijgegeven fase: {stage}",
             "zie data/graduation_report.md: welke checks falen"),
        Item(fp_ok if rep else False, "rapport hoort bij de huidige config (vingerafdruk)",
             "config gewijzigd: draai kolibri graduate opnieuw"),
        Item(age <= g.max_age_days if rep else False,
             f"rapport is {age:.0f} dagen oud (max {g.max_age_days})" if rep else "rapport-leeftijd: n.v.t.",
             "draai kolibri graduate opnieuw"),
    ]))

    env = os.environ
    sections.append(("5. Live-voorbereiding", [
        Item(len(env.get("DASHBOARD_TOKEN", "")) >= 16, "DASHBOARD_TOKEN gezet (>= 16 tekens)", "zet in .env"),
        Item(bool(env.get("TELEGRAM_BOT_TOKEN") and env.get("TELEGRAM_CHAT_ID")) or None,
             "Telegram-meldingen ingesteld", "zet TELEGRAM_BOT_TOKEN en TELEGRAM_CHAT_ID in .env"),
        Item(bool(env.get("KRAKEN_API_KEY") and env.get("KRAKEN_API_SECRET")),
             "Kraken API-sleutels gezet (aparte subaccount, GEEN opnamerecht, IP-allowlist)",
             "maak de sleutel aan in Kraken en zet KRAKEN_API_KEY / KRAKEN_API_SECRET in .env"),
        Item(None, "kolibri check-live gedraaid en OK (fees, filters, saldo)", "kolibri check-live"),
    ]))

    n_live, _ = _journal_trades(live_db)
    sections.append(("6. Canary (echt geld, kleine orders)", [
        Item(n_live >= g.canary_min_live_trades,
             f"canary trades: {n_live} (minimaal {g.canary_min_live_trades} voor normale grootte)",
             "MODE=live LIVE_CONFIRM=I_ACCEPT_THE_RISK kolibri run  (met canary-rapport)"),
    ]))
    return sections


def render(sections: list[tuple[str, list[Item]]]) -> str:
    out, next_step = [], ""
    for title, items in sections:
        out.append(f"\n{title}")
        for it in items:
            mark = "✅" if it.ok else "⚠️ " if it.ok is None else "❌"
            out.append(f"  {mark} {it.text}")
            if it.ok is False and not next_step:
                next_step = it.fix
    done = "\nAlles groen: volg LIVE_TESTPLAN.md voor de volgende fase."
    out.append(f"\nVolgende stap: {next_step}" if next_step else done)
    return "\n".join(out)
