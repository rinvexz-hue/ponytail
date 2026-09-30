# KOLIBRI — risk-first scalping desk (BTC / ETH / SOL / XRP)

Autonomous 1–10 minute scalper for large-cap crypto. It trades only when a setup fires **and**
every hard gate passes **and** the expected edge after fees and slippage is clearly positive.
"No trade" is the normal output. **Paper mode is the default**; live mode refuses to start
without `MODE=live`, `LIVE_CONFIRM=I_ACCEPT_THE_RISK` and a passing, current graduation report
bound to the exact config. No profit is claimed or implied — see [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md).

## Read this first (the honest numbers)

At Binance spot VIP0 with BNB discount a round trip costs ~15 bps before slippage. The cost gate
requires the TP1 distance (= 1R) to be ≥ 3× round-trip cost ≈ 45+ bps. On BTC a 1m ATR is
typically 5–15 bps, so most BTC setups are **correctly rejected by `4_cost`**. Expect few trades
until you run on a lower-fee tier/venue. That is the system working, not broken. Also: Binance
left the Netherlands in 2023 — verify which venue you may legally use before live.

## Quick start

```bash
cd kolibri
python3.12 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
pytest -q                              # 80+ tests: indicators vs `ta`, lookahead, chaos, parity, risk properties
kolibri download --days 180            # Binance public 1m klines incl. taker-buy volume -> data/history
kolibri backtest --days 180
kolibri graduate --days 180 --paper-journal data/kolibri.sqlite
cp .env.example .env                   # set DASHBOARD_TOKEN (>=16 chars), Telegram vars
kolibri run                            # paper; dashboard on http://127.0.0.1:8080
docker compose up -d --build           # same, as a long-lived service (VPS / home server)
```

## How a trade happens

```
Scout (trades -> closed 1m bars, L2 book, health, clock drift)
  -> Analyst: features (closed bars only) -> regime -> setups A-D -> hard gates -> soft score -> Intent
  -> Risk Officer: cooldowns, halts, sizing (0.25 % incl. costs), heat, correlation, exposure -> qty
  -> Executioner: post-only entry -> exchange-side stop -> TP1 50 % -> BE+fees -> 1.5 ATR trail / time stop
  -> Auditor + Journal: every intent, rejection (with gate), order, fill, trade, kill -> SQLite
  -> Alerts (Telegram) + Dashboard
```

The same `Desk` code runs backtest, paper and live; only the price source and adapter change.
`tests/test_backtest.py::test_backtest_and_paper_paths_produce_identical_intents` proves it.

| Module | Role |
|---|---|
| `scout/` | trade stream → 1m bars (timer close, late trades dropped, never repainted), book summary, health, drift |
| `analyst/` | streaming indicators (TA-Lib seeding, verified vs `ta`), features, regime, setups, gates, score |
| `risk/` | sizing, heat, same-direction cap, net exposure, daily/weekly/DD halts (persisted), cooldowns |
| `executioner/` | order state machine, idempotent ids, partial/late/duplicate fills, stops, TPs, reconciliation |
| `adapters/` | `SimBroker` (backtest + paper, conservative fills), `BinanceAdapter` (live, spot) |
| `backtest/` | event-driven engine, data (CSV/ZIP, downloader, synthetic), metrics, Monte Carlo |
| `auditor/` | daily report, rejection histogram, drift vs backtest, graduation report |
| `alerts/`, `dashboard/` | Telegram (severity, rate limit, CRITICAL repeats until `/ack`), local-only dashboard |

## Gates (first failing gate is journaled)

`0_venue_no_short`, `0_dedup`, `1_regime`, `1_stop_distance`, `2_htf`, `2_leader`, `3_spread`,
`3_slippage`, `score`, `4_cost`, `4_net_r`, `5_data_gap`, `5_stale`, `5_clock`, `6_blackout`,
`7_cooldown`, `8_risk_*`. Each has a pass **and** a fail test (`tests/test_gates.py`).

## Deliberate deviations from the brief (and why)

| Brief | Built | Why |
|---|---|---|
| polars / numpy / DuckDB+Parquet | pure-Python streaming indicators, CSV in Binance's own layout, SQLite | O(1) incremental per closed bar is what live needs; identical code in backtest = parity. No extra deps. Upgrade path: Parquet if history > years. |
| uvloop | stdlib asyncio | load is a few msgs/s; not the bottleneck |
| typed async event bus | synchronous journal + subscribers, one runtime lock | deterministic backtests; the lock removes interleaving races that an async bus would add |
| "reject if leverage needed" | size is **capped** at 1x notional | tight scalping stops would otherwise reject almost everything; capping keeps risk ≤ 0.25 % and never levers |
| resting TP limit orders | synthetic TP on spot (market exit when price trades through) | Binance spot has no reduce-only and locks balance per resting sell: stop + TP cannot coexist |
| HTMX / React | one static HTML page + JSON API | nothing to build; auth via bearer token |
| scripts/ folder | `kolibri <subcommand>` CLI | one entry point |
| Auditor LLM job | not built | optional in the brief; never in the hot path. Hook: `auditor.daily_report()` text |

See [RUNBOOK.md](RUNBOOK.md) for operations, [REVIEW_LOG.md](REVIEW_LOG.md) for the three review passes.
