# SWARMEXEC

A real autonomous meme coin trading execution engine for Solana (Jupiter/
Raydium routing). This is a **separate project from any dashboard/UI** —
it only produces a structured append-only event log (`data/events.jsonl`)
that a dashboard can read; it contains no UI itself.

**This is a live-money system. Read this whole file before changing
`SWARMEXEC_MODE`.**

## What mode does it boot into by default?

`PAPER`. Every fresh clone, every missing `.env`, every misconfigured
deploy defaults to PAPER: simulated fills against real live prices, zero
chain transactions, zero financial risk. You have to deliberately opt into
anything else.

| Mode | Real money? | Chain txs? | How to enable |
|---|---|---|---|
| `PAPER` (default) | No | No | Nothing — this is the default |
| `TESTNET` | No | Devnet only | `SWARMEXEC_MODE=TESTNET` |
| `LIVE_CAPPED` | **Yes** | Yes, mainnet | `SWARMEXEC_MODE=LIVE_CAPPED` + signer running |
| `LIVE` | **Yes, uncapped by mode** | Yes, mainnet | `LIVE_CAPPED` requirements **+** `SWARMEXEC_CONFIRM=I ACCEPT REAL FINANCIAL LOSS` |

`LIVE` refuses to boot at all without the exact confirmation phrase in
`SWARMEXEC_CONFIRM`. This is deliberately annoying. It exists so a stray
`.env` copied from a template can't silently turn on real trading.

Note that `LIVE_CAPPED` is still real money — "capped" refers to the hard
position/loss caps below, not to risk being zero. Treat it as the normal
graduation step, not as a safe mode.

## The hard caps (`src/config/index.ts`)

These are enforced in code by the risk layer (`src/risk/RiskEngine.ts`),
not by convention. A strategy cannot see or influence this file — only the
risk engine imports it, and the risk engine can only shrink or reject an
order, never enlarge one.

- **Max $ per position** — default $50
- **Max total capital at risk** across all open positions — default $250
- **Max trades per hour** — default 6 (entries only; exits are never
  rate-limited — the one thing this system must always be able to do is
  get out of a trade)
- **Max daily loss (circuit breaker)** — default $100 realized loss halts
  all new entries until the UTC day rolls over; open positions are still
  monitored and can still exit
- **Max slippage** — default 1.5%

Change these in `src/config/index.ts` (`DEFAULT_RISK_CAPS`) or override via
environment. Increasing them is a decision to risk more money — do it
deliberately, not as a fix for a rejected order you didn't understand.

## Graduation: PAPER before real money

A strategy cannot run in `LIVE_CAPPED`/`LIVE` until it has accumulated at
least **7 days** and **30 trades** of PAPER-mode history (both
configurable in `DEFAULT_RISK_CAPS`). This is tracked per-strategy in
`data/graduation/graduation.json` and enforced by the risk engine
(`STRATEGY_NOT_GRADUATED` rejection) — it survives restarts, so nobody has
to remember it by hand. There is no override flag. If a strategy needs to
graduate faster, let it run longer in PAPER; don't edit the JSON file.

## Kill switch

```
npm run killswitch -- halt            # stop all new order submission
npm run killswitch -- halt-and-exit   # also market-exit every open position
npm run killswitch -- status
npm run killswitch -- reset           # resume trading
```

This works by writing a flag file (`SWARMEXEC_KILLSWITCH_PATH`, default
`./data/KILL`) that the main loop polls every tick — it works even if the
main process is wedged, because it doesn't depend on the main process
being responsive. `halt-and-exit` is handled once per trip (tracked by
timestamp) and bypasses the normal risk pipeline entirely, since it's a
deliberate emergency wind-down, not a new speculative entry.

## Key management: the signer is a separate process

The main trading loop (`npm run dev` / `start:*`) **never loads a private
key**. Key material lives only in `src/signer/server.ts`, a standalone
HTTP process bound to `127.0.0.1` that:

- loads a keypair from `SWARMEXEC_SIGNER_KEYPAIR_PATH` (Solana CLI JSON
  format) — set this only in the signer's own environment, never the main
  process's
- requires a bearer token (`SWARMEXEC_SIGNER_TOKEN`) even though it's
  localhost-only, as defense in depth against other local processes
- inspects every transaction it's asked to sign and **rejects anything
  touching a program ID outside a fixed allowlist**
  (`src/signer/allowlist.ts`: System, Compute Budget, SPL Token,
  SPL Token-2022, Associated Token Account, plus your DEX aggregator) —
  this is what stops a compromised or buggy strategy process from
  smuggling in an authority-change or drain instruction disguised as a
  swap
- requires `SWARMEXEC_JUPITER_PROGRAM_ID` to be set explicitly and
  **refuses to boot without it** — it is deliberately not hardcoded.
  Jupiter's aggregator program ID has changed across major versions
  (v4 → v6); this scaffold has no way to verify it against a live source,
  so trusting a hardcoded guess would be worse than requiring you to read
  the current value off https://docs.jup.ag yourself

Run it as its own process:

```
npm run signer
```

Use a **burner wallet** funded only with what you are fully prepared to
lose, topped up manually. Never point this at a wallet holding your main
balance. In a real deployment, run the signer under its own OS user (or
its own container) with no other network egress, not just as a second
terminal tab.

## Architecture

```
Signal sources ──▶ Strategies ──▶ Risk engine ──▶ Executor ──▶ Position manager
 (read-only,        (pure fn,      (hard caps,      (Paper or     (P&L, SL/TP
  never trades)      no I/O)        rug/price        Jupiter       exits)
                                    gates, kill       live)
                                    switch)
                         │
                         ▼
              append-only JSONL event log (data/events.jsonl)
```

- **Signals** (`src/signals`) — pluggable read-only observers (e.g. a
  Dexscreener new-pair poller). Never trade.
- **Strategies** (`src/strategy`) — pure `(signal, context) -> Intent |
  null`. No I/O, easy to unit-test and replay against historical signals.
- **Risk engine** (`src/risk`) — the only place an `Intent` can become an
  `Order`. Kill switch → circuit breaker → dedupe → rate limit →
  graduation → rug-check + price-agreement hard gates → position sizing.
  Every step can reject or shrink; nothing can grow an order.
- **Rug-check gate** (`src/risk/gates/rugCheckGate.ts`) — mint/freeze
  authority renounced, liquidity lock status (unknown = reject, not a
  score), top-10 holder concentration, simulated-sell honeypot check.
  These are hard gates, not a score a strategy can override.
- **Price-agreement gate** (`src/risk/gates/priceAgreementGate.ts`) —
  requires at least two independent price sources (Dexscreener, Jupiter)
  to agree within a threshold before sizing a position.
- **Execution** (`src/execution`) — `PaperExecutor` simulates a fill
  against a real live price with a pessimistic slippage/fee model.
  `LiveExecutor` builds a real swap via Jupiter's quote/swap API and hands
  it to the signer service to sign and submit.
- **Position manager** (`src/position`) — tracks open positions, computes
  live unrealized P&L, and generates its own exit `Intent`s on
  stop-loss/take-profit — these are marked `isExit: true` so the risk
  engine never rate-limits or dedupe-blocks a needed exit.
- Every event at every stage is appended to `data/events.jsonl` — this is
  the audit trail and what a separate dashboard should read.

## Running it

```bash
npm install
npm test              # unit tests for every safety-critical module
npm run start:paper   # default; safe to leave running
```

Watch `data/events.jsonl` grow. Nothing here ever touches a real wallet
until you deliberately set `SWARMEXEC_MODE=LIVE_CAPPED` (or `LIVE`) *and*
start `npm run signer` with a funded burner wallet.

## What this scaffold does NOT do for you

- **`NewPairMomentumStrategy`** (`src/strategy`) has no real edge — it's a
  template proving the pipeline end to end, not something to run with real
  money unmodified.
- **LP-lock detection** in the rug-check gate has no general-purpose
  on-chain check wired in (locker programs vary); it defaults to
  "unknown" for every mint, which the gate treats as a hard reject. Wire
  in a real locker-program check or a curated allowlist before relying on
  this in LIVE_CAPPED — don't loosen the "unknown = reject" default
  instead.
- **MEV protection** — `LiveExecutor` does not yet submit through a
  private RPC or Jito bundle; on mainnet with a public RPC you are exposed
  to sandwich attacks. Add private submission before running real size.
- A dashboard/UI. This engine only writes `data/events.jsonl`.

## Reality check

Most real losses in bots like this happen in the first 48 hours to (1)
slippage/MEV on illiquid pairs, (2) a rug pull the risk gate didn't
actually stop, or (3) a sizing/dedupe bug that was never rate-limited.
Run PAPER mode far longer than feels necessary before trusting it — a week
of paper P&L that matches expectations is the real graduation gate, not
"the code compiles."
