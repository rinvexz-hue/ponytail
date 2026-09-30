"""Historical bars: Binance kline CSV/ZIP files (data.binance.vision layout), a REST downloader,
and a synthetic generator for tests and demos. Stdlib only.

Storage choice: one CSV per symbol-month in Binance's own column layout. It is what the public
dumps already ship, needs no extra dependency, and is plenty fast for 1m bars."""

from __future__ import annotations

import csv
import io
import json
import math
import random
import time
import urllib.parse
import urllib.request
import zipfile
from collections.abc import Iterator
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

from kolibri.core.config import Config
from kolibri.core.models import MINUTE_MS, Bar, floor_to

REST = "https://api.binance.com/api/v3/klines"


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


def download(symbol: str, start_ms: int, end_ms: int, data_dir: str | Path, pause_s: float = 0.25) -> int:
    """Paginate Binance public klines (includes taker-buy volume). Resumable: rewrites month files."""
    n, cursor = 0, start_ms
    while cursor < end_ms:
        q = urllib.parse.urlencode({"symbol": symbol, "interval": "1m", "startTime": cursor,
                                    "endTime": end_ms - 1, "limit": 1000})
        with urllib.request.urlopen(f"{REST}?{q}", timeout=30) as resp:  # noqa: S310 (fixed https host)
            rows = json.load(resp)
        if not rows:
            break
        bars = list(parse_rows(symbol, iter([[str(x) for x in r] for r in rows])))
        now = int(time.time() * 1000)
        bars = [b for b in bars if b.close_ts <= now]  # never store the still-forming bar
        save_bars(data_dir, bars)
        n += len(bars)
        cursor = int(rows[-1][0]) + MINUTE_MS
        time.sleep(pause_s)
    return n


def synthetic(cfg: Config, start_ms: int, minutes: int, seed: int = 7) -> dict[str, list[Bar]]:
    """Regime-switching market (trend / range / squeeze / chaos) with a leader and correlated alts.
    For tests and demos only: it has no real edge in it and must never be used to judge a strategy."""
    rng = random.Random(seed)
    base_px = {"BTCUSDT": 65000.0, "ETHUSDT": 2600.0, "SOLUSDT": 150.0, "XRPUSDT": 0.6}
    betas = {"BTCUSDT": 1.0, "ETHUSDT": 1.1, "SOLUSDT": 1.4, "XRPUSDT": 1.2}
    px = {s: base_px.get(s, 100.0) for s in cfg.symbols}
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
