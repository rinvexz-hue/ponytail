# Known limitations — what KOLIBRI cannot guarantee

**No edge is proven.** Nothing in this repo has been run on real market data (the build environment
had no access to Kraken). The setups are reasonable hypotheses, not validated strategies. The
graduation pipeline exists precisely because they may not survive costs.

## Economics
- Kraken retail spot fees (0.60–1.20 % round trip below the top tiers) are large even for a
  15m/4h horizon: only trades with several percent of room to the next 4h level clear the cost
  gate. Expect few trades, especially at the entry fee tier.
- 4h levels are confirmed swing pivots (2 lower bars each side, ~5–10 days of memory), else the
  2-day extreme. A pivot is only known 8 hours after it formed. No volume profile / order blocks.
- Expected-R uses a win probability per setup. Until `kolibri optimize` has ≥ 30 trades for a
  setup it stays the hand-set prior (50 % + 1 %/score point); with data it is calibrated from
  research trades and shrunk toward 50 %. Calibration on a short history is still noisy.
- `kolibri optimize` searches only 3 parameters on a coarse grid, by design. It cannot find an edge
  that is not there; its main job is to avoid fooling you.
- Canary stage uses tiny real orders: it proves execution, not profitability. Few canary trades
  say little about expectancy.
- Synthetic spot TPs pay taker fee + slippage, not maker. Modelled honestly in backtest and paper.

## Backtest realism
- Backtests use 1m bars replayed as a 4-point path (open, adverse extreme, favourable extreme,
  close). Real intrabar order, queue position and the 60 s entry timeout are only approximated.
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
