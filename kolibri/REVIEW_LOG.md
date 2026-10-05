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

## Venue switch to Kraken (EUR) — re-review

| # | Area | Issue | Fix | Covered by |
|---|---|---|---|---|
| 23 | Resilience | Kraken websocket only accepts book depths 10/25/100/500/1000; depth 20 would fail on the first live start | depth 25 (top 20 still used) | ccxt source checked; not testable without the venue |
| 24 | Orders | Kraken `cl_ord_id` free text is max 18 chars; ours were 22 | 17-char ids | `test_idempotent_client_ids` |
| 25 | Money | high fees put breakeven+fees above a 1R TP1, so the moved stop would fire instantly | capped one tick under the TP1 fill price | `test_breakeven_stop_never_placed_through_the_market` |
| 26 | Risk | Kraken has a minimum order size per pair (`ordermin`) besides min cost | `min_qty` in symbol config, checked in sizing and TP splitting; live start verifies it | `test_sizing_never_exceeds_risk_cap_and_respects_filters` |
| 27 | Money | Kraken sells default to fees in the base asset, which would drift local vs exchange holdings | every order sends `oflags=fciq` (fees in EUR) | code path; `check-live` |
| 28 | Data | Kraken candles have no taker-buy volume | history rebuilt from public trades through the live BarBuilder; live bars appended locally | `test_paper_runtime_streams_and_kills_on_stale_data` (warm-up via trades) |

## Top-down 4h → 15m re-review

| # | Area | Issue | Fix | Covered by |
|---|---|---|---|---|
| 29 | Lookahead | the 4h context must never use the forming 4h bar | context updates only on the 15m bar that closes a 4h bar | `test_4h_context_only_updates_on_closed_4h_bar`, `test_future_bars_cannot_change_the_past` |
| 30 | Data | a 15m bar with missing 1m bars (or whose last minute never came) must not trade or vanish | aggregator emits it when the next window starts, flagged incomplete → `5_data_gap` | `test_aggregator_is_causal_and_flags_gaps` |
| 31 | Signals | dedup counted 1m bars after the move to 15m signals | dedup in signal-timeframe bars | `test_no_short_on_spot_and_dedup` |
| 32 | Signals | new 4h gates need both directions tested | stack / slope / EMA50 side / room each fail; baseline passes | `test_each_gate_fails`, `test_baseline_passes_every_gate_with_default_risk_config` |
| 33 | Money | cost gate only looked at the 1R TP1 although half the position targets the 4h level | gate on the expected gross target (TP1 part + 4h-target part) | `test_default_fees_block_small_targets`, `test_net_r_gate` |
| 34 | Tests | timing tests hard-coded 5 s / 10 min / 3 min | tests read entry timeout, time stop and cooldowns from config | `test_time_stop`, `test_entry_timeout_reprices_once_then_abandons`, `test_cooldowns` |
| 35 | Backtest | synthetic generator trended up to ~40 %/day (unrealistic levels in demos) | drift / volatility scaled to ~3 %/day | demo screenshots |

## Optimisation + road-to-live re-review

| # | Area | Issue | Fix | Covered by |
|---|---|---|---|---|
| 36 | Risk | live mode started the risk officer at the paper equity (10k): a 500 EUR account would trip the −8 % drawdown kill at once | anchors reset to the real balance on the first run of a journal | `test_risk_anchors_reset_to_real_equity` |
| 37 | Resilience | paper and live shared one journal: paper halts / trades would leak into live and into graduation | journal per mode (`data/kolibri-{mode}.sqlite`) | `test_live_start_reports_canary_stage` + graduation defaults |
| 38 | Signals | 4h "levels" were plain 2-day extremes | confirmed swing pivots, causal (known only after 2 closed bars) | `test_4h_pivots_are_confirmed_only_after_two_closed_bars` |
| 39 | Overfitting | an optimiser picking the best grid cell overfits | holdout never seen, fold-median − ½ spread, neighbour smoothing, margin vs current, holdout must not get worse | `test_robust_score_rejects_thin_folds`, synthetic run refuses to change |
| 40 | Overfitting | calibrating win rates on a handful of trades | ≥ 30 trades per setup, shrinkage to 50 %, clamped 15–85 % | `test_calibration_needs_enough_trades_and_shrinks` |
| 41 | Safety | 300 paper trades is unreachable at this horizon, so the old gate made live impossible rather than safe | staged graduation: canary (tiny real orders) then live; live still needs paper quality bars + clean canary | `test_stage_ladder`, `test_canary_caps_order_value` |

## Integration + polish re-review

| # | Area | Issue | Fix | Covered by |
|---|---|---|---|---|
| 42 | Gates | "expectancy ≥ 0" graduation checks passed with zero trades (empty journal looked green) | no trades → check fails with "geen trades" | `test_live_start_reports_canary_stage`, e2e `graduate` run |
| 43 | Integration | drift detection (live vs backtest) existed but was never called | runs with the daily report; WARN alerts in Dutch | `test_drift_flags_live_worse_than_backtest` |
| 44 | Consistency | docs / CLI disagreed on history length (90 vs 120 days) and named the old single journal | 120 days everywhere; journal per mode in RUNBOOK | grep check |
| 45 | UX | Telegram daily report was the only English message | Dutch, same tone as the dashboard | — |
| 46 | UX | phone: tables scrolled sideways and long labels overflowed (page 499 px wide at 390) | rows become cards, "why no trade" first, labels wrap; KPI grid 4/2 columns; 4h support/resistance as a range bar; glossary collapsible | headless Chromium at 390 px: no horizontal scroll on both tabs |
