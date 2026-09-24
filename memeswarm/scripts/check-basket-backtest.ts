// Minimal runnable check for runBacktestOnRealBasket (src/backtest.ts) —
// no fixtures, no framework. Run with: npx tsx scripts/check-basket-backtest.ts
//
// Covers the one piece of genuinely new logic: aligning several real candle
// series (which can start/end at different times, e.g. a later Kraken
// listing) by intersecting timestamps rather than zipping by array index.
// The ATR-scaled exit math and trend-confirmation entry gate reuse
// already-exercised logic from runBacktestOnRealCandles/simulation.ts.

import { runBacktestOnRealBasket } from '../src/backtest'
import type { RealBasketAsset } from '../src/backtest'
import type { RealCandle } from '../src/lib/historicalData'

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`)
}

const MS_PER_CANDLE = 3_600_000 // 1h
const CANDLE_COUNT = 400

function fakeCandles(startIndex: number, count: number, seed: number): RealCandle[] {
  const out: RealCandle[] = []
  let price = 1
  let s = seed
  const rand = () => {
    // deterministic LCG so the candle SHAPE is reproducible across runs —
    // only entry/exit timing (via the real code's Math.random()) varies.
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  for (let i = 0; i < count; i++) {
    // A sustained uptrend for the first two-thirds, then a downtrend — both
    // strong enough to reliably push marketFactor past ENTRY_REGIME_THRESHOLD
    // in both directions, so the check actually exercises entries AND exits
    // (stop-loss/trail/moonshot), not just the alignment math.
    const drift = i < (count * 2) / 3 ? 0.006 : -0.006
    price *= 1 + drift + (rand() - 0.5) * 0.05
    price = Math.max(price, 0.0001)
    out.push({ time: (startIndex + i) * MS_PER_CANDLE, close: price, quoteVolume: 1000 })
  }
  return out
}

// Asset A: full range [0, CANDLE_COUNT).
// Asset B: starts 15 candles later (simulates a later Binance listing) and
// is missing one candle in the middle (simulates a gap) — the intersection
// with A must exclude both the first 15 timestamps AND the gapped one.
const aCandles = fakeCandles(0, CANDLE_COUNT, 1)
const bCandlesRaw = fakeCandles(15, CANDLE_COUNT - 15, 2)
const gapIndex = 100
const bCandles = bCandlesRaw.filter((_, i) => i !== gapIndex)
const cCandles = fakeCandles(0, CANDLE_COUNT, 3)

const assets: RealBasketAsset[] = [
  { label: 'A', candles: aCandles },
  { label: 'B', candles: bCandles },
  { label: 'C', candles: cCandles },
]

// Independently computed expected intersection size, to check the
// function's alignment logic against ground truth rather than against
// itself.
const timeSets = assets.map((a) => new Set(a.candles.map((c) => c.time)))
const expectedCommonTimes = [...timeSets[0]].filter((t) => timeSets.every((s) => s.has(t))).length

const result = runBacktestOnRealBasket(assets, MS_PER_CANDLE)

assert(result.ticks === expectedCommonTimes - 1, `ticks (${result.ticks}) should equal expectedCommonTimes-1 (${expectedCommonTimes - 1})`)
assert(Number.isFinite(result.endEquity) && result.endEquity > 0, `endEquity must be finite and positive, got ${result.endEquity}`)
assert(Number.isFinite(result.totalPnl), 'totalPnl must be finite')
assert(result.wins + result.losses <= result.fills, 'closed trades (wins+losses) cannot exceed total fills')
assert(result.maxDrawdownPct >= 0, 'drawdown cannot be negative')
assert(result.fills > 0, 'a sustained trend across the whole basket should trigger at least one entry')
assert(result.symbol === 'A/B/C', `symbol should list all three basket labels, got "${result.symbol}"`)
assert(result.equityCurve.every((v) => Number.isFinite(v)), 'equity curve must contain only finite values')

// A single asset with too little history must be dropped, not crash the run.
const tooShort: RealBasketAsset = { label: 'D', candles: fakeCandles(0, 10, 4) }
const resultWithShortAsset = runBacktestOnRealBasket([...assets, tooShort], MS_PER_CANDLE)
assert(resultWithShortAsset.symbol === 'A/B/C', 'an asset with too little history must be excluded, not crash the basket')

// Zero usable assets must throw a clear error, not silently return garbage.
let threw = false
try {
  runBacktestOnRealBasket([tooShort], MS_PER_CANDLE)
} catch {
  threw = true
}
assert(threw, 'a basket with no asset meeting the minimum history requirement must throw')

console.log('OK — runBacktestOnRealBasket:', JSON.stringify({
  ticks: result.ticks,
  fills: result.fills,
  wins: result.wins,
  losses: result.losses,
  totalPnlPct: result.totalPnlPct.toFixed(2),
}))
