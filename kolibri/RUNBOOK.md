# KOLIBRI runbook

All times UTC. State (halts, equity anchors, journal) lives in `data/kolibri-paper.sqlite` / `data/kolibri-live.sqlite` (one journal per mode) and survives restarts.

## Start / stop

| Action | Command |
|---|---|
| Start (paper) | `docker compose up -d --build` or `kolibri run` |
| Logs | `docker compose logs -f kolibri` |
| Stop | `docker compose stop` (SIGTERM → flatten all → wait ≤10 s for fills → exit; exchange-side stops remain if an exit did not fill) |
| Dashboard | `ssh -L 8080:127.0.0.1:8080 you@vps`, open `http://127.0.0.1:8080`, paste `DASHBOARD_TOKEN` |

The dashboard port is bound to 127.0.0.1 on the host. Never publish it; reach it over SSH/VPN.

## Kill / flatten

- **KILL** (dashboard button, or automatic): cancels everything, market-exits every position,
  halts until **manual re-arm**, sends a CRITICAL alert that repeats until `/ack`.
- **FLATTEN** (dashboard): exits everything but does not halt.
- Automatic kill triggers: stale data > 3 s, websocket down > 5 s, 3 consecutive order rejects,
  position mismatch vs exchange (seen on 2 consecutive reconciles), unexpected position, API error
  rate > 30 %, clock drift > 1 s, a protective stop rejected, any internal task dying.
- Loss limits: daily −2 % → flatten + halt until next UTC day (automatic). Weekly −5 % or −8 %
  from peak → halt until manual re-arm.

## Recover after a halt

1. Read why: dashboard header / Telegram / `sqlite3 data/kolibri-live.sqlite "select * from events where kind='kill' order by id desc limit 5"`.
2. Check the venue UI: no open orders, no unexpected balances in the trading sub-account.
3. Fix the cause (network, keys, clock: `chronyc tracking`, venue incident).
4. Re-arm: dashboard **Re-arm**, or offline `kolibri rearm` (also re-anchors drawdown/week at current equity).
5. Watch the next hour of the dashboard; if the same kill fires again, stop and investigate.

## Restart mid-position (crash, deploy, host reboot)

On start the desk reconciles twice with the venue. Any position it did not open in this process
is treated as unexpected: flattened, halted, CRITICAL alert. You re-arm manually. This is
intentional (fail closed); do not "fix" it by skipping reconciliation.

## Promotion path (never skip a stage)

The operator's version, in Dutch with commands and go/stop criteria per phase, is
[LIVE_TESTPLAN.md](LIVE_TESTPLAN.md); `kolibri preflight` shows the current position. Summary:

1. `kolibri download --days 120` (hours: Kraken's public trade endpoint is rate limited; it resumes
   where it stopped) → `kolibri backtest` → `kolibri graduate` (walk-forward OOS, ±20 %
   perturbation, Monte Carlo). Fix nothing by curve-fitting; ≤ 12 tunables.
2. Paper ≥ 2 weeks: `kolibri run` with `MODE=paper`. Then
   `kolibri graduate --days 120` (reads the paper and live journals automatically).
3. Kraken has no spot testnet. Instead: `kolibri check-live` with the live keys (read-only: prints
   balances, verifies tick / lot / minimum order size and the fee tier Kraken really charges you;
   refuses on any mismatch). Then **canary**: a report with stage `canary` lets live run with every
   order capped at `execution.canary_notional` (25 EUR) until ≥ 10 clean canary trades unlock
   stage `live` on the next `kolibri graduate`.
4. Live-small: a **dedicated Kraken sub-account** holding only EUR, ≤ 10 % of intended capital.
   API key permissions: *Query funds*, *Query open/closed orders & trades*, *Create & modify
   orders*, *Cancel/close orders*, *WebSocket interface*. **Never** *Withdraw funds*. Set the key's
   IP allowlist to the VPS. `check-live` and every live start probe the key and refuse it unless
   Kraken answers *Permission denied* to a withdraw query. Then `MODE=live`, `LIVE_CONFIRM=I_ACCEPT_THE_RISK`.
5. Scale only after live-small matches the graduation baseline (Auditor drift flags stay quiet).

Changing any trading parameter changes the config fingerprint and invalidates the graduation
report: re-run step 1–2. Reports expire after 30 days.

## Routine checks

- Daily 00:00 UTC Telegram report: trades, sum R, top rejection gates, kills.
- Heartbeat every 15 min; silence > 30 min = process or Telegram down.
- Weekly: `kolibri graduate` on fresh data; compare with live (drift).
- Keep `config/events_calendar.yaml` current (FOMC, CPI, NFP).
