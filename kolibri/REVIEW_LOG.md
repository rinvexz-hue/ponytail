# Review log

Three passes against the checklist in the brief (consistency, time, lookahead, money, orders,
concurrency, resilience, signals, backtest realism, security). Every issue that was found, how it
was fixed, and what now covers it.

## Pass 1 — correctness of the trade path (after M1–M9 were first assembled)

| # | Area | Issue | Fix | Covered by |
|---|---|---|---|---|
| 1 | Consistency | YAML parses bare `off` as `false`: config failed to load | quoted `"off"` | `cfg` fixture (every test), `test_blackouts` |
| 2 | Money / risk | 0.25 % risk with tight scalping stops needs > 1x notional; spot 1x would veto nearly every trade | size capped at 98 % of 1x notional headroom (risk lands ≤ 0.25 %, never levered) | `test_sizing_never_exceeds_risk_cap_and_respects_filters` (hypothesis) |
| 3 | Journal | `trade` event crashed (`symbol` kwarg clash) | journal the `ClosedTrade` as one field | all backtest tests |
| 4 | Orders | entry filling after our cancel raised "fill without intent" | intents kept per entry order id; late fills create a protected position | `test_fill_after_cancel_race_still_protected` |
| 5 | Signals | dead config: with the score→win-prob prior (0.004/pt) `min_net_r 0.25` was unreachable | prior slope 0.01/pt (documented as uncalibrated) | `test_baseline_passes_every_gate_with_default_risk_config` |
| 6 | Signals | `score` gate unreachable: a low score always failed `4_net_r` first | score checked before the cost gate | `test_each_gate_fails[...score]` |
| 7 | Consistency | typo in `tunable` raised AttributeError instead of a config error | validator raises ValueError | `test_config_consistency_is_enforced` |
| 8 | Resilience | reconcile detected an unexpected position but the kill switch could not flatten it (unknown locally) | orphan adopted and market-exited immediately | `test_reconcile_unexpected_position_is_flattened`, `test_restart_mid_position_ends_flat_and_consistent` |
| 9 | Orders | kill with a pending entry that fills before the cancel lands → managed position while halted | cancelled entries remembered; a late fill is flattened with the kill reason | `test_kill_with_pending_entry_that_fills_late_ends_flat` |
| 10 | Orders / venue | Binance spot has no reduce-only and locks balance per resting sell: 100 % stop + resting TP1 = rejects | `supports_reduce_only` capability; spot TPs are synthetic market exits (taker cost modelled in backtest/paper) | `test_spot_tp_is_synthetic_and_never_oversells`, `test_spot_mean_reversion_target_exits_everything` |
| 11 | Consistency | `order_rate_per_min` was dead config | entries rejected (`8_risk_rate_limit`) when the budget is spent; stops/exits never throttled | `test_order_rate_budget` |
| 12 | Resilience | `Desk._touch` asserted on a symbol with no print yet → bar task death | falls back to the bar close | `test_touch_falls_back_to_bar_close_before_first_print` |
| 13 | Money | live adapter sent float quantities; fees in base asset would break reconciliation | exact decimal strings; refuse to start without BNB when the discount is configured | not testable without the venue (see KNOWN_LIMITATIONS) |
| 14 | Resilience | `poll_ack` returns at once without Telegram → treated as a dead task → spurious kill at startup | only scheduled when configured; clean returns still count as task death | `test_paper_runtime_streams_and_kills_on_stale_data` |

## Pass 2 — concurrency, memory, walk-forward

| # | Area | Issue | Fix | Covered by |
|---|---|---|---|---|
| 15 | Concurrency | live adapter awaits yield mid-Executioner: trade stream, bar clock, watchdog, reconcile and dashboard could interleave (e.g. two stops placed) | one runtime lock around every Desk mutation (`ponytail:` note on its ceiling) | `test_runtime_serialises_desk_mutations` (fails with peak 3 concurrent calls when the lock is removed) |
| 16 | Memory | `Desk.intents` grew without bound in a long-lived process | bounded deque | — (trivial) |
| 17 | Backtest | `--optimize` searched an arbitrary tunable index and fitted window 1 on its own warm-up | grid on the first two tunables, windows ≥ 2 only | — (optional path; default graduation uses fixed params) |
| 18 | Concurrency | kill task spawned on task death was fire-and-forget | kept referenced; goes through the lock | `test_paper_runtime_streams_and_kills_on_stale_data` |
| 19 | Security | dashboard re-arm bypassed the lock | `Runtime.rearm()` under the lock | `test_dashboard_requires_token` |

## Pass 3 — full system run (paper runtime + real browser against a fake exchange)

| # | Area | Issue | Fix | Covered by |
|---|---|---|---|---|
| 20 | Concurrency | FastAPI ran sync handlers in a threadpool → SQLite "created in another thread" on `/api/state` | all handlers async (event-loop thread owns the journal) | found and verified by a headless-Chromium run of the dashboard; TestClient uses its own thread so it cannot reproduce it |
| 21 | Resilience | paper restart restored cash but dropped holdings (equity jump, could fake a drawdown kill) | full paper account persisted; restart goes through orphan → flatten → halt like live | `test_paper_restart_mid_position_is_flattened_and_halted` |
| 22 | UI | "no_setup" shown as a warning chip; stale status text | neutral chip; status cleared on success | visual check (desktop dark + 390 px light, no horizontal scroll) |

Final pass-3 re-scan after these fixes: no float in the price/qty/fee path, no naive datetimes,
no config field unused, every gate has a pass and a fail test, ruff + `mypy --strict` clean,
full suite green. Risk + execution coverage is enforced ≥ 85 % in CI.
