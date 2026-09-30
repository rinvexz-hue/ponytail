"""Historical 1m bars: a CSV store (one file per symbol-month, standard kline column layout incl.
taker-buy volume), a Kraken downloader that rebuilds bars from public trades, and a synthetic
generator for tests and demos. Stdlib only; plenty fast for 1m bars."""

from __future__ import annotations

import csv
import io
import math
import random
import zipfile
from collections.abc import Iterator
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from kolibri.core.config import Config
from kolibri.core.models import MINUTE_MS, Bar, floor_to


def _ms(x: str) -> int:
    v = int(x)
    return v // 1000 if v > 10**14 else v  # 2025+ spot dumps use microseconds


def parse_rows(symbol: str, rows: Iterator[list[str]]) -> Iterator[Bar]:
    for r in rows:
        if not r or not r[0].isdigit():
            continue  # header / blank
        yield Bar(symbol, _ms(r[0]), MINUTE_MS, Decimal(r[1]), Decimal(r[2]), Decimal(r[3]), Decimal(r[4]),
                  Decimal(r[5]), Decimal(r[9]))


def _month_files(data_dir: Path, symbol: str) -> list[Path]:
    return sorted([*data_dir.glob(f"{symbol}-1m-*.csv"), *data_dir.glob(f"{symbol}-1m-*.zip")])


def load_bars(data_dir: str | Path, symbol: str, start_ms: int = 0, end_ms: int = 2**62) -> list[Bar]:
    out: dict[int, Bar] = {}
    for p in _month_files(Path(data_dir), symbol):
        if p.suffix == ".zip":
            with zipfile.ZipFile(p) as z:
                for name in z.namelist():
                    text = io.TextIOWrapper(z.open(name), encoding="utf-8")
                    for b in parse_rows(symbol, csv.reader(text)):
                        out[b.open_ts] = b
        else:
            with p.open(newline="") as fh:
                for b in parse_rows(symbol, csv.reader(fh)):
                    out[b.open_ts] = b
    return [out[k] for k in sorted(out) if start_ms <= k < end_ms]


def save_bars(data_dir: str | Path, bars: list[Bar]) -> None:
    by_month: dict[tuple[str, str], list[Bar]] = {}
    for b in bars:
        m = datetime.fromtimestamp(b.open_ts / 1000, UTC).strftime("%Y-%m")
        by_month.setdefault((b.symbol, m), []).append(b)
    Path(data_dir).mkdir(parents=True, exist_ok=True)
    for (sym, m), chunk in by_month.items():
        p = Path(data_dir) / f"{sym}-1m-{m}.csv"
        existing = {b.open_ts: b for b in load_bars_file(p, sym)} if p.exists() else {}
        existing.update({b.open_ts: b for b in chunk})
        with p.open("w", newline="") as fh:
            w = csv.writer(fh)
            for ts in sorted(existing):
                b = existing[ts]
                w.writerow([b.open_ts, b.open, b.high, b.low, b.close, b.volume, b.close_ts - 1, 0, 0,
                            b.taker_buy_volume, 0, 0])


def load_bars_file(p: Path, symbol: str) -> list[Bar]:
    with p.open(newline="") as fh:
        return list(parse_rows(symbol, csv.reader(fh)))


def append_bars(data_dir: str | Path, bars: list[Bar]) -> None:
    """Cheap append for the live runtime (one row per closed bar); load_bars de-duplicates."""
    Path(data_dir).mkdir(parents=True, exist_ok=True)
    for b in bars:
        m = datetime.fromtimestamp(b.open_ts / 1000, UTC).strftime("%Y-%m")
        with (Path(data_dir) / f"{b.symbol}-1m-{m}.csv").open("a", newline="") as fh:
            csv.writer(fh).writerow([b.open_ts, b.open, b.high, b.low, b.close, b.volume, b.close_ts - 1, 0, 0,
                                     b.taker_buy_volume, 0, 0])


def download(cfg: Config, symbol: str, start_ms: int, end_ms: int) -> int:
    """Rebuild 1m bars from Kraken's public trade history (taker side included). Resumable: continues
    after the newest stored bar, saving one UTC day at a time. Slow by design (public rate limit):
    budget roughly 1-3 hours per symbol per 6 months."""
    import asyncio

    import ccxt.pro as ccxtpro

    from kolibri.scout.scout import bars_from_trades

    have = load_bars(cfg.data_dir, symbol, start_ms, end_ms)
    cursor = have[-1].close_ts if have else start_ms - start_ms % MINUTE_MS

    async def run() -> int:
        ex = ccxtpro.kraken({"enableRateLimit": True})
        n, day = 0, 1440 * MINUTE_MS
        try:
            nonlocal cursor
            while cursor < end_ms:
                stop = min(end_ms, cursor - cursor % day + day)
                bars = await bars_from_trades(ex, cfg, symbol, cursor, stop)
                save_bars(cfg.data_dir, bars)
                n += len(bars)
                print(f"{symbol} {datetime.fromtimestamp(cursor / 1000, UTC):%Y-%m-%d}: {len(bars)} bars", flush=True)
                cursor = stop
        finally:
            await ex.close()
        return n

    return asyncio.run(run())


def synthetic(cfg: Config, start_ms: int, minutes: int, seed: int = 7) -> dict[str, list[Bar]]:
    """Regime-switching market (trend / range / squeeze / chaos) with a leader and correlated alts.
    For tests and demos only: it has no real edge in it and must never be used to judge a strategy."""
    rng = random.Random(seed)
    by_base_px = {"BTC": 60000.0, "ETH": 2400.0, "SOL": 140.0, "XRP": 0.55}
    by_base_beta = {"BTC": 1.0, "ETH": 1.1, "SOL": 1.4, "XRP": 1.2}
    base_px = {s: by_base_px.get(cfg.symbol_specs[s].base, 100.0) for s in cfg.symbols}
    betas = {s: by_base_beta.get(cfg.symbol_specs[s].base, 1.0) for s in cfg.symbols}
    px = dict(base_px)
    out: dict[str, list[Bar]] = {s: [] for s in cfg.symbols}
    regime, left, drift, vol, anchor = "range", 0, 0.0, 6e-4, 0.0
    for i in range(minutes):
        if left <= 0:
            regime = rng.choices(["trend", "range", "squeeze", "chaos"], [0.35, 0.4, 0.2, 0.05])[0]
            left = rng.randint(30, 240)
            drift = rng.choice([-1, 1]) * rng.uniform(1e-4, 3e-4) if regime == "trend" else 0.0
            vol = {"trend": 6e-4, "range": 5e-4, "squeeze": 2e-4, "chaos": 2.5e-3}[regime]
            anchor = 0.0
        left -= 1
        shock = rng.gauss(0, vol)
        if regime == "range":
            anchor += shock
            lead_ret = shock - 0.15 * anchor
        else:
            lead_ret = drift + shock
        ts = start_ms + i * MINUTE_MS
        for s in cfg.symbols:
            spec = cfg.symbol_specs[s]
            r = betas.get(s, 1.0) * lead_ret + (0 if s == cfg.leader else rng.gauss(0, vol * 0.5))
            o = px[s]
            path = [o]
            for k in range(1, 7):
                path.append(o * math.exp(r * k / 6 + rng.gauss(0, vol * 0.35)))
            c = path[-1]
            px[s] = c
            hi, lo = max(path), min(path)
            v = rng.lognormvariate(0, 0.4) * (1 + 800 * abs(r)) * (10 / (base_px.get(s, 100.0) / 1000 + 1))
            buy_frac = min(0.95, max(0.05, 0.5 + r / (vol * 4 + 1e-12) * 0.25 + rng.gauss(0, 0.05)))

            def q(x: float, tick: Decimal = spec.tick) -> Decimal:
                return floor_to(Decimal(repr(x)), tick)

            vol_d = Decimal(repr(round(v, 4)))
            out[s].append(Bar(s, ts, MINUTE_MS, q(o), q(hi), q(lo), q(c), vol_d,
                              Decimal(repr(round(v * buy_frac, 4)))))
    return out
