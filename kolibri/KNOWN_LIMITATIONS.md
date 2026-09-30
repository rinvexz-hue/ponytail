# Known limitations — what KOLIBRI cannot guarantee

**No edge is proven.** Nothing in this repo has been run on real market data (the build environment
had no access to Kraken). The setups are reasonable hypotheses, not validated strategies. The
graduation pipeline exists precisely because they may not survive costs.

## Economics
- Kraken retail spot fees (0.60–1.20 % round trip below the top tiers) are many times a typical
  1–10 minute move; the cost gate will block nearly every scalp. Scalping on Kraken spot only
  becomes arithmetically possible near the top fee tiers, or with a longer holding horizon.
- Expected-R per candidate uses a **prior** win probability mapped from the score
  (`win_prob_prior`, `win_prob_per_score_pt`). It is not calibrated. After paper trading, replace it
  with per-setup hit rates from the journal.
- Synthetic spot TPs pay taker fee + slippage, not maker. Modelled honestly in backtest and paper.

## Backtest realism
- Backtests use 1m bars replayed as a 4-point path (open, adverse extreme, favourable extreme,
  close). Real intrabar order, queue position and the 5 s entry timeout are only approximated.
  Post-only fills require price to trade *through* the level (conservative), but adverse selection
  on fills is not modelled beyond that.
- No historical order book: spread/slippage use per-symbol constants; book imbalance and depth
  scores are neutral (0.5) in backtests, so live scores can differ from backtest scores.
- Derivatives context (funding, OI, liquidations) is not wired; its score component is a constant
  0.5 (weight 5). Funding blackout is off (spot).
- Single fee tier; no VIP tier changes over time. No survivorship issue for these 4 symbols, but
  period selection bias is on you: include crashes and chop.
- Relative-volume uses a 20-day same-minute baseline once ≥ 5 samples exist, else a 60-bar
  fallback; short histories see the fallback.

## Execution / venue
- The live Kraken adapter has **not** been exercised against the venue (no network in the build
  environment) and Kraken has no spot testnet. Run `kolibri check-live`, then live-small only.
- Order-size filters in `config/symbols.yaml` are best-known values; live start refuses if Kraken
  reports different ones (`check-live` prints the real values).
- History: Kraken candles have no taker-buy volume, so bars are rebuilt from public trades. The
  first download is slow (hours per few months per symbol); live bars are appended locally so
  restarts only fetch the gap.
- Spot has no reduce-only: between cancelling a stop and placing its replacement (TP1, trail,
  breakeven) the remainder is briefly unprotected (one REST round trip). Upgrade path: OCO legs.
- Every order asks Kraken to charge fees in EUR (`fciq`), so base holdings match the desk exactly;
  a fill reporting its fee in another currency is approximated from the configured rate.
- A position mismatch is only acted on after two consecutive reconciliations (~30 s) to avoid
  killing on in-flight fills; during that window the mismatch persists.
- Stops are Kraken `stop-loss` orders (market on trigger, last price): in a gap or thin book the fill can be far worse than
  the stop; risk-per-trade is not a hard cap on realised loss.

## Operations
- One process, one lock: a slow REST call delays tick handling. Fine at this scale.
- SQLite writes happen on the event loop (tiny, WAL). Journal grows forever; rotate yearly.
- Restarting mid-position always flattens and halts (by design).
- Clock drift is measured against the exchange every 60 s; NTP on the host is still required.
- The dashboard has bearer-token auth only; its safety relies on being bound to loopback/VPN.
- The Auditor LLM job from the brief is not implemented.
- Legal / product: spot only, 1x, long only by default. Kraken margin shorts and futures are not
  used; check what you may use before enabling anything.
